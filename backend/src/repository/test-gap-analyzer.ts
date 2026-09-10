import type { LLMContext } from "./context-builder.js";

// ======================================================
// TYPES
// ======================================================

/**
 * Two-tier design:
 *
 * TIER 1 — "fallback": expressions like `x ?? y` or `x || y`. These split
 * cleanly into exactly two behavioral cases (pass-through vs. fallback),
 * and we can mechanically check whether the existing test code actually
 * calls the symbol with inputs that exercise each case AND asserts on the
 * result. This is the only kind with real evidence behind its coverage
 * verdict, so it's the only kind that ever produces a `coverageGaps` entry.
 *
 * TIER 2 — everything else (branch, loop, return, param, error-handling).
 * We still detect these lexically from the diff, because they're useful
 * signal for a human reviewing the commit. But we have no reliable way to
 * check whether existing tests actually exercise them (title-keyword
 * matching was proven unreliable — see prior analysis), so their coverage
 * status is always "unknown" and they are NEVER auto-generated against.
 */
export type BehaviorKind =
  | "fallback"
  | "branch"
  | "loop"
  | "return"
  | "param"
  | "error-handling"
  | "other";

export type CoverageStatus = "covered" | "not-covered" | "unknown";

/** One verifiable input/output case belonging to a Tier 1 behavior. */
export interface BehaviorCase {
  /** e.g. "showTitleAndFeatureImage is nullish (null/undefined)" */
  condition: string;
  status: CoverageStatus;
  /** The test code line that proves coverage, if status === "covered". */
  evidence?: string | undefined;
}

/** A single detected change, Tier 1 (with cases) or Tier 2 (cases always empty). */
export interface ChangedBehavior {
  /** Human-readable label derived from the diff line. */
  label: string;
  kind: BehaviorKind;
  /** The exact diff line that produced this signal, for auditability. */
  evidence: string;
  /** Populated only for Tier 1 (fallback) behaviors. */
  cases: BehaviorCase[];
  /**
   * "covered" = every case covered, "not-covered" = every case uncovered,
   * "unknown" = Tier 2 (no case-level verification exists) or mixed cases
   * (use `cases` for the partial picture in that situation).
   */
  overallStatus: CoverageStatus;
}

/** A single, verified, addressable gap — this is what reaches the generator. */
export interface CoverageGap {
  /** Unique label used as the generator's addressesGap contract key. */
  label: string;
  kind: BehaviorKind;
  /** The diff line this gap originated from. */
  evidence: string;
  /** The specific uncovered case, e.g. "value is nullish → falls back to true". */
  condition: string;
}

export interface GapAnalysisInput {
  symbol: string;
  sourceFile: string;
  /**
   * Unified diff text for this symbol/file (lines prefixed with +/-/context).
   * This is the ground truth for "what changed" — everything else in this
   * module is derived from it, not guessed.
   */
  diffText: string;
  existingTestFile?: string;
  existingTestCode?: string;
  notes?: string[];
}

export interface TestGapAnalysis {
  targetSymbol: string;
  sourceFile: string;
  /** Every detected behavior, Tier 1 and Tier 2, for audit/dissertation purposes. */
  changedBehaviors: ChangedBehavior[];
  /** Test titles found in the existing test file. Informational only — NOT used for gap decisions. */
  existingCoverage: string[];
  /** Only Tier 1, verified, not-covered cases. This is what generation targets. */
  coverageGaps: CoverageGap[];
}

// ======================================================
// ENTRY POINT
// ======================================================

export function analyzeCoverageGaps(input: GapAnalysisInput): TestGapAnalysis {
  const testCode = input.existingTestCode ?? "";

  const fallbackBehaviors = extractFallbackBehaviors(input.diffText, input.symbol, testCode);
  const lexicalBehaviors = extractLexicalBehaviors(input.diffText);
  const changedBehaviors = [...fallbackBehaviors, ...lexicalBehaviors];

  const existingCoverage = extractExistingCoverage(testCode);

  const coverageGaps: CoverageGap[] = fallbackBehaviors.flatMap((behavior) =>
    behavior.cases
      .filter((c) => c.status === "not-covered")
      .map((c) => ({
        label: `${behavior.label} — ${c.condition}`,
        kind: behavior.kind,
        evidence: behavior.evidence,
        condition: c.condition,
      }))
  );

  console.log(
    `[GapAnalyzer] Symbol: "${input.symbol}" | ` +
      `diffText length: ${input.diffText?.length ?? 0} chars | ` +
      `testCode length: ${testCode.length} chars | ` +
      `fallback behaviors: ${fallbackBehaviors.length} | ` +
      `lexical (unverified) behaviors: ${lexicalBehaviors.length} | ` +
      `verified coverage gaps: ${coverageGaps.length}`
  );

  if (input.diffText && input.diffText.length > 0 && changedBehaviors.length === 0) {
    console.warn(
      `[GapAnalyzer] ⚠️ WARNING: Diff extracted (${input.diffText.length} chars) but no behaviors detected. ` +
        `Regex patterns may not match this diff format or structure.`
    );
    console.warn(`[GapAnalyzer] DEBUG: Raw diffText for "${input.symbol}":\n${input.diffText}`);
  }

  if (fallbackBehaviors.length > 0 && coverageGaps.length === 0) {
    console.log(
      `[GapAnalyzer] ℹ️ All fallback behaviors for "${input.symbol}" are covered by existing tests.`
    );
  }

  if (lexicalBehaviors.length > 0) {
    console.log(
      `[GapAnalyzer] ℹ️ ${lexicalBehaviors.length} Tier-2 (unverified) behavior(s) detected for ` +
        `"${input.symbol}" — not sent to generator, coverage status unknown by design.`
    );
  }

  return {
    targetSymbol: input.symbol,
    sourceFile: input.sourceFile,
    changedBehaviors,
    existingCoverage,
    coverageGaps,
  };
}

export function analyzeCoverageGapsBatch(inputs: GapAnalysisInput[]): TestGapAnalysis[] {
  return inputs.map(analyzeCoverageGaps);
}

// ======================================================
// TIER 1 — FALLBACK EXPRESSIONS (?? and ||)
// ======================================================
//
// `property: sourceExpr ?? fallbackExpr` (or `||`) splits into exactly two
// behavioral cases:
//   1. pass-through — sourceExpr is not nullish/falsy, its value is used
//   2. fallback      — sourceExpr is nullish/falsy, fallbackExpr is used
//
// We only claim "covered" for a case when we find a call site in the test
// code that (a) passes an input value landing in that case's branch, and
// (b) has a nearby assertion that references the same property. Both are
// required — a call with no assertion proves nothing, and an assertion
// with no matching call proves nothing either.

const FALLBACK_ASSIGNMENT_PATTERN =
  /^\s*([a-zA-Z_$][\w$]*)\s*:\s*(.+?)\s*(\?\?|\|\|)\s*(.+?),?\s*$/;

interface FallbackExpr {
  property: string;
  sourceExpr: string;
  operator: "??" | "||";
  fallbackExpr: string;
}

function extractFallbackExpr(trimmed: string): FallbackExpr | null {
  const m = FALLBACK_ASSIGNMENT_PATTERN.exec(trimmed);
  if (!m || !m[1] || !m[2] || !m[3] || !m[4]) return null;
  return {
    property: m[1],
    sourceExpr: m[2].trim(),
    operator: m[3] as "??" | "||",
    fallbackExpr: m[4].trim(),
  };
}

/** Values that put a `??` or `||` expression into the "fallback" branch. */
function isFallbackTriggeringLiteral(token: string, operator: "??" | "||"): boolean {
  const t = token.trim();
  if (operator === "??") {
    return t === "null" || t === "undefined";
  }
  // `||` — any falsy literal triggers the fallback
  return (
    t === "null" ||
    t === "undefined" ||
    t === "false" ||
    t === "0" ||
    t === '""' ||
    t === "''" ||
    t === "``"
  );
}

/**
 * Find calls to `symbolName(...)` in the test code and, for each, look for
 * an object-literal value passed for `property`. Uses brace-counting
 * (not a single regex) so nested objects in earlier arguments don't
 * corrupt the match.
 */
interface CallSitePropertyValue {
  /** The raw token passed for this property, or "<omitted>" if the key never appears in the call. */
  rawValue: string;
  /** Index into testCode right after the full call expression — used to search for a nearby assertion. */
  searchFrom: number;
}

function findCallSitePropertyValues(
  testCode: string,
  symbolName: string,
  property: string
): CallSitePropertyValue[] {
  const results: CallSitePropertyValue[] = [];
  const callPattern = new RegExp(`\\b${escapeRegex(symbolName)}\\s*\\(`, "g");

  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(testCode)) !== null) {
    const openParenIdx = match.index + match[0].length - 1;
    const closeParenIdx = findMatchingBracket(testCode, openParenIdx, "(", ")");
    if (closeParenIdx === -1) continue;

    const argsText = testCode.slice(openParenIdx + 1, closeParenIdx);
    const propRegex = new RegExp(`\\b${escapeRegex(property)}\\s*:\\s*([^,}]+)`);
    const propMatch = propRegex.exec(argsText);

    results.push({
      rawValue: propMatch && propMatch[1] ? propMatch[1].trim() : "<omitted>",
      searchFrom: closeParenIdx + 1,
    });
  }

  return results;
}

/** Brace/paren counting to find the index of the matching close bracket. */
function findMatchingBracket(text: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Does an `expect(...)` referencing `property` appear within a reasonable window after a call site? */
function hasNearbyAssertion(testCode: string, fromIdx: number, property: string, windowSize = 400): string | null {
  const window = testCode.slice(fromIdx, fromIdx + windowSize);
  const assertPattern = new RegExp(`expect\\([^)]*\\)[^;]*${escapeRegex(property)}[^;]*;`);
  // Also try the more common `expect(x.property).toBe(...)` shape where the
  // property is inside the expect(...) argument itself.
  const assertPattern2 = new RegExp(`expect\\([^)]*${escapeRegex(property)}[^)]*\\)[^;]*;`);

  const m = assertPattern.exec(window) ?? assertPattern2.exec(window);
  return m ? m[0].trim() : null;
}

function extractFallbackBehaviors(
  diffText: string,
  symbolName: string,
  testCode: string
): ChangedBehavior[] {
  const addedLines = getAddedLines(diffText);
  const behaviors: ChangedBehavior[] = [];

  for (const line of addedLines) {
    const fb = extractFallbackExpr(line);
    if (!fb) continue;

    const nullishOrFalsy = fb.operator === "??" ? "nullish (null/undefined)" : "falsy";
    const passThroughCondition = `${fb.property} is provided and not ${nullishOrFalsy}`;
    const fallbackCondition = `${fb.property} is ${nullishOrFalsy} → falls back to \`${truncate(fb.fallbackExpr, 30)}\``;

    const callSites = findCallSitePropertyValues(testCode, symbolName, fb.property);

    const passThroughEvidence = findCoveringCallSite(callSites, testCode, fb, "pass-through");
    const fallbackEvidence = findCoveringCallSite(callSites, testCode, fb, "fallback");

    const cases: BehaviorCase[] = [
      {
        condition: passThroughCondition,
        status: passThroughEvidence ? "covered" : "not-covered",
        evidence: passThroughEvidence ?? undefined,
      },
      {
        condition: fallbackCondition,
        status: fallbackEvidence ? "covered" : "not-covered",
        evidence: fallbackEvidence ?? undefined,
      },
    ];

    const allCovered = cases.every((c) => c.status === "covered");
    const noneCovered = cases.every((c) => c.status === "not-covered");

    behaviors.push({
      label: `\`${fb.property}\` uses \`${fb.sourceExpr}\` with a \`${fb.operator}\` fallback to \`${truncate(fb.fallbackExpr, 30)}\``,
      kind: "fallback",
      evidence: line,
      cases,
      overallStatus: allCovered ? "covered" : noneCovered ? "not-covered" : "unknown",
    });
  }

  return behaviors;
}

function findCoveringCallSite(
  callSites: CallSitePropertyValue[],
  testCode: string,
  fb: FallbackExpr,
  wanted: "pass-through" | "fallback"
): string | null {
  for (const site of callSites) {
    const isOmitted = site.rawValue === "<omitted>";
    const triggersFallback = isOmitted || isFallbackTriggeringLiteral(site.rawValue, fb.operator);
    const kind: "pass-through" | "fallback" = triggersFallback ? "fallback" : "pass-through";

    if (kind !== wanted) continue;

    const assertion = hasNearbyAssertion(testCode, site.searchFrom, fb.property);
    if (assertion) return assertion;
  }
  return null;
}

// ======================================================
// TIER 2 — LEXICAL SIGNALS (unverified; never sent to generator)
// ======================================================
//
// These are still detected for audit/reporting purposes, but we do not
// claim to know their coverage status. Title-keyword matching against test
// names was the previous approach here and was demonstrated to produce
// false positives and false negatives — it is intentionally not used
// anymore. Until a call-site+assertion verifier exists for these kinds
// too, they stay Tier 2.

const ADDED_LINE = /^\+(?!\+\+)(.*)$/;

const BRANCH_PATTERNS: RegExp[] = [
  /\bif\s*\(([^)]*)\)/,
  /\bswitch\s*\(([^)]*)\)/,
  /\bcase\s+([^:]+):/,
  /[^:?]\?[^.?:]+:[^:]/, // ternary operator, excluding ?? and ?.
];

const LOOP_PATTERNS: RegExp[] = [/\bfor\s*\(/, /\bwhile\s*\(/, /\.map\(/, /\.forEach\(/, /\.reduce\(/];

const ERROR_HANDLING_PATTERNS: RegExp[] = [/\btry\s*{/, /\bcatch\s*\(/, /\bthrow\s+/];

const PARAM_PATTERN = /\bfunction\s+\w+\s*\(([^)]*)\)|=>\s*\(?([^)=]*)\)?\s*=>?/;

function getAddedLines(diffText: string): string[] {
  return diffText
    .split("\n")
    .map((line) => ADDED_LINE.exec(line)?.[1])
    .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
    .map((line) => line.trim());
}

function extractLexicalBehaviors(diffText: string): ChangedBehavior[] {
  const signals: ChangedBehavior[] = [];
  const addedLines = getAddedLines(diffText);

  if (addedLines.length === 0 && diffText.trim().length > 0) {
    console.warn(
      `[GapAnalyzer] DEBUG: No added lines found. diffText has ${diffText.length} chars but no +NNNN lines.`
    );
  }

  for (const trimmed of addedLines) {
    // Skip lines already captured as a Tier 1 fallback — don't double-count.
    if (extractFallbackExpr(trimmed)) continue;

    if (BRANCH_PATTERNS.some((p) => p.test(trimmed))) {
      signals.push(unverified(`branches on \`${summarizeCondition(trimmed)}\``, "branch", trimmed));
    }

    if (LOOP_PATTERNS.some((p) => p.test(trimmed))) {
      signals.push(unverified(`iterates (\`${truncate(trimmed, 40)}\`)`, "loop", trimmed));
    }

    if (ERROR_HANDLING_PATTERNS.some((p) => p.test(trimmed))) {
      signals.push(unverified(`handles errors (\`${truncate(trimmed, 40)}\`)`, "error-handling", trimmed));
    }

    if (/\bfunction\b|=>/.test(trimmed) && /\(/.test(trimmed)) {
      const paramMatch = PARAM_PATTERN.exec(trimmed);
      const params = (paramMatch?.[1] ?? paramMatch?.[2] ?? "").trim();
      if (params) {
        signals.push(unverified(`uses parameter(s) \`${truncate(params, 40)}\``, "param", trimmed));
      }
    }

    if (/\breturn\b/.test(trimmed)) {
      signals.push(
        unverified(`returns \`${truncate(trimmed.replace(/^return\s*/, ""), 40)}\``, "return", trimmed)
      );
    }
  }

  return dedupeBehaviors(signals);
}

function unverified(label: string, kind: BehaviorKind, evidence: string): ChangedBehavior {
  return { label, kind, evidence, cases: [], overallStatus: "unknown" };
}

function summarizeCondition(line: string): string {
  const ifMatch = /\bif\s*\(([^)]*)\)/.exec(line);
  if (ifMatch?.[1]) return truncate(ifMatch[1].trim(), 40);
  const caseMatch = /\bcase\s+([^:]+):/.exec(line);
  if (caseMatch?.[1]) return truncate(caseMatch[1].trim(), 40);
  return truncate(line, 40);
}

function dedupeBehaviors(behaviors: ChangedBehavior[]): ChangedBehavior[] {
  const seen = new Set<string>();
  const out: ChangedBehavior[] = [];
  for (const b of behaviors) {
    const key = `${b.kind}:${b.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ======================================================
// EXISTING TEST TITLES (informational only)
// ======================================================
//
// IMPORTANT: this is NOT used to decide coverage anymore. Test titles are
// not evidence of what a test actually exercises — only call sites and
// assertions are. This is kept purely as descriptive metadata for the
// output/dissertation ("here's what the file's tests are named"), never
// as input to a covered/not-covered decision.

const TEST_TITLE_PATTERN = /\b(?:it|test|describe)\s*\(\s*(['"`])(.*?)\1/g;

function extractExistingCoverage(testCode: string): string[] {
  const titles: string[] = [];
  for (const match of testCode.matchAll(TEST_TITLE_PATTERN)) {
    const title = match[2]?.trim();
    if (title) titles.push(title);
  }
  return titles;
}

// ======================================================
// ADAPTER — build inputs from analysis + LLMContext
// ======================================================

/**
 * Extract the unified diff hunk for a specific file from the full rawDiff.
 * Returns the "diff --git" section for that file, or empty string if not found.
 */
function extractFileDiffFromRaw(rawDiff: string, targetFile: string): string {
  const headerPattern = new RegExp(`^diff --git a/.+? b/${escapeRegex(targetFile)}$`, "m");

  const headerMatch = headerPattern.exec(rawDiff);
  if (!headerMatch) {
    console.warn(`[GapAnalyzer] Could not find diff section for "${targetFile}" in rawDiff.`);
    return "";
  }

  const startIdx = headerMatch.index;
  const restOfDiff = rawDiff.slice(startIdx + headerMatch[0].length);
  const nextFileMatch = /\ndiff --git /.exec(restOfDiff);

  const endIdx = nextFileMatch ? startIdx + headerMatch[0].length + nextFileMatch.index : rawDiff.length;

  return rawDiff.slice(startIdx, endIdx);
}

/**
 * Given the diff and a test file path, return just the lines this commit
 * *added* to that test file, joined back into source-shaped text.
 *
 * Why this exists: `context.testCode` is whatever snapshot the caller
 * assembled it from (parent SHA, a cache, an index — we don't control it
 * here). That snapshot can predate this commit's own test additions. If a
 * developer adds a test for the exact behavior they just changed, in the
 * *same* commit, and we only look at the stale snapshot, the analyzer will
 * never see that test — and will confidently regenerate a duplicate for a
 * gap that no longer exists the moment this commit lands.
 *
 * The diff itself always reflects this commit's own additions, regardless
 * of what any external snapshot says. So we pull the `+` lines out of the
 * test file's own hunk and splice them into whatever existingTestCode we
 * were given, rather than trusting the snapshot alone.
 *
 * This is line-level, not AST-level — good enough for the regex-based
 * call-site/assertion matching this module already does, since a
 * hand-written test block is normally added as one contiguous run of `+`
 * lines (so brace/paren balance within that block is preserved).
 */
function extractAddedTestLinesForFile(rawDiff: string, testFile: string): string {
  const testFileDiff = extractFileDiffFromRaw(rawDiff, testFile);
  if (!testFileDiff) return "";
  return getAddedLines(testFileDiff).join("\n");
}

/**
 * Build gap analysis inputs from the analysis object and LLMContext.
 * This wires the real diff data (rawDiff) into the gap analyzer.
 */
export function buildGapAnalysisInputsFromAnalysis(
  changedSymbols: Array<{ name: string; file: string; changeType: string }>,
  rawDiff: string,
  context: LLMContext
): GapAnalysisInput[] {
  console.log(`[GapAnalysisBuilder] rawDiff received: ${rawDiff?.length ?? 0} chars`);

  return changedSymbols.map((symbol) => {
    const fileDiff = extractFileDiffFromRaw(rawDiff, symbol.file);

    console.log(`[GapAnalysisBuilder] Extracted diff for "${symbol.file}": ${fileDiff.length} chars`);

    const candidateForSymbol = context.candidateTests.find(
      (c: any) => c.changedFile === symbol.file
    );
    const testCodeExcerpt = candidateForSymbol
      ? context.testCode.find((tc: any) => tc.file === candidateForSymbol.testFile)
      : undefined;

    const input: GapAnalysisInput = {
      symbol: symbol.name,
      sourceFile: symbol.file,
      diffText: fileDiff || "",
      notes: [`Symbol ${symbol.changeType}`],
    };

    if (candidateForSymbol?.testFile) {
      input.existingTestFile = candidateForSymbol.testFile;

      // See extractAddedTestLinesForFile: this commit may have added a test
      // for this exact symbol, and the snapshot in context.testCode may not
      // reflect that yet. Splice the diff's own added test lines in so the
      // coverage check sees them regardless.
      const addedTestLines = extractAddedTestLinesForFile(rawDiff, candidateForSymbol.testFile);
      const baseTestCode = testCodeExcerpt?.content ?? "";

      if (addedTestLines) {
        const alreadyPresent = baseTestCode.includes(addedTestLines);
        console.log(
          `[GapAnalysisBuilder] Test file "${candidateForSymbol.testFile}": ` +
            `${addedTestLines.split("\n").length} added line(s) found in this commit's diff` +
            (alreadyPresent
              ? " (already present in the provided testCode snapshot — no merge needed)."
              : " — NOT found in the provided testCode snapshot. Merging them in before analysis " +
                "so a same-commit test isn't mistaken for a coverage gap.")
        );

        input.existingTestCode = alreadyPresent
          ? baseTestCode
          : baseTestCode
          ? `${baseTestCode}\n${addedTestLines}`
          : addedTestLines;
      } else if (baseTestCode) {
        input.existingTestCode = baseTestCode;
      }
    }

    return input;
  });
}