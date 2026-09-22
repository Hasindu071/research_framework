import fs from "fs";
import path from "path";
import type { TestMatch, TestRelationship } from "./test-analyzer.js";
import { validateAndRepairTestCode } from "./test-validator.js";

// ======================================================
// PRISMA IMPORT / MOCK DETECTION
// ======================================================

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
    return {
      style: "default",
      source: defaultMatch[2]!,
      name: defaultMatch[1]!,
    };
  }

  return null;
}

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

    if (!models.has(model)) {
      models.set(model, new Set());
    }

    models.get(model)!.add(method);
  }

  if (models.size === 0) {
    return null;
  }

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
// PRISMA ENUM MOCK SANITIZER
// ======================================================

function sanitizeProblemPrismaEnumMocks(code: string): {
  code: string;
  rewrittenCount: number;
} {
  const ENUM_MODULE_PATTERN =
    /@calcom\/prisma\/enums|@prisma\/client\/enums/;

  let rewrittenCount = 0;

  const lines = code.split("\n");
  const outputLines: string[] = [];

  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (
      trimmed.startsWith("vi.mock(") &&
      ENUM_MODULE_PATTERN.test(trimmed)
    ) {
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

          if (
            depth === 0 &&
            bracketDepth === 0 &&
            ch === ")"
          ) {
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

      const sourceMatch = mockCode.match(
        /vi\.mock\(\s*['"]([^'"]+)['"]/
      );

      const source =
        sourceMatch?.[1] ?? "@calcom/prisma/enums";

      if (usesImportOriginal) {
        outputLines.push(mockCode);
      } else {
        rewrittenCount++;

        console.log(
          `[Test-File-Writer] ⚠️ SANITIZED: Found unsafe full-replacement mock for "${source}".`
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

  return {
    code: outputLines.join("\n"),
    rewrittenCount,
  };
}

export function healPrismaEnumMocksOnDisk(
  testFileAbsolute: string
): boolean {
  if (!fs.existsSync(testFileAbsolute)) {
    return false;
  }

  const raw = fs.readFileSync(testFileAbsolute, "utf8");

  const { code, rewrittenCount } =
    sanitizeProblemPrismaEnumMocks(raw);

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

  if (!trimmed.startsWith("describe")) {
    return code;
  }

  let braceDepth = 0;
  let braceStart = -1;
  let braceEnd = -1;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (char === "{") {
      if (braceDepth === 0) {
        braceStart = i + 1;
      }

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
    const content = trimmed
      .slice(braceStart, braceEnd)
      .trim();

    if (content.length > 0) {
      return content;
    }
  }

  return code;
}

function fixLLMPatternMistakes(
  code: string,
  testFileExtension: string
): string {
  let fixed = code;

  const isJsxCapable =
    /\.(tsx|jsx)$/i.test(testFileExtension);

  if (!isJsxCapable) {
    console.log(
      "[Test-File-Writer] ⚠️ JSX stripping: This is a non-JSX file, removing any JSX syntax..."
    );

    console.log(
      `[Test-File-Writer]    File: ${testFileExtension}`
    );

    let pass1Count = 0;
    let prevFixed = fixed;

    fixed = fixed.replace(
      /=>\s*<[^>]*?(?:>[\s\S]*?<\/[^>]*?>|\/?>)/g,
      "=> null"
    );

    pass1Count = (
      prevFixed.match(
        /=>\s*<[^>]*?(?:>[\s\S]*?<\/[^>]*?>|\/?>)/g
      ) || []
    ).length;

    if (pass1Count > 0) {
      console.log(
        `[Test-File-Writer] ✓ Pass 1: Stripped ${pass1Count} JSX in arrow functions`
      );
    }

    let pass2Count = 0;
    prevFixed = fixed;

    fixed = fixed.replace(
      /return\s+<[^>]*?(?:>[\s\S]*?<\/[^>]*?>|\/?>)/g,
      "return null"
    );

    pass2Count = (
      prevFixed.match(
        /return\s+<[^>]*?(?:>[\s\S]*?<\/[^>]*?>|\/?>)/g
      ) || []
    ).length;

    if (pass2Count > 0) {
      console.log(
        `[Test-File-Writer] ✓ Pass 2: Stripped ${pass2Count} JSX in return statements`
      );
    }

    let pass3Count = 0;
    prevFixed = fixed;

    fixed = fixed.replace(
      /:\s*<[^>]*?(?:>[\s\S]*?<\/[^>]*?>|\/?>)/g,
      ": null"
    );

    pass3Count = (
      prevFixed.match(
        /:\s*<[^>]*?(?:>[\s\S]*?<\/[^>]*?>|\/?>)/g
      ) || []
    ).length;

    if (pass3Count > 0) {
      console.log(
        `[Test-File-Writer] ✓ Pass 3: Stripped ${pass3Count} JSX assigned to object properties`
      );
    }

    let pass4Count = 0;
    prevFixed = fixed;

    fixed = fixed.replace(
      /<>[\s\S]*?<\/>/g,
      "null"
    );

    pass4Count = (
      prevFixed.match(/<>[\s\S]*?<\/>/g) || []
    ).length;

    if (pass4Count > 0) {
      console.log(
        `[Test-File-Writer] ✓ Pass 4: Stripped ${pass4Count} JSX fragments`
      );
    }

    let pass5Count = 0;
    prevFixed = fixed;

    fixed = fixed.replace(
      /<[a-zA-Z][^>]*?(?:>[\s\S]*?<\/[a-zA-Z][^>]*?>|\/?>)/g,
      "null"
    );

    pass5Count = (
      prevFixed.match(
        /<[a-zA-Z][^>]*?(?:>[\s\S]*?<\/[a-zA-Z][^>]*?>|\/?>)/g
      ) || []
    ).length;

    if (pass5Count > 0) {
      console.log(
        `[Test-File-Writer] ✓ Pass 5: Stripped ${pass5Count} remaining JSX/HTML elements`
      );
    }

    let pass6Count = 0;
    prevFixed = fixed;

    const emergencyMatches =
      fixed.match(/<\s*[a-zA-Z/][^}]*?>/g) || [];

    pass6Count = emergencyMatches.length;

    if (pass6Count > 0) {
      console.log(
        `[Test-File-Writer] ⚠️ Pass 6 (Emergency): Found ${pass6Count} potential JSX tags:`,
        emergencyMatches.slice(0, 3)
      );

      fixed = fixed.replace(
        /<\s*[a-zA-Z/][^}]*?>/g,
        "("
      );
    }

    const totalStripped =
      pass1Count +
      pass2Count +
      pass3Count +
      pass4Count +
      pass5Count +
      pass6Count;

    console.log(
      `[Test-File-Writer] ✓ JSX STRIPPING COMPLETE: ${totalStripped} total replacements made`
    );
  } else {
    console.log(
      `[Test-File-Writer] JSX file (.tsx/.jsx) detected - skipping JSX stripping`
    );
  }

  const stubTestRegex =
    /it\s*\(\s*['"`][^'"`]+['"`]\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*{\s*expect\s*\(\s*(?:true|false|1|0|null|undefined|'[^']*'|"[^"]*")\s*\)\s*\.toBe(?:Null|Undefined|NaN|Truthy|Falsy|InstanceOf|Defined|Called|CalledTimes|CalledWith|CalledOnce)?\s*\(\s*(?:true|false|1|0|null|undefined|'[^']*'|"[^"]*")\s*\)\s*;\s*}\s*\);/gm;

  const stubMatches =
    Array.from(fixed.matchAll(stubTestRegex));

  if (stubMatches.length > 0) {
    console.log(
      `[Test-File-Writer] ⚠️ CRITICAL: Detected ${stubMatches.length} stub test(s) that don't test actual function behavior!`
    );

    for (const match of stubMatches) {
      console.log(
        `[Test-File-Writer]    Stub test: ${match[0].substring(
          0,
          100
        )}...`
      );
    }
  }

  if (
    fixed.includes("expect(true).toBe(true)") ||
    fixed.includes("expect(false).toBe(false)") ||
    fixed.includes("expect(null).toBeNull()") ||
    fixed.includes("expect(undefined).toBeUndefined()")
  ) {
    console.log(
      `[Test-File-Writer] ⚠️ CRITICAL: Generated test contains stub assertions!`
    );
  }

  if (fixed.includes("vi.advanceTimersByTimeAsync")) {
    const hasBeforeEachWithFakeTimers =
      /beforeEach\s*\(\s*\(\)\s*=>\s*{\s*vi\.useFakeTimers\(\)/
        .test(fixed);

    if (!hasBeforeEachWithFakeTimers) {
      if (!fixed.includes("vi.useFakeTimers()")) {
        const firstItIndex = fixed.indexOf("it(");

        if (firstItIndex > -1) {
          const lineStart =
            fixed.lastIndexOf("\n", firstItIndex) + 1;

          const indent =
            fixed
              .substring(lineStart, firstItIndex)
              .match(/^\s*/)?.[0] || "";

          const beforeEachCode =
            `beforeEach(() => {\n` +
            `${indent}  vi.useFakeTimers();\n` +
            `${indent}});\n\n` +
            `${indent}`;

          fixed =
            fixed.substring(0, lineStart) +
            beforeEachCode +
            fixed.substring(lineStart);

          console.log(
            "[Test-File-Writer] ✓ Added beforeEach with vi.useFakeTimers() for timer-based tests"
          );
        }
      }
    }
  }

  if (
    fixed.includes("screen.getByText") ||
    fixed.includes("screen.findByText")
  ) {
    if (fixed.includes("render(")) {
      const screenMethods = new Set<string>();

      const screenRegex =
        /screen\.(get|find|query)(By\w+)/g;

      let match;

      while (
        (match = screenRegex.exec(fixed)) !== null
      ) {
        screenMethods.add(
          (match[1] || "") +
            (match[2] || "")
        );
      }

      if (screenMethods.size > 0) {
        fixed = fixed.replace(
          /screen\.(get|find|query)(By\w+)/g,
          "$1$2"
        );

        const methodsList =
          Array.from(screenMethods).join(", ");

        const hasExistingDestructure =
          /const\s+{\s*\w+.*}\s*=\s*render\s*\(/;

        if (!hasExistingDestructure.test(fixed)) {
          fixed = fixed.replace(
            /(\n\s*)render\s*\(/,
            `$1const { ${methodsList} } = render(`
          );
        }

        console.log(
          "[Test-File-Writer] ✓ Fixed screen.getByX pattern"
        );
      }
    }
  }

  const componentDefRegex =
    /function\s+(\w+)\s*\(\s*\)\s*{[\s\S]*?}/g;

  let componentMatch;

  while (
    (componentMatch =
      componentDefRegex.exec(fixed)) !== null
  ) {
    const componentCode =
      componentMatch[0];

    const hookCallRegex =
      /\b(use\w+)\s*\(/g;

    let hookMatch;

    while (
      (hookMatch =
        hookCallRegex.exec(componentCode)) !== null
    ) {
      const hookName = hookMatch[1];

      if (
        !fixed.includes(`const ${hookName}`) &&
        !fixed.includes(`import.*${hookName}`) &&
        !fixed.includes(`function ${hookName}`) &&
        !fixed.match(
          new RegExp(`\\b${hookName}\\s*=`)
        )
      ) {
        console.log(
          `[Test-File-Writer] ⚠️ WARNING: Component uses undefined hook '${hookName}'.`
        );
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

  return stubPatterns.some((pattern) =>
    pattern.test(testCode)
  );
}

function usesTargetFunction(
  testCode: string,
  targetSymbol: string | undefined
): boolean {
  if (!targetSymbol) {
    return true;
  }

  return testCode.includes(targetSymbol);
}

function validateTestQuality(
  testCode: string
): { valid: boolean; reason?: string } {
  if (testCode.includes("expect(true).toBe(true)")) {
    return {
      valid: false,
      reason:
        "Tautological assertion: expect(true).toBe(true)",
    };
  }

  if (testCode.includes("expect(false).toBe(false)")) {
    return {
      valid: false,
      reason:
        "Tautological assertion: expect(false).toBe(false)",
    };
  }

  const assertionMatches =
    testCode.match(/expect\([^)]+\)\.\w+/g) || [];

  const isDefinedMatches =
    testCode.match(
      /expect\([^)]+\)\.toBeDefined\(\)/g
    ) || [];

  if (
    assertionMatches.length === 1 &&
    isDefinedMatches.length === 1
  ) {
    return {
      valid: false,
      reason:
        "Weak assertion: only expects result to be defined",
    };
  }

  if (
    testCode.includes("TODO") ||
    testCode.includes("FIXME") ||
    testCode.includes("placeholder")
  ) {
    return {
      valid: false,
      reason:
        "Placeholder test with TODO/FIXME comments",
    };
  }

  const itMatches =
    testCode.match(
      /it\s*\([^)]+\)\s*,?\s*(?:async\s*)?\(\s*\)\s*=>\s*{([^}]*)}/g
    ) || [];

  for (const match of itMatches) {
    const body =
      match
        .split("{")[1]
        ?.split("}")[0]
        ?.trim();

    if (!body || body.length === 0) {
      return {
        valid: false,
        reason: "Test with empty body",
      };
    }
  }

  if (
    /expect\([^)]*\)\.toHaveBeenCalled\(\)/.test(
      testCode
    ) &&
    assertionMatches.length === 1
  ) {
    return {
      valid: false,
      reason:
        "Weak assertion: only checks if function was called",
    };
  }

  if (!testCode.includes("expect(")) {
    return {
      valid: false,
      reason:
        "No assertions found: test must use expect()",
    };
  }

  return { valid: true };
}

function cleanGeneratedTestCode(
  code: string,
  testFileExtension: string = ".ts"
): string {
  console.log(
    "[Test-File-Writer] USING FIXED cleanGeneratedTestCode"
  );

  let cleaned =
    code.replace(/\r\n/g, "\n").trim();

  cleaned = cleaned.replace(
    /^\s*(?:typescript|ts|javascript|js)\s*\n/i,
    ""
  );

  cleaned = fixLLMPatternMistakes(
    cleaned,
    testFileExtension
  );

  cleaned = fixCommonSyntaxErrors(cleaned);

  cleaned = stripOuterDescribeWrapper(cleaned);

  cleaned = cleaned.replace(
    /^```(?:typescript|ts|javascript|js)?\s*/i,
    ""
  );

  cleaned = cleaned.replace(
    /\s*```$/i,
    ""
  );

  const {
    code: sanitized,
    rewrittenCount,
  } =
    sanitizeProblemPrismaEnumMocks(cleaned);

  cleaned = sanitized;

  if (rewrittenCount > 0) {
    console.log(
      `[Test-File-Writer] ⚠️ Sanitized ${rewrittenCount} unsafe prisma-enum mock(s)`
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

        if (
          depth === 0 &&
          bracketDepth === 0 &&
          ch === ")"
        ) {
          foundEnd = true;
          break;
        }
      }

      while (
        !foundEnd &&
        i + 1 < lines.length
      ) {
        i++;

        const nextLine = lines[i];

        if (nextLine) {
          mockCode += "\n" + nextLine;

          for (const ch of nextLine) {
            if (ch === "(") depth++;
            else if (ch === ")") depth--;

            if (ch === "{") bracketDepth++;
            else if (ch === "}") bracketDepth--;

            if (
              depth === 0 &&
              bracketDepth === 0 &&
              ch === ")"
            ) {
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

      console.log(
        `[Test-File-Writer] ✓ PRESERVING LLM import: ${trimmed}`
      );

      i++;
    } else if (trimmed.length > 0) {
      other.push(line || "");
      i++;
    } else {
      i++;
    }
  }

  const reassembled = [
    ...imports,
    ...mocks,
    ...other,
  ].join("\n");

  const reassembledLines =
    reassembled.split("\n");

  const nonEmptyLines =
    reassembledLines.filter(
      (line) => line.trim().length > 0
    );

  const minIndent =
    nonEmptyLines.length > 0
      ? Math.min(
          ...nonEmptyLines.map(
            (line) =>
              line.match(/^\s*/)?.[0].length ?? 0
          )
        )
      : 0;

  const result =
    reassembledLines
      .map((line) =>
        line.slice(minIndent)
      )
      .join("\n")
      .trim();

  console.log(
    "[Test-File-Writer] Cleaned testCode (first 200 chars):"
  );

  console.log(
    result.substring(0, 200)
  );

  return result;
}

// ======================================================
// PICKING THE SINGLE BEST RELATED TEST FILE
// ======================================================

const RELATIONSHIP_RANK: Record<
  TestRelationship,
  number
> = {
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
    const best = [...matchesForFile].sort(
      (a, b) => {
        const rankDiff =
          RELATIONSHIP_RANK[b.relationship] -
          RELATIONSHIP_RANK[a.relationship];

        if (rankDiff !== 0) {
          return rankDiff;
        }

        return b.confidence - a.confidence;
      }
    )[0]!;

    return {
      testFile: best.testFile,
      isNewFile: false,
      match: best,
    };
  }

  return {
    testFile: inferNewTestFileName(sourceFile),
    isNewFile: true,
  };
}

export function inferNewTestFileName(
  sourceFile: string
): string {
  const match =
    sourceFile.match(
      /^(.+)\.(ts|tsx|js|jsx)$/
    );

  if (!match) {
    return `${sourceFile}.test.ts`;
  }

  const basePath = match[1]!;
  const sourceExtension = match[2]!;

  if (basePath.endsWith(".test")) {
    return sourceFile;
  }

  if (
    sourceExtension === "tsx" ||
    sourceExtension === "jsx"
  ) {
    return `${basePath}.test.${sourceExtension}`;
  }

  return `${basePath}.test.${sourceExtension}`;
}

// ======================================================
// MERGING GENERATED TESTS
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

function existingImportMatches(
  existingContent: string | null,
  importStatement: string
): boolean {
  if (!existingContent) {
    return false;
  }

  const normalize = (value: string) =>
    value
      .replace(/\s+/g, " ")
      .replace(/;\s*$/, "")
      .trim();

  const target =
    normalize(importStatement);

  const existingImports =
    existingContent.match(
      /^\s*import\s+.+?\s+from\s+["'][^"']+["'];?\s*$/gm
    ) || [];

  return existingImports.some(
    (existing) =>
      normalize(existing) === target
  );
}

// ======================================================
// NEW HELPER — CHECK WHETHER ANY IMPORT ALREADY PROVIDES
// THE TARGET SYMBOL
// ======================================================

function importContainsSymbol(
  importStatement: string,
  symbol: string
): boolean {
  const escapedSymbol =
    symbol.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

  // Named import:
  // import { create } from 'zustand';
  // import { atom, create } from 'zustand';
  // import { create as createStore } from 'zustand';
  const namedImportRegex =
    new RegExp(
      `import\\s*\\{[^}]*\\b${escapedSymbol}\\b[^}]*\\}\\s*from`,
      "m"
    );

  if (namedImportRegex.test(importStatement)) {
    return true;
  }

  // Default import:
  // import create from 'module';
  const defaultImportRegex =
    new RegExp(
      `import\\s+${escapedSymbol}\\s+from`,
      "m"
    );

  if (defaultImportRegex.test(importStatement)) {
    return true;
  }

  return false;
}

// ======================================================
// CHECK EXISTING FILE FOR A NAMED SYMBOL IMPORT
// ======================================================

function existingFileHasSymbolImport(
  existingContent: string | null,
  symbol: string
): boolean {
  if (!existingContent) {
    return false;
  }

  const escapedSymbol =
    symbol.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

  const namedImportRegex =
    new RegExp(
      `import\\s*\\{[^}]*\\b${escapedSymbol}\\b[^}]*\\}\\s*from\\s*["'][^"']+["']`,
      "m"
    );

  if (namedImportRegex.test(existingContent)) {
    return true;
  }

  const defaultImportRegex =
    new RegExp(
      `import\\s+${escapedSymbol}\\s+from\\s*["'][^"']+["']`,
      "m"
    );

  return defaultImportRegex.test(
    existingContent
  );
}

export function mergeGeneratedTests(
  repositoryRoot: string,
  testFile: string,
  isNewFile: boolean,
  sourceFile: string,
  generatedTests: GeneratedTestLike[],
  targetSymbol?: string
): MergeResult {
  console.log(
    "[Test-File-Writer] MERGE CALLED - isNewFile:",
    isNewFile,
    "testFile:",
    testFile
  );

  const testFileAbsolute =
    path.resolve(
      repositoryRoot,
      testFile
    );

  // ============================================================
  // 0. Read existing test file
  // ============================================================

  let existingTestContent:
    | string
    | null = null;

  if (
    fs.existsSync(
      testFileAbsolute
    )
  ) {
    try {
      existingTestContent =
        fs.readFileSync(
          testFileAbsolute,
          "utf8"
        );
    } catch {
      existingTestContent = null;
    }
  }

  // ============================================================
  // 1. Clean generated tests
  // ============================================================

  const cleanedTests =
    generatedTests.map((t) => ({
      ...t,
      testCode:
        cleanGeneratedTestCode(
          t.testCode,
          testFile
        ),
    }));

  console.log(
    "[Test-File-Writer] MERGE: Cleaned",
    generatedTests.length,
    "test(s)"
  );

  // ============================================================
  // 1.5 Validate and repair
  // ============================================================

  const validatedTests =
    cleanedTests.map((t) => {
      const testFileAbsoluteForValidation =
        path.isAbsolute(testFile)
          ? testFile
          : path.resolve(
              repositoryRoot,
              testFile
            );

      const validation =
        validateAndRepairTestCode(
          t.testCode,
          testFileAbsoluteForValidation,
          repositoryRoot
        );

      if (
        !validation.valid &&
        validation.errors.length > 0
      ) {
        console.log(
          `[Test-File-Writer] ⚠️ Validation errors found in test: "${t.name}"`
        );

        for (const err of validation.errors) {
          console.log(
            `  Line ${err.line}, Col ${err.column}: ${err.code} - ${err.message}`
          );
        }
      }

      if (
        validation.code !==
        t.testCode
      ) {
        console.log(
          `[Test-File-Writer] ✓ Test code was repaired for: "${t.name}"`
        );
      }

      return {
        ...t,
        testCode: validation.code,
        validationErrors:
          validation.errors,
      };
    });

  // ============================================================
  // 2. Detect Prisma import style
  // ============================================================

  const sourceFileAbsolute =
    path.isAbsolute(sourceFile)
      ? sourceFile
      : path.resolve(
          repositoryRoot,
          sourceFile
        );

  let sourceFileContent:
    | string
    | null = null;

  if (
    fs.existsSync(
      sourceFileAbsolute
    )
  ) {
    try {
      sourceFileContent =
        fs.readFileSync(
          sourceFileAbsolute,
          "utf8"
        );
    } catch {
      sourceFileContent = null;
    }
  }

  const prismaImportStyle =
    sourceFileContent
      ? detectPrismaImportStyleFromSource(
          sourceFileContent
        )
      : null;

  // ============================================================
  // 3. Initialize imports and mocks
  // ============================================================

  const allImports =
    new Set<string>();

  const allMocks: string[] = [];

  // ============================================================
  // 4. Extract imports and mocks
  // ============================================================

  for (const t of validatedTests) {
    const lines =
      t.testCode.split("\n");

    const mockLines: string[] = [];

    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      const trimmed =
        line?.trim() ?? "";

      if (
        trimmed.startsWith(
          "vi.mock("
        )
      ) {
        let mockCode =
          line || "";

        let depth = 0;
        let bracketDepth = 0;
        let foundEnd = false;

        for (const ch of mockCode) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;

          if (ch === "{") bracketDepth++;
          else if (ch === "}") bracketDepth--;

          if (
            depth === 0 &&
            bracketDepth === 0 &&
            ch === ")"
          ) {
            foundEnd = true;
            break;
          }
        }

        while (
          !foundEnd &&
          i + 1 < lines.length
        ) {
          i++;

          const nextLine =
            lines[i];

          if (nextLine) {
            mockCode +=
              "\n" + nextLine;

            for (const ch of nextLine) {
              if (ch === "(") depth++;
              else if (ch === ")") depth--;

              if (ch === "{") bracketDepth++;
              else if (ch === "}") bracketDepth--;

              if (
                depth === 0 &&
                bracketDepth === 0 &&
                ch === ")"
              ) {
                foundEnd = true;
                break;
              }
            }
          }
        }

        mockLines.push(
          mockCode
        );

        i++;
      } else if (
        trimmed.startsWith(
          "import "
        )
      ) {
        const normalizedImport =
          trimmed.endsWith(";")
            ? trimmed
            : trimmed + ";";

        allImports.add(
          normalizedImport
        );

        i++;
      } else {
        i++;
      }
    }

    for (const mock of mockLines) {
      allMocks.push(mock);
    }
  }

  // ============================================================
  // 5. Sanitize Prisma enum mocks
  // ============================================================

  for (
    let m = 0;
    m < allMocks.length;
    m++
  ) {
    const {
      code: sanitized,
      rewrittenCount,
    } =
      sanitizeProblemPrismaEnumMocks(
        allMocks[m]!
      );

    if (rewrittenCount > 0) {
      allMocks[m] =
        sanitized;

      console.log(
        `[Test-File-Writer] ✓ Sanitized Prisma enum mock`
      );
    }
  }

  // ============================================================
  // 6. Filter framework imports
  // ============================================================

  const TEST_FRAMEWORK_IMPORTS =
    new Set([
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

  const filteredImports =
    new Set<string>();

  for (const imp of allImports) {
    if (
      TEST_FRAMEWORK_IMPORTS.has(
        imp
      )
    ) {
      console.log(
        `[Test-File-Writer] ⚠️ Filtered framework import: ${imp}`
      );
    } else {
      filteredImports.add(
        imp
      );
    }
  }

  // ============================================================
  // 7. Auto-detect missing imports
  // ============================================================

  try {
    for (const t of cleanedTests) {
      const code =
        t.testCode;

      const symbolImportMap =
        new Map<string, string>([
          [
            "React",
            "import React from 'react';",
          ],
          [
            "StrictMode",
            "import { StrictMode } from 'react';",
          ],
          [
            "useState",
            "import { useState } from 'react';",
          ],
          [
            "useEffect",
            "import { useEffect } from 'react';",
          ],
          [
            "useContext",
            "import { useContext } from 'react';",
          ],
          [
            "useCallback",
            "import { useCallback } from 'react';",
          ],
          [
            "useMemo",
            "import { useMemo } from 'react';",
          ],

          // Zustand
          [
            "create",
            "import { create } from 'zustand';",
          ],
          [
            "createWithEqualityFn",
            "import { createWithEqualityFn } from 'zustand/traditional';",
          ],
          [
            "persist",
            "import { persist } from 'zustand/middleware';",
          ],
          [
            "createJSONStorage",
            "import { createJSONStorage } from 'zustand/middleware';",
          ],
          [
            "devtools",
            "import { devtools } from 'zustand/middleware';",
          ],
          [
            "subscribeWithSelector",
            "import { subscribeWithSelector } from 'zustand/middleware';",
          ],
          [
            "combine",
            "import { combine } from 'zustand/middleware';",
          ],

          // Testing library
          [
            "render",
            "import { render } from '@testing-library/react';",
          ],
          [
            "screen",
            "import { screen } from '@testing-library/react';",
          ],
          [
            "act",
            "import { act } from '@testing-library/react';",
          ],
          [
            "cleanup",
            "import { cleanup } from '@testing-library/react';",
          ],
          [
            "waitFor",
            "import { waitFor } from '@testing-library/react';",
          ],
          [
            "fireEvent",
            "import { fireEvent } from '@testing-library/react';",
          ],
          [
            "within",
            "import { within } from '@testing-library/react';",
          ],
          [
            "userEvent",
            "import userEvent from '@testing-library/user-event';",
          ],
          [
            "sleep",
            "import { sleep } from './test-utils';",
          ],
        ]);

      for (
        const [
          symbol,
          importStatement,
        ] of symbolImportMap
      ) {
        const symbolPatterns = [
          new RegExp(
            `\\b${symbol}\\s*\\(`
          ),
          new RegExp(
            `\\b${symbol}\\s*\\)`
          ),
          new RegExp(
            `\\b${symbol}\\s*,`
          ),
          new RegExp(
            `\\b${symbol}\\s*;`
          ),
          new RegExp(
            `\\s${symbol}\\b`
          ),
          new RegExp(
            `\\b${symbol}$`,
            "m"
          ),
          new RegExp(
            `\\b${symbol}\\.`
          ),
          new RegExp(
            `\\(${symbol}`
          ),
          new RegExp(
            `\\[${symbol}`
          ),
          new RegExp(
            `${symbol}\\]`
          ),
          new RegExp(
            `${symbol}\\}`
          ),
          new RegExp(
            `\\{\\s*${symbol}`
          ),
        ];

        const isUsed =
          symbolPatterns.some(
            (pattern) =>
              pattern.test(code)
          );

        if (!isUsed) {
          continue;
        }

        // ====================================================
        // IMPORTANT FIX:
        // Check both existing file AND generated imports.
        // ====================================================

        const alreadyImportedInGenerated =
          Array.from(
            filteredImports
          ).some((imp) =>
            importContainsSymbol(
              imp,
              symbol
            )
          );

        const alreadyImportedInExistingFile =
          existingFileHasSymbolImport(
            existingTestContent,
            symbol
          );

        if (
          !alreadyImportedInGenerated &&
          !alreadyImportedInExistingFile
        ) {
          filteredImports.add(
            importStatement
          );

          console.log(
            `[Test-File-Writer] ✓ Auto-added missing import for ${symbol}`
          );
        } else {
          console.log(
            `[Test-File-Writer] ✓ Import already exists for ${symbol} — skipping duplicate`
          );
        }
      }

      // ========================================================
      // Prisma-specific import
      // ========================================================

      const referencesPrisma =
        /\bprisma\s*\./.test(
          code
        );

      const alreadyHasPrismaImport =
        Array.from(
          filteredImports
        ).some((imp) =>
          /@calcom\/prisma|@prisma\/client/.test(
            imp
          )
        ) ||
        (!!existingTestContent &&
          /@calcom\/prisma|@prisma\/client/.test(
            existingTestContent
          ));

      if (
        referencesPrisma &&
        !alreadyHasPrismaImport
      ) {
        if (prismaImportStyle) {
          const stmt =
            prismaImportStyle.style ===
            "default"
              ? `import ${prismaImportStyle.name} from '${prismaImportStyle.source}';`
              : `import { ${prismaImportStyle.name} } from '${prismaImportStyle.source}';`;

          filteredImports.add(
            stmt
          );
        } else {
          filteredImports.add(
            "import { prisma } from '@calcom/prisma';"
          );
        }
      }

      // ========================================================
      // Detect function calls
      // ========================================================

      const functionCallRegex =
        /\b(\w+)\s*\(/g;

      let funcMatch;

      const localFunctionsAndImports =
        new Set<string>();

      for (
        const importStmt of filteredImports
      ) {
        const importMatch =
          importStmt.match(
            /(?:import|from)\s+(?:\{([^}]+)\}|(\w+))/
          );

        if (importMatch) {
          const imported =
            importMatch[1] ||
            importMatch[2];

          if (imported) {
            imported
              .split(",")
              .forEach((name) => {
                localFunctionsAndImports.add(
                  name
                    .trim()
                    .split(" as ")[0]
                    ?.trim() || ""
                );
              });
          }
        }
      }

      while (
        (funcMatch =
          functionCallRegex.exec(
            code
          )) !== null
      ) {
        const funcName =
          funcMatch[1];

        if (
          funcName &&
          !localFunctionsAndImports.has(
            funcName
          )
        ) {
          if (
            symbolImportMap.has(
              funcName
            )
          ) {
            const importStatement =
              symbolImportMap.get(
                funcName
              );

            if (
              importStatement &&
              !Array.from(
                filteredImports
              ).some((imp) =>
                importContainsSymbol(
                  imp,
                  funcName
                )
              ) &&
              !existingFileHasSymbolImport(
                existingTestContent,
                funcName
              )
            ) {
              filteredImports.add(
                importStatement
              );

              console.log(
                `[Test-File-Writer] ✓ Auto-added missing import for function ${funcName}`
              );
            }
          }
        }
      }
    }
  } catch (err) {
    console.log(
      `[Test-File-Writer] Auto-import safety net skipped: ${
        err instanceof Error
          ? err.message
          : String(err)
      }`
    );
  }

  // ============================================================
  // 7b. IMPORT DEDUP HELPERS
  // ============================================================

  const normalizeImportStatement = (
    importStatement: string
  ): string => {
    return importStatement
      .replace(/\s+/g, " ")
      .replace(/;\s*$/, "")
      .trim();
  };

  const existingSymbolImportMatches = (
    existingContent: string | null,
    symbol: string,
    modulePath: string
  ): boolean => {
    if (!existingContent) {
      return false;
    }

    const normalizedModulePath =
      modulePath
        .replace(/\\/g, "/")
        .replace(/["']/g, "")
        .replace(/;$/, "")
        .trim();

    const importRegex =
      /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']\s*;?/g;

    let match: RegExpExecArray | null;

    while (
      (match =
        importRegex.exec(
          existingContent
        )) !== null
    ) {
      const importClause =
        match[1]!.trim();

      const importedModule =
        match[2]!
          .replace(/\\/g, "/")
          .trim();

      if (
        importedModule !==
          normalizedModulePath &&
        !importedModule.endsWith(
          normalizedModulePath
        ) &&
        !normalizedModulePath.endsWith(
          importedModule
        )
      ) {
        continue;
      }

      const namedMatch =
        importClause.match(
          /\{([\s\S]*?)\}/
        );

      if (namedMatch) {
        const names =
          namedMatch[1]!
            .split(",")
            .map((name) => {
              const parts =
                name
                  .trim()
                  .split(
                    /\s+as\s+/
                  );

              return parts[
                parts.length - 1
              ]!.trim();
            })
            .filter(Boolean);

        if (
          names.includes(symbol)
        ) {
          return true;
        }
      }

      const defaultMatch =
        importClause.match(
          /^([A-Za-z_$][\w$]*)/
        );

      if (
        defaultMatch &&
        defaultMatch[1] === symbol
      ) {
        return true;
      }
    }

    return false;
  };

  // ============================================================
  // 8. ADD TARGET FUNCTION IMPORT
  // ============================================================

  let relativeImportPath = "";

  if (
    targetSymbol &&
    sourceFile
  ) {
    const testDir =
      path.dirname(testFile);

    const sourceDir =
      path.dirname(sourceFile);

    const sourceBaseName =
      path.basename(
        sourceFile,
        path.extname(
          sourceFile
        )
      );

    if (
      testDir === sourceDir
    ) {
      relativeImportPath =
        `./${sourceBaseName}`;
    } else {
      const relativePath =
        path.relative(
          testDir,
          sourceDir
        );

      relativeImportPath =
        path
          .join(
            relativePath,
            sourceBaseName
          )
          .replace(
            /\\/g,
            "/"
          );

      if (
        !relativeImportPath.startsWith(
          "."
        )
      ) {
        relativeImportPath =
          `./${relativeImportPath}`;
      }
    }

    const targetImportStatement =
      `import { ${targetSymbol} } from '${relativeImportPath}';`;

    // ========================================================
    // IMPORTANT FIX
    //
    // Previously this only checked existingTestContent.
    // For a NEW file, existingTestContent is null.
    //
    // Now we check:
    // 1. Existing test file
    // 2. Generated imports already collected in filteredImports
    // ========================================================

    const symbolAlreadyImportedInExistingFile =
      existingFileHasSymbolImport(
        existingTestContent,
        targetSymbol
      );

    const symbolAlreadyImportedInGeneratedImports =
      Array.from(
        filteredImports
      ).some((imp) =>
        importContainsSymbol(
          imp,
          targetSymbol
        )
      );

    const targetImportAlreadyInGeneratedImports =
      Array.from(
        filteredImports
      ).some(
        (imp) =>
          normalizeImportStatement(
            imp
          ) ===
          normalizeImportStatement(
            targetImportStatement
          )
      );

    if (
      symbolAlreadyImportedInExistingFile
    ) {
      console.log(
        `[Test-File-Writer] ✓ Target symbol already imported in existing test file: ${targetSymbol}`
      );
    } else if (
      symbolAlreadyImportedInGeneratedImports
    ) {
      console.log(
        `[Test-File-Writer] ✓ Target symbol already imported in generated imports — skipping duplicate: ${targetSymbol}`
      );
    } else if (
      !targetImportAlreadyInGeneratedImports
    ) {
      filteredImports.add(
        targetImportStatement
      );

      console.log(
        `[Test-File-Writer] ✓ Added target function import: ${targetImportStatement}`
      );
    } else {
      console.log(
        `[Test-File-Writer] ✓ Target function import already exists: ${targetSymbol}`
      );
    }
  }

  // ============================================================
  // 9. GENERIC PRISMA AUTO-MOCK
  // ============================================================

  if (prismaImportStyle) {
    const hasPrismaMock =
      allMocks.some((m) =>
        m.includes(
          prismaImportStyle.source
        )
      );

    if (!hasPrismaMock) {
      const combinedTestCode =
        cleanedTests
          .map(
            (t) => t.testCode
          )
          .join("\n");

      const genericMock =
        buildGenericPrismaMock(
          combinedTestCode,
          prismaImportStyle.style,
          prismaImportStyle.source
        );

      if (genericMock) {
        allMocks.push(
          genericMock
        );

        console.log(
          `[Test-File-Writer] ✓ Injected generic Prisma auto-mock`
        );
      }
    }
  }

  // ============================================================
  // 10. BUILD TOP LEVEL BLOCK
  // ============================================================

  let topLevelBlock = "";

  if (
    filteredImports.size > 0
  ) {
    topLevelBlock +=
      Array.from(
        filteredImports
      ).join("\n") +
      "\n\n";
  }

  if (
    allMocks.length > 0
  ) {
    topLevelBlock +=
      allMocks.join(
        "\n\n"
      ) +
      "\n\n";
  }

  // ============================================================
  // 11. DEDUPLICATE AND VALIDATE TESTS
  // ============================================================

  const seenTestContent =
    new Set<string>();

  const uniqueTests =
    cleanedTests.filter(
      (t) => {
        const normalized =
          t.testCode
            .replace(
              /\s+/g,
              " "
            )
            .trim();

        if (
          seenTestContent.has(
            normalized
          )
        ) {
          console.log(
            `[Test-File-Writer] ⚠️ DEDUP: Skipping duplicate test "${t.name}"`
          );

          return false;
        }

        if (
          isStubTest(
            t.testCode
          )
        ) {
          console.log(
            `[Test-File-Writer] ⚠️ REJECTED: Stub test "${t.name}"`
          );

          return false;
        }

        if (
          targetSymbol &&
          !usesTargetFunction(
            t.testCode,
            targetSymbol
          )
        ) {
          console.log(
            `[Test-File-Writer] ⚠️ REJECTED: Test "${t.name}" doesn't call target "${targetSymbol}"`
          );

          return false;
        }

        const qualityCheck =
          validateTestQuality(
            t.testCode
          );

        if (
          !qualityCheck.valid
        ) {
          console.log(
            `[Test-File-Writer] ⚠️ REJECTED: Test "${t.name}" — ${qualityCheck.reason}`
          );

          return false;
        }

        seenTestContent.add(
          normalized
        );

        return true;
      }
    );

  // ============================================================
  // 12. BUILD TEST BODY
  // ============================================================

  const generatedBlock =
    uniqueTests
      .map((t) => {
        const lines =
          t.testCode.split(
            "\n"
          );

        const testOnlyLines: string[] =
          [];

        let i = 0;

        while (
          i < lines.length
        ) {
          const line =
            lines[i];

          const trimmed =
            line?.trim() ?? "";

          if (
            trimmed.startsWith(
              "vi.mock("
            )
          ) {
            let depth = 0;
            let bracketDepth = 0;
            let foundEnd = false;

            for (const ch of line || "") {
              if (ch === "(")
                depth++;
              else if (ch === ")")
                depth--;

              if (ch === "{")
                bracketDepth++;
              else if (ch === "}")
                bracketDepth--;

              if (
                depth === 0 &&
                bracketDepth === 0 &&
                ch === ")"
              ) {
                foundEnd = true;
                break;
              }
            }

            while (
              !foundEnd &&
              i + 1 <
                lines.length
            ) {
              i++;

              const nextLine =
                lines[i];

              for (
                const ch of
                  nextLine || ""
              ) {
                if (ch === "(")
                  depth++;
                else if (
                  ch === ")"
                )
                  depth--;

                if (ch === "{")
                  bracketDepth++;
                else if (
                  ch === "}"
                )
                  bracketDepth--;

                if (
                  depth === 0 &&
                  bracketDepth ===
                    0 &&
                  ch === ")"
                ) {
                  foundEnd = true;
                  break;
                }
              }
            }

            i++;
          } else if (
            trimmed.startsWith(
              "import "
            )
          ) {
            i++;
          } else if (
            trimmed.length > 0
          ) {
            testOnlyLines.push(
              line || ""
            );

            i++;
          } else {
            i++;
          }
        }

        return (
          `\n  // Auto-generated — addresses a coverage gap identified from this commit's diff (${t.name})\n` +
          testOnlyLines
            .map(
              (line) =>
                `  ${line}`
            )
            .join("\n")
        );
      })
      .join("\n");

  // ============================================================
  // 13. VALIDATION SUMMARY
  // ============================================================

  const rejectedCount =
    cleanedTests.length -
    uniqueTests.length;

  if (
    rejectedCount > 0
  ) {
    console.log(
      `[Test-File-Writer] ℹ️ REJECTION SUMMARY: ${rejectedCount} rejected, ${uniqueTests.length} accepted`
    );
  }

  // ============================================================
  // 14. NO VALID TESTS
  // ============================================================

  if (
    uniqueTests.length === 0
  ) {
    console.log(
      `[Test-File-Writer] ⚠️ ALL TESTS REJECTED`
    );

    return {
      testFileAbsolute:
        path.resolve(
          repositoryRoot,
          testFile
        ),
      finalContent: "",
      originalContent:
        null,
    };
  }

  // ============================================================
  // 15. CREATE NEW FILE
  // ============================================================

  if (
    isNewFile ||
    !fs.existsSync(
      testFileAbsolute
    )
  ) {
    const relativeImport =
      toRelativeImportSpecifier(
        testFileAbsolute,
        sourceFileAbsolute
      );

    const symbolBase =
      path
        .basename(
          sourceFile
        )
        .replace(
          /\.(ts|tsx|js|jsx)$/,
          ""
        );

    console.log(
      `[Test-File-Writer] ✓ Creating new test file with import: ${relativeImport}`
    );

    const scaffold =
      topLevelBlock +
      `import * as ${toIdentifier(
        symbolBase
      )} from "${relativeImport}";\n\n` +
      `describe("${symbolBase}", () => {${generatedBlock}\n});\n`;

    fs.mkdirSync(
      path.dirname(
        testFileAbsolute
      ),
      {
        recursive: true,
      }
    );

    fs.writeFileSync(
      testFileAbsolute,
      scaffold,
      "utf8"
    );

    console.log(
      `[Test-File-Writer] ✓ Successfully created new test file: ${testFileAbsolute}`
    );

    return {
      testFileAbsolute,
      finalContent:
        scaffold,
      originalContent:
        null,
    };
  }

  // ============================================================
  // 16. EXISTING FILE
  // ============================================================

  const originalContentRaw =
    fs.readFileSync(
      testFileAbsolute,
      "utf8"
    );

  const {
    code: originalContent,
    rewrittenCount: healedCount,
  } =
    sanitizeProblemPrismaEnumMocks(
      originalContentRaw
    );

  if (
    healedCount > 0
  ) {
    console.log(
      `[Test-File-Writer] ✓ Healed ${healedCount} pre-existing unsafe mock(s)`
    );
  }

  // ============================================================
  // 17. MERGE IMPORTS
  // ============================================================

  let finalContent: string;

  if (
    topLevelBlock.trim()
      .length > 0 ||
    filteredImports.size >
      0 ||
    allMocks.length > 0
  ) {
    const existingImportsRaw =
      originalContent.match(
        /^import .+$/gm
      ) || [];

    const existingImports =
      new Set(
        existingImportsRaw.map(
          (imp) =>
            imp
              .trim()
              .endsWith(";")
              ? imp.trim()
              : imp.trim() + ";"
        )
      );

    const newImports =
      Array.from(
        filteredImports
      ).filter((imp) => {
        if (
          existingImports.has(
            imp
          )
        ) {
          return false;
        }

        // IMPORTANT:
        // If the existing file already imports
        // the target symbol from ANY module,
        // do not add another target import.

        if (
          targetSymbol &&
          existingFileHasSymbolImport(
            originalContent,
            targetSymbol
          )
        ) {
          return false;
        }

        if (
          targetSymbol &&
          existingSymbolImportMatches(
            originalContent,
            targetSymbol,
            relativeImportPath
          )
        ) {
          return false;
        }

        return true;
      });

    const newMocks =
      allMocks.filter(
        (mock) => {
          const sourceMatch =
            mock.match(
              /vi\.mock\(\s*['"]([^'"]+)['"]/
            );

          if (!sourceMatch) {
            return true;
          }

          const source =
            sourceMatch[1];

          return (
            !originalContent.includes(
              `vi.mock('${source}'`
            ) &&
            !originalContent.includes(
              `vi.mock("${source}"`
            )
          );
        }
      );

    const shouldAddMocks =
      newMocks.length > 0;

    if (
      newImports.length > 0 ||
      shouldAddMocks
    ) {
      const firstImportIdx =
        originalContent.search(
          /^import /m
        );

      if (
        firstImportIdx !== -1
      ) {
        const insertAfterIdx =
          originalContent.indexOf(
            "\n",
            firstImportIdx
          );

        let insertedContent =
          "";

        if (
          newImports.length > 0
        ) {
          insertedContent +=
            newImports.join(
              "\n"
            ) + "\n";
        }

        if (
          shouldAddMocks
        ) {
          insertedContent +=
            newMocks.join(
              "\n\n"
            ) + "\n\n";
        }

        finalContent =
          originalContent.slice(
            0,
            insertAfterIdx + 1
          ) +
          insertedContent +
          originalContent.slice(
            insertAfterIdx + 1
          );
      } else {
        finalContent =
          newImports.join(
            "\n"
          ) +
          (newImports.length > 0
            ? "\n\n"
            : "") +
          newMocks.join(
            "\n\n"
          ) +
          (newMocks.length > 0
            ? "\n\n"
            : "") +
          originalContent;
      }
    } else {
      finalContent =
        originalContent;
    }
  } else {
    finalContent =
      originalContent;
  }

  // ============================================================
  // 18. APPEND GENERATED TESTS
  // ============================================================

  const insertionIdxForTests =
    findOuterBlockInsertionPoint(
      finalContent
    );

  if (
    insertionIdxForTests ===
    -1
  ) {
    finalContent =
      `${finalContent}\n${generatedBlock}\n`;
  } else {
    finalContent =
      finalContent.slice(
        0,
        insertionIdxForTests
      ) +
      "\n" +
      generatedBlock +
      "\n" +
      finalContent.slice(
        insertionIdxForTests
      );
  }

  // ============================================================
  // 19. WRITE FILE
  // ============================================================

  fs.writeFileSync(
    testFileAbsolute,
    finalContent,
    "utf8"
  );

  console.log(
    `[Test-File-Writer] ✓ Successfully merged generated tests into ${testFileAbsolute}`
  );

  console.log(
    `[Test-File-Writer] ✓ Added ${uniqueTests.length} test(s) from ${generatedTests.length} generated test(s)`
  );

  return {
    testFileAbsolute,
    finalContent,
    originalContent,
  };
}

// ======================================================
// REVERT MERGE
// ======================================================

export function revertMerge(
  result: MergeResult
): void {
  if (
    result.originalContent ===
    null
  ) {
    try {
      fs.unlinkSync(
        result.testFileAbsolute
      );

      console.log(
        `[Test-File-Writer] Reverted: deleted newly created ${result.testFileAbsolute}`
      );
    } catch {
      // Already deleted.
    }

    return;
  }

  fs.writeFileSync(
    result.testFileAbsolute,
    result.originalContent,
    "utf8"
  );

  console.log(
    `[Test-File-Writer] Reverted: restored original content of ${result.testFileAbsolute}`
  );
}

// ======================================================
// FIND OUTER DESCRIBE INSERTION POINT
// ======================================================

function findOuterBlockInsertionPoint(
  content: string
): number {
  const describeMatch =
    /\bdescribe\s*\(\s*(['"`]).*?\1\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*{/.exec(
      content
    );

  if (!describeMatch) {
    return -1;
  }

  const openBraceIdx =
    describeMatch.index +
    describeMatch[0].length -
    1;

  let depth = 0;

  for (
    let i = openBraceIdx;
    i < content.length;
    i++
  ) {
    if (
      content[i] === "{"
    ) {
      depth++;
    } else if (
      content[i] === "}"
    ) {
      depth--;

      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

// ======================================================
// RELATIVE IMPORT
// ======================================================

function toRelativeImportSpecifier(
  fromFileAbsolute: string,
  toFileAbsolute: string
): string {
  const fromDir =
    path.dirname(
      fromFileAbsolute
    );

  const normalizedFrom =
    path.resolve(fromDir);

  const normalizedTo =
    path.resolve(
      toFileAbsolute
    );

  let rel =
    path
      .relative(
        normalizedFrom,
        normalizedTo
      )
      .replace(
        /\.(ts|tsx|js|jsx)$/,
        ""
      );

  rel =
    rel.replace(
      /\\/g,
      "/"
    );

  if (
    !rel.startsWith(".")
  ) {
    rel = `./${rel}`;
  }

  return rel;
}

// ======================================================
// IDENTIFIER
// ======================================================

function toIdentifier(
  name: string
): string {
  const cleaned =
    name.replace(
      /[^a-zA-Z0-9_$]/g,
      "_"
    );

  return /^[0-9]/.test(
    cleaned
  )
    ? `_${cleaned}`
    : cleaned;
}