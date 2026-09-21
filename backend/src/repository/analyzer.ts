import { simpleGit } from "simple-git";
import { Project } from "ts-morph";
import path from "path";

import { analyzeSymbol } from "./symbol-analyzer.js";
import { analyzeDependencyChanges } from "./dependencyAnalyzer.js";
import { analyzeTests } from "./test-analyzer.js";
import { discoverSourceFiles } from "./file-discovery.js";

import type { DependencyChange } from "./dependencyAnalyzer.js";
import type { TestAnalysisResult } from "./test-analyzer.js";

// ======================================================
// TYPES
// ======================================================

interface SymbolChange {
  oldName: string;
  newName: string;
  file: string;
  type: "rename" | "modified";
}

interface ChangedLine {
  type: "added" | "deleted";
  content: string;
  newLineNumber?: number;
}

interface FileChange {
  file: string;

  status:
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "unknown";

  binary: boolean;

  insertions: number;
  deletions: number;

  changedLines: ChangedLine[];
}

export interface CommitAnalysis {
  commit: {
    hash: string;
    message: string;
    author: string;
    date: string;
  };

  summary: {
    filesChanged: number;
    totalInsertions: number;
    totalDeletions: number;
  };

  changes: FileChange[];

  symbolChanges: SymbolChange[];

  symbolAnalysis: {
    symbolChange: SymbolChange;
    analysis: ReturnType<typeof analyzeSymbol>;
  }[];

  dependencyChanges: DependencyChange[];

  testAnalysis: TestAnalysisResult;

  rawDiff: string;
}

// ======================================================
// ANALYZE COMMIT
// ======================================================

export async function analyzeCommit(
  repositoryPath: string,
  commitHash: string
): Promise<CommitAnalysis> {

  const git = simpleGit(repositoryPath);

  console.log("======================================");
  console.log("Starting commit analysis");
  console.log(`Commit: ${commitHash}`);
  console.log("======================================");

  // ==================================================
  // 1. Get commit information
  // ==================================================

  const log = await git.log({
    from: `${commitHash}^`,
    to: commitHash,
    maxCount: 1,
  });

  const latestCommit = log.latest;

  if (!latestCommit) {
    throw new Error(
      `Commit not found: ${commitHash}`
    );
  }

  // ==================================================
  // 2. Get raw diff
  // ==================================================

  console.log("Getting git diff...");

  const rawDiff = await git.diff([
    `${commitHash}^`,
    commitHash,
  ]);

  // ==================================================
  // 3. Parse diff
  // ==================================================

  console.log("Parsing diff...");

  const changes = parseDiff(rawDiff);

  const dependencyChanges =
    analyzeDependencyChanges(rawDiff);

  const testAnalysis =
    analyzeTests(
      changes,
      repositoryPath
    );

  console.log(
    `Files changed: ${changes.length}`
  );

  // ==================================================
  // 4. Detect symbol changes
  // ==================================================

  const renameChanges =
    detectSymbolRenames(changes);

  const modifiedChanges =
    detectModifiedSymbols(
      changes,
      repositoryPath
    );

  const symbolChanges =
    mergeSymbolChanges(
      renameChanges,
      modifiedChanges
    );

  console.log(
    `Symbol changes detected: ${symbolChanges.length}`
  );

  console.log(
    `  - Renames: ${renameChanges.length}`
  );

  console.log(
    `  - Modified: ${modifiedChanges.length}`
  );

  // ==================================================
  // 5. Analyze changed symbols
  // ==================================================

  const symbolAnalysis: {
    symbolChange: SymbolChange;
    analysis: ReturnType<typeof analyzeSymbol>;
  }[] = [];

  // Discover all source files once
  // and reuse them for symbol analysis.
  const discoveredFiles =
    discoverSourceFiles(repositoryPath);

  // --------------------------------------------------
  // Prevent analyzing the same symbol repeatedly
  // --------------------------------------------------

  const analyzedSymbols =
    new Set<string>();

  for (const symbolChange of symbolChanges) {

    const symbolName =
      symbolChange.newName;

    // Include file in the key so two files
    // can have symbols with the same name.
    const symbolKey =
      `${symbolChange.file}:${symbolName}`;

    if (
      analyzedSymbols.has(symbolKey)
    ) {
      console.log(
        `Skipping duplicate symbol: ${symbolName} in ${symbolChange.file}`
      );

      continue;
    }

    analyzedSymbols.add(symbolKey);

    console.log(
      `Analyzing symbol: ${symbolName} in ${symbolChange.file}`
    );

    const analysis =
      analyzeSymbol(
        discoveredFiles,
        symbolName
      );

    symbolAnalysis.push({
      symbolChange,
      analysis,
    });
  }

  // ==================================================
  // 6. Calculate summary
  // ==================================================

  const totalInsertions =
    changes.reduce(
      (total, change) =>
        total + change.insertions,
      0
    );

  const totalDeletions =
    changes.reduce(
      (total, change) =>
        total + change.deletions,
      0
    );

  // ==================================================
  // 7. Return result
  // ==================================================

  console.log("======================================");
  console.log("Commit analysis completed");
  console.log("======================================");

  const result: CommitAnalysis = {
    commit: {
      hash: latestCommit.hash || "",
      message: latestCommit.message || "",
      author: latestCommit.author_name || "",
      date: latestCommit.date || "",
    },

    summary: {
      filesChanged: changes.length,
      totalInsertions,
      totalDeletions,
    },

    changes,
    symbolChanges,
    symbolAnalysis,
    dependencyChanges,
    testAnalysis,
    rawDiff,
  };

  return result;
}

// ======================================================
// DIFF PARSER
// ======================================================

function parseDiff(
  diff: string
): FileChange[] {

  const changes: FileChange[] = [];

  if (!diff.trim()) {
    return changes;
  }

  // Git separates each file with "diff --git"

  const fileDiffs =
    diff
      .split(/^diff --git /m)
      .filter(Boolean);

  for (const fileDiff of fileDiffs) {

    const lines =
      fileDiff.split("\n");

    const firstLine = lines[0];

    if (!firstLine) {
      continue;
    }

    // Example:
    // a/apps/file.tsx b/apps/file.tsx

    const fileMatch =
      firstLine.match(
        /a\/(.+?) b\/(.+)$/
      );

    if (!fileMatch) {
      continue;
    }

    const file =
      fileMatch[2] || "";

    // ==================================================
    // Detect binary
    // ==================================================

    const binary =
      lines.some(
        (line) =>
          line.includes("Binary files")
      );

    // ==================================================
    // Determine status
    // ==================================================

    let status:
      FileChange["status"] =
      "modified";

    if (
      lines.some(
        (line) =>
          line.startsWith(
            "new file mode"
          )
      )
    ) {

      status = "added";

    } else if (
      lines.some(
        (line) =>
          line.startsWith(
            "deleted file mode"
          )
      )
    ) {

      status = "deleted";

    } else if (
      lines.some(
        (line) =>
          line.startsWith(
            "similarity index"
          )
      )
    ) {

      status = "renamed";
    }

    // ==================================================
    // Extract changed lines
    // ==================================================

    const changedLines: ChangedLine[] = [];

    let insertions = 0;
    let deletions = 0;

    let newLineNumber = 0;
    let oldLineNumber = 0;

    for (const line of lines) {

      // Parse hunk headers
      //
      // Example:
      // @@ -10,5 +10,7 @@

      if (line.startsWith("@@")) {

        const match =
          line.match(
            /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/
          );

        if (match?.[1]) {
          newLineNumber =
            parseInt(match[1]) - 1;
        }

        const oldMatch =
          line.match(
            /-(\d+)/
          );

        if (oldMatch?.[1]) {
          oldLineNumber =
            parseInt(oldMatch[1]) - 1;
        }

        continue;
      }

      // ==================================================
      // Ignore Git metadata
      // ==================================================

      if (
        line.startsWith("+++ ") ||
        line.startsWith("--- ") ||
        line.startsWith("index ") ||
        line.startsWith("new file mode") ||
        line.startsWith("deleted file mode") ||
        line.startsWith("similarity index") ||
        line.startsWith("rename from") ||
        line.startsWith("rename to")
      ) {
        continue;
      }

      // ==================================================
      // Added line
      // ==================================================

      if (line.startsWith("+")) {

        insertions++;

        newLineNumber++;

        changedLines.push({
          type: "added",
          content: line.substring(1),
          newLineNumber,
        });
      }

      // ==================================================
      // Deleted line
      // ==================================================

      else if (line.startsWith("-")) {

        deletions++;

        oldLineNumber++;

        changedLines.push({
          type: "deleted",
          content: line.substring(1),
        });
      }

      // ==================================================
      // Context line
      // ==================================================

      else if (line.startsWith(" ")) {

        newLineNumber++;
        oldLineNumber++;
      }
    }

    changes.push({
      file,
      status,
      binary,
      insertions,
      deletions,
      changedLines,
    });
  }

  return changes;
}

// ======================================================
// DETECT REAL SYMBOL RENAMES
// ======================================================
//
// We DO NOT do:
//
// old symbols × new symbols
//
// Instead:
//
// deleted line
//      ↓
// find a very similar added line
//      ↓
// check whether only the symbol name changed
//
// Example:
//
// - getEventLocationType(location.type)
// + getLocationByType(location.type)
//
// This is a rename.
//
// ======================================================

function detectSymbolRenames(
  changes: FileChange[]
): SymbolChange[] {

  const symbolChanges: SymbolChange[] = [];

  const detected =
    new Set<string>();

  for (const change of changes) {

    // Don't analyze binary files

    if (change.binary) {
      continue;
    }

    const deletedLines =
      change.changedLines.filter(
        (line) =>
          line.type === "deleted"
      );

    const addedLines =
      change.changedLines.filter(
        (line) =>
          line.type === "added"
      );

    // ==================================================
    // Compare deleted lines with added lines
    // ==================================================

    for (const deleted of deletedLines) {

      const oldSymbol =
        extractChangedSymbol(
          deleted.content
        );

      if (!oldSymbol) {
        continue;
      }

      for (const added of addedLines) {

        const newSymbol =
          extractChangedSymbol(
            added.content
          );

        if (!newSymbol) {
          continue;
        }

        if (
          oldSymbol === newSymbol
        ) {
          continue;
        }

        // ==================================================
        // Normalize both lines
        // ==================================================

        const normalizedOld =
          normalizeSymbolLine(
            deleted.content,
            oldSymbol
          );

        const normalizedNew =
          normalizeSymbolLine(
            added.content,
            newSymbol
          );

        // If the lines become identical after
        // replacing the symbol names, this is
        // a strong rename candidate.

        if (
          normalizedOld !== normalizedNew
        ) {
          continue;
        }

        const key =
          `${change.file}:${oldSymbol}->${newSymbol}`;

        if (
          detected.has(key)
        ) {
          continue;
        }

        detected.add(key);

        symbolChanges.push({
          oldName: oldSymbol,
          newName: newSymbol,
          file: change.file,
          type: "rename",
        });
      }
    }
  }

  return symbolChanges;
}

// ======================================================
// DETECT MODIFIED SYMBOLS
// ======================================================
//
// Finds functions, classes, methods, and variables
// whose source ranges contain changed lines.
//
// Example:
//
// function calculateTotal() {    <-- line 10
//   ...                          <-- line 11
//   return total;                <-- line 12 changed
// }                              <-- line 13
//
// Since line 12 is inside the function range,
// calculateTotal is considered modified.
//
// ======================================================

function detectModifiedSymbols(
  changes: FileChange[],
  repositoryRoot: string
): SymbolChange[] {

  const symbolChanges: SymbolChange[] = [];

  const detected =
    new Set<string>();

  const project =
    new Project({
      skipAddingFilesFromTsConfig: true,
    });

  for (const change of changes) {

    // ==================================================
    // Skip binary files
    // ==================================================

    if (change.binary) {
      continue;
    }

    // ==================================================
    // Deleted files do not exist in the checked-out
    // target commit, so there is no AST to inspect.
    // ==================================================

    if (
      change.status === "deleted"
    ) {
      continue;
    }

    // ==================================================
    // Skip files without changes
    // ==================================================

    if (
      change.changedLines.length === 0
    ) {
      continue;
    }

    // ==================================================
    // Get absolute path
    // ==================================================

    const absolutePath =
      path.resolve(
        repositoryRoot,
        change.file
      );

    let sourceFile;

    try {

      sourceFile =
        project.addSourceFileAtPath(
          absolutePath
        );

    } catch (error) {

      console.warn(
        `[SymbolDetection] Could not parse ${change.file}:`,
        error instanceof Error
          ? error.message
          : String(error)
      );

      continue;
    }

    // ==================================================
    // Only added lines are used because the repository
    // is currently checked out at the target commit.
    // ==================================================

    const changedLineNumbers =
      change.changedLines
        .filter(
          (line) =>
            line.type === "added" &&
            line.newLineNumber !== undefined
        )
        .map(
          (line) =>
            line.newLineNumber!
        );

    if (
      changedLineNumbers.length === 0
    ) {
      continue;
    }

    console.log(
      `[SymbolDetection] ${change.file}: ` +
      `${changedLineNumbers.length} changed line(s)`
    );

    // ==================================================
    // FUNCTIONS
    // ==================================================

    for (
      const fn
      of sourceFile.getFunctions()
    ) {

      const start =
        fn.getStartLineNumber();

      const end =
        fn.getEndLineNumber();

      const changed =
        changedLineNumbers.some(
          (line) =>
            line >= start &&
            line <= end
        );

      if (!changed) {
        continue;
      }

      const name =
        fn.getName();

      if (!name) {
        continue;
      }

      const key =
        `${change.file}:${name}`;

      if (
        detected.has(key)
      ) {
        continue;
      }

      detected.add(key);

      symbolChanges.push({
        oldName: name,
        newName: name,
        file: change.file,
        type: "modified",
      });

      console.log(
        `[SymbolDetection] ✓ Function modified: ${name} (${change.file}:${start}-${end})`
      );
    }

    // ==================================================
    // CLASSES
    // ==================================================

    for (
      const cls
      of sourceFile.getClasses()
    ) {

      const classStart =
        cls.getStartLineNumber();

      const classEnd =
        cls.getEndLineNumber();

      const classChanged =
        changedLineNumbers.some(
          (line) =>
            line >= classStart &&
            line <= classEnd
        );

      const className =
        cls.getName();

      if (
        classChanged &&
        className
      ) {

        const key =
          `${change.file}:${className}`;

        if (
          !detected.has(key)
        ) {

          detected.add(key);

          symbolChanges.push({
            oldName: className,
            newName: className,
            file: change.file,
            type: "modified",
          });

          console.log(
            `[SymbolDetection] ✓ Class modified: ${className} (${change.file}:${classStart}-${classEnd})`
          );
        }
      }

      // ==================================================
      // METHODS
      // ==================================================

      for (
        const method
        of cls.getMethods()
      ) {

        const start =
          method.getStartLineNumber();

        const end =
          method.getEndLineNumber();

        const changed =
          changedLineNumbers.some(
            (line) =>
              line >= start &&
              line <= end
          );

        if (!changed) {
          continue;
        }

        const name =
          method.getName();

        const key =
          `${change.file}:${name}`;

        if (
          detected.has(key)
        ) {
          continue;
        }

        detected.add(key);

        symbolChanges.push({
          oldName: name,
          newName: name,
          file: change.file,
          type: "modified",
        });

        console.log(
          `[SymbolDetection] ✓ Method modified: ${name} (${change.file}:${start}-${end})`
        );
      }
    }

    // ==================================================
    // VARIABLES
    // ==================================================

    for (
      const variable
      of sourceFile.getVariableDeclarations()
    ) {

      const start =
        variable.getStartLineNumber();

      const end =
        variable.getEndLineNumber();

      const changed =
        changedLineNumbers.some(
          (line) =>
            line >= start &&
            line <= end
        );

      if (!changed) {
        continue;
      }

      const name =
        variable.getName();

      const key =
        `${change.file}:${name}`;

      if (
        detected.has(key)
      ) {
        continue;
      }

      detected.add(key);

      symbolChanges.push({
        oldName: name,
        newName: name,
        file: change.file,
        type: "modified",
      });

      console.log(
        `[SymbolDetection] ✓ Variable modified: ${name} (${change.file}:${start}-${end})`
      );
    }
  }

  return symbolChanges;
}

// ======================================================
// MERGE SYMBOL CHANGES
// ======================================================
//
// Prevent duplicate symbols when the same symbol is
// detected both as a rename and as a modified symbol.
//
// ======================================================

function mergeSymbolChanges(
  renameChanges: SymbolChange[],
  modifiedChanges: SymbolChange[]
): SymbolChange[] {

  const result: SymbolChange[] = [];

  const seen =
    new Set<string>();

  for (
    const change of [
      ...renameChanges,
      ...modifiedChanges,
    ]
  ) {

    const key =
      `${change.file}:${change.newName}`;

    if (
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);

    result.push(change);
  }

  return result;
}

// ======================================================
// EXTRACT SYMBOL FROM CHANGED LINE
// ======================================================

function extractChangedSymbol(
  line: string
): string | undefined {

  // ==================================================
  // Function / variable declaration
  //
  // const foo =
  // let foo =
  // var foo =
  // function foo()
  // ==================================================

  const declarationMatch =
    line.match(
      /(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/
    );

  if (
    declarationMatch
  ) {
    return declarationMatch[1];
  }

  // ==================================================
  // Class
  // ==================================================

  const classMatch =
    line.match(
      /(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/
    );

  if (
    classMatch
  ) {
    return classMatch[1];
  }

  // ==================================================
  // Import
  // ==================================================

  const namedImportMatch =
    line.match(
      /import\s*\{\s*([A-Za-z_$][\w$]*)/
    );

  if (
    namedImportMatch
  ) {
    return namedImportMatch[1];
  }

  // ==================================================
  // Function call
  // ==================================================

  const callMatch =
    line.match(
      /\b([A-Za-z_$][\w$]*)\s*\(/
    );

  if (
    callMatch
  ) {
    return callMatch[1];
  }

  return undefined;
}

// ======================================================
// NORMALIZE SYMBOL LINE
// ======================================================

function normalizeSymbolLine(
  line: string,
  symbol: string
): string {

  // Escape special regex characters

  const escapedSymbol =
    symbol.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

  return line
    .replace(
      new RegExp(
        `\\b${escapedSymbol}\\b`,
        "g"
      ),
      "__SYMBOL__"
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}