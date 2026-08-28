import { simpleGit } from "simple-git";
import { analyzeSymbol } from "./symbol-analyzer.js";
import { analyzeDependencyChanges } from "./dependencyAnalyzer.js";
import type { DependencyChange } from "./dependencyAnalyzer.js";

// ======================================================
// TYPES
// ======================================================

interface SymbolChange {
  oldName: string;
  newName: string;
  file: string;
  type: "rename";
}

interface ChangedLine {
  type: "added" | "deleted";
  content: string;
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

interface CommitAnalysis {
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
  const dependencyChanges = analyzeDependencyChanges(rawDiff);

  console.log(
    `Files changed: ${changes.length}`
  );

  // ==================================================
  // 4. Detect REAL symbol renames
  // ==================================================

  const symbolChanges =
    detectSymbolRenames(changes);

  console.log(
    `Symbol renames detected: ${symbolChanges.length}`
  );

  // ==================================================
  // 5. Analyze renamed symbols
  // ==================================================

  const symbolAnalysis: {
    symbolChange: SymbolChange;
    analysis: ReturnType<typeof analyzeSymbol>;
  }[] = [];

  // --------------------------------------------------
  // Prevent analyzing the same new symbol repeatedly
  // --------------------------------------------------

  const analyzedSymbols =
    new Set<string>();

  for (const symbolChange of symbolChanges) {

    const symbolName =
      symbolChange.newName;

    if (analyzedSymbols.has(symbolName)) {

      console.log(
        `Skipping duplicate symbol: ${symbolName}`
      );

      continue;
    }

    analyzedSymbols.add(symbolName);

    console.log(
      `Analyzing symbol: ${symbolName}`
    );

    const analysis =
      analyzeSymbol(
        repositoryPath,
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

  return {
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
    rawDiff,
  };
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

    for (const line of lines) {

      // Ignore Git metadata

      if (
        line.startsWith("+++ ") ||
        line.startsWith("--- ") ||
        line.startsWith("@@") ||
        line.startsWith("index ") ||
        line.startsWith("new file mode") ||
        line.startsWith("deleted file mode") ||
        line.startsWith("similarity index") ||
        line.startsWith("rename from") ||
        line.startsWith("rename to")
      ) {
        continue;
      }

      // Added line

      if (line.startsWith("+")) {

        insertions++;

        changedLines.push({
          type: "added",
          content: line.substring(1),
        });
      }

      // Deleted line

      else if (line.startsWith("-")) {

        deletions++;

        changedLines.push({
          type: "deleted",
          content: line.substring(1),
        });
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

  // Prevent duplicate records

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

        if (oldSymbol === newSymbol) {
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

        // If the lines become identical after replacing
        // the symbol names with __SYMBOL__, then the only
        // meaningful change is the symbol name.
        //
        // Therefore this is a strong rename candidate.

        if (
          normalizedOld !== normalizedNew
        ) {
          continue;
        }

        const key =
          `${change.file}:${oldSymbol}->${newSymbol}`;

        if (detected.has(key)) {
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

  if (declarationMatch) {
    return declarationMatch[1];
  }

  // ==================================================
  // Class
  // ==================================================

  const classMatch =
    line.match(
      /(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/
    );

  if (classMatch) {
    return classMatch[1];
  }

  // ==================================================
  // Import
  //
  // import { foo } from ...
  // ==================================================

  const namedImportMatch =
    line.match(
      /import\s*\{\s*([A-Za-z_$][\w$]*)/
    );

  if (namedImportMatch) {
    return namedImportMatch[1];
  }

  // ==================================================
  // Function call
  //
  // foo(...)
  // ==================================================

  const callMatch =
    line.match(
      /\b([A-Za-z_$][\w$]*)\s*\(/
    );

  if (callMatch) {
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

