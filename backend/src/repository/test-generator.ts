import type { LLMContext } from "./context-builder.js";
import type { LLMClient } from "./llm-client.js";
import type { PrioritizedTest } from "./test-prioritizer.js";
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
 * targets. Each target is one changed symbol that was referenced by a
 * prioritized test AND has at least one verified (Tier-1) coverage gap.
 *
 * Symbols with zero coverageGaps are skipped entirely — either they're
 * fully covered, or (currently) they only have Tier-2 unverified signals,
 * which we deliberately do not generate against yet.
 *
 * Returns both the targets (for generation) and the full gap analyses
 * (for audit/reporting).
 */
export function buildGenerationTargets(
  prioritized: PrioritizedTest[],
  context: LLMContext,
  rawDiff: string,
  options: { topN?: number } = {}
): GenerationTargetingResult {
  const topN = options.topN ?? prioritized.length;
  const chosen = prioritized.slice(0, topN);

  const targets: TestGenerationTarget[] = [];
  const allGapAnalyses: TestGapAnalysis[] = [];
  // Dedup by symbol name — two prioritized test files could both relate to
  // the same changed symbol; we don't want to build the same target twice.
  const seenSymbols = new Set<string>();

  for (const test of chosen) {
    const relatedSymbols = context.changedSymbols.filter((sym) => {
      const candidateForTest = context.candidateTests.find(
        (c) => c.testFile === test.testFile
      );
      return candidateForTest && candidateForTest.changedFile === sym.file;
    });

    const gapInputs = buildGapAnalysisInputsFromAnalysis(relatedSymbols, rawDiff, context);
    const gapAnalyses = analyzeCoverageGapsBatch(gapInputs);

    // Keep all gap analyses for reporting (regardless of whether gaps were found)
    allGapAnalyses.push(...gapAnalyses);

    for (const symbol of relatedSymbols) {
      if (seenSymbols.has(symbol.name)) {
        console.log(
          `[Test-Generator] Skipping "${symbol.name}" — already built a target for this symbol from an earlier test file`
        );
        continue;
      }

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
        `[Test-Generator] Creating target for "${symbol.name}" with ${gapAnalysis.coverageGaps.length} verified gap(s)`
      );

      const sourceCodeExcerpt = context.sourceCode.find((s) => s.file === symbol.file);
      const testCodeExcerpt = context.testCode.find((t) => t.file === test.testFile);
      const testFramework = inferFrameworkFromFileName(test.testFile);

      targets.push({
        symbol: symbol.name,
        sourceFile: symbol.file,
        changedCode: sourceCodeExcerpt?.content ?? "",
        commitMessage: context.commit.message,
        existingTestFile: test.testFile,
        existingTestCode: testCodeExcerpt?.content ?? "",
        framework: testFramework,
        notes: [
          `Symbol ${symbol.changeType}`,
          `Test priority: ${test.priority}`,
          ...test.evidence,
        ],
        coverageGaps: gapAnalysis.coverageGaps,
      });
    }
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