import type { CoverageGap } from "./test-gap-analyzer.js";

/**
 * One unit of generation work: "write new tests covering this symbol,
 * in this existing test file, given this changed code."
 *
 * Deliberately narrower than LLMContext — generation is scoped to one
 * changed symbol at a time, not "generate tests for this commit."
 *
 * `coverageGaps` is the closed list of Tier-1, verified gaps this target
 * is allowed to generate tests for. The generator enforces a 1:1 mapping
 * between gaps and generated tests — see test-generator.ts's
 * validateAndNormalize, which drops any test whose addressesGap doesn't
 * exactly match one of these labels.
 */
export interface TestGenerationTarget {
  /** e.g. "withLiveSettings" */
  symbol: string;
  /** File where the symbol is defined, e.g. "apps/admin/src/editor/card-config.ts" */
  sourceFile: string;
  /** The changed code for this symbol (diff hunk or full function body). */
  changedCode: string;
  /** Commit message, for behavioral intent. */
  commitMessage?: string;
  /** Existing test file this generation should extend/mirror, if any. */
  existingTestFile?: string;
  existingTestCode?: string;
  /** Test framework to target, e.g. "vitest". */
  framework: string;
  /** Optional extra static-analysis context: prioritizer evidence, related symbols, etc. */
  notes?: string[];
  /**
   * The verified, not-covered cases the LLM must generate tests for —
   * and ONLY these. Populated exclusively from Tier-1 (fallback) analysis;
   * Tier-2 (branch/loop/etc.) signals never appear here because their
   * coverage status can't be verified against test code yet.
   */
  coverageGaps: CoverageGap[];
}

export interface GeneratedTestCase {
  name: string;
  purpose: string;
  targetSymbol: string;
  testCode: string;
  /** Must exactly match one of the target's coverageGaps[].label. Enforced, not trusted. */
  addressesGap: string;
}

export interface TestGenerationResult {
  testFile: string;
  targetSymbol: string;
  generatedTests: GeneratedTestCase[];
  /** Set if generation for this target failed outright (LLM error, etc). */
  error?: string;
}

export interface TestGenerationBatchResult {
  results: TestGenerationResult[];
}