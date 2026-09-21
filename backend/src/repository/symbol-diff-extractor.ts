import * as ts from "typescript";
import { Project, SyntaxKind } from "ts-morph";

/**
 * Given a file path, symbol name, and unified diff, extract only the diff
 * lines that belong to that symbol's AST range.
 *
 * This replaces the "here's the entire file diff, figure it out" approach
 * with "here's ONLY the lines that belong to this symbol".
 *
 * Example:
 * - internals.ts has functions A(), B(), C()
 * - Only A() changed
 * - OLD: analyzer gets entire internals.ts diff (includes B, C context)
 * - NEW: analyzer gets only A's changed lines
 *
 * Pipeline:
 *   changed symbol
 *       ↓
 *   findSymbolRange()
 *       ↓
 *   AST range (declaration)
 *       ↓
 *   extractSymbolDiff()
 *       ↓
 *   only relevant Git hunks
 *       ↓
 *   gap analyzer
 */

interface SymbolRange {
  startLine: number;
  endLine: number;
  name: string;
}

/**
 * Find a symbol's DECLARATION line range in a source file using AST analysis.
 * Returns { startLine, endLine } (1-indexed, inclusive).
 *
 * IMPORTANT: This finds the DECLARATION (not just any identifier reference).
 * Example: for "createStore", it finds "function createStore() { ... }"
 * not the usage site "const x = createStore()".
 */
export function findSymbolRange(
  sourceFilePath: string,
  symbolName: string
): SymbolRange | null {
  try {
    const project = new Project();
    const sourceFile = project.addSourceFileAtPath(sourceFilePath);

    // Strategy: Look for declarations of this symbol directly.
    // This is more reliable than finding any identifier and hoping it's the declaration.

    // 1. Check for function declarations: function symbolName() { ... }
    const functionDecl = sourceFile.getFunction(symbolName);
    if (functionDecl) {
      const startLine = functionDecl.getStartLineNumber();
      const endLine = functionDecl.getEndLineNumber();
      console.log(
        `[SymbolDiffExtractor] Found function declaration "${symbolName}" at lines ${startLine}–${endLine}`
      );
      return { startLine, endLine, name: symbolName };
    }

    // 2. Check for class declarations: class symbolName { ... }
    const classDecl = sourceFile.getClass(symbolName);
    if (classDecl) {
      const startLine = classDecl.getStartLineNumber();
      const endLine = classDecl.getEndLineNumber();
      console.log(
        `[SymbolDiffExtractor] Found class declaration "${symbolName}" at lines ${startLine}–${endLine}`
      );
      return { startLine, endLine, name: symbolName };
    }

    // 3. Check for variable declarations: const/let/var symbolName = ...
    const variables = sourceFile.getVariableDeclarations();
    const varDecl = variables.find((v) => v.getName() === symbolName);
    if (varDecl) {
      // Get the parent statement (which contains the entire const/let/var declaration)
      const statement = varDecl.getVariableStatement();
      if (statement) {
        const startLine = statement.getStartLineNumber();
        const endLine = statement.getEndLineNumber();
        console.log(
          `[SymbolDiffExtractor] Found variable declaration "${symbolName}" at lines ${startLine}–${endLine}`
        );
        return { startLine, endLine, name: symbolName };
      }
    }

    // 4. Check for export declarations
    const exportedDecl = sourceFile.getExportedDeclarations().get(symbolName)?.[0];
    if (exportedDecl) {
      const startLine = exportedDecl.getStartLineNumber();
      const endLine = exportedDecl.getEndLineNumber();
      console.log(
        `[SymbolDiffExtractor] Found exported declaration "${symbolName}" at lines ${startLine}–${endLine}`
      );
      return { startLine, endLine, name: symbolName };
    }

    console.warn(
      `[SymbolDiffExtractor] Symbol "${symbolName}" declaration not found in "${sourceFilePath}"`
    );
    return null;
  } catch (error) {
    console.error(
      `[SymbolDiffExtractor] Error analyzing "${symbolName}": ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Given a unified diff and a symbol's line range, extract only the diff
 * lines (hunks) that overlap with the symbol's source range.
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
    // Git metadata — always include
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

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match?.[1]) {
        currentHunkStart = parseInt(match[1]);
        newFileLineNumber = currentHunkStart;
      }

      // Check if this hunk overlaps with the symbol range
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

    // Diff content lines
    if (inRelevantHunk) {
      relevantLines.push(line);

      // Track line numbers for context
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
 * Check whether a hunk (identified by its header line) overlaps with the
 * target line range.
 *
 * Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
 * The "newStart" and "newCount" tell us which lines in the NEW file this hunk touches.
 */
function checkHunkOverlap(
  hunkHeader: string,
  symbolStart: number,
  symbolEnd: number
): boolean {
  // @@ -oldStart,oldCount +newStart,newCount @@
  const match = hunkHeader.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);

  if (!match || !match[1]) {
    return false;
  }

  const hunkStart = parseInt(match[1]);
  const hunkCount = parseInt(match[2] ?? "1");
  const hunkEnd = hunkStart + hunkCount - 1;

  // Check overlap: [a, b] overlaps [c, d] iff a <= d and c <= b
  return hunkStart <= symbolEnd && symbolStart <= hunkEnd;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
