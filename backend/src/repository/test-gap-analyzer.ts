import type { LLMContext } from "./context-builder.js";
import type { ILLMClient } from "./llm-client.js";
import {
  findSymbolRange,
  extractSymbolDiff,
} from "./symbol-diff-extractor.js";

// ======================================================
// TYPES
// ======================================================

export type BehaviorKind =
  | "fallback"
  | "branch"
  | "loop"
  | "return"
  | "param"
  | "error-handling"
  | "other";

export type CoverageStatus = "covered" | "not-covered" | "unknown";

export interface BehaviorCase {
  condition: string;
  status: CoverageStatus;
  evidence?: string;
}

export interface ChangedBehavior {
  label: string;
  kind: BehaviorKind;
  evidence: string;
  cases: BehaviorCase[];
  overallStatus: CoverageStatus;
}

export interface CoverageGap {
  label: string;
  kind: BehaviorKind;
  evidence: string;
  condition: string;
}

export interface GapAnalysisInput {
  symbol: string;
  sourceFile: string;
  diffText: string;
  existingTestFile?: string;
  existingTestCode?: string;
  notes?: string[];
  repositoryRoot: string;
}

export interface TestGapAnalysis {
  targetSymbol: string;
  sourceFile: string;
  changedBehaviors: ChangedBehavior[];
  existingCoverage: string[];
  coverageGaps: CoverageGap[];
}

// ======================================================
// ENTRY POINT
// ======================================================

export async function analyzeCoverageGaps(
  input: GapAnalysisInput,
  llmClient: ILLMClient
): Promise<TestGapAnalysis> {
  const testCode = input.existingTestCode ?? "";

  // Tier 1: fallback expressions
  const fallbackBehaviors = await extractFallbackBehaviors(
    input.diffText,
    input.symbol,
    testCode,
    llmClient
  );

  // Tier 2: general changed behaviors
  const lexicalBehaviors = extractLexicalBehaviors(input.diffText);

  const changedBehaviors = [
    ...fallbackBehaviors,
    ...lexicalBehaviors,
  ];

  const existingCoverage = extractExistingCoverage(testCode);

  // ======================================================
  // BUILD GENERATION TARGETS
  // ======================================================
  //
  // IMPORTANT:
  // We no longer restrict generation to fallback (?? / ||)
  // behaviors.
  //
  // Tier 1:
  //   - not-covered -> generate
  //   - unknown      -> also allow generation
  //
  // Tier 2:
  //   - every meaningful changed behavior becomes a
  //     generation candidate.
  //
  // This keeps the system practical instead of requiring
  // perfect coverage proof before generating a test.
  // ======================================================

  const coverageGaps: CoverageGap[] = [];

  // ------------------------------------------------------
  // Tier 1 - fallback behaviors
  // ------------------------------------------------------

  for (const behavior of fallbackBehaviors) {
    for (const testCase of behavior.cases) {
      if (
        testCase.status === "not-covered" ||
        testCase.status === "unknown"
      ) {
        coverageGaps.push({
          label: `${behavior.label} — ${testCase.condition}`,
          kind: behavior.kind,
          evidence: behavior.evidence,
          condition: testCase.condition,
        });
      }
    }
  }

  // ------------------------------------------------------
  // Tier 2 - general behaviors
  // ------------------------------------------------------
  //
  // These used to be marked "unknown" and completely blocked
  // from generation.
  //
  // Now they are allowed to become generation targets.
  // The LLM generator can decide how to write the test.
  // ------------------------------------------------------

  for (const behavior of lexicalBehaviors) {
    coverageGaps.push({
      label: behavior.label,
      kind: behavior.kind,
      evidence: behavior.evidence,
      condition: `Changed behavior: ${behavior.label}`,
    });
  }

  // Remove duplicate generation targets
  const uniqueCoverageGaps = dedupeCoverageGaps(coverageGaps);

  console.log(
    `[GapAnalyzer] Symbol: "${input.symbol}" | ` +
      `diffText length: ${input.diffText?.length ?? 0} chars | ` +
      `testCode length: ${testCode.length} chars | ` +
      `fallback behaviors: ${fallbackBehaviors.length} | ` +
      `lexical behaviors: ${lexicalBehaviors.length} | ` +
      `generation targets: ${uniqueCoverageGaps.length}`
  );

  // ------------------------------------------------------
  // Debug: diff exists but nothing was detected
  // ------------------------------------------------------

  if (
    input.diffText &&
    input.diffText.length > 0 &&
    changedBehaviors.length === 0
  ) {
    console.warn(
      `[GapAnalyzer] ⚠️ WARNING: Diff extracted (${input.diffText.length} chars) ` +
        `but no behaviors detected.`
    );

    console.warn(
      `[GapAnalyzer] DEBUG: Raw diffText for "${input.symbol}":\n` +
        input.diffText.substring(0, 1000)
    );

    const addedLines = getAddedLines(input.diffText);

    console.warn(
      `[GapAnalyzer] DEBUG: Added lines (${addedLines.length}): ` +
        JSON.stringify(addedLines.slice(0, 10))
    );
  }

  if (fallbackBehaviors.length > 0) {
    console.log(
      `[GapAnalyzer] ℹ️ Detected ${fallbackBehaviors.length} fallback behavior(s).`
    );
  }

  if (lexicalBehaviors.length > 0) {
    console.log(
      `[GapAnalyzer] ℹ️ Detected ${lexicalBehaviors.length} general behavior(s). ` +
        `These are now allowed to reach the generator.`
    );
  }

  if (uniqueCoverageGaps.length > 0) {
    console.log(
      `[GapAnalyzer] ✅ Generation targets for "${input.symbol}":`
    );

    uniqueCoverageGaps.forEach((gap, index) => {
      console.log(
        `  ${index + 1}. [${gap.kind}] ${gap.label}`
      );
    });
  } else {
    console.log(
      `[GapAnalyzer] ℹ️ No generation targets found for "${input.symbol}".`
    );
  }

  return {
    targetSymbol: input.symbol,
    sourceFile: input.sourceFile,
    changedBehaviors,
    existingCoverage,
    coverageGaps: uniqueCoverageGaps,
  };
}

export async function analyzeCoverageGapsBatch(
  inputs: GapAnalysisInput[],
  llmClient: ILLMClient
): Promise<TestGapAnalysis[]> {
  return Promise.all(
    inputs.map((input) =>
      analyzeCoverageGaps(input, llmClient)
    )
  );
}

// ======================================================
// TIER 1 — FALLBACK EXPRESSIONS
// ======================================================

const FALLBACK_PROPERTY_PATTERN =
  /^\s*([a-zA-Z_$][\w$]*)\s*:\s*(.+?)\s*(\?\?|\|\|)\s*(.+?),?\s*$/;

const FALLBACK_VARIABLE_PATTERN =
  /^\s*(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(.+?)\s*(\?\?|\|\|)\s*(.+?)\s*;?\s*$/;

interface FallbackExpr {
  property: string;
  sourceExpr: string;
  operator: "??" | "||";
  fallbackExpr: string;
  isVariableAssignment: boolean;
}

function extractFallbackExpr(
  trimmed: string
): FallbackExpr | null {
  const propertyMatch =
    FALLBACK_PROPERTY_PATTERN.exec(trimmed);

  if (
    propertyMatch &&
    propertyMatch[1] &&
    propertyMatch[2] &&
    propertyMatch[3] &&
    propertyMatch[4]
  ) {
    return {
      property: propertyMatch[1],
      sourceExpr: propertyMatch[2].trim(),
      operator:
        propertyMatch[3] === "??" ? "??" : "||",
      fallbackExpr: propertyMatch[4].trim(),
      isVariableAssignment: false,
    };
  }

  const variableMatch =
    FALLBACK_VARIABLE_PATTERN.exec(trimmed);

  if (
    variableMatch &&
    variableMatch[1] &&
    variableMatch[2] &&
    variableMatch[3] &&
    variableMatch[4]
  ) {
    return {
      property: variableMatch[1],
      sourceExpr: variableMatch[2].trim(),
      operator:
        variableMatch[3] === "??" ? "??" : "||",
      fallbackExpr: variableMatch[4].trim(),
      isVariableAssignment: true,
    };
  }

  if (
    trimmed.includes("??") ||
    trimmed.includes("||")
  ) {
    console.log(
      `[GapAnalyzer-Fallback] Line contains ?? or || but ` +
        `didn't match fallback pattern: "${trimmed}"`
    );
  }

  return null;
}

// ======================================================
// FALLBACK COVERAGE VERIFICATION
// ======================================================

async function verifyFallbackCoverage(
  fb: FallbackExpr,
  passThroughCondition: string,
  fallbackCondition: string,
  testCode: string,
  symbolName: string,
  llmClient: ILLMClient
): Promise<BehaviorCase[]> {
  const systemPrompt = `
You are a code coverage analyst.

Determine whether each behavioral case of a fallback expression
using ?? or || is covered by the existing tests.

A case is covered only if:

1. A test calls the relevant function with an input that exercises
   that behavior.
2. The test contains an assertion checking the resulting behavior.

Return JSON only.

Format:

{
  "cases": [
    {
      "condition": "exact condition provided",
      "status": "covered" | "not-covered",
      "evidence": "short evidence"
    }
  ]
}

If coverage cannot be determined, use "unknown".

Do not invent evidence.
`;

  const userPrompt = `
Analyze the following changed behavior.

FALLBACK EXPRESSION:
Property: ${fb.property}
Source expression: ${fb.sourceExpr}
Operator: ${fb.operator}
Fallback expression: ${fb.fallbackExpr}
Type: ${
    fb.isVariableAssignment
      ? "variable assignment"
      : "object property"
  }

BEHAVIORAL CASES:

1. ${passThroughCondition}

2. ${fallbackCondition}

SYMBOL:
${symbolName}

EXISTING TEST CODE:

\`\`\`
${testCode}
\`\`\`

Return JSON only.
`;

  try {
    interface LLMCoverageResponse {
      cases?: Array<{
        condition: string;
        status:
          | "covered"
          | "not-covered"
          | "unknown";
        evidence?: string;
      }>;
    }

    const response =
      await llmClient.generateJSON<LLMCoverageResponse>(
        systemPrompt,
        userPrompt
      );

    console.log(
      `[GapAnalyzer-LLM] Coverage verification for "${fb.property}": ` +
        `${response.cases?.length ?? 0} verdict(s)`
    );

    const resultCases: BehaviorCase[] = [
      {
        condition: passThroughCondition,
        status: "unknown",
      },
      {
        condition: fallbackCondition,
        status: "unknown",
      },
    ];

    if (response.cases) {
      for (const llmCase of response.cases) {
        const matchingCase = resultCases.find(
          (item) =>
            item.condition === llmCase.condition
        );

        if (matchingCase) {
          matchingCase.status = llmCase.status;
          if (llmCase.evidence !== undefined) {
            matchingCase.evidence = llmCase.evidence;
          }
        }
      }
    }

    return resultCases;
  } catch (error) {
    console.warn(
      `[GapAnalyzer-LLM] Coverage verification failed for ` +
        `"${fb.property}": ${
          error instanceof Error
            ? error.message
            : String(error)
        }`
    );

    return [
      {
        condition: passThroughCondition,
        status: "unknown",
      },
      {
        condition: fallbackCondition,
        status: "unknown",
      },
    ];
  }
}

// ======================================================
// FALLBACK BEHAVIOR EXTRACTION
// ======================================================

async function extractFallbackBehaviors(
  diffText: string,
  symbolName: string,
  testCode: string,
  llmClient: ILLMClient
): Promise<ChangedBehavior[]> {
  const addedLines = getAddedLines(diffText);
  const behaviors: ChangedBehavior[] = [];

  console.log(
    `[GapAnalyzer-Fallback] Processing ${addedLines.length} ` +
      `added lines for symbol "${symbolName}"`
  );

  for (const line of addedLines) {
    const fb = extractFallbackExpr(line);

    if (!fb) continue;

    const nullishOrFalsy =
      fb.operator === "??"
        ? "nullish (null/undefined)"
        : "falsy";

    const passThroughCondition =
      `${fb.property} is provided and not ${nullishOrFalsy}`;

    const fallbackCondition =
      `${fb.property} is ${nullishOrFalsy} → ` +
      `falls back to \`${truncate(
        fb.fallbackExpr,
        30
      )}\``;

    if (!testCode || testCode.trim().length === 0) {
      behaviors.push({
        label:
          `\`${fb.property}\` uses ` +
          `\`${fb.sourceExpr}\` with ` +
          `\`${fb.operator}\` fallback to ` +
          `\`${truncate(fb.fallbackExpr, 30)}\``,
        kind: "fallback",
        evidence: line,
        cases: [
          {
            condition: passThroughCondition,
            status: "not-covered",
          },
          {
            condition: fallbackCondition,
            status: "not-covered",
          },
        ],
        overallStatus: "not-covered",
      });

      continue;
    }

    const cases = await verifyFallbackCoverage(
      fb,
      passThroughCondition,
      fallbackCondition,
      testCode,
      symbolName,
      llmClient
    );

    const allCovered =
      cases.length > 0 &&
      cases.every(
        (c) => c.status === "covered"
      );

    const noneCovered =
      cases.length > 0 &&
      cases.every(
        (c) => c.status === "not-covered"
      );

    behaviors.push({
      label:
        `\`${fb.property}\` uses ` +
        `\`${fb.sourceExpr}\` with ` +
        `\`${fb.operator}\` fallback to ` +
        `\`${truncate(fb.fallbackExpr, 30)}\``,
      kind: "fallback",
      evidence: line,
      cases,
      overallStatus: allCovered
        ? "covered"
        : noneCovered
        ? "not-covered"
        : "unknown",
    });
  }

  return behaviors;
}

// ======================================================
// TIER 2 — GENERAL CHANGED BEHAVIORS
// ======================================================

const BRANCH_PATTERNS: RegExp[] = [
  /\bif\s*\(([^)]*)\)/,
  /\bswitch\s*\(([^)]*)\)/,
  /\bcase\s+([^:]+):/,
  /[^:?]\?[^.?:]+:[^:]/,
];

const LOOP_PATTERNS: RegExp[] = [
  /\bfor\s*\(/,
  /\bwhile\s*\(/,
  /\.map\(/,
  /\.forEach\(/,
  /\.reduce\(/,
];

const ERROR_HANDLING_PATTERNS: RegExp[] = [
  /\btry\s*{/,
  /\bcatch\s*\(/,
  /\bthrow\s+/,
];

const PARAM_PATTERN =
  /\bfunction\s+\w+\s*\(([^)]*)\)|=>\s*\(?([^)=]*)\)?\s*=>?/;

function extractLexicalBehaviors(
  diffText: string
): ChangedBehavior[] {
  const signals: ChangedBehavior[] = [];
  const addedLines = getAddedLines(diffText);

  for (const trimmed of addedLines) {
    // Fallback behavior is already handled separately.
    if (extractFallbackExpr(trimmed)) {
      continue;
    }

    if (
      BRANCH_PATTERNS.some((pattern) =>
        pattern.test(trimmed)
      )
    ) {
      signals.push(
        generationCandidate(
          `branches on \`${summarizeCondition(
            trimmed
          )}\``,
          "branch",
          trimmed
        )
      );
    }

    if (
      LOOP_PATTERNS.some((pattern) =>
        pattern.test(trimmed)
      )
    ) {
      signals.push(
        generationCandidate(
          `iterates (\`${truncate(
            trimmed,
            40
          )}\`)`,
          "loop",
          trimmed
        )
      );
    }

    if (
      ERROR_HANDLING_PATTERNS.some((pattern) =>
        pattern.test(trimmed)
      )
    ) {
      signals.push(
        generationCandidate(
          `handles errors (\`${truncate(
            trimmed,
            40
          )}\`)`,
          "error-handling",
          trimmed
        )
      );
    }

    if (
      (/\bfunction\b|=>/.test(trimmed)) &&
      /\(/.test(trimmed)
    ) {
      const paramMatch =
        PARAM_PATTERN.exec(trimmed);

      const params = (
        paramMatch?.[1] ??
        paramMatch?.[2] ??
        ""
      ).trim();

      if (params) {
        signals.push(
          generationCandidate(
            `uses parameter(s) \`${truncate(
              params,
              40
            )}\``,
            "param",
            trimmed
          )
        );
      }
    }

    if (/\breturn\b/.test(trimmed)) {
      // ===================================================
      // FILTER: Skip returns that reference internal state
      // ===================================================
      // Don't create test gaps for returns that involve:
      // - Direct state property access (.v, .d, .e)
      // - Internal dev_ APIs that expose state
      // - Wrapped/proxy object manipulation
      const isInternalStateReturn = /\.(v|d|e)\b|dev_get_atom_state|wrapped|proxy|toPrimitive|\[INTERNAL\]/i.test(trimmed);
      
      if (!isInternalStateReturn) {
        signals.push(
          generationCandidate(
            `returns \`${truncate(
              trimmed.replace(/^return\s*/, ""),
              40
            )}\``,
            "return",
            trimmed
          )
        );
      } else {
        console.log(`[Gap-Analyzer] Skipping internal-state return: ${truncate(trimmed, 50)}`);
      }
    }
  }

  return dedupeBehaviors(signals);
}

function generationCandidate(
  label: string,
  kind: BehaviorKind,
  evidence: string
): ChangedBehavior {
  return {
    label,
    kind,
    evidence,
    cases: [],
    overallStatus: "unknown",
  };
}

// ======================================================
// HELPERS
// ======================================================

function summarizeCondition(
  line: string
): string {
  const ifMatch =
    /\bif\s*\(([^)]*)\)/.exec(line);

  if (ifMatch?.[1]) {
    return truncate(
      ifMatch[1].trim(),
      40
    );
  }

  const caseMatch =
    /\bcase\s+([^:]+):/.exec(line);

  if (caseMatch?.[1]) {
    return truncate(
      caseMatch[1].trim(),
      40
    );
  }

  return truncate(line, 40);
}

function dedupeBehaviors(
  behaviors: ChangedBehavior[]
): ChangedBehavior[] {
  const seen = new Set<string>();
  const output: ChangedBehavior[] = [];

  for (const behavior of behaviors) {
    const key =
      `${behavior.kind}:${behavior.label}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(behavior);
  }

  return output;
}

function dedupeCoverageGaps(
  gaps: CoverageGap[]
): CoverageGap[] {
  const seen = new Set<string>();
  const output: CoverageGap[] = [];

  for (const gap of gaps) {
    const key =
      `${gap.kind}:${gap.label}:${gap.condition}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(gap);
  }

  return output;
}

function truncate(
  text: string,
  max: number
): string {
  return text.length > max
    ? `${text.slice(0, max)}…`
    : text;
}

function escapeRegex(
  str: string
): string {
  return str.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

// ======================================================
// EXISTING TEST TITLES
// ======================================================

const TEST_TITLE_PATTERN =
  /\b(?:it|test|describe)\s*\(\s*(['"`])(.*?)\1/g;

function extractExistingCoverage(
  testCode: string
): string[] {
  const titles: string[] = [];

  for (
    const match of testCode.matchAll(
      TEST_TITLE_PATTERN
    )
  ) {
    const title = match[2]?.trim();

    if (title) {
      titles.push(title);
    }
  }

  return titles;
}

// ======================================================
// DIFF HELPERS
// ======================================================

function getAddedLines(
  diffText: string
): string[] {
  const addedPattern =
    /^\+(?!\+\+)(.*)$/gm;

  const results: string[] = [];
  let match: RegExpExecArray | null;

  while (
    (match = addedPattern.exec(diffText)) !== null
  ) {
    const line = match[1]?.trim();

    if (line) {
      results.push(line);
    }
  }

  return results;
}

// ======================================================
// FILE DIFF EXTRACTION
// ======================================================

function extractFileDiffFromRaw(
  rawDiff: string,
  targetFile: string
): string {
  const headerPattern = new RegExp(
    `^diff --git a/.+? b/${escapeRegex(
      targetFile
    )}$`,
    "m"
  );

  const headerMatch =
    headerPattern.exec(rawDiff);

  if (!headerMatch) {
    console.warn(
      `[GapAnalyzer] Could not find diff section for "${targetFile}".`
    );

    return "";
  }

  const startIdx = headerMatch.index;

  const restOfDiff = rawDiff.slice(
    startIdx + headerMatch[0].length
  );

  const nextFileMatch =
    /\ndiff --git /.exec(restOfDiff);

  const endIdx = nextFileMatch
    ? startIdx +
      headerMatch[0].length +
      nextFileMatch.index
    : rawDiff.length;

  const extracted = rawDiff.slice(
    startIdx,
    endIdx
  );

  console.log(
    `[GapAnalyzer-Extract] Found header for "${targetFile}", ` +
      `extracted ${extracted.length} chars`
  );

  return extracted;
}

function extractAddedTestLinesForFile(
  rawDiff: string,
  testFile: string
): string {
  const testFileDiff =
    extractFileDiffFromRaw(
      rawDiff,
      testFile
    );

  if (!testFileDiff) {
    return "";
  }

  return getAddedLines(
    testFileDiff
  ).join("\n");
}

// ======================================================
// BUILD GAP ANALYSIS INPUTS
// ======================================================

export function buildGapAnalysisInputsFromAnalysis(
  changedSymbols: Array<{
    name: string;
    file: string;
    changeType: string;
  }>,
  rawDiff: string,
  context: LLMContext,
  repositoryRoot: string
): GapAnalysisInput[] {
  console.log(
    "\n========== GAP INPUT DEBUG START =========="
  );

  console.log(
    `[GapAnalysisBuilder] Building inputs for ` +
      `${changedSymbols.length} symbol(s)`
  );

  console.log(
    `[GapAnalysisBuilder] rawDiff received: ` +
      `${rawDiff?.length ?? 0} chars`
  );

  console.log(
    `[GapAnalysisBuilder] repositoryRoot: ` +
      `${repositoryRoot}`
  );

  const inputs: GapAnalysisInput[] = [];

  for (const symbol of changedSymbols) {
    console.log(
      `\n[GapAnalysisBuilder] Processing symbol: ` +
        `"${symbol.name}"`
    );

    // IMPORTANT:
    // Keep symbol-specific diff extraction.
    const symbolRange = findSymbolRange(
      repositoryRoot,
      symbol.file,
      symbol.name
    );

    console.log(
      `[GapAnalysisBuilder] Symbol range: ` +
        `lines ${symbolRange?.startLine ?? "unknown"}–` +
        `${symbolRange?.endLine ?? "unknown"}`
    );

    const symbolDiff = symbolRange
      ? extractSymbolDiff(
          rawDiff,
          symbol.file,
          symbolRange
        )
      : "";

    console.log(
      `[GapAnalysisBuilder] Extracted diff: ` +
        `${symbolDiff.length} chars`
    );

    // Find ALL related test files.
    const allCandidatesForSymbol =
      context.candidateTests.filter(
        (candidate: any) =>
          candidate.changedFile === symbol.file
      );

    console.log(
      `[GapAnalysisBuilder] Found ` +
        `${allCandidatesForSymbol.length} related test file(s)`
    );

    allCandidatesForSymbol.forEach(
      (candidate: any) => {
        console.log(
          `[GapAnalysisBuilder] - ${candidate.testFile}`
        );
      }
    );

    // Combine existing test code from all related files.
    const allTestCode =
      allCandidatesForSymbol
        .map((candidate: any) => {
          const testCodeExcerpt =
            context.testCode.find(
              (tc: any) =>
                tc.file === candidate.testFile
            );

          return (
            testCodeExcerpt?.content ?? ""
          );
        })
        .filter(
          (code: string) =>
            code.length > 0
        )
        .join(
          "\n\n// ===== Next test file =====\n\n"
        );

    console.log(
      `[GapAnalysisBuilder] Combined test code: ` +
        `${allTestCode.length} chars`
    );

    const input: GapAnalysisInput = {
      symbol: symbol.name,
      sourceFile: symbol.file,

      // Keep the new symbol-specific diff.
      diffText: symbolDiff || "",

      repositoryRoot,

      notes: [
        `Symbol ${symbol.changeType}`,
        `Checking coverage across ` +
          `${allCandidatesForSymbol.length} related test file(s)`,
      ],
    };

    if (
      allCandidatesForSymbol.length > 0
    ) {
      input.existingTestFile =
        allCandidatesForSymbol
          .map(
            (candidate: any) =>
              candidate.testFile
          )
          .join(" | ");

      const allAddedTestLines: string[] =
        [];

      for (
        const candidate of allCandidatesForSymbol
      ) {
        const addedTestLines =
          extractAddedTestLinesForFile(
            rawDiff,
            candidate.testFile
          );

        if (addedTestLines) {
          allAddedTestLines.push(
            addedTestLines
          );
        }
      }

      const addedTestLinesStr =
        allAddedTestLines.join(
          "\n\n// ===== Added in next file =====\n\n"
        );

      const combinedTestCode =
        allTestCode
          ? addedTestLinesStr
            ? `${allTestCode}

 // ===== Added in this commit =====

${addedTestLinesStr}`
            : allTestCode
          : addedTestLinesStr;

      if (combinedTestCode) {
        console.log(
          `[GapAnalysisBuilder] Final test code ` +
            `for gap analysis: ` +
            `${combinedTestCode.length} chars`
        );

        input.existingTestCode =
          combinedTestCode;
      }
    }

    inputs.push(input);

    console.log(
      `[GapAnalysisBuilder] ✓ Input prepared: ` +
        `diffLength=${input.diffText?.length ?? 0}, ` +
        `testCodeLength=${input.existingTestCode?.length ?? 0}`
    );
  }

  console.log(
    `\n[GapAnalysisBuilder] TOTAL INPUTS CREATED: ` +
      `${inputs.length}`
  );

  console.log(
    "========== GAP INPUT DEBUG END ==========\n"
  );

  return inputs;
}