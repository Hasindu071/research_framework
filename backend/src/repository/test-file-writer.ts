import fs from "fs";
import path from "path";
import type { TestMatch, TestRelationship } from "./test-analyzer.js";
import { buildMissingMockStubs } from "./auto-mock-generator.js";

// ======================================================
// CLEAN GENERATED TEST CODE
// ======================================================

/**
 * If the LLM ignored the "no describe()" instruction and wrapped its own
 * test(s) in a describe(), strip that one outer layer so we don't end up
 * double-nested inside the scaffold's own describe().
 */
function stripOuterDescribeWrapper(code: string): string {
  const trimmed = code.trim();
  
  // Check for describe block at the start
  if (!trimmed.startsWith("describe")) return code;
  
  // Simple approach: find the outermost { and matching }
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
  
  // If we found matching braces and they wrap actual code, extract it
  if (braceStart > 0 && braceEnd > braceStart) {
    const content = trimmed.slice(braceStart, braceEnd).trim();
    if (content.length > 0) {
      return content;
    }
  }
  
  return code;
}

/**
 * Clean generated test code before writing it to disk.
 * - Removes outer describe() wrapper if the LLM added one (defensive strip)
 * - Removes Markdown code fences if Gemini added them
 * - Removes excess indentation from all lines
 * - Moves vi.mock() calls to the top (in case LLM put them elsewhere)
 * - Handles multi-line vi.mock() statements properly
 */
function cleanGeneratedTestCode(code: string): string {
  console.log("[Test-File-Writer] USING FIXED cleanGeneratedTestCode");
  console.log("[Test-File-Writer] Raw testCode from LLM (first 200 chars):");
  console.log(code.substring(0, 200));
  
  let cleaned = code.replace(/\r\n/g, "\n").trim();

  // Strip outer describe() wrapper if present (defensive against LLM ignoring the instruction)
  cleaned = stripOuterDescribeWrapper(cleaned);

  // Remove Markdown code fences if Gemini added them
  cleaned = cleaned.replace(/^```(?:typescript|ts|javascript|js)?\s*/i, "");
  cleaned = cleaned.replace(/\s*```$/i, "");

  // Extract vi.mock and import lines to move to top, handling multi-line mocks
  const lines = cleaned.split("\n");
  const mocks: string[] = [];
  const imports: string[] = [];
  const other: string[] = [];
  
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line?.trim() ?? "";
    
    if (trimmed.startsWith("vi.mock(")) {
      // Extract the full mock statement (may span multiple lines)
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
      
      // Continue reading lines until complete
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
      i++;
    } else if (trimmed.length > 0) {
      other.push(line || "");
      i++;
    } else {
      i++;
    }
  }
  
  // Reassemble with imports FIRST, then mocks, then other code
  // This ensures imports are available before vi.mock() references them
  const reassembled = [...imports, ...mocks, ...other].join("\n");

  // Remove unwanted indentation
  const reassembledLines = reassembled.split("\n");
  const nonEmptyLines = reassembledLines.filter((line) => line.trim().length > 0);
  
  const minIndent =
    nonEmptyLines.length > 0
      ? Math.min(...nonEmptyLines.map((line) => line.match(/^\s*/)?.[0].length ?? 0))
      : 0;

  const result = reassembledLines.map((line) => line.slice(minIndent)).join("\n").trim();
  console.log("[Test-File-Writer] Cleaned testCode (first 200 chars):");
  console.log(result.substring(0, 200));
  return result;
}

// ======================================================
// PICKING THE SINGLE BEST RELATED TEST FILE
// ======================================================

/**
 * Strength of evidence, weakest to strongest — mirrors the ordering
 * documented on TestRelationship in test-analyzer.ts. Higher wins.
 */
const RELATIONSHIP_RANK: Record<TestRelationship, number> = {
  dependency: 0,
  "locale-import": 1,
  "same-directory": 2,
  "same-name": 3,
  import: 4,
  "symbol-usage": 5,
};

export interface TargetTestFileResolution {
  /** Repo-relative path of the test file generated tests should land in. */
  testFile: string;
  /** True if this file doesn't exist yet and needs to be created from scratch. */
  isNewFile: boolean;
  /** The match that justified this choice, if any test file was found at all. */
  match?: TestMatch;
}

/**
 * Given every TestMatch found for one changed source file, pick the single
 * most relevant test file to extend — ranked by relationship strength,
 * ties broken by confidence. If nothing matched at all, fall back to a
 * co-located `<basename>.test.ts`, which the caller will need to create.
 *
 * This replaces "arbitrarily pick whichever candidate test the prioritizer
 * happened to rank first" with a deliberate, evidence-based choice, and it's
 * the single place that decision gets made — callers should not re-derive it.
 */
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

/**
 * Co-located `<basename>.test.ts` or `<basename>.test.tsx` next to the source file — 
 * matching the source file's extension to preserve JSX support.
 * 
 * Rule:
 * - Source .tsx → Test .test.tsx
 * - Source .ts  → Test .test.ts
 * - Source .jsx → Test .test.jsx
 * - Source .js  → Test .test.js
 */
export function inferNewTestFileName(sourceFile: string): string {
  // Extract the base name without extension
  const match = sourceFile.match(/^(.+)\.(ts|tsx|js|jsx)$/);
  if (!match) {
    // Fallback if format doesn't match expected pattern
    return `${sourceFile}.test.ts`;
  }

  const basePath = match[1];
  const sourceExtension = match[2];

  // Preserve the JSX-capable extension
  if (sourceExtension === "tsx" || sourceExtension === "jsx") {
    return `${basePath}.test.${sourceExtension}`;
  }

  // Regular TS/JS gets .ts/.js test file
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
  /**
   * Content of the file before this merge. `null` means the file didn't
   * exist before — i.e. we created it — so "reverting" means deleting it,
   * not restoring old text.
   */
  originalContent: string | null;
}

/**
 * Merge freshly generated `it()`/`test()` blocks into a real test file.
 *
 * - If the file already exists: insert the new blocks just before the
 *   closing brace of the outermost `describe(...)`, so they land alongside
 *   the existing tests rather than in a side file.
 * - If it doesn't exist: scaffold a new file with an import of the source
 *   module and a `describe()` wrapper around the generated tests.
 *
 * `testFileAbsolute` in the result IS the file the project actually uses —
 * this function never writes to a `__generated__/` or `generated_*` copy.
 */
export function mergeGeneratedTests(
  repositoryRoot: string,
  testFile: string,
  isNewFile: boolean,
  sourceFile: string,
  generatedTests: GeneratedTestLike[]
): MergeResult {
  console.log("[Test-File-Writer] MERGE CALLED - isNewFile:", isNewFile, "testFile:", testFile);
  const testFileAbsolute = path.resolve(repositoryRoot, testFile);

  // Clean all generated test code first
  const cleanedTests = generatedTests.map((t) => ({
    ...t,
    testCode: cleanGeneratedTestCode(t.testCode),
  }));

  // Extract all imports and vi.mock() calls from all tests
  const allImports = new Set<string>();
  const allMocks: string[] = [];

  for (const t of cleanedTests) {
    let code = t.testCode;
    
    // Extract complete vi.mock() statements by parsing carefully
    // Look for vi.mock calls anywhere in the code (even if wrongly placed inside it())
    const lines = code.split("\n");
    const mockLines: string[] = [];
    let i = 0;
    
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line?.trim() ?? "";
      
      // Check if this line starts a vi.mock() call
      if (trimmed.startsWith("vi.mock(")) {
        // Extract the full mock statement by tracking parens/braces
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
        
        // If not complete on first line, keep reading
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
        // Extract imports separately
        allImports.add(trimmed);
        i++;
      } else if (trimmed.length > 0 && !trimmed.startsWith("vi.")) {
        // Regular test code — skip here, process later
        i++;
      } else {
        i++;
      }
    }
    
    // Add all extracted mocks
    for (const mock of mockLines) {
      allMocks.push(mock);
    }
  }

  // Safety net: auto-mock any local component import the LLM missed
  try {
    const sourceFileAbsolute = path.resolve(repositoryRoot, sourceFile);
    if (fs.existsSync(sourceFileAbsolute)) {
      const sourceFileContent = fs.readFileSync(sourceFileAbsolute, "utf8");
      const combinedTestCode = cleanedTests.map((t) => t.testCode).join("\n");
      const missingMocks = buildMissingMockStubs(sourceFileContent, combinedTestCode);
      if (missingMocks.length > 0) {
        console.log(
          `[Test-File-Writer] Auto-mocking ${missingMocks.length} local component import(s) the LLM didn't mock`
        );
        allMocks.push(...missingMocks);
      }
    }
  } catch (err) {
    console.log(
      `[Test-File-Writer] Auto-mock safety net skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Build import and mock block at file top
  // Order: imports first, then mocks (vitest requirement)
  let topLevelBlock = "";
  if (allImports.size > 0) {
    topLevelBlock += Array.from(allImports).join("\n") + "\n\n";
  }
  if (allMocks.length > 0) {
    topLevelBlock += allMocks.join("\n\n") + "\n\n";
  }

  // Build indented test block for describe
  const generatedBlock = cleanedTests
    .map((t) => {
      const lines = t.testCode.split("\n");
      const testOnlyLines: string[] = [];
      let i = 0;
      
      while (i < lines.length) {
        const line = lines[i];
        const trimmed = line?.trim() ?? "";
        
        // Skip vi.mock() calls and imports — they go at file top
        if (trimmed.startsWith("vi.mock(")) {
          // Skip the entire mock statement
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
          // Skip imports
          i++;
        } else if (trimmed.length > 0) {
          // Keep test code
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

  if (isNewFile || !fs.existsSync(testFileAbsolute)) {
    const relativeImport = toRelativeImportSpecifier(
      testFileAbsolute,
      path.resolve(repositoryRoot, sourceFile)
    );
    const symbolBase = path
      .basename(sourceFile)
      .replace(/\.(ts|tsx|js|jsx)$/, "");

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

  const originalContent = fs.readFileSync(testFileAbsolute, "utf8");
  const insertionIndex = findOuterBlockInsertionPoint(originalContent);

  // Add imports and mocks at the top of the file if not already present
  let finalContent: string;
  if (topLevelBlock.trim().length > 0) {
    const existingImports = originalContent.match(/^import .+$/gm) || [];
    const existingMockStarts = originalContent.match(/^vi\.mock\(/gm) || [];
    
    const newImports = Array.from(allImports).filter(
      (imp) => !existingImports.some((existing) => existing.trim() === imp)
    );
    
    // Only add mocks if we don't have roughly the same number
    const shouldAddMocks = allMocks.length > 0 && existingMockStarts.length < allMocks.length;
    
    if (newImports.length > 0 || shouldAddMocks) {
      const firstImportIdx = originalContent.search(/^import /m);
      if (firstImportIdx !== -1) {
        // Insert after first import line
        const insertAfterIdx = originalContent.indexOf("\n", firstImportIdx);
        let insertedContent = "";
        if (newImports.length > 0) {
          insertedContent += newImports.join("\n") + "\n";
        }
        if (shouldAddMocks) {
          insertedContent += allMocks.join("\n\n") + "\n\n";
        }
        finalContent =
          originalContent.slice(0, insertAfterIdx + 1) +
          insertedContent +
          originalContent.slice(insertAfterIdx + 1);
      } else {
        // No imports exist, add at the top
        finalContent =
          newImports.join("\n") +
          (newImports.length > 0 ? "\n\n" : "") +
          allMocks.join("\n\n") +
          (allMocks.length > 0 ? "\n\n" : "") +
          originalContent;
      }
    } else {
      finalContent = originalContent;
    }
  } else {
    finalContent = originalContent;
  }

  // Now insert test blocks
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

  return { testFileAbsolute, finalContent, originalContent };
}

/**
 * Undo a merge — restores the file to its pre-merge state (or deletes it,
 * if the merge created it). Used when generated tests don't pass and the
 * caller doesn't want to keep them in the real file.
 */
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

/**
 * Find the index just before the final closing `});` of the outermost
 * describe block, via brace counting (not a single regex) so nested
 * describes/callbacks don't throw off the match. Returns -1 if no
 * top-level describe wrapper is found.
 */
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

function indent(code: string, prefix: string): string {
  return code
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join("\n");
}

function toRelativeImportSpecifier(
  fromFileAbsolute: string,
  toFileAbsolute: string
): string {
  const fromDir = path.dirname(fromFileAbsolute);
  let rel = path
    .relative(fromDir, toFileAbsolute)
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