import { simpleGit } from "simple-git";
import { analyzeCommit } from "./analyzer.js";
import { buildLLMContext } from "./context-builder.js";
import { analyzeDependencyChanges } from "./dependencyAnalyzer.js";
import { createLLMClient } from "./llm-client.js";
import { prioritizeTests } from "./test-prioritizer.js";
import { buildGenerationTargets, generateTests } from "./test-generator.js";
import { runPrioritizedTests, enrichTestInputsWithContext, type GeneratedTestInput } from "./test-runner.js";
import { convertCommitResultToDatasetRow } from "./dataset-generator.js";
import { revertMerge, type MergeResult } from "./test-file-writer.js";
import { validateTsConfig, formatValidationResult, suggestFixes } from "./ts-config-validator.js";
import fs from "fs";
import path from "path";

// ======================================================
// TYPES
// ======================================================

/**
 * Classification of a commit based on whether it includes test files
 * and whether source files have corresponding tests.
 */
export type CommitClassification = "feature_with_tests" | "feature_without_tests" | "mixed";

export interface CommitClassificationResult {
  classification: CommitClassification;
  confidence: number;
  filesChanged: number;
  filesChangedCount: number;
  testFilesChanged: number;
  testFilesChangedCount: number;
  sourceFilesWithCorrespondingTests: number;
  sourceFilesWithoutCorrespondingTests: number;
  notes: string[];
}

/**
 * Classify a commit based on whether it includes test files
 * and whether source files have corresponding tests.
 * 
 * Classification logic:
 * - "feature_with_tests": Commit includes test file changes OR all changed source files have corresponding tests
 * - "feature_without_tests": Commit has no test file changes and source files lack corresponding tests
 * - "mixed": Some source files have corresponding tests, others don't, OR test files changed but some source files lack tests
 */
function classifyCommit(analysis: any): CommitClassificationResult {
  const allChangedFiles = analysis.summary.filesChanged || 0;
  
  // Strict pattern matching for test files - ensures we don't match utils.ts
  // Must end with .test.ts, .spec.ts, etc. or be in __tests__ / e2e directories
  const testFilePattern = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$|__tests__|\.e2e\.|\.integration-test\./i;
  
  const changedFiles: string[] = analysis.changedFiles || [];
  const testFilesChanged = changedFiles.filter((f: string) => testFilePattern.test(f)).length;
  const sourceFilesChanged = changedFiles.filter((f: string) => !testFilePattern.test(f)).length;

  // Analyze source files to see which have corresponding tests
  let sourceFilesWithTests = 0;
  let sourceFilesWithoutTests = 0;

  for (const sourceFile of changedFiles.filter((f: string) => !testFilePattern.test(f))) {
    // Simple heuristic: check if a corresponding test file was also changed
    const baseName = sourceFile.replace(/\.[^.]+$/, "");
    const hasCorrespondingTest = changedFiles.some((f: string) =>
      testFilePattern.test(f) && f.includes(baseName)
    );

    if (hasCorrespondingTest) {
      sourceFilesWithTests++;
    } else {
      sourceFilesWithoutTests++;
    }
  }

  // Determine classification
  let classification: CommitClassification;
  let confidence = 0.8;

  if (testFilesChanged === 0) {
    classification = "feature_without_tests";
    confidence = 0.95; // High confidence — no test files changed
  } else if (sourceFilesWithoutTests === 0 && sourceFilesChanged > 0) {
    classification = "feature_with_tests";
    confidence = 0.9; // High confidence — all source files have corresponding tests
  } else if (sourceFilesWithoutTests > 0 && testFilesChanged > 0) {
    classification = "mixed";
    confidence = 0.85; // Medium confidence — some with tests, some without
  } else if (testFilesChanged > 0 && sourceFilesChanged === 0) {
    classification = "feature_with_tests";
    confidence = 0.8; // Only test files changed
  } else {
    classification = "mixed";
    confidence = 0.7; // Default to mixed if uncertain
  }

  const notes: string[] = [];
  if (testFilesChanged > 0) {
    notes.push(`${testFilesChanged} test file(s) changed`);
  }
  if (sourceFilesWithTests > 0) {
    notes.push(`${sourceFilesWithTests} source file(s) have corresponding tests`);
  }
  if (sourceFilesWithoutTests > 0) {
    notes.push(`${sourceFilesWithoutTests} source file(s) without corresponding tests`);
  }

  return {
    classification,
    confidence,
    filesChanged: allChangedFiles,
    filesChangedCount: allChangedFiles,
    testFilesChanged,
    testFilesChangedCount: testFilesChanged,
    sourceFilesWithCorrespondingTests: sourceFilesWithTests,
    sourceFilesWithoutCorrespondingTests: sourceFilesWithoutTests,
    notes,
  };
}

/**
 * Generates rich metadata for each generated test for MongoDB storage.
 * This includes the test code, gap information, reason for generation, and execution results.
 */
function generateRichGeneratedTestMetadata(
  generationResults: any[],
  generationTargets: any[],
  gapAnalyses: any[],
  executionResults: any[]
): any[] {
  const enrichedTests: any[] = [];

  for (const generationResult of generationResults) {
    if (!generationResult.generatedTests) continue;

    const target = generationTargets.find((t) => t.symbol === generationResult.targetSymbol);
    const gapAnalysis = gapAnalyses.find((g) => g.symbol === generationResult.targetSymbol);

    for (const generatedTest of generationResult.generatedTests) {
      // Find corresponding execution result
      const execution = executionResults.find(
        (r) => r.generatedTestName === generatedTest.name && r.testFile === generationResult.testFile
      );

      enrichedTests.push({
        // Identifiers
        targetSymbol: generationResult.targetSymbol,
        sourceFile: target?.sourceFile ?? "",
        testFile: generationResult.testFile,
        testName: generatedTest.name,

        // The actual test code
        testCode: generatedTest.testCode,

        // Why was this test generated?
        reason: generatedTest.reason ?? `Generated to cover gap in ${generationResult.targetSymbol}`,

        // Gap information that prompted generation
        gap: generatedTest.gap ?? {
          condition: gapAnalysis?.coverageGaps?.[0]?.condition ?? "Unknown",
          kind: gapAnalysis?.coverageGaps?.[0]?.kind ?? "unknown",
          label: gapAnalysis?.coverageGaps?.[0]?.label ?? "Unknown gap",
        },

        // Execution results
        execution: execution
          ? {
              status: execution.status,
              passed: execution.status === "passed",
              failed: execution.status === "failed",
              errored: execution.status === "error",
              duration: execution.duration,
              durationMs: Math.round(execution.duration * 1000),
              framework: execution.framework,
              notes: execution.notes,
              stderr: execution.stderr ? execution.stderr.slice(0, 1000) : undefined,
              keptInTestFile: execution.keptInTestFile ?? false,
            }
          : {
              status: "not_executed",
              passed: false,
              failed: false,
              errored: false,
              duration: 0,
              durationMs: 0,
              framework: null,
              notes: "Not executed",
              stderr: undefined,
              keptInTestFile: false,
            },

        // Metadata
        generatedAt: new Date().toISOString(),
      });
    }
  }

  return enrichedTests;
}

/**
 * Revert all uncommitted changes to test files by using git.
 * This ensures that any test merges from the generation/execution phase
 * are cleaned up before returning to the original commit.
 */
async function revertGeneratedTestChanges(git: any, repositoryPath: string): Promise<void> {
  try {
    // Get list of uncommitted changes
    const status = await git.status();
    
    if (status.modified.length === 0 && status.created.length === 0) {
      console.log(`[Pipeline] No uncommitted test changes to revert`);
      return;
    }

    // Identify test files (assuming they're in __tests__, .test.ts, .spec.ts patterns)
    const testFilePattern = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$|__tests__|\.e2e\.|\.integration-test\./i;
    const changedTestFiles = [
      ...status.modified,
      ...status.created,
    ].filter((file: string) => testFilePattern.test(file));

    if (changedTestFiles.length === 0) {
      console.log(`[Pipeline] No uncommitted test file changes to revert`);
      return;
    }

    console.log(`[Pipeline] Reverting ${changedTestFiles.length} test file change(s)...`);
    
    // Revert modified test files
    const modifiedTestFiles = status.modified.filter((file: string) => testFilePattern.test(file));
    if (modifiedTestFiles.length > 0) {
      await git.checkout(modifiedTestFiles);
      console.log(`[Pipeline] ✓ Reverted ${modifiedTestFiles.length} modified test file(s)`);
    }

    // Remove newly created test files
    const createdTestFiles = status.created.filter((file: string) => testFilePattern.test(file));
    if (createdTestFiles.length > 0) {
      for (const file of createdTestFiles) {
        const filePath = path.resolve(repositoryPath, file);
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.warn(
            `[Pipeline] ⚠️ Failed to delete created test file ${file}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
      console.log(`[Pipeline] ✓ Removed ${createdTestFiles.length} newly created test file(s)`);
    }

    console.log(`[Pipeline] ✓ Reverted all generated test changes`);
  } catch (error) {
    console.warn(
      `[Pipeline] ⚠️ Failed to revert test changes via git: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    // Don't throw — continue with checkout attempt, but log the warning
  }
}

/**
 * Revert all accumulated test merges from the pipeline.
 * This is called before checking out the original commit to ensure
 * all generated test modifications are cleaned up.
 */
function revertAccumulatedMerges(merges: MergeResult[]): void {
  if (merges.length === 0) {
    return;
  }

  console.log(`[Pipeline] Reverting ${merges.length} accumulated test merge(s)...`);
  
  for (const merge of merges) {
    try {
      revertMerge(merge);
    } catch (error) {
      console.warn(
        `[Pipeline] ⚠️ Failed to revert merge for ${merge.testFileAbsolute}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  
  console.log(`[Pipeline] ✓ Reverted all test merges`);
}

/**
 * Full analysis pipeline for a specific commit.
 * Wraps the entire workflow: analyze → prioritize → generate → execute
 * with proper checkout/restore of the repository state.
 * 
 * This is the single source of truth for the entire pipeline.
 */
export async function analyzeAndTestCommit(
  repositoryPath: string,
  commitHash: string,
  testCommand?: string
): Promise<any> {
  const git = simpleGit(repositoryPath);
  const accumulatedMerges: MergeResult[] = []; // Track all test merges for cleanup

  console.log("======================================");
  console.log("Full commit pipeline started");
  console.log(`Commit: ${commitHash}`);
  console.log("======================================");

  // ==================================================
  // 0. Validate TypeScript configuration
  // ==================================================

  console.log("[Pipeline] Validating TypeScript configuration...");
  const tsConfigValidation = validateTsConfig(repositoryPath);
  
  for (const line of formatValidationResult(tsConfigValidation)) {
    console.log(line);
  }

  if (!tsConfigValidation.canProceed) {
    console.error("[Pipeline] ❌ TypeScript configuration is invalid");
    console.log("[Pipeline] Suggested fixes:");
    for (const suggestion of suggestFixes(tsConfigValidation)) {
      console.log(suggestion);
    }
    
    return {
      success: false,
      error: "TypeScript configuration validation failed",
      details: tsConfigValidation.issues,
      suggestions: suggestFixes(tsConfigValidation),
    };
  }

  // ==================================================
  // 1. Save current HEAD state
  // ==================================================

  let originalCommit: string | null = null;
  try {
    const commitResult = await git.revparse(["HEAD"]);
    originalCommit = commitResult.trim();
    console.log(`[Pipeline] Saved original HEAD state: ${originalCommit}`);
  } catch (error) {
    throw new Error(
      `Failed to determine current HEAD state: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  try {
    // ==================================================
    // 2. Checkout target commit
    // ==================================================

    console.log(`[Pipeline] Checking out commit ${commitHash}...`);
    try {
      await git.checkout(commitHash);
      console.log(`[Pipeline] ✓ Checked out commit ${commitHash}`);
    } catch (checkoutError) {
      throw new Error(
        `Failed to checkout commit ${commitHash}: ${
          checkoutError instanceof Error ? checkoutError.message : String(checkoutError)
        }`
      );
    }

    // ==================================================
    // 3. Analyze the commit
    // ==================================================

    console.log("[Pipeline] Step 1/6: Analyzing commit...");
    const baselineStartTime = Date.now();
    const analysis = await analyzeCommit(repositoryPath, commitHash);
    const baselineTime = (Date.now() - baselineStartTime) / 1000;
    console.log(`[Pipeline] ✓ Analysis complete: ${analysis.summary.filesChanged} files changed (${baselineTime.toFixed(2)}s)`);

    // FIX #4: Classify the commit
    const commitClassification = classifyCommit(analysis);
    console.log(
      `[Pipeline] ✓ Commit classified as: ${commitClassification.classification} ` +
      `(confidence: ${(commitClassification.confidence * 100).toFixed(0)}%)`
    );

    // ==================================================
    // 4. Build LLM context and prioritize tests
    // ==================================================

    console.log("[Pipeline] Step 2/6: Building LLM context and prioritizing tests...");
    const llmContext = buildLLMContext(analysis, repositoryPath);
    const llmClient = createLLMClient();

    let prioritizationResult: any;
    const prioritizedStartTime = Date.now();
    try {
      prioritizationResult = await prioritizeTests(llmContext, llmClient);
      const prioritizedTime = (Date.now() - prioritizedStartTime) / 1000;
      console.log(
        `[Pipeline] ✓ Prioritized ${prioritizationResult.tests.length} tests (${prioritizedTime.toFixed(2)}s)`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Pipeline] ❌ Prioritization failed: ${msg}`);
      throw err;
    }

    // ==================================================
    // 5. Build generation targets and analyze gaps
    // ==================================================

    console.log("[Pipeline] Step 3/6: Analyzing coverage gaps...");
    
    // DEBUG: Log generation target context before gap analysis
    console.log("========== GAP ANALYSIS DEBUG START ==========");
    console.log(`[Pipeline] changedSymbols count: ${llmContext.changedSymbols.length}`);
    console.log(`[Pipeline] candidateTests count: ${llmContext.candidateTests.length}`);
    console.log(`[Pipeline] prioritized tests count: ${prioritizationResult.tests.length}`);
    console.log(`[Pipeline] Top-N selection: ${Math.min(5, prioritizationResult.tests.length)}`);
    console.log("[Pipeline] Changed symbols:");
    for (const symbol of llmContext.changedSymbols) {
      console.log(`  - "${symbol.name}" in "${symbol.file}" (${symbol.changeType})`);
    }
    console.log("[Pipeline] Candidate tests:");
    for (const candidate of llmContext.candidateTests.slice(0, 10)) {
      console.log(`  - ${candidate.testFile} (for ${candidate.changedFile}, confidence ${candidate.confidence})`);
    }
    if (llmContext.candidateTests.length > 10) {
      console.log(`  ... and ${llmContext.candidateTests.length - 10} more`);
    }
    console.log("========== GAP ANALYSIS DEBUG END ==========\n");
    
    const { targets: generationTargets, gapAnalyses } = await buildGenerationTargets(
      prioritizationResult.tests,
      llmContext,
      llmClient,
      analysis.rawDiff,
      repositoryPath,
      { topN: 5 }
    );
    
    console.log(`[Pipeline] ✓ Built ${generationTargets.length} generation target(s)`);
    console.log(`[Pipeline] ✓ Gap analyses completed: ${gapAnalyses.length} symbol(s) analyzed`);
    console.log(`[Pipeline] Gap analysis summary: analyzedSymbols=${gapAnalyses.length}, totalVerifiedGaps=${gapAnalyses.reduce((sum, g) => sum + g.coverageGaps.length, 0)}`);

    // ==================================================
    // 6. Generate tests
    // ==================================================

    console.log("[Pipeline] Step 4/6: Generating tests...");
    let generationResult: any = { results: [] };
    const generationStartTime = Date.now();

    if (generationTargets.length > 0) {
      try {
        generationResult = await generateTests(generationTargets, llmClient);
        const generationTime = (Date.now() - generationStartTime) / 1000;
        const generatedCount = generationResult.results.reduce(
          (sum: number, r: any) => sum + (r.generatedTests?.length ?? 0),
          0
        );
        console.log(`[Pipeline] ✓ Generated ${generatedCount} test cases (${generationTime.toFixed(2)}s)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Pipeline] ❌ Generation failed: ${msg}`);
        throw err;
      }
    } else {
      console.log("[Pipeline] No generation targets, skipping generation");
    }

    // ==================================================
    // 7. Run prioritized existing tests
    // ==================================================

    console.log("[Pipeline] Step 5/6: Running prioritized existing tests...");
    const prioritizedTestInputs = prioritizationResult.tests.map((test: any) => ({
      testFile: test.testFile,
      priority: test.priority,
    }));

    const enrichedPrioritizedInputs = await enrichTestInputsWithContext(
      prioritizedTestInputs,
      repositoryPath
    );

    let prioritizedExecution: { testExecution: any[]; stoppedEarly: boolean } = {
      testExecution: [],
      stoppedEarly: false,
    };

    if (enrichedPrioritizedInputs.length > 0) {
      prioritizedExecution = await runPrioritizedTests(enrichedPrioritizedInputs, {
        repositoryRoot: repositoryPath,
        ...(testCommand && { testCommand }), // Include testCommand only if provided
        stopOnFailure: false,
        timeoutMs: 120_000,
        keepGeneratedTests: false,
      });

      const prioritizedPassed = prioritizedExecution.testExecution.filter(
        (r: any) => r.status === "passed"
      ).length;
      const prioritizedFailed = prioritizedExecution.testExecution.filter(
        (r: any) => r.status === "failed"
      ).length;

      console.log(
        `[Pipeline] ✓ Executed ${prioritizedExecution.testExecution.length} prioritized test(s): ` +
          `${prioritizedPassed} passed, ${prioritizedFailed} failed`
      );
    }

    // ==================================================
    // 8. Run generated tests
    // ==================================================

    console.log("[Pipeline] Step 6/6: Running generated tests...");
    const generatedTestInputs: GeneratedTestInput[] = [];

    for (const result of generationResult.results as any[]) {
      if (!result.generatedTests) continue;

      const target = generationTargets.find((t) => t.symbol === result.targetSymbol);

      for (const generatedTest of result.generatedTests) {
        generatedTestInputs.push({
          testFile: result.testFile,
          priority: 0,
          testCode: generatedTest.testCode,
          testName: generatedTest.name,
          targetSymbol: generatedTest.targetSymbol ?? result.targetSymbol,
          sourceFile: target?.sourceFile ?? "",
          isNewTestFile: target?.isNewTestFile ?? false,
        });
      }
    }

    const enrichedGeneratedInputs = await enrichTestInputsWithContext(
      generatedTestInputs,
      repositoryPath
    );

    let generatedExecution: { testExecution: any[]; stoppedEarly: boolean } = {
      testExecution: [],
      stoppedEarly: false,
    };

    if (enrichedGeneratedInputs.length > 0) {
      generatedExecution = await runPrioritizedTests(enrichedGeneratedInputs, {
        repositoryRoot: repositoryPath,
        ...(testCommand && { testCommand }), // Include testCommand only if provided
        stopOnFailure: false,
        timeoutMs: 120_000,
        keepGeneratedTests: false,  // Don't keep in repo — save to MongoDB instead
      });

      const genPassed = generatedExecution.testExecution.filter(
        (r: any) => r.status === "passed"
      ).length;
      const genFailed = generatedExecution.testExecution.filter(
        (r: any) => r.status === "failed"
      ).length;

      console.log(
        `[Pipeline] ✓ Executed ${generatedExecution.testExecution.length} generated test(s): ` +
          `${genPassed} passed, ${genFailed} failed`
      );
    }

    // ==================================================
    // 9. Compile and return results
    // ==================================================

    console.log("[Pipeline] ======================================");
    console.log("[Pipeline] Pipeline completed successfully ✓");
    console.log("[Pipeline] ======================================");

    const generatedCount = generationResult.results.reduce(
      (sum: number, r: any) => sum + (r.generatedTests?.length ?? 0),
      0
    );

    const finalResponse: any = {
      success: true,
      commit: {
        hash: analysis.commit.hash,
        message: analysis.commit.message,
        author: analysis.commit.author,
        date: analysis.commit.date,
      },
      commitClassification,
      timing: {
        baselineTime,
        prioritizedTime: prioritizationResult.tests.length > 0 ? (Date.now() - prioritizedStartTime) / 1000 : 0,
        generationTime: generationResult.results.length > 0 ? (Date.now() - generationStartTime) / 1000 : 0,
      },
      analysis: {
        filesChanged: analysis.summary.filesChanged,
        totalInsertions: analysis.summary.totalInsertions,
        totalDeletions: analysis.summary.totalDeletions,
        changedSymbols: llmContext.changedSymbols,
        dependencyChanges: analyzeDependencyChanges(analysis.rawDiff),
      },
      prioritization: {
        candidateTests: llmContext.candidateTests.length,
        prioritizedTests: prioritizationResult.tests,
      },
      gapAnalysis: {
        results: gapAnalyses,
        summary: {
          analyzedSymbols: gapAnalyses.length,
          totalChangedBehaviors: gapAnalyses.reduce(
            (sum, g) => sum + g.changedBehaviors.length,
            0
          ),
          totalVerifiedGaps: gapAnalyses.reduce((sum, g) => sum + g.coverageGaps.length, 0),
        },
      },
      generation: {
        results: generationResult.results,
        summary: {
          targetCount: generationTargets.length,
          generatedCount,
          failedCount: generationResult.results.filter((r: any) => r.error).length,
          successRate:
            generationTargets.length > 0
              ? (((generationTargets.length -
                  generationResult.results.filter((r: any) => r.error).length) /
                  generationTargets.length) *
                100).toFixed(1)
              : 0,
        },
      },
      existingTestExecution: {
        results: prioritizedExecution.testExecution.map((r: any) => ({
          testFile: r.testFile,
          status: r.status,
          passed: r.status === "passed",
          failed: r.status === "failed",
          duration: r.duration,
          durationMs: Math.round(r.duration * 1000),
          framework: r.framework,
          notes: r.notes,
          error: r.status === "error" ? r.stderr : undefined,
        })),
        summary: {
          selected: prioritizedTestInputs.length,
          executed: prioritizedExecution.testExecution.length,
          passed: prioritizedExecution.testExecution.filter((r: any) => r.status === "passed")
            .length,
          failed: prioritizedExecution.testExecution.filter((r: any) => r.status === "failed")
            .length,
          errors: prioritizedExecution.testExecution.filter((r: any) => r.status === "error")
            .length,
          not_found: prioritizedExecution.testExecution.filter((r: any) => r.status === "not_found")
            .length,
          skipped: prioritizedExecution.testExecution.filter((r: any) => r.status === "skipped")
            .length,
        },
        stoppedEarly: prioritizedExecution.stoppedEarly,
      },
      generatedTestExecution: {
        results: generatedExecution.testExecution.map((r: any) => ({
          testFile: r.testFile,
          generatedTestName: r.generatedTestName,
          status: r.status,
          passed: r.status === "passed",
          failed: r.status === "failed",
          duration: r.duration,
          durationMs: Math.round(r.duration * 1000),
          framework: r.framework,
          notes: r.notes,
          error: r.status === "error" ? r.stderr : undefined,
        })),
        summary: {
          generated: generatedCount,
          executed: generatedExecution.testExecution.length,
          passed: generatedExecution.testExecution.filter((r: any) => r.status === "passed")
            .length,
          failed: generatedExecution.testExecution.filter((r: any) => r.status === "failed")
            .length,
          errors: generatedExecution.testExecution.filter((r: any) => r.status === "error")
            .length,
          not_found: generatedExecution.testExecution.filter((r: any) => r.status === "not_found")
            .length,
          skipped: generatedExecution.testExecution.filter((r: any) => r.status === "skipped")
            .length,
        },
        stoppedEarly: generatedExecution.stoppedEarly,
      },
      // ======================================================
      // ENRICHED GENERATED TEST DATA FOR RESEARCH/MONGODB
      // Store each generated test with full context for analysis
      // ======================================================
      generatedTestsForStorage: generateRichGeneratedTestMetadata(
        generationResult.results,
        generationTargets,
        gapAnalyses,
        generatedExecution.testExecution
      ),
    };

    // FIX #6: Convert result to dataset row for CSV export
    // Must be done AFTER finalResponse is fully constructed
    finalResponse.datasetRow = convertCommitResultToDatasetRow(
      finalResponse,
      "default-repository"
    );

    return finalResponse;
  } finally {
    // ==================================================
    // CLEANUP: Revert all generated test changes
    // ==================================================

    if (originalCommit) {
      console.log(`[Pipeline] Step 7/7: Cleaning up generated test modifications...`);
      await revertGeneratedTestChanges(git, repositoryPath);
      
      // ALWAYS restore original HEAD state
      // ==================================================
      console.log(`[Pipeline] Restoring repository to original commit: ${originalCommit}...`);
      try {
        await git.checkout(originalCommit);
        console.log(`[Pipeline] ✓ Successfully restored to ${originalCommit}`);
      } catch (restoreError) {
        console.error(
          `[Pipeline] ❌ FAILED to restore original commit state: ${
            restoreError instanceof Error ? restoreError.message : String(restoreError)
          }`
        );
        console.error(`[Pipeline] Repository may be in detached HEAD state at ${originalCommit}`);
        throw restoreError;
      }
    }
  }
}
