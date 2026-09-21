import * as ts from "typescript";
import { Project, SyntaxKind } from "ts-morph";
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
 * lines (hunks) that overlap with that symbol's source range.
 *
 * Returns a new unified diff containing only those hunks.
 */
export function extractSymbolDiff(
  fullDiff: string,
  targetFile: string,
  symbolRange: SymbolRange
): string {
  const fileSectionPattern = new RegExp(
    `^diff --git a/.+? b/${escapeRegex(targetFile)}$.*?(?=^diff --git |$)`,
    "ms"
  );

  const fileMatch = fileSectionPattern.exec(fullDiff);

  if (!fileMatch) {
    console.warn(
      `[SymbolDiffExtractor] No diff section found for "${targetFile}"`
    );

    return "";
  }

  const fileDiff = fileMatch[0];
  const lines = fileDiff.split("\n");
  const relevantLines: string[] = [];

  let currentHunkStart = 0;
  let currentHunkLines: string[] = [];
  let newFileLineNumber = 0;
  let inRelevantHunk = false;

  for (const line of lines) {
    // ------------------------------------------------------------
    // Git metadata
    // ------------------------------------------------------------

    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file")
    ) {
      if (relevantLines.length === 0 || inRelevantHunk) {
        relevantLines.push(line);
      }

      continue;
    }

    // ------------------------------------------------------------
    // Hunk header
    // ------------------------------------------------------------

    if (line.startsWith("@@")) {
      const match = line.match(
        /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/
      );

      if (match?.[1]) {
        currentHunkStart = parseInt(match[1]);
        newFileLineNumber = currentHunkStart;
      }

      inRelevantHunk = checkHunkOverlap(
        line,
        symbolRange.startLine,
        symbolRange.endLine
      );

      if (inRelevantHunk) {
        relevantLines.push(line);
      }

      currentHunkLines = [];

      continue;
    }

    // ------------------------------------------------------------
    // Diff content
    // ------------------------------------------------------------

    if (inRelevantHunk) {
      relevantLines.push(line);

      if (line.startsWith("+")) {
        newFileLineNumber++;
      } else if (line.startsWith(" ")) {
        newFileLineNumber++;
      }
    }
  }

  return relevantLines.join("\n");
}

/**
 * Check whether a hunk overlaps with the target symbol range.
 *
 * Hunk example:
 *
 * @@ -20,5 +20,8 @@
 *
 * The +20,8 part represents the NEW file range.
 */
function checkHunkOverlap(
  hunkHeader: string,
  symbolStart: number,
  symbolEnd: number
): boolean {
  const match = hunkHeader.match(
    /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/
  );

  if (!match || !match[1]) {
    return false;
  }

  const hunkStart = parseInt(match[1]);
  const hunkCount = parseInt(match[2] ?? "1");

  const hunkEnd = hunkStart + hunkCount - 1;

  return (
    hunkStart <= symbolEnd &&
    symbolStart <= hunkEnd
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}