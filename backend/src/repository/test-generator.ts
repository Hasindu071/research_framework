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
// TEMPLATE DISCOVERY
// ======================================================

/**
 * Search the repository for a template test file matching the given framework.
 * Used when creating new test files from scratch.
 */
async function findTemplateTestFile(
  repositoryRoot: string,
  targetFramework: string
): Promise<{ file: string; content: string } | null> {
  try {
    // Import fs to read files
    const fs = await import("fs");
    const path = await import("path");
    const { glob } = await import("glob");

    // Search for test files with common patterns
    const testPatterns = [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/tests/**/*.ts",
      "**/tests/**/*.tsx",
    ];

    for (const pattern of testPatterns) {
      const testFiles = await glob(pattern, {
        cwd: repositoryRoot,
        ignore: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
        maxDepth: 10,
      });

      // Try to find a test file with matching framework
      for (const testFile of testFiles.slice(0, 20)) {
        // Check framework based on filename and content
        const framework = inferFrameworkFromFileName(testFile);
        if (framework === targetFramework) {
          try {
            const fullPath = path.join(repositoryRoot, testFile);
            const content = fs.readFileSync(fullPath, "utf-8");
            
            // Make sure it has actual test content, not just imports
            if (content.includes("it(") || content.includes("test(") || content.includes("describe(")) {
              console.log(
                `[Test-Generator] Found template test file for "${targetFramework}": ${testFile}`
              );
              return { file: testFile, content };
            }
          } catch {
            // Skip files we can't read
            continue;
          }
        }
      }
    }

    console.log(
      `[Test-Generator] No template test file found in repository for framework "${targetFramework}"`
    );
    return null;
  } catch (error) {
    console.log(
      `[Test-Generator] Template search failed (non-critical): ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

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
  repositoryRoot: string,
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

  // A changed symbol is "in scope" if:
  // 1. (Preferred) At least one of the top-N prioritized test files has a real relationship to its file, OR
  // 2. (Fallback) If there are no prioritized tests, all changed symbols are in scope
  //    (we'll generate tests directly for them)
  const relevantSymbols = context.changedSymbols.filter((symbol) => {
    // If we have prioritized tests, require a match
    if (chosenTestFiles.size > 0) {
      return context.candidateTests.some(
        (candidate) =>
          candidate.changedFile === symbol.file &&
          chosenTestFiles.has(candidate.testFile)
      );
    }
    // If we have NO prioritized tests, all changed symbols are fair game
    return true;
  });

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
    const testFramework = inferFrameworkFromFileName(resolution.testFile);
    
    // For new test files, find a template test file from the same framework to use as a style guide
    let testCodeExcerpt: { file: string; content: string } | undefined;
    let templateFile: string | undefined;
    let isTemplate = false;
    
    if (resolution.isNewFile) {
      // First, try to find a template from candidate tests (tests related to this commit)
      let templateCandidate = context.testCode.find((t) => {
        const candidateFramework = inferFrameworkFromFileName(t.file);
        return candidateFramework === testFramework;
      });
      
      if (templateCandidate) {
        testCodeExcerpt = templateCandidate;
        templateFile = templateCandidate.file;
        isTemplate = true;
        console.log(
          `[Test-Generator] Using template test file for style reference: ${templateFile}`
        );
      } else {
        // Second, search the entire repository for a matching framework test file
        console.log(
          `[Test-Generator] No candidate tests found for framework "${testFramework}". ` +
          `Searching repository for a template test file...`
        );
        const repositoryTemplate = await findTemplateTestFile(repositoryRoot, testFramework);
        
        if (repositoryTemplate) {
          testCodeExcerpt = {
            file: repositoryTemplate.file,
            content: repositoryTemplate.content,
          };
          templateFile = repositoryTemplate.file;
          isTemplate = true;
          console.log(
            `[Test-Generator] Found repository template test file: ${templateFile}`
          );
        } else {
          console.log(
            `[Test-Generator] No template test file found in repository for framework "${testFramework}". ` +
            `Gemini will generate test structure from scratch (using file structure conventions).`
          );
        }
      }
    } else {
      testCodeExcerpt = context.testCode.find((t) => t.file === resolution.testFile);
    }

    const relatedPrioritizedEvidence = prioritized
      .filter((p) => matchesForFile.some((m) => m.testFile === p.testFile))
      .flatMap((p) => p.evidence);

    targets.push({
      symbol: symbol.name,
      sourceFile: symbol.file,
      testFile: resolution.testFile,
      changedCode: sourceCodeExcerpt?.content ?? "",
      commitMessage: context.commit.message,
      existingTestFile: resolution.testFile,
      existingTestCode: testCodeExcerpt?.content ?? "",
      existingTestCodeIsTemplate: isTemplate,
      // NOTE: TestGenerationTarget in generator-types.ts needs this field
      // added — it's what test-runner.ts uses to decide whether to
      // scaffold a brand-new file or extend an existing one.
      isNewTestFile: resolution.isNewFile,
      framework: testFramework,
      notes: [
        `Symbol ${symbol.changeType}`,
        resolution.isNewFile
          ? templateFile
            ? `No related test file found — using ${templateFile} as style template`
            : "No related test file found for this source file — a new test file will be created from scratch"
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