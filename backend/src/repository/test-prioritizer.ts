import type { LLMContext } from "./context-builder.js";
import type { ILLMClient } from "./llm-client.js";
import {
  TEST_PRIORITIZER_SYSTEM_PROMPT,
  buildTestPrioritizerUserPrompt,
} from "./prompts.js";

// ======================================================
// CONSTANTS
// ======================================================

/**
 * Only execute tests with a relevance score at or above this threshold.
 * Tests below this are filtered out as not sufficiently relevant to the changes.
 */
const RELEVANCE_THRESHOLD = 0.3;

// ======================================================
// TYPES
// ======================================================

export interface PrioritizedTest {
  testFile: string;
  priority: number;
  score: number;
  reason: string;
  evidence: string[];
}

export interface TestPrioritizationResult {
  tests: PrioritizedTest[];
  /**
   * Tests that were filtered out due to being below the relevance threshold.
   * Included here for audit trail purposes.
   */
  filtered?: PrioritizedTest[];
}

/** Raw shape we ask the LLM for — see prompts.ts. */
interface RawLLMResponse {
  testPrioritization?: {
    tests?: Partial<PrioritizedTest>[];
  };
}

// ======================================================
// PRIORITIZE TESTS
// ======================================================

export async function prioritizeTests(
  context: LLMContext,
  llmClient: ILLMClient
): Promise<TestPrioritizationResult> {
  // Nothing to rank — skip the LLM call entirely rather than paying
  // for a round trip that can only return an empty list.
  if (context.candidateTests.length === 0) {
    console.log("[Test-Prioritizer] No candidate tests to rank, skipping LLM call");
    return { tests: [] };
  }

  console.log(`[Test-Prioritizer] Starting prioritization for ${context.candidateTests.length} candidate tests`);

  const userPrompt = buildTestPrioritizerUserPrompt(context);
  console.log(`[Test-Prioritizer] User prompt prepared (${userPrompt.length} characters)`);

  try {
    console.log("[Test-Prioritizer] Calling LLM to generate JSON...");
    const raw = await llmClient.generateJSON<RawLLMResponse>(
      TEST_PRIORITIZER_SYSTEM_PROMPT,
      userPrompt
    );
    console.log("[Test-Prioritizer] LLM response received successfully ✓");

    return validateAndNormalize(raw, context);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("[Test-Prioritizer] ⚠️ LLM prioritization failed");
    console.error(`[Test-Prioritizer] Error: ${errorMsg}`);
    
    // Check for specific error types
    if (errorMsg.includes("429") || errorMsg.includes("quota") || errorMsg.includes("rate limit")) {
      console.error("[Test-Prioritizer] 🚨 QUOTA EXCEEDED or RATE LIMITED detected");
    }
    if (errorMsg.includes("403") || errorMsg.includes("unauthorized") || errorMsg.includes("permission")) {
      console.error("[Test-Prioritizer] 🚨 AUTHENTICATION/PERMISSION ERROR detected");
    }
    if (errorMsg.includes("fetch failed") || errorMsg.includes("Network error")) {
      console.error("[Test-Prioritizer] 🚨 NETWORK ERROR detected - check connectivity");
    }
    
    throw error;
  }
}

// ======================================================
// VALIDATION
// ======================================================
//
// The LLM is being trusted to rank evidence static analysis already
// found — it should never be the source of a test file that doesn't
// exist in our candidate list (design doc point 6: explainable,
// grounded decisions, not free-form guesses). We defensively drop
// anything that doesn't match a real candidate rather than trusting
// the model's output verbatim.

function validateAndNormalize(
  raw: RawLLMResponse,
  context: LLMContext
): TestPrioritizationResult {
  const candidateFiles = new Set(
    context.candidateTests.map((test) => test.testFile)
  );

  const rawTests = raw.testPrioritization?.tests ?? [];

  const valid: PrioritizedTest[] = [];
  const filtered: PrioritizedTest[] = [];
  const seen = new Set<string>();

  for (const test of rawTests) {
    if (!test.testFile || !candidateFiles.has(test.testFile)) {
      // Hallucinated or malformed entry — drop it rather than
      // surfacing a test file that was never a real candidate.
      continue;
    }

    if (seen.has(test.testFile)) {
      // Model returned a duplicate — keep the first occurrence.
      continue;
    }

    seen.add(test.testFile);

    const prioritizedTest: PrioritizedTest = {
      testFile: test.testFile,
      score: clampScore(test.score),
      priority: 0, // reassigned below, once we know the final order
      reason: test.reason?.trim() || "No reason provided by the model.",
      evidence: Array.isArray(test.evidence) ? test.evidence : [],
    };

    // FIX #3: Apply relevance threshold filtering
    if (prioritizedTest.score < RELEVANCE_THRESHOLD) {
      filtered.push(prioritizedTest);
      console.log(
        `[Test-Prioritizer] Filtered test below relevance threshold (${RELEVANCE_THRESHOLD}): ` +
        `${test.testFile} (score: ${prioritizedTest.score.toFixed(2)})`
      );
    } else {
      valid.push(prioritizedTest);
    }
  }

  // Any candidate the model silently dropped still gets ranked, at
  // the bottom (if above threshold), so a caller iterating "all candidates in priority
  // order" never loses one — it just won't have an LLM-authored
  // reason.
  for (const candidate of context.candidateTests) {
    if (seen.has(candidate.testFile)) {
      continue;
    }

    const fallbackTest: PrioritizedTest = {
      testFile: candidate.testFile,
      score: candidate.confidence,
      priority: 0,
      reason:
        "Not ranked by the model; falling back to static-analysis confidence.",
      evidence: [],
    };

    // FIX #3: Apply relevance threshold filtering to fallback tests too
    if (fallbackTest.score < RELEVANCE_THRESHOLD) {
      filtered.push(fallbackTest);
      console.log(
        `[Test-Prioritizer] Filtered test below relevance threshold (${RELEVANCE_THRESHOLD}): ` +
        `${candidate.testFile} (score: ${fallbackTest.score.toFixed(2)})`
      );
    } else {
      valid.push(fallbackTest);
    }
  }

  valid.sort((a, b) => b.score - a.score);

  valid.forEach((test, index) => {
    test.priority = index + 1;
  });

  if (filtered.length > 0) {
    console.log(
      `[Test-Prioritizer] Filtered ${filtered.length} tests below relevance threshold (${RELEVANCE_THRESHOLD})`
    );
  }

  return { tests: valid, filtered };
}

function clampScore(score: number | undefined): number {
  if (typeof score !== "number" || Number.isNaN(score)) {
    return 0;
  }

  return Math.min(1, Math.max(0, score));
}