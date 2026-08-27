import { simpleGit } from "simple-git";
import { analyzeSymbol } from "./symbol-analyzer.js";

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

  console.log(
    `Files changed: ${changes.length}`
  );

  // ==================================================
  // 4. Detect symbol renames
  // ==================================================

  const symbolChanges =
    detectSymbolRenames(changes);

  console.log(
    `Unique symbol renames detected: ${symbolChanges.length}`
  );

  // ==================================================
  // 5. Analyze symbols
  // ==================================================

  const symbolAnalysis: {
    symbolChange: SymbolChange;
    analysis: ReturnType<typeof analyzeSymbol>;
  }[] = [];

  // --------------------------------------------------
  // IMPORTANT:
  // Keep track of symbols already analyzed.
  // --------------------------------------------------

  const analyzedSymbols =
    new Set<string>();

  for (const symbolChange of symbolChanges) {

    const symbolName =
      symbolChange.newName;

    // ------------------------------------------------
    // Don't analyze same symbol multiple times
    // ------------------------------------------------

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

  // --------------------------------------------------
  // Git separates files using diff --git
  // --------------------------------------------------

  const fileDiffs =
    diff
      .split(/^diff --git /m)
      .filter(Boolean);

  for (const fileDiff of fileDiffs) {

    const lines =
      fileDiff.split("\n");

    // ==================================================
    // Get file path
    // ==================================================

    const firstLine = lines[0];

    if (!firstLine) {
      continue;
    }

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

      // ------------------------------------------------
      // Ignore metadata
      // ------------------------------------------------

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

      // ------------------------------------------------
      // Added line
      // ------------------------------------------------

      if (line.startsWith("+")) {

        insertions++;

        changedLines.push({
          type: "added",
          content: line.substring(1),
        });
      }

      // ------------------------------------------------
      // Deleted line
      // ------------------------------------------------

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
// DETECT SYMBOL RENAMES
// ======================================================

function detectSymbolRenames(
  changes: FileChange[]
): SymbolChange[] {

  const symbolChanges: SymbolChange[] = [];

  // --------------------------------------------------
  // Prevent duplicates
  // --------------------------------------------------

  const detected =
    new Set<string>();

  for (const change of changes) {

    // Don't try to detect symbols
    // inside binary files.

    if (change.binary) {
      continue;
    }

    const deletedLines =
      change.changedLines
        .filter(
          (line) =>
            line.type === "deleted"
        )
        .map(
          (line) =>
            line.content
        );

    const addedLines =
      change.changedLines
        .filter(
          (line) =>
            line.type === "added"
        )
        .map(
          (line) =>
            line.content
        );

    // ==================================================
    // Find old declarations
    // ==================================================

    const oldSymbols =
      new Set<string>();

    for (const deletedLine of deletedLines) {

      const oldMatch =
        extractSymbolName(
          deletedLine
        );

      if (oldMatch) {
        oldSymbols.add(oldMatch);
      }
    }

    // ==================================================
    // Find new declarations
    // ==================================================

    const newSymbols =
      new Set<string>();

    for (const addedLine of addedLines) {

      const newMatch =
        extractSymbolName(
          addedLine
        );

      if (newMatch) {
        newSymbols.add(newMatch);
      }
    }

    // ==================================================
    // Compare old/new symbols
    // ==================================================

    for (const oldName of oldSymbols) {

      for (const newName of newSymbols) {

        // Same name = not a rename

        if (oldName === newName) {
          continue;
        }

        // Create unique identifier

        const key =
          `${change.file}:${oldName}->${newName}`;

        // Skip duplicates

        if (detected.has(key)) {
          continue;
        }

        detected.add(key);

        symbolChanges.push({
          oldName,
          newName,
          file: change.file,
          type: "rename",
        });
      }
    }
  }

  return symbolChanges;
}

// ======================================================
// Extract symbol name from a changed line
// ======================================================

function extractSymbolName(
  line: string
): string | undefined {

  // --------------------------------------------------
  // function foo()
  // const foo =
  // let foo =
  // var foo =
  // --------------------------------------------------

  const declarationMatch =
    line.match(
      /(?:export\s+)?(?:async\s+)?(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/
    );

  if (declarationMatch) {

    return declarationMatch[1];
  }

  // --------------------------------------------------
  // class Foo
  // --------------------------------------------------

  const classMatch =
    line.match(
      /(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/
    );

  if (classMatch) {

    return classMatch[1];
  }

  return undefined;
}