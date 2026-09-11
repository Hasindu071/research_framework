import fs from "fs";
import path from "path";
import type { TestMatch, TestRelationship } from "./test-analyzer.js";

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
 * Co-located `<basename>.test.ts` next to the source file — the naming
 * convention Rule 1 (same-name) in test-analyzer.ts already recognizes,
 * so a file created here will itself be found as a "same-name" match on
 * the next run.
 */
export function inferNewTestFileName(sourceFile: string): string {
  const parsed = sourceFile.replace(/\.(ts|tsx|js|jsx)$/, "");
  return `${parsed}.test.ts`;
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
  const testFileAbsolute = path.resolve(repositoryRoot, testFile);

  const generatedBlock = generatedTests
    .map(
      (t) =>
        `\n  // Auto-generated — addresses a coverage gap identified from this commit's diff (${t.name})\n${indent(
          t.testCode,
          "  "
        )}`
    )
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
      `import * as ${toIdentifier(symbolBase)} from "${relativeImport}";\n\n` +
      `describe("${symbolBase}", () => {\n${generatedBlock}\n});\n`;

    fs.mkdirSync(path.dirname(testFileAbsolute), { recursive: true });
    fs.writeFileSync(testFileAbsolute, scaffold, "utf8");

    console.log(
      `[Test-File-Writer] Created new test file: ${testFileAbsolute}`
    );

    return { testFileAbsolute, finalContent: scaffold, originalContent: null };
  }

  const originalContent = fs.readFileSync(testFileAbsolute, "utf8");
  const insertionIndex = findOuterBlockInsertionPoint(originalContent);

  const finalContent =
    insertionIndex === -1
      ? // No describe wrapper found — append at end of file rather than
        // guessing where flat it()/test() calls should be interleaved.
        `${originalContent}\n${generatedBlock}\n`
      : `${originalContent.slice(0, insertionIndex)}\n${generatedBlock}\n${originalContent.slice(
          insertionIndex
        )}`;

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