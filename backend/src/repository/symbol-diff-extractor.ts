import { Project } from "ts-morph";
import path from "path";

/**
 * Given a repository root, file path, and symbol name, find the symbol's
 * declaration range in the correct repository.
 *
 * IMPORTANT:
 * sourceFilePath is normally a repository-relative path such as:
 *
 *   src/react/devtools/useAtomsDevtools.ts
 *
 * repositoryRoot is the repository supplied through the API/Postman:
 *
 *   D:\MY 4th yr Research\jotai\jotai
 *
 * The two are combined to get the real absolute source file path.
 */

interface SymbolRange {
  startLine: number;
  endLine: number;
  name: string;
}

/**
 * Find a symbol's DECLARATION line range in a source file using AST analysis.
 *
 * Returns { startLine, endLine } (1-indexed, inclusive).
 *
 * IMPORTANT:
 * This finds the DECLARATION, not just any identifier reference.
 */
export function findSymbolRange(
  repositoryRoot: string,
  sourceFilePath: string,
  symbolName: string
): SymbolRange | null {
  try {
    // ------------------------------------------------------------
    // IMPORTANT:
    // Resolve the source file relative to the repository being
    // analyzed, NOT relative to the framework/backend directory.
    // ------------------------------------------------------------

    const absoluteSourceFilePath = path.resolve(
      repositoryRoot,
      sourceFilePath
    );

    console.log(
      `[SymbolDiffExtractor] Repository root: ${repositoryRoot}`
    );

    console.log(
      `[SymbolDiffExtractor] Resolving source file: ${sourceFilePath}`
    );

    console.log(
      `[SymbolDiffExtractor] Absolute source file: ${absoluteSourceFilePath}`
    );

    const project = new Project();

    const sourceFile = project.addSourceFileAtPath(
      absoluteSourceFilePath
    );

    // ------------------------------------------------------------
    // 1. Function declaration
    // ------------------------------------------------------------

    const functionDecl = sourceFile.getFunction(symbolName);

    if (functionDecl) {
      const startLine = functionDecl.getStartLineNumber();
      const endLine = functionDecl.getEndLineNumber();

      console.log(
        `[SymbolDiffExtractor] Found function declaration "${symbolName}" at lines ${startLine}–${endLine}`
      );

      return {
        startLine,
        endLine,
        name: symbolName,
      };
    }

    // ------------------------------------------------------------
    // 2. Class declaration
    // ------------------------------------------------------------

    const classDecl = sourceFile.getClass(symbolName);

    if (classDecl) {
      const startLine = classDecl.getStartLineNumber();
      const endLine = classDecl.getEndLineNumber();

      console.log(
        `[SymbolDiffExtractor] Found class declaration "${symbolName}" at lines ${startLine}–${endLine}`
      );

      return {
        startLine,
        endLine,
        name: symbolName,
      };
    }

    // ------------------------------------------------------------
    // 3. Variable declaration
    // ------------------------------------------------------------

    const variables = sourceFile.getVariableDeclarations();

    const varDecl = variables.find(
      (v) => v.getName() === symbolName
    );

    if (varDecl) {
      const statement = varDecl.getVariableStatement();

      if (statement) {
        const startLine = statement.getStartLineNumber();
        const endLine = statement.getEndLineNumber();

        console.log(
          `[SymbolDiffExtractor] Found variable declaration "${symbolName}" at lines ${startLine}–${endLine}`
        );

        return {
          startLine,
          endLine,
          name: symbolName,
        };
      }
    }

    // ------------------------------------------------------------
    // 4. Exported declaration
    // ------------------------------------------------------------

    const exportedDecl = sourceFile
      .getExportedDeclarations()
      .get(symbolName)?.[0];

    if (exportedDecl) {
      const startLine = exportedDecl.getStartLineNumber();
      const endLine = exportedDecl.getEndLineNumber();

      console.log(
        `[SymbolDiffExtractor] Found exported declaration "${symbolName}" at lines ${startLine}–${endLine}`
      );

      return {
        startLine,
        endLine,
        name: symbolName,
      };
    }

    console.warn(
      `[SymbolDiffExtractor] Symbol "${symbolName}" declaration not found in "${absoluteSourceFilePath}"`
    );

    return null;
  } catch (error) {
    console.error(
      `[SymbolDiffExtractor] Error analyzing "${symbolName}": ${
        error instanceof Error ? error.message : String(error)
      }`
    );

    return null;
  }
}

/**
 * Given a unified diff and a symbol's line range, extract only the diff
 * hunks that overlap with that symbol in the NEW version of the file.
 *
 * IMPORTANT:
 * - Only the exact target file is selected.
 * - Only hunks overlapping the symbol's line range are returned.
 * - Unrelated files/hunks are never included.
 */
export function extractSymbolDiff(
  fullDiff: string,
  targetFile: string,
  symbolRange: SymbolRange
): string {
  const normalizedTarget = normalizePath(targetFile);

  console.log(
    `[SymbolDiffExtractor] Extracting diff for "${normalizedTarget}" ` +
      `within lines ${symbolRange.startLine}–${symbolRange.endLine}`
  );

  // ============================================================
  // 1. Split the complete diff into individual file sections
  // ============================================================

  const diffLines = fullDiff.split(/\r?\n/);
  let targetSection: string[] = [];
  let insideTargetFile = false;

  for (const line of diffLines) {
    if (!line) continue;

    // A new file section starts here
    if (line.startsWith("diff --git ")) {
      // If we were already inside the target file, stop.
      if (insideTargetFile) {
        break;
      }

      const match = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
      if (!match || !match[1] || !match[2]) {
        continue;
      }

      const oldPath = normalizePath(match[1]);
      const newPath = normalizePath(match[2]);

      // Exact target-file match.
      if (oldPath === normalizedTarget || newPath === normalizedTarget) {
        insideTargetFile = true;
        targetSection.push(line);
      }

      continue;
    }

    if (insideTargetFile) {
      targetSection.push(line);
    }
  }

  // ============================================================
  // 2. Ensure the target file was actually found
  // ============================================================

  if (!insideTargetFile || targetSection.length === 0) {
    console.warn(
      `[SymbolDiffExtractor] No diff section found for "${normalizedTarget}"`
    );

    return "";
  }

  console.log(
    `[SymbolDiffExtractor] Found exact diff section for "${normalizedTarget}" ` +
      `(${targetSection.length} lines)`
  );

  // ============================================================
  // 3. Process only the hunks belonging to the target file
  // ============================================================

  const relevantHunks: string[] = [];
  let currentHunk: string[] = [];
  let currentHunkIsRelevant = false;

  for (const line of targetSection) {
    // ------
    // Hunk header
    // ------
    if (line.startsWith("@@")) {
      // Save previous hunk if it was relevant.
      if (currentHunkIsRelevant && currentHunk.length > 0) {
        relevantHunks.push(currentHunk.join("\n"));
      }

      currentHunk = [];
      currentHunkIsRelevant = false;

      const hunkRange = parseNewFileHunkRange(line);

      if (!hunkRange) {
        console.warn(
          `[SymbolDiffExtractor] Could not parse hunk header: ${line}`
        );
        continue;
      }

      const overlaps = rangesOverlap(
        hunkRange.startLine,
        hunkRange.endLine,
        symbolRange.startLine,
        symbolRange.endLine
      );

      console.log(
        `[SymbolDiffExtractor] Hunk ${hunkRange.startLine}–${hunkRange.endLine} ` +
          `→ ${overlaps ? "RELEVANT" : "ignored"}`
      );

      if (overlaps) {
        currentHunkIsRelevant = true;
        currentHunk.push(line);
      }

      continue;
    }

    // ------
    // File metadata (skip)
    // ------
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to")
    ) {
      continue;
    }

    // ------
    // Hunk content
    // ------
    if (currentHunkIsRelevant) {
      currentHunk.push(line);
    }
  }

  // Save final hunk.
  if (currentHunkIsRelevant && currentHunk.length > 0) {
    relevantHunks.push(currentHunk.join("\n"));
  }

  // ============================================================
  // 4. Nothing relevant
  // ============================================================

  if (relevantHunks.length === 0) {
    console.warn(
      `[SymbolDiffExtractor] No relevant hunks found for symbol ` +
        `"${symbolRange.name}" (${symbolRange.startLine}–${symbolRange.endLine})`
    );

    return "";
  }

  // ============================================================
  // 5. Build the final symbol-specific diff
  // ============================================================

  const header = targetSection
    .filter(
      (line) =>
        line.startsWith("diff --git ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ")
    )
    .join("\n");

  const result = [header, ...relevantHunks].filter(Boolean).join("\n");

  console.log(
    `[SymbolDiffExtractor] Final symbol diff for "${symbolRange.name}": ` +
      `${result.length} chars, ${relevantHunks.length} relevant hunk(s)`
  );

  return result;
}

/**
 * Parse the NEW-file range from a unified diff hunk header.
 *
 * Example:
 *   @@ -20,5 +20,8 @@
 *
 * means the changed hunk occupies lines 20–27
 * in the NEW version of the file.
 */
function parseNewFileHunkRange(hunkHeader: string): {
  startLine: number;
  endLine: number;
} | null {
  const match = hunkHeader.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);

  if (!match || !match[1]) {
    return null;
  }

  const startLine = parseInt(match[1], 10);

  // If count is omitted, Git means one line.
  const count = match[2] ? parseInt(match[2], 10) : 1;

  const endLine = count === 0 ? startLine : startLine + count - 1;

  return {
    startLine,
    endLine,
  };
}

/**
 * Check whether two inclusive line ranges overlap.
 */
function rangesOverlap(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number
): boolean {
  return firstStart <= secondEnd && secondStart <= firstEnd;
}

/**
 * Normalize Windows/Linux path separators.
 */
function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
}