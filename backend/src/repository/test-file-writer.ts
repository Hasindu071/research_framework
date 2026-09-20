import fs from "fs";
import path from "path";
import type { TestMatch, TestRelationship } from "./test-analyzer.js";

// ======================================================
// PRISMA IMPORT / MOCK DETECTION
// ======================================================

/**
 * Detect how the production source file imports Prisma, so any auto-added
 * import/mock in the test file matches the same export shape.
 * Returns null if the source file doesn't import Prisma at all.
 */
function detectPrismaImportStyleFromSource(
  sourceContent: string
): { style: "default" | "named"; source: string; name: string } | null {
  const namedMatch = sourceContent.match(
    /import\s*{\s*([^}]*\bprisma\b[^}]*)\s*}\s*from\s*["'](@calcom\/prisma[^"']*)["']/
  );
  if (namedMatch) {
    return { style: "named", source: namedMatch[2]!, name: "prisma" };
  }

  const defaultMatch = sourceContent.match(
    /import\s+(\w+)\s+from\s*["'](@calcom\/prisma[^"']*)["']/
  );
  if (defaultMatch) {
    return { style: "default", source: defaultMatch[2]!, name: defaultMatch[1]! };
  }

  return null;
}

/**
 * Scan generated test code for every `prisma.<model>.<method>` usage and
 * build a minimal, mechanically-correct mock object covering exactly those
 * calls as `vi.fn()`. This is NOT test logic — it's a safety net so a
 * forgotten vi.mock() never lets a real PrismaClient call fire during a
 * generated test run.
 */
function buildGenericPrismaMock(
  code: string,
  style: "default" | "named",
  source: string
): string | null {
  const usageRegex = /\bprisma\.(\w+)\.(\w+)/g;
  const models = new Map<string, Set<string>>();
  let match: RegExpExecArray | null;

  while ((match = usageRegex.exec(code)) !== null) {
    const model = match[1]!;
    const method = match[2]!;
    if (!models.has(model)) models.set(model, new Set());
    models.get(model)!.add(method);
  }

  if (models.size === 0) return null;

  const modelEntries = Array.from(models.entries())
    .map(([model, methods]) => {
      const methodEntries = Array.from(methods)
        .map((m) => `${m}: vi.fn()`)
        .join(", ");
      return `${model}: { ${methodEntries} }`;
    })
    .join(",\n    ");

  const body = `{\n    ${modelEntries}\n  }`;

  return style === "default"
    ? `vi.mock('${source}', () => ({ default: ${body} }));`
    : `vi.mock('${source}', () => ({ prisma: ${body} }));`;
}

// ======================================================
// PRISMA ENUM MOCK SANITIZER (NEW)
// ======================================================

/**
 * The system prompt tells the LLM never to fully mock "@calcom/prisma/enums"
 * (or any prisma enum module), but the LLM sometimes does it anyway, and
 * once one of those merges into a shared test file, vi.mock()'s hoisting
 * means it silently breaks EVERY test in that file — including ones that
 * have nothing to do with enums — because any transitively-imported code
 * that needs a real enum value now gets `undefined`, which surfaces as
 * "No <X> export is defined on the <module> mock" and the whole file fails
 * to even load (0 tests run).
 *
 * This scans a block of code (either freshly generated, or already-on-disk
 * file content) for any vi.mock() targeting a prisma enums module that does
 * NOT use importOriginal, and neutralizes it by rewriting it into a safe
 * passthrough mock. This runs on every merge, so even a bad mock that
 * slipped through in an earlier round gets healed the next time this file
 * is touched — no manual cleanup needed, and no test behavior is altered
 * since the rewritten mock just returns every real export unchanged.
 */
function sanitizeProblemPrismaEnumMocks(code: string): {
  code: string;
  rewrittenCount: number;
} {
  const ENUM_MODULE_PATTERN = /@calcom\/prisma\/enums|@prisma\/client\/enums/;
  let rewrittenCount = 0;

  const lines = code.split("\n");
  const outputLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed.startsWith("vi.mock(") && ENUM_MODULE_PATTERN.test(trimmed)) {
      let mockCode = line;
      let depth = 0;
      let bracketDepth = 0;
      let foundEnd = false;

      const scan = (s: string) => {
        for (const ch of s) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          if (ch === "{") bracketDepth++;
          else if (ch === "}") bracketDepth--;
          if (depth === 0 && bracketDepth === 0 && ch === ")") {
            foundEnd = true;
            break;
          }
        }
      };
      scan(mockCode);

      while (!foundEnd && i + 1 < lines.length) {
        i++;
        const next = lines[i] ?? "";
        mockCode += "\n" + next;
        scan(next);
      }

      const usesImportOriginal = /importOriginal/.test(mockCode);
      const sourceMatch = mockCode.match(/vi\.mock\(\s*['"]([^'"]+)['"]/);
      const source = sourceMatch?.[1] ?? "@calcom/prisma/enums";

      if (usesImportOriginal) {
        // Already safe — leave it exactly as-is.
        outputLines.push(mockCode);
      } else {
        rewrittenCount++;
        console.log(
          `[Test-File-Writer] ⚠️ SANITIZED: Found unsafe full-replacement mock for "${source}" ` +
          `(breaks any code needing real enum values). Rewriting as a safe passthrough.`
        );
        outputLines.push(
          `vi.mock('${source}', async (importOriginal) => {\n` +
          `  const actual = await importOriginal();\n` +
          `  return { ...actual };\n` +
          `});`
        );
      }
      i++;
    } else {
      outputLines.push(line);
      i++;
    }
  }

  return { code: outputLines.join("\n"), rewrittenCount };
}

/**
 * Convenience wrapper — sanitize a full file already on disk, in place if
 * a rewrite was needed. Used both by mergeGeneratedTests() and (optionally)
 * by the test-runner's error-path healing, so a poisoned mock never has
 * to wait for the next generation round to be fixed.
 */
export function healPrismaEnumMocksOnDisk(testFileAbsolute: string): boolean {
  if (!fs.existsSync(testFileAbsolute)) return false;

  const raw = fs.readFileSync(testFileAbsolute, "utf8");
  const { code, rewrittenCount } = sanitizeProblemPrismaEnumMocks(raw);

  if (rewrittenCount > 0) {
    fs.writeFileSync(testFileAbsolute, code, "utf8");
    console.log(
      `[Test-File-Writer] ✓ Healed ${rewrittenCount} unsafe prisma-enum mock(s) directly on disk: ${testFileAbsolute}`
    );
    return true;
  }

  return false;
}

// ======================================================
// SYMBOL EXTRACTION HELPERS
// ======================================================

function stripOuterDescribeWrapper(code: string): string {
  const trimmed = code.trim();

  if (!trimmed.startsWith("describe")) return code;

  let braceDepth = 0;
  let braceStart = -1;
  let braceEnd = -1;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (char === "{") {
      if (braceDepth === 0) braceStart = i + 1;
      braceDepth++;
    } else if (char === "}") {
      braceDepth--;
      if (braceDepth === 0) {
        braceEnd = i;
        break;
      }
    }
  }

  if (braceStart > 0 && braceEnd > braceStart) {
    const content = trimmed.slice(braceStart, braceEnd).trim();
    if (content.length > 0) {
      return content;
    }
  }

  return code;
}

function fixLLMPatternMistakes(code: string, testFileExtension: string): string {
  let fixed = code;

  const isJsxCapable = /\.(tsx|jsx)$/i.test(testFileExtension);

  if (!isJsxCapable) {
    console.log("[Test-File-Writer] ⚠️ JSX stripping: This is a non-JSX file, removing any JSX syntax...");
    console.log(`[Test-File-Writer]    File: ${testFileExtension}`);

    let pass1Count = 0;
    let prevFixed = fixed;
    fixed = fixed.replace(/=>\s*<[^>]*?(?:>[\s\S]*?<\/[^>]*?>|\/?>)/g, "=> null");
    pass1Count = (prevFixed.match(/=>\s*<[^>]*?(?:>[\s\S]*?<\/[^>]*?>|\/?>)/g) || []).length;
    if (pass1Count > 0) {
      console.log(`[Test-File-Writer] ✓ Pass 1: Stripped ${pass1Count} JSX in arrow functions`);
    }

    let pass2Count = 0;
    prevFixed = fixed;
    fixed = fixed.replace(/return\s+<[^>]*?(?:>[\s\S]*?<\/[^>]*?>|\/?>)/g, "return null");
    pass2Count = (prevFixed.match(/return\s+<[^>]*?(?:>[\s\S]*?<\/[^>]*?>|\/?>)/g) || []).length;
    if (pass2Count > 0) {
      console.log(`[Test-File-Writer] ✓ Pass 2: Stripped ${pass2Count} JSX in return statements`);
    }

    let pass3Count = 0;
    prevFixed = fixed;
    fixed = fixed.replace(/:\s*<[^>]*?(?:>[\s\S]*?<\/[^>]*?>|\/?>)/g, ": null");
    pass3Count = (prevFixed.match(/:\s*<[^>]*?(?:>[\s\S]*?<\/[^>]*?>|\/?>)/g) || []).length;
    if (pass3Count > 0) {
      console.log(`[Test-File-Writer] ✓ Pass 3: Stripped ${pass3Count} JSX assigned to object properties`);
    }

    let pass4Count = 0;
    prevFixed = fixed;
    fixed = fixed.replace(/<>[\s\S]*?<\/>/g, "null");
    pass4Count = (prevFixed.match(/<>[\s\S]*?<\/>/g) || []).length;
    if (pass4Count > 0) {
      console.log(`[Test-File-Writer] ✓ Pass 4: Stripped ${pass4Count} JSX fragments`);
    }

    let pass5Count = 0;
    prevFixed = fixed;
    fixed = fixed.replace(/<[a-zA-Z][^>]*?(?:>[\s\S]*?<\/[a-zA-Z][^>]*?>|\/?>)/g, "null");
    pass5Count = (prevFixed.match(/<[a-zA-Z][^>]*?(?:>[\s\S]*?<\/[a-zA-Z][^>]*?>|\/?>)/g) || []).length;
    if (pass5Count > 0) {
      console.log(`[Test-File-Writer] ✓ Pass 5: Stripped ${pass5Count} remaining JSX/HTML elements`);
    }

    let pass6Count = 0;
    prevFixed = fixed;
    const emergencyMatches = fixed.match(/<\s*[a-zA-Z/][^}]*?>/g) || [];
    pass6Count = emergencyMatches.length;
    if (pass6Count > 0) {
      console.log(`[Test-File-Writer] ⚠️  Pass 6 (Emergency): Found ${pass6Count} potential JSX tags:`, emergencyMatches.slice(0, 3));
      fixed = fixed.replace(/<\s*[a-zA-Z/][^}]*?>/g, "(");
    }

    const totalStripped = pass1Count + pass2Count + pass3Count + pass4Count + pass5Count + pass6Count;
    console.log(`[Test-File-Writer] ✓ JSX STRIPPING COMPLETE: ${totalStripped} total replacements made`);
  } else {
    console.log(`[Test-File-Writer] JSX file (.tsx/.jsx) detected - skipping JSX stripping`);
  }

  const stubTestRegex = /it\s*\(\s*['"`][^'"`]+['"`]\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*{\s*expect\s*\(\s*(?:true|false|1|0|null|undefined|'[^']*'|"[^"]*")\s*\)\s*\.toBe(?:Null|Undefined|NaN|Truthy|Falsy|InstanceOf|Defined|Called|CalledTimes|CalledWith|CalledOnce)?\s*\(\s*(?:true|false|1|0|null|undefined|'[^']*'|"[^"]*")\s*\)\s*;\s*}\s*\);/gm;
  const stubMatches = Array.from(fixed.matchAll(stubTestRegex));

  if (stubMatches.length > 0) {
    console.log(`[Test-File-Writer] ⚠️ CRITICAL: Detected ${stubMatches.length} stub test(s) that don't test actual function behavior!`);
    for (const match of stubMatches) {
      console.log(`[Test-File-Writer]    Stub test: ${match[0].substring(0, 100)}...`);
    }
    console.log(`[Test-File-Writer]    These tests always pass but don't verify function behavior. They should be replaced with real tests.`);
  }

  if (fixed.includes("expect(true).toBe(true)") ||
      fixed.includes("expect(false).toBe(false)") ||
      fixed.includes("expect(null).toBeNull()") ||
      fixed.includes("expect(undefined).toBeUndefined()")) {
    console.log(`[Test-File-Writer] ⚠️ CRITICAL: Generated test contains stub assertions (always pass, don't test real behavior)!`);
    console.log(`[Test-File-Writer]    The LLM likely couldn't understand the function and generated a placeholder.`);
    console.log(`[Test-File-Writer]    This test should be skipped or rewritten with actual function behavior verification.`);
  }

  if (fixed.includes("vi.advanceTimersByTimeAsync")) {
    const hasBeforeEachWithFakeTimers = /beforeEach\s*\(\s*\(\)\s*=>\s*{\s*vi\.useFakeTimers\(\)/.test(fixed);

    if (!hasBeforeEachWithFakeTimers) {
      if (!fixed.includes("vi.useFakeTimers()")) {
        const firstItIndex = fixed.indexOf("it(");
        if (firstItIndex > -1) {
          const lineStart = fixed.lastIndexOf("\n", firstItIndex) + 1;
          const indent = fixed.substring(lineStart, firstItIndex).match(/^\s*/)?.[0] || "";

          const beforeEachCode = `beforeEach(() => {\n${indent}  vi.useFakeTimers();\n${indent}});\n\n${indent}`;
          fixed = fixed.substring(0, lineStart) + beforeEachCode + fixed.substring(lineStart);

          console.log("[Test-File-Writer] ✓ Added beforeEach with vi.useFakeTimers() for timer-based tests");
        }
      }
    }
  }

  if (fixed.includes("screen.getByText") || fixed.includes("screen.findByText")) {
    if (fixed.includes("render(")) {
      const screenMethods = new Set<string>();
      const screenRegex = /screen\.(get|find|query)(By\w+)/g;
      let match;
      while ((match = screenRegex.exec(fixed)) !== null) {
        screenMethods.add((match[1] || '') + (match[2] || ''));
      }

      if (screenMethods.size > 0) {
        fixed = fixed.replace(/screen\.(get|find|query)(By\w+)/g, "$1$2");

        const methodsList = Array.from(screenMethods).join(", ");

        const hasExistingDestructure = /const\s+{\s*\w+.*}\s*=\s*render\s*\(/;
        if (!hasExistingDestructure.test(fixed)) {
          fixed = fixed.replace(
            /(\n\s*)render\s*\(/,
            `$1const { ${methodsList} } = render(`
          );
        }

        console.log("[Test-File-Writer] ✓ Fixed screen.getByX pattern: replaced with destructured methods");
      }
    }
  }

  const componentDefRegex = /function\s+(\w+)\s*\(\s*\)\s*{[\s\S]*?}/g;
  let componentMatch;
  while ((componentMatch = componentDefRegex.exec(fixed)) !== null) {
    const componentCode = componentMatch[0];
    const hookCallRegex = /\b(use\w+)\s*\(/g;
    let hookMatch;
    while ((hookMatch = hookCallRegex.exec(componentCode)) !== null) {
      const hookName = hookMatch[1];
      if (!fixed.includes(`const ${hookName}`) &&
          !fixed.includes(`import.*${hookName}`) &&
          !fixed.includes(`function ${hookName}`) &&
          !fixed.match(new RegExp(`\\b${hookName}\\s*=`))) {
        console.log(`[Test-File-Writer] ⚠️ WARNING: Component uses undefined hook '${hookName}'. LLM test may fail.`);
      }
    }
  }

  return fixed;
}

function fixCommonSyntaxErrors(code: string): string {
  code = code.replace(/,{2,}/g, ",");
  code = code.replace(/,(\s*\))/g, "$1");
  code = code.replace(/<\/>\s*,+\s*,/g, "</>");
  return code;
}

function isStubTest(testCode: string): boolean {
  const stubPatterns = [
    /expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/,
    /expect\s*\(\s*false\s*\)\s*\.toBe\s*\(\s*false\s*\)/,
    /expect\s*\(\s*null\s*\)\s*\.toBeNull\s*\(\s*\)/,
    /expect\s*\(\s*undefined\s*\)\s*\.toBeUndefined\s*\(\s*\)/,
    /expect\s*\(\s*1\s*\)\s*\.toBe\s*\(\s*1\s*\)/,
    /expect\s*\(\s*0\s*\)\s*\.toBe\s*\(\s*0\s*\)/,
  ];

  return stubPatterns.some(pattern => pattern.test(testCode));
}

function usesTargetFunction(testCode: string, targetSymbol: string | undefined): boolean {
  if (!targetSymbol) return true;
  return testCode.includes(targetSymbol);
}

function validateTestQuality(testCode: string): { valid: boolean; reason?: string } {
  // Reject tautological assertions
  if (testCode.includes("expect(true).toBe(true)")) {
    return { valid: false, reason: "Tautological assertion: expect(true).toBe(true)" };
  }

  if (testCode.includes("expect(false).toBe(false)")) {
    return { valid: false, reason: "Tautological assertion: expect(false).toBe(false)" };
  }

  // Reject tests with only toBeDefined assertions
  const assertionMatches = testCode.match(/expect\([^)]+\)\.\w+/g) || [];
  const isDefinedMatches = testCode.match(/expect\([^)]+\)\.toBeDefined\(\)/g) || [];

  if (assertionMatches.length === 1 && isDefinedMatches.length === 1) {
    return { valid: false, reason: "Weak assertion: only expects result to be defined (must assert on actual value or behavior)" };
  }

  // Reject placeholder tests
  if (testCode.includes("TODO") || testCode.includes("FIXME") || testCode.includes("placeholder")) {
    return { valid: false, reason: "Placeholder test with TODO/FIXME comments" };
  }

  // Reject empty test bodies
  const itMatches = testCode.match(/it\s*\([^)]+\)\s*,?\s*(?:async\s*)?\(\s*\)\s*=>\s*{([^}]*)}/g) || [];
  for (const match of itMatches) {
    const body = match.split('{')[1]?.split('}')[0]?.trim();
    if (!body || body.length === 0) {
      return { valid: false, reason: "Test with empty body" };
    }
  }

  // New: Reject tests that only do type checking without behavior verification
  if (/expect\([^)]*\)\.toHaveBeenCalled\(\)/.test(testCode) && assertionMatches.length === 1) {
    return { valid: false, reason: "Weak assertion: only checks if function was called without verifying result or side effects" };
  }

  // New: Reject tests that don't actually make any assertions
  if (!testCode.includes("expect(")) {
    return { valid: false, reason: "No assertions found: test must use expect() to verify behavior" };
  }

  return { valid: true };
}

function cleanGeneratedTestCode(code: string, testFileExtension: string = ".ts"): string {
  console.log("[Test-File-Writer] USING FIXED cleanGeneratedTestCode");
  console.log("[Test-File-Writer] testFileExtension parameter:", testFileExtension);
  console.log("[Test-File-Writer] Is JSX file?", testFileExtension.match(/\.(tsx|jsx)$/i) !== null);
  console.log("[Test-File-Writer] Raw testCode from LLM (first 200 chars):");
  console.log(code.substring(0, 200));

  let cleaned = code.replace(/\r\n/g, "\n").trim();

  if (!testFileExtension.match(/\.(tsx|jsx)$/i)) {
    console.log("[Test-File-Writer] Running aggressive JSX sanitization for non-JSX file...");

    const hasJSX = /=>\s*<[^>]|\breturn\s+<[^>]|:\s*<[^>]|<[a-zA-Z]/m.test(cleaned);
    if (hasJSX) {
      console.log("[Test-File-Writer] ⚠️ Detected JSX syntax in non-JSX file - will strip");
    }
  }

  // Strip a bare leading language-tag word (e.g. Gemini emitting
  // " typescript\nimport ..." without markdown fences).
  cleaned = cleaned.replace(/^\s*(?:typescript|ts|javascript|js)\s*\n/i, "");

  cleaned = fixLLMPatternMistakes(cleaned, testFileExtension);
  cleaned = fixCommonSyntaxErrors(cleaned);
  cleaned = stripOuterDescribeWrapper(cleaned);

  cleaned = cleaned.replace(/^```(?:typescript|ts|javascript|js)?\s*/i, "");
  cleaned = cleaned.replace(/\s*```$/i, "");

  // Neutralize any unsafe full-replacement mock of a prisma enums module
  // BEFORE splitting into imports/mocks/other below, so the mock-extraction
  // logic sees the already-safe rewritten version.
  const { code: sanitized, rewrittenCount } = sanitizeProblemPrismaEnumMocks(cleaned);
  cleaned = sanitized;
  if (rewrittenCount > 0) {
    console.log(
      `[Test-File-Writer] ⚠️ Sanitized ${rewrittenCount} unsafe prisma-enum mock(s) in freshly generated test code`
    );
  }

  const lines = cleaned.split("\n");
  const mocks: string[] = [];
  const imports: string[] = [];
  const other: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line?.trim() ?? "";

    if (trimmed.startsWith("vi.mock(")) {
      let mockCode = line || "";
      let depth = 0;
      let bracketDepth = 0;
      let foundEnd = false;

      for (const ch of mockCode) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (ch === "{") bracketDepth++;
        else if (ch === "}") bracketDepth--;
        if (depth === 0 && bracketDepth === 0 && ch === ")") {
          foundEnd = true;
          break;
        }
      }

      while (!foundEnd && i + 1 < lines.length) {
        i++;
        const nextLine = lines[i];
        if (nextLine) {
          mockCode += "\n" + nextLine;
          for (const ch of nextLine) {
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
            if (ch === "{") bracketDepth++;
            else if (ch === "}") bracketDepth--;
            if (depth === 0 && bracketDepth === 0 && ch === ")") {
              foundEnd = true;
              break;
            }
          }
        }
      }

      mocks.push(mockCode);
      i++;
    } else if (trimmed.startsWith("import ")) {
      imports.push(line || "");
      console.log(`[Test-File-Writer] ✓ PRESERVING LLM import: ${trimmed}`);
      i++;
    } else if (trimmed.length > 0) {
      other.push(line || "");
      i++;
    } else {
      i++;
    }
  }

  const reassembled = [...imports, ...mocks, ...other].join("\n");

  const reassembledLines = reassembled.split("\n");
  const nonEmptyLines = reassembledLines.filter((line) => line.trim().length > 0);

  const minIndent =
    nonEmptyLines.length > 0
      ? Math.min(...nonEmptyLines.map((line) => line.match(/^\s*/)?.[0].length ?? 0))
      : 0;

  const result = reassembledLines.map((line) => line.slice(minIndent)).join("\n").trim();
  console.log("[Test-File-Writer] Cleaned testCode (first 200 chars):");
  console.log(result.substring(0, 200));

  if (result.match(/<[a-zA-Z][^>]*>/)) {
    console.log("[Test-File-Writer] ⚠️⚠️⚠️ WARNING: Code still contains JSX-like syntax after cleaning!");
    console.log("[Test-File-Writer] Lines with potential JSX:");
    result.split("\n").forEach((line, idx) => {
      if (line.match(/<[a-zA-Z]/)) {
        console.log(`  Line ${idx + 1}: ${line.substring(0, 100)}`);
      }
    });
  }

  return result;
}

// ======================================================
// PICKING THE SINGLE BEST RELATED TEST FILE
// ======================================================

const RELATIONSHIP_RANK: Record<TestRelationship, number> = {
  dependency: 0,
  "locale-import": 1,
  "same-directory": 2,
  "same-name": 3,
  import: 4,
  "symbol-usage": 5,
};

export interface TargetTestFileResolution {
  testFile: string;
  isNewFile: boolean;
  match?: TestMatch;
}

export function resolveTargetTestFile(
  sourceFile: string,
  matchesForFile: TestMatch[]
): TargetTestFileResolution {
  if (matchesForFile.length > 0) {
    const best = [...matchesForFile].sort((a, b) => {
      const rankDiff =
        RELATIONSHIP_RANK[b.relationship] - RELATIONSHIP_RANK[a.relationship];

      if (rankDiff !== 0) {
        return rankDiff;
      }

      return b.confidence - a.confidence;
    })[0]!;

    return { testFile: best.testFile, isNewFile: false, match: best };
  }

  return { testFile: inferNewTestFileName(sourceFile), isNewFile: true };
}

export function inferNewTestFileName(sourceFile: string): string {
  const match = sourceFile.match(/^(.+)\.(ts|tsx|js|jsx)$/);
  if (!match) {
    return `${sourceFile}.test.ts`;
  }

  const basePath = match[1]!;
  const sourceExtension = match[2]!;

  if (basePath.endsWith('.test')) {
    return sourceFile;
  }

  if (sourceExtension === "tsx" || sourceExtension === "jsx") {
    return `${basePath}.test.${sourceExtension}`;
  }

  return `${basePath}.test.${sourceExtension}`;
}

// ======================================================
// MERGING GENERATED TESTS INTO THE REAL FILE
// ======================================================

export interface GeneratedTestLike {
  name: string;
  testCode: string;
}

export interface MergeResult {
  testFileAbsolute: string;
  finalContent: string;
  originalContent: string | null;
}

export function mergeGeneratedTests(
  repositoryRoot: string,
  testFile: string,
  isNewFile: boolean,
  sourceFile: string,
  generatedTests: GeneratedTestLike[],
  targetSymbol?: string
): MergeResult {
  console.log("[Test-File-Writer] MERGE CALLED - isNewFile:", isNewFile, "testFile:", testFile);
  const testFileAbsolute = path.resolve(repositoryRoot, testFile);

  const cleanedTests = generatedTests.map((t) => ({
    ...t,
    testCode: cleanGeneratedTestCode(t.testCode, testFile),
  }));

  console.log("[Test-File-Writer] MERGE: Cleaned", generatedTests.length, "test(s), testFile parameter:", testFile);

  const sourceFileAbsolute = path.isAbsolute(sourceFile)
    ? sourceFile
    : path.resolve(repositoryRoot, sourceFile);
  let sourceFileContent: string | null = null;
  if (fs.existsSync(sourceFileAbsolute)) {
    try {
      sourceFileContent = fs.readFileSync(sourceFileAbsolute, "utf8");
    } catch {
      sourceFileContent = null;
    }
  }
  const prismaImportStyle = sourceFileContent
    ? detectPrismaImportStyleFromSource(sourceFileContent)
    : null;

  const allImports = new Set<string>();
  const allMocks: string[] = [];

  for (const t of cleanedTests) {
    let code = t.testCode;

    const lines = code.split("\n");
    const mockLines: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line?.trim() ?? "";

      if (trimmed.startsWith("vi.mock(")) {
        let mockCode = line || "";
        let depth = 0;
        let bracketDepth = 0;
        let foundEnd = false;

        for (const ch of mockCode) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          if (ch === "{") bracketDepth++;
          else if (ch === "}") bracketDepth--;
          if (depth === 0 && bracketDepth === 0 && ch === ")") {
            foundEnd = true;
            break;
          }
        }

        while (!foundEnd && i + 1 < lines.length) {
          i++;
          const nextLine = lines[i];
          if (nextLine) {
            mockCode += "\n" + nextLine;
            for (const ch of nextLine) {
              if (ch === "(") depth++;
              else if (ch === ")") depth--;
              if (ch === "{") bracketDepth++;
              else if (ch === "}") bracketDepth--;
              if (depth === 0 && bracketDepth === 0 && ch === ")") {
                foundEnd = true;
                break;
              }
            }
          }
        }

        mockLines.push(mockCode);
        i++;
      } else if (trimmed.startsWith("import ")) {
        const normalizedImport = trimmed.endsWith(';') ? trimmed : trimmed + ';';
        allImports.add(normalizedImport);
        i++;
      } else if (trimmed.length > 0 && !trimmed.startsWith("vi.")) {
        i++;
      } else {
        i++;
      }
    }

    for (const mock of mockLines) {
      allMocks.push(mock);
    }
  }

  // Belt-and-suspenders: sanitize allMocks again here (cleanGeneratedTestCode
  // already ran the sanitizer per-test, but this second pass guarantees
  // safety regardless of how allMocks was assembled).
  for (let m = 0; m < allMocks.length; m++) {
    const { code: sanitized, rewrittenCount } = sanitizeProblemPrismaEnumMocks(allMocks[m]!);
    if (rewrittenCount > 0) {
      allMocks[m] = sanitized;
    }
  }

  // CRITICAL: Filter out test framework imports from generated code.
  // These are always provided by the test file and should NEVER be re-imported.
  // This is a critical safety net to prevent duplicate imports that break the merge.
  const TEST_FRAMEWORK_IMPORTS = new Set([
    "import { it } from 'vitest';",
    'import { it } from "vitest";',
    "import { expect } from 'vitest';",
    'import { expect } from "vitest";',
    "import { describe } from 'vitest';",
    'import { describe } from "vitest";',
    "import { vi } from 'vitest';",
    'import { vi } from "vitest";',
    "import { beforeEach } from 'vitest';",
    'import { beforeEach } from "vitest";',
    "import { afterEach } from 'vitest';",
    'import { afterEach } from "vitest";',
    "import { beforeAll } from 'vitest';",
    'import { beforeAll } from "vitest";',
    "import { afterAll } from 'vitest';",
    'import { afterAll } from "vitest";',
    "import { test } from 'vitest';",
    'import { test } from "vitest";',
  ]);

  // Remove test framework imports from allImports
  const filteredImports = new Set<string>();
  let removedFrameworkImports = 0;
  for (const imp of allImports) {
    if (TEST_FRAMEWORK_IMPORTS.has(imp)) {
      removedFrameworkImports++;
      console.log(`[Test-File-Writer] ⚠️ Filtered out test framework import (already provided): ${imp}`);
    } else {
      filteredImports.add(imp);
    }
  }
  
  if (removedFrameworkImports > 0) {
    console.log(`[Test-File-Writer] ✓ Removed ${removedFrameworkImports} duplicate test framework import(s)`);
  }
  try {
    for (const t of cleanedTests) {
      const code = t.testCode;

      const symbolImportMap = new Map<string, string>([
        ['React', "import React from 'react';"],
        ['StrictMode', "import { StrictMode } from 'react';"],
        ['useState', "import { useState } from 'react';"],
        ['useEffect', "import { useEffect } from 'react';"],
        ['useContext', "import { useContext } from 'react';"],
        ['useCallback', "import { useCallback } from 'react';"],
        ['useMemo', "import { useMemo } from 'react';"],
        ['create', "import { create } from 'zustand';"],
        ['createWithEqualityFn', "import { createWithEqualityFn } from 'zustand/traditional';"],
        ['persist', "import { persist } from 'zustand/middleware';"],
        ['createJSONStorage', "import { createJSONStorage } from 'zustand/middleware';"],
        ['devtools', "import { devtools } from 'zustand/middleware';"],
        ['subscribeWithSelector', "import { subscribeWithSelector } from 'zustand/middleware';"],
        ['combine', "import { combine } from 'zustand/middleware';"],
        ['render', "import { render } from '@testing-library/react';"],
        ['screen', "import { screen } from '@testing-library/react';"],
        ['act', "import { act } from '@testing-library/react';"],
        ['cleanup', "import { cleanup } from '@testing-library/react';"],
        ['waitFor', "import { waitFor } from '@testing-library/react';"],
        ['fireEvent', "import { fireEvent } from '@testing-library/react';"],
        ['within', "import { within } from '@testing-library/react';"],
        ['userEvent', "import userEvent from '@testing-library/user-event';"],
        ['sleep', "import { sleep } from './test-utils';"],
        // NOTE: Deliberately omit test framework globals (vi, it, describe, expect, beforeEach, etc.)
        // These are ALWAYS provided by the test file framework and should never be re-imported.
        // They are handled separately by the TEST_FRAMEWORK_IMPORTS filter above.
      ]);

      for (const [symbol, importStatement] of symbolImportMap) {
        const symbolPatterns = [
          new RegExp(`\\b${symbol}\\s*\\(`),
          new RegExp(`\\b${symbol}\\s*\\)`),
          new RegExp(`\\b${symbol}\\s*,`),
          new RegExp(`\\b${symbol}\\s*;`),
          new RegExp(`\\s${symbol}\\b`),
          new RegExp(`\\b${symbol}$`, 'm'),
          new RegExp(`\\b${symbol}\\.`),
          new RegExp(`\\(${symbol}`),
          new RegExp(`\\[${symbol}`),
          new RegExp(`${symbol}\\]`),
          new RegExp(`${symbol}\\}`),
          new RegExp(`\\{\\s*${symbol}`),
        ];

        const isUsed = symbolPatterns.some(pattern => pattern.test(code));

        if (isUsed && !filteredImports.has(importStatement)) {
          filteredImports.add(importStatement);
          console.log(`[Test-File-Writer] Auto-added missing import for ${symbol}`);
        }
      }

      // prisma-specific auto-import (varies by export style, so it isn't
      // in the generic map above).
      const referencesPrisma = /\bprisma\s*\./.test(code);
      const alreadyHasPrismaImport = Array.from(filteredImports).some((imp) =>
        /@calcom\/prisma|@prisma\/client/.test(imp)
      );

      if (referencesPrisma && !alreadyHasPrismaImport) {
        if (prismaImportStyle) {
          const stmt =
            prismaImportStyle.style === "default"
              ? `import ${prismaImportStyle.name} from '${prismaImportStyle.source}';`
              : `import { ${prismaImportStyle.name} } from '${prismaImportStyle.source}';`;
          filteredImports.add(stmt);
          console.log(`[Test-File-Writer] ✓ Auto-added missing prisma import (${prismaImportStyle.style}): ${stmt}`);
        } else {
          filteredImports.add(`import { prisma } from '@calcom/prisma';`);
          console.log(`[Test-File-Writer] ⚠️ Auto-added fallback named prisma import — could not detect source import style`);
        }
      }

      const functionCallRegex = /\b(\w+)\s*\(/g;
      let funcMatch;
      const localFunctionsAndImports = new Set<string>();

      for (const importStmt of filteredImports) {
        const importMatch = importStmt.match(/(?:import|from)\s+(?:\{([^}]+)\}|(\w+))/);
        if (importMatch) {
          const imported = importMatch[1] || importMatch[2];
          if (imported) {
            imported.split(',').forEach(name => {
              localFunctionsAndImports.add(name.trim().split(' as ')[0]?.trim() || '');
            });
          }
        }
      }

      while ((funcMatch = functionCallRegex.exec(code)) !== null) {
        const funcName = funcMatch[1];
        if (funcName && !localFunctionsAndImports.has(funcName)) {
          if (symbolImportMap.has(funcName)) {
            const importStatement = symbolImportMap.get(funcName);
            if (importStatement && !filteredImports.has(importStatement)) {
              filteredImports.add(importStatement);
              console.log(`[Test-File-Writer] Auto-added missing import for function ${funcName}`);
            }
          }
        }
      }
    }
  } catch (err) {
    console.log(`[Test-File-Writer] Auto-import safety net skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (targetSymbol && sourceFile) {
    const testDir = path.dirname(testFile);
    const sourceDir = path.dirname(sourceFile);
    const sourceBaseName = path.basename(sourceFile, path.extname(sourceFile));

    let relativeImportPath: string;
    if (testDir === sourceDir) {
      relativeImportPath = `./${sourceBaseName}`;
    } else {
      const relativePath = path.relative(testDir, sourceDir);
      relativeImportPath = path.join(relativePath, sourceBaseName).replace(/\\/g, "/");
      if (!relativeImportPath.startsWith(".")) {
        relativeImportPath = `./${relativeImportPath}`;
      }
    }

    const targetImportStatement = `import { ${targetSymbol} } from '${relativeImportPath}';`;
    if (!filteredImports.has(targetImportStatement)) {
      filteredImports.add(targetImportStatement);
      console.log(`[Test-File-Writer] ✓ Added target function import: ${targetImportStatement}`);
    }
  }

  // Generic Prisma auto-mock safety net (does not affect enum mocks —
  // those are handled entirely by sanitizeProblemPrismaEnumMocks above).
  if (prismaImportStyle) {
    const hasPrismaMock = allMocks.some((m) => m.includes(prismaImportStyle.source));
    if (!hasPrismaMock) {
      const combinedTestCode = cleanedTests.map((t) => t.testCode).join("\n");
      const genericMock = buildGenericPrismaMock(
        combinedTestCode,
        prismaImportStyle.style,
        prismaImportStyle.source
      );
      if (genericMock) {
        allMocks.push(genericMock);
        console.log(`[Test-File-Writer] ✓ Injected generic Prisma auto-mock (safety net): ${genericMock.slice(0, 120)}...`);
      }
    }
  }

  let topLevelBlock = "";
  if (filteredImports.size > 0) {
    topLevelBlock += Array.from(filteredImports).join("\n") + "\n\n";
  }
  if (allMocks.length > 0) {
    topLevelBlock += allMocks.join("\n\n") + "\n\n";
  }

  const seenTestContent = new Set<string>();
  const uniqueTests = cleanedTests.filter((t) => {
    const normalized = t.testCode
      .replace(/\s+/g, " ")
      .trim();

    if (seenTestContent.has(normalized)) {
      console.log(
        `[Test-File-Writer] ⚠️ DEDUP: Skipping duplicate test "${t.name}" — ` +
        `identical code already processed in this merge batch`
      );
      return false;
    }

    if (isStubTest(t.testCode)) {
      console.log(
        `[Test-File-Writer] ⚠️ REJECTED: Stub test "${t.name}" — ` +
        `test doesn't verify real function behavior (e.g., expect(true).toBe(true)). ` +
        `The LLM likely couldn't understand the function.`
      );
      return false;
    }

    if (targetSymbol && !usesTargetFunction(t.testCode, targetSymbol)) {
      console.log(
        `[Test-File-Writer] ⚠️ REJECTED: Test "${t.name}" — ` +
        `doesn't call the target function '${targetSymbol}'. ` +
        `Generated test must directly invoke the function being tested.`
      );
      return false;
    }

    const qualityCheck = validateTestQuality(t.testCode);
    if (!qualityCheck.valid) {
      console.log(
        `[Test-File-Writer] ⚠️ REJECTED: Test "${t.name}" — ` +
        `${qualityCheck.reason}`
      );
      return false;
    }

    seenTestContent.add(normalized);
    return true;
  });

  const generatedBlock = uniqueTests
    .map((t) => {
      const lines = t.testCode.split("\n");
      const testOnlyLines: string[] = [];
      let i = 0;

      while (i < lines.length) {
        const line = lines[i];
        const trimmed = line?.trim() ?? "";

        if (trimmed.startsWith("vi.mock(")) {
          let depth = 0;
          let bracketDepth = 0;
          let foundEnd = false;

          for (const ch of (line || "")) {
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
            if (ch === "{") bracketDepth++;
            else if (ch === "}") bracketDepth--;
            if (depth === 0 && bracketDepth === 0 && ch === ")") {
              foundEnd = true;
              break;
            }
          }

          while (!foundEnd && i + 1 < lines.length) {
            i++;
            const nextLine = lines[i];
            for (const ch of (nextLine || "")) {
              if (ch === "(") depth++;
              else if (ch === ")") depth--;
              if (ch === "{") bracketDepth++;
              else if (ch === "}") bracketDepth--;
              if (depth === 0 && bracketDepth === 0 && ch === ")") {
                foundEnd = true;
                break;
              }
            }
          }
          i++;
        } else if (trimmed.startsWith("import ")) {
          i++;
        } else if (trimmed.length > 0) {
          testOnlyLines.push(line || "");
          i++;
        } else {
          i++;
        }
      }

      return (
        `\n  // Auto-generated — addresses a coverage gap identified from this commit's diff (${t.name})\n` +
        testOnlyLines.map((line) => `  ${line}`).join("\n")
      );
    })
    .join("\n");

  const rejectedCount = cleanedTests.length - uniqueTests.length;
  if (rejectedCount > 0) {
    console.log(`[Test-File-Writer] ℹ️ REJECTION SUMMARY: ${rejectedCount} test(s) rejected during validation, ${uniqueTests.length} test(s) accepted`);
  }

  if (uniqueTests.length === 0) {
    console.log(`[Test-File-Writer] ⚠️ ALL TESTS REJECTED: No valid tests to write. Skipping merge.`);
    return {
      testFileAbsolute: path.resolve(repositoryRoot, testFile),
      finalContent: "",
      originalContent: null,
    };
  }

  if (isNewFile || !fs.existsSync(testFileAbsolute)) {
    const relativeImport = toRelativeImportSpecifier(
      testFileAbsolute,
      sourceFileAbsolute
    );
    const symbolBase = path
      .basename(sourceFile)
      .replace(/\.(ts|tsx|js|jsx)$/, "");

    console.log(
      `[Test-File-Writer] Creating new test file with import: ${relativeImport} (from ${testFileAbsolute} to ${sourceFileAbsolute})`
    );

    const scaffold =
      topLevelBlock +
      `import * as ${toIdentifier(symbolBase)} from "${relativeImport}";\n\n` +
      `describe("${symbolBase}", () => {${generatedBlock}\n});\n`;

    fs.mkdirSync(path.dirname(testFileAbsolute), { recursive: true });
    fs.writeFileSync(testFileAbsolute, scaffold, "utf8");

    console.log(
      `[Test-File-Writer] Created new test file: ${testFileAbsolute}`
    );

    return { testFileAbsolute, finalContent: scaffold, originalContent: null };
  }

  // Read the existing file, then IMMEDIATELY heal any unsafe prisma-enum
  // mock that may have been merged in during an earlier round. This is
  // what fixes files that are already poisoned on disk, not just newly
  // generated code.
  const originalContentRaw = fs.readFileSync(testFileAbsolute, "utf8");
  const { code: originalContent, rewrittenCount: healedCount } =
    sanitizeProblemPrismaEnumMocks(originalContentRaw);

  if (healedCount > 0) {
    console.log(
      `[Test-File-Writer] ✓ Healed ${healedCount} pre-existing unsafe mock(s) in ${testFileAbsolute} ` +
      `from an earlier merge round — every test in this file was likely failing because of this.`
    );
  }

  let finalContent: string;
  if (topLevelBlock.trim().length > 0 || filteredImports.size > 0 || allMocks.length > 0) {
    const existingImportsRaw = originalContent.match(/^import .+$/gm) || [];
    const existingImports = new Set(
      existingImportsRaw.map((imp) => (imp.trim().endsWith(';') ? imp.trim() : imp.trim() + ';'))
    );

    const newImports = Array.from(filteredImports).filter(
      (imp) => !existingImports.has(imp)
    );

    const newMocks = allMocks.filter((mock) => {
      const sourceMatch = mock.match(/vi\.mock\(\s*['"]([^'"]+)['"]/);
      if (!sourceMatch) return true;
      return !originalContent.includes(`vi.mock('${sourceMatch[1]}'`) &&
             !originalContent.includes(`vi.mock("${sourceMatch[1]}"`);
    });

    const shouldAddMocks = newMocks.length > 0;

    if (newImports.length > 0 || shouldAddMocks) {
      const firstImportIdx = originalContent.search(/^import /m);
      if (firstImportIdx !== -1) {
        const insertAfterIdx = originalContent.indexOf("\n", firstImportIdx);
        let insertedContent = "";
        if (newImports.length > 0) {
          insertedContent += newImports.join("\n") + "\n";
        }
        if (shouldAddMocks) {
          insertedContent += newMocks.join("\n\n") + "\n\n";
        }
        finalContent =
          originalContent.slice(0, insertAfterIdx + 1) +
          insertedContent +
          originalContent.slice(insertAfterIdx + 1);
      } else {
        finalContent =
          newImports.join("\n") +
          (newImports.length > 0 ? "\n\n" : "") +
          newMocks.join("\n\n") +
          (newMocks.length > 0 ? "\n\n" : "") +
          originalContent;
      }
    } else {
      finalContent = originalContent;
    }
  } else {
    finalContent = originalContent;
  }

  const insertionIdxForTests = findOuterBlockInsertionPoint(finalContent);
  if (insertionIdxForTests === -1) {
    finalContent = `${finalContent}\n${generatedBlock}\n`;
  } else {
    finalContent =
      finalContent.slice(0, insertionIdxForTests) +
      "\n" +
      generatedBlock +
      "\n" +
      finalContent.slice(insertionIdxForTests);
  }

  fs.writeFileSync(testFileAbsolute, finalContent, "utf8");

  console.log(
    `[Test-File-Writer] Extended existing test file with ${generatedTests.length} test(s): ${testFileAbsolute}`
  );

  // originalContent returned here is the HEALED version (post-sanitize),
  // not the raw on-disk bytes. That's intentional: if this merge is later
  // reverted, we want revertMerge() to restore the file to a working
  // state, not resurrect the poisoned mock.
  return { testFileAbsolute, finalContent, originalContent };
}

export function revertMerge(result: MergeResult): void {
  if (result.originalContent === null) {
    try {
      fs.unlinkSync(result.testFileAbsolute);
      console.log(
        `[Test-File-Writer] Reverted: deleted newly created ${result.testFileAbsolute}`
      );
    } catch {
      // Already gone — nothing to do.
    }
    return;
  }

  fs.writeFileSync(result.testFileAbsolute, result.originalContent, "utf8");
  console.log(
    `[Test-File-Writer] Reverted: restored original content of ${result.testFileAbsolute}`
  );
}

function findOuterBlockInsertionPoint(content: string): number {
  const describeMatch =
    /\bdescribe\s*\(\s*(['"`]).*?\1\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*{/.exec(
      content
    );

  if (!describeMatch) {
    return -1;
  }

  const openBraceIdx = describeMatch.index + describeMatch[0].length - 1;
  let depth = 0;

  for (let i = openBraceIdx; i < content.length; i++) {
    if (content[i] === "{") {
      depth++;
    } else if (content[i] === "}") {
      depth--;

      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function toRelativeImportSpecifier(
  fromFileAbsolute: string,
  toFileAbsolute: string
): string {
  const fromDir = path.dirname(fromFileAbsolute);

  const normalizedFrom = path.resolve(fromDir);
  const normalizedTo = path.resolve(toFileAbsolute);

  let rel = path
    .relative(normalizedFrom, normalizedTo)
    .replace(/\.(ts|tsx|js|jsx)$/, "");

  rel = rel.replace(/\\/g, "/");

  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }

  return rel;
}

function toIdentifier(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_$]/g, "_");
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}