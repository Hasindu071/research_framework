import type { LLMContext } from "./context-builder.js";
import type { LLMClient } from "./llm-client.js";
import type { PrioritizedTest } from "./test-prioritizer.js";
import type { TestMatch } from "./test-analyzer.js";
import { resolveTargetTestFile } from "./test-file-writer.js";
import {
  TEST_GENERATOR_SYSTEM_PROMPT,
  buildTestGeneratorUserPrompt,
} from "./generator-prompts.js";
import type {
  TestGenerationTarget,
  GeneratedTestCase,
  TestGenerationResult,
  TestGenerationBatchResult,
} from "./generator-types.js";
import {
  analyzeCoverageGapsBatch,
  buildGapAnalysisInputsFromAnalysis,
  type TestGapAnalysis,
} from "./test-gap-analyzer.js";

/**
 * Result of building generation targets, including the gap analysis that
 * informed which targets to create.
 */
export interface GenerationTargetingResult {
  targets: TestGenerationTarget[];
  gapAnalyses: TestGapAnalysis[];
}

/** Raw shape we ask the LLM for — see generator-prompts.ts. */
interface RawGenerationResponse {
  testCases?: Partial<GeneratedTestCase>[];
}

const MAX_GENERATED_TESTS_PER_TARGET = 8;

// ======================================================
// BUILD TARGETS FROM PRIORITIZED TESTS
// ======================================================

/**
 * Turns prioritized test results + LLMContext into concrete generation
 * targets. Each target is one changed symbol referenced by a prioritized
 * test that has at least one verified (Tier-1) coverage gap.
 *
 * Symbols with zero coverageGaps are skipped entirely — either they're
 * fully covered, or (currently) they only have Tier-2 unverified signals,
 * which we deliberately do not generate against yet.
 *
 * IMPORTANT: for each changed symbol we no longer trust "whichever
 * candidate test the prioritizer happened to rank first" as the file to
 * extend. `context.candidateTests` can contain several TestMatch entries
 * for the same source file (e.g. both a same-directory guess and a real
 * symbol-usage match). We instead resolve a single best target test file
 * per source file via resolveTargetTestFile(), using relationship strength
 * (symbol-usage > import > same-name > same-directory > locale-import >
 * dependency). If nothing matched at all, the target is flagged
 * `isNewTestFile: true` and a fresh co-located test file will be created
 * for it rather than falling back to some other file.
 *
 * Returns both the targets (for generation) and the full gap analyses
 * (for audit/reporting).
 */
export async function buildGenerationTargets(
  prioritized: PrioritizedTest[],
  context: LLMContext,
  llmClient: LLMClient,
  rawDiff: string,
  options: { topN?: number } = {}
): Promise<GenerationTargetingResult> {
  const topN = options.topN ?? prioritized.length;
  const chosenTestFiles = new Set(
    prioritized.slice(0, topN).map((test) => test.testFile)
  );

  const targets: TestGenerationTarget[] = [];
  const allGapAnalyses: TestGapAnalysis[] = [];
  // Dedup by symbol name — several candidate tests could all relate to the
  // same changed symbol; we only ever build one target for it.
  const seenSymbols = new Set<string>();

  // A changed symbol is "in scope" if at least one of the top-N prioritized
  // test files has a real relationship to its file — this preserves the
  // original "only bother with symbols something highly-ranked cares about"
  // filtering, without letting that highly-ranked test file dictate which
  // file gets edited if a stronger-evidence match exists elsewhere.
  const relevantSymbols = context.changedSymbols.filter((symbol) =>
    context.candidateTests.some(
      (candidate) =>
        candidate.changedFile === symbol.file &&
        chosenTestFiles.has(candidate.testFile)
    )
  );

  for (const symbol of relevantSymbols) {
    if (seenSymbols.has(symbol.name)) {
      console.log(
        `[Test-Generator] Skipping "${symbol.name}" — already built a target for this symbol`
      );
      continue;
    }

    const matchesForFile = context.candidateTests.filter(
      (candidate) => candidate.changedFile === symbol.file
    ) as TestMatch[];

    const resolution = resolveTargetTestFile(symbol.file, matchesForFile);

    const gapInputs = buildGapAnalysisInputsFromAnalysis(
      [symbol],
      rawDiff,
      context
    );
    const gapAnalyses = await analyzeCoverageGapsBatch(gapInputs, llmClient);

    // Keep all gap analyses for reporting (regardless of whether gaps were found)
    allGapAnalyses.push(...gapAnalyses);

    const gapAnalysis = gapAnalyses.find((g) => g.targetSymbol === symbol.name);

    if (!gapAnalysis || gapAnalysis.coverageGaps.length === 0) {
      console.log(
        `[Test-Generator] Skipping "${symbol.name}" — ` +
          `${!gapAnalysis ? "no gap analysis found" : "no verified coverage gaps (fully covered, or only unverified Tier-2 signals present)"}`
      );
      continue;
    }

    seenSymbols.add(symbol.name);

    console.log(
      `[Test-Generator] Creating target for "${symbol.name}" with ${gapAnalysis.coverageGaps.length} verified gap(s) — ` +
        (resolution.isNewFile
          ? `no related test file found, will create "${resolution.testFile}"`
          : `extending "${resolution.testFile}" (${resolution.match?.relationship}, confidence ${resolution.match?.confidence})`)
    );

    const sourceCodeExcerpt = context.sourceCode.find((s) => s.file === symbol.file);
    const testCodeExcerpt = resolution.isNewFile
      ? undefined
      : context.testCode.find((t) => t.file === resolution.testFile);
    const testFramework = inferFrameworkFromFileName(resolution.testFile);

    const relatedPrioritizedEvidence = prioritized
      .filter((p) => matchesForFile.some((m) => m.testFile === p.testFile))
      .flatMap((p) => p.evidence);

    targets.push({
      symbol: symbol.name,
      sourceFile: symbol.file,
      changedCode: sourceCodeExcerpt?.content ?? "",
      commitMessage: context.commit.message,
      existingTestFile: resolution.testFile,
      existingTestCode: testCodeExcerpt?.content ?? "",
      // NOTE: TestGenerationTarget in generator-types.ts needs this field
      // added — it's what test-runner.ts uses to decide whether to
      // scaffold a brand-new file or extend an existing one.
      isNewTestFile: resolution.isNewFile,
      framework: testFramework,
      notes: [
        `Symbol ${symbol.changeType}`,
        resolution.isNewFile
          ? "No related test file found for this source file — a new test file will be created"
          : `Selected as the single best related test file via "${resolution.match?.relationship}" relationship`,
        ...relatedPrioritizedEvidence,
      ],
      coverageGaps: gapAnalysis.coverageGaps,
    } as TestGenerationTarget);
  }

  return { targets, gapAnalyses: allGapAnalyses };
}

function inferFrameworkFromFileName(testFile: string): string {
  if (testFile.includes("playwright") || /\.e2e\./.test(testFile)) {
    return "playwright";
  }
  if (testFile.includes("jest")) {
    return "jest";
  }
  if (testFile.includes("vitest")) {
    return "vitest";
  }
  if (testFile.includes("mocha")) {
    return "mocha";
  }
  return "vitest"; // default
}

// ======================================================
// GENERATE TESTS
// ======================================================

export async function generateTests(
  targets: TestGenerationTarget[],
  llmClient: LLMClient
): Promise<TestGenerationBatchResult> {
  if (targets.length === 0) {
    console.log("[Test-Generator] No generation targets, skipping LLM calls");
    return { results: [] };
  }

  console.log(`[Test-Generator] Generating tests for ${targets.length} target(s)`);

  const results: TestGenerationResult[] = [];

  for (const target of targets) {
    try {
      const result = await generateTestsForTarget(target, llmClient);
      results.push(result);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `[Test-Generator] ⚠️ Generation failed for "${target.symbol}" (${target.sourceFile})`
      );
      console.error(`[Test-Generator] Error: ${errorMsg}`);

      results.push({
        testFile: target.existingTestFile ?? inferTestFileName(target),
        targetSymbol: target.symbol,
        generatedTests: [],
        error: errorMsg,
      });
    }
  }

  return { results };
}

async function generateTestsForTarget(
  target: TestGenerationTarget,
  llmClient: LLMClient
): Promise<TestGenerationResult> {
  const userPrompt = buildTestGeneratorUserPrompt(target);
  console.log(
    `[Test-Generator] Requesting test cases for "${target.symbol}" (${userPrompt.length} chars prompt, ${target.coverageGaps.length} gap(s) to fill)`
  );

  const raw = await llmClient.generateJSON<RawGenerationResponse>(
    TEST_GENERATOR_SYSTEM_PROMPT,
    userPrompt
  );

  const generatedTests = validateAndNormalize(raw, target);

  console.log(
    `[Test-Generator] ✓ Got ${generatedTests.length}/${target.coverageGaps.length} verified test case(s) for "${target.symbol}"`
  );

  return {
    testFile: target.existingTestFile ?? inferTestFileName(target),
    targetSymbol: target.symbol,
    generatedTests,
  };
}

// ======================================================
// VALIDATION
// ======================================================
//
// The LLM is trusted to write test *code*, not to decide what counts as
// a valid gap. Anything whose addressesGap doesn't exactly match a gap
// we actually identified gets dropped — this is the enforcement point
// that stops scope creep (the model deciding on its own that some other
// behavior "should" be tested too).

function validateAndNormalize(
  raw: RawGenerationResponse,
  target: TestGenerationTarget
): GeneratedTestCase[] {
  const validGapLabels = new Set(target.coverageGaps.map((g) => g.label));

  const rawCases = raw.testCases ?? [];
  const valid: GeneratedTestCase[] = [];
  const seenGaps = new Set<string>();

  for (const testCase of rawCases) {
    if (
      !testCase.testCode ||
      typeof testCase.testCode !== "string" ||
      !testCase.testCode.trim()
    ) {
      continue;
    }

    if (!looksLikeTestCode(testCase.testCode)) {
      console.warn(
        `[Test-Generator] Dropping suspicious test case for "${target.symbol}" — doesn't look like test code`
      );
      continue;
    }

    const gapLabel = testCase.addressesGap?.trim();
    if (!gapLabel || !validGapLabels.has(gapLabel)) {
      console.warn(
        `[Test-Generator] Dropping test for "${target.symbol}" — ` +
          `addressesGap "${gapLabel}" doesn't match any identified gap. ` +
          `Model likely expanded scope beyond the verified gap list. Valid gaps: ${Array.from(
            validGapLabels
          ).join(" | ")}`
      );
      continue;
    }

    if (seenGaps.has(gapLabel)) {
      console.log(`[Test-Generator] Skipping duplicate test for gap "${gapLabel}"`);
      continue;
    }
    seenGaps.add(gapLabel);

    valid.push({
      name: testCase.name?.trim() || `test for ${gapLabel}`,
      purpose: testCase.purpose?.trim() || "No purpose provided by the model.",
      targetSymbol: testCase.targetSymbol?.trim() || target.symbol,
      testCode: testCase.testCode.trim(),
      addressesGap: gapLabel,
    });

    if (valid.length >= MAX_GENERATED_TESTS_PER_TARGET) {
      break;
    }
  }

  return valid;
}

function looksLikeTestCode(code: string): boolean {
  return /\b(it|test|describe)\s*\(/.test(code);
}

function inferTestFileName(target: TestGenerationTarget): string {
  if (target.existingTestFile) return target.existingTestFile;

  const parsed = target.sourceFile.replace(/\.(ts|tsx|js|jsx)$/, "");
  return `${parsed}.test.ts`;
}