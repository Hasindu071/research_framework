import fs from "fs";
import path from "path";

import type { DependencyChange } from "../repository/dependencyAnalyzer.js";
import type { TestMatch } from "../repository/test-analyzer.js";

// ======================================================
// NOTE ON INPUT TYPE
// ======================================================
//
// This module intentionally does NOT import `CommitAnalysis` from
// analyzer.ts, because that interface currently isn't exported.
// The only change needed on that side is:
//
//     export interface CommitAnalysis { ... }
//
// Until that's done, `CommitAnalysisLike` below mirrors the shape we
// actually consume, so this file can be built and typechecked
// independently of that one-line edit.

interface CommitAnalysisLike {
  commit: {
    hash: string;
    message: string;
    author: string;
    date: string;
  };
  changes: {
    file: string;
    status: "added" | "modified" | "deleted" | "renamed" | "unknown";
    binary: boolean;
  }[];
  symbolChanges: {
    oldName: string;
    newName: string;
    file: string;
    type: "rename";
  }[];
  dependencyChanges: DependencyChange[];
  testAnalysis: {
    relatedTests: TestMatch[];
  };
}

// ======================================================
// TYPES — mirrors the JSON shape from the design doc
// ======================================================

export interface ChangedFileSummary {
  file: string;
  status: string;
}

export interface ChangedSymbolSummary {
  name: string;
  file: string;
  /**
   * "renamed": detected via the diff-based rename heuristic in
   * analyzer.ts.
   * "modified": the symbol wasn't renamed, but a test's
   * `changedSymbolsUsed` tells us the commit touched its
   * declaration/body (see extractChangedSymbolNames in
   * test-analyzer.ts).
   */
  changeType: "renamed" | "modified";
}

export interface DependencyChangeSummary {
  package: string;
  changeType: DependencyChange["changeType"];
  from?: string | undefined;
  to?: string | undefined;
}

export interface CandidateTestSummary {
  testFile: string;
  changedFile: string;
  relationship: TestMatch["relationship"];
  impact?: TestMatch["impact"];
  confidence: number;
  symbols?: string[];
}

export interface CodeExcerpt {
  file: string;
  /** Full file content, or a truncated excerpt — see MAX_EXCERPT_CHARS. */
  content: string;
  truncated: boolean;
}

export interface LLMContext {
  commit: {
    hash: string;
    message: string;
  };
  changedFiles: ChangedFileSummary[];
  changedSymbols: ChangedSymbolSummary[];
  dependencyChanges: DependencyChangeSummary[];
  candidateTests: CandidateTestSummary[];
  sourceCode: CodeExcerpt[];
  testCode: CodeExcerpt[];
}

export interface BuildContextOptions {
  /**
   * Cap on how much of any single file we send to the LLM. Keeps the
   * prompt bounded even if a changed or candidate-test file happens
   * to be huge — per design doc point 7 ("don't send the entire
   * repository").
   */
  maxExcerptChars?: number;
  /** Cap on how many candidate tests' code we include. */
  maxTestFiles?: number;
}

const DEFAULT_MAX_EXCERPT_CHARS = 6000;
const DEFAULT_MAX_TEST_FILES = 15;

// ======================================================
// BUILD CONTEXT
// ======================================================

export function buildLLMContext(
  analysis: CommitAnalysisLike,
  repositoryRoot: string,
  options: BuildContextOptions = {}
): LLMContext {
  const maxExcerptChars = options.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS;
  const maxTestFiles = options.maxTestFiles ?? DEFAULT_MAX_TEST_FILES;

  const changedFiles = analysis.changes
    .filter((change) => !change.binary)
    .map((change) => ({
      file: change.file,
      status: change.status,
    }));

  const changedSymbols = buildChangedSymbols(analysis);

  const dependencyChanges = analysis.dependencyChanges.map((dep) => ({
    package: dep.package,
    changeType: dep.changeType,
    from: dep.from,
    to: dep.to,
  }));

  // Rank candidate tests before truncating so the tests we drop (if
  // any) are the weakest-evidence ones, not an arbitrary prefix.
  const rankedTests = [...analysis.testAnalysis.relatedTests].sort(
    (a, b) => b.confidence - a.confidence
  );

  const candidateTests: CandidateTestSummary[] = rankedTests.map((match) => ({
    testFile: match.testFile,
    changedFile: match.changedFile,
    relationship: match.relationship,
    impact: match.impact,
    confidence: match.confidence,
    ...(match.symbols && { symbols: match.symbols }),
  }));

  // Only the non-test changed files have "source code" in the sense
  // the LLM needs (what actually changed); test files are handled
  // separately below via the candidate list.
  const sourceFiles = analysis.changes
    .filter((change) => !change.binary)
    .map((change) => change.file);

  const sourceCode = readExcerpts(
    sourceFiles,
    repositoryRoot,
    maxExcerptChars
  );

  const testFilesToInclude = dedupe(
    rankedTests.slice(0, maxTestFiles).map((match) => match.testFile)
  );

  const testCode = readExcerpts(
    testFilesToInclude,
    repositoryRoot,
    maxExcerptChars
  );

  return {
    commit: {
      hash: analysis.commit.hash,
      message: analysis.commit.message,
    },
    changedFiles,
    changedSymbols,
    dependencyChanges,
    candidateTests,
    sourceCode,
    testCode,
  };
}

// ======================================================
// CHANGED SYMBOLS
// ======================================================
//
// Two independent sources of evidence feed this list:
//
//   1. Detected renames (analyzer.ts's `symbolChanges`) — we know
//      both the old and new name, so we report the new name as
//      "renamed".
//   2. Symbols the test-analyzer already determined were touched by
//      this commit, surfaced per-match as `changedSymbolsUsed`
//      (test-analyzer.ts's extractChangedSymbolNames). We don't
//      re-derive this from the diff here — it already did the work —
//      we just fold it into one deduplicated list.
//
// This deliberately does not attempt to detect brand-new symbols
// that aren't referenced by any candidate test; those aren't
// currently evidenced by anything in the pipeline, so listing them
// as "changed" would be a guess rather than a finding.

function buildChangedSymbols(
  analysis: CommitAnalysisLike
): ChangedSymbolSummary[] {
  const seen = new Set<string>();
  const result: ChangedSymbolSummary[] = [];

  const add = (
    name: string,
    file: string,
    changeType: ChangedSymbolSummary["changeType"]
  ) => {
    const key = `${file}:${name}:${changeType}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    result.push({ name, file, changeType });
  };

  for (const rename of analysis.symbolChanges) {
    add(rename.newName, rename.file, "renamed");
  }

  for (const match of analysis.testAnalysis.relatedTests) {
    for (const symbol of match.changedSymbolsUsed ?? []) {
      add(symbol, match.changedFile, "modified");
    }
  }

  return result;
}

// ======================================================
// READ CODE EXCERPTS
// ======================================================

function readExcerpts(
  files: string[],
  repositoryRoot: string,
  maxExcerptChars: number
): CodeExcerpt[] {
  const excerpts: CodeExcerpt[] = [];

  for (const file of dedupe(files)) {
    const absolutePath = path.resolve(repositoryRoot, file);

    let content: string;

    try {
      content = fs.readFileSync(absolutePath, "utf8");
    } catch {
      // File may have been deleted by the commit, or is otherwise
      // unreadable — skip it rather than failing the whole build.
      continue;
    }

    const truncated = content.length > maxExcerptChars;

    excerpts.push({
      file,
      content: truncated ? content.slice(0, maxExcerptChars) : content,
      truncated,
    });
  }

  return excerpts;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}