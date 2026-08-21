import { simpleGit } from "simple-git";

interface ChangedLine {
  type: "added" | "deleted";
  content: string;
}

interface FileChange {
  file: string;
  status: "added" | "modified" | "deleted" | "renamed" | "unknown";
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
  rawDiff: string;
}

export async function analyzeCommit(
  repositoryPath: string,
  commitHash: string
): Promise<CommitAnalysis> {
  const git = simpleGit(repositoryPath);

  // --------------------------------------------------
  // 1. Get commit information
  // --------------------------------------------------
  const log = await git.log({
    from: `${commitHash}^`,
    to: commitHash,
    maxCount: 1,
  });

  const latestCommit = log.latest;
  if (!latestCommit) {
    throw new Error(`Commit not found: ${commitHash}`);
  }

  // --------------------------------------------------
  // 2. Get raw diff
  // --------------------------------------------------
  const rawDiff = await git.diff([`${commitHash}^`, commitHash]);

  // --------------------------------------------------
  // 3. Parse the diff
  // --------------------------------------------------
  const changes = parseDiff(rawDiff);

  // --------------------------------------------------
  // 4. Calculate summary
  // --------------------------------------------------
  const totalInsertions = changes.reduce((total, change) => total + change.insertions, 0);
  const totalDeletions = changes.reduce((total, change) => total + change.deletions, 0);

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
    // Keep the original diff for debugging/research.
    rawDiff,
  };
}

// ======================================================
// DIFF PARSER
// ======================================================
function parseDiff(diff: string): FileChange[] {
  const changes: FileChange[] = [];

  if (!diff.trim()) {
    return changes;
  }

  // Git separates files using "diff --git"
  const fileDiffs = diff.split(/^diff --git /m).filter(Boolean);

  for (const fileDiff of fileDiffs) {
    const lines = fileDiff.split("\n");

    // --------------------------------------------------
    // Get file path
    // --------------------------------------------------
    const firstLine = lines[0];
    if (!firstLine) {
      continue;
    }
    const fileMatch = firstLine.match(/a\/(.+?) b\/(.+)$/);
    if (!fileMatch) {
      continue;
    }
    const file = fileMatch[2] || "";

    // --------------------------------------------------
    // Detect binary file
    // --------------------------------------------------
    const binary = lines.some((line) => line.includes("Binary files"));

    // --------------------------------------------------
    // Determine status
    // --------------------------------------------------
    let status: FileChange["status"] = "modified";
    if (lines.some((line) => line.startsWith("new file mode"))) {
      status = "added";
    } else if (lines.some((line) => line.startsWith("deleted file mode"))) {
      status = "deleted";
    } else if (lines.some((line) => line.startsWith("similarity index"))) {
      status = "renamed";
    }

    // --------------------------------------------------
    // Extract changed lines
    // --------------------------------------------------
    const changedLines: ChangedLine[] = [];
    let insertions = 0;
    let deletions = 0;

    for (const line of lines) {
      // Ignore diff metadata
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

      if (line.startsWith("+")) {
        insertions++;
        changedLines.push({
          type: "added",
          content: line.substring(1),
        });
      }

      if (line.startsWith("-")) {
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
