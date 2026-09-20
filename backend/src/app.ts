import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import { analyzeCommit } from "./repository/analyzer.js";
import { buildLLMContext } from "./repository/context-builder.js";
import { analyzeDependencyChanges } from "./repository/dependencyAnalyzer.js";
import { LLMClient } from "./repository/llm-client.js";
import { getPrompts } from "./repository/prompts.js";
import { runPrioritizedTests, enrichTestInputsWithContext, type GeneratedTestInput } from "./repository/test-runner.js";
import { prioritizeTests } from "./repository/test-prioritizer.js";
import { buildGenerationTargets, generateTests } from "./repository/test-generator.js";
import { connectMongoDB, disconnectMongoDB, saveAnalysisResult, getAnalysisResults, listRepositories } from "./repository/mongodb-service.js";

const app = express();

app.use(express.json());

// Initialize MongoDB connection on startup
let mongoInitialized = false;
let mongoConnected = false;

async function initializeMongoDB() {
  if (!mongoInitialized) {
    try {
      await connectMongoDB();
      mongoInitialized = true;
      mongoConnected = true;
      console.log("✓ MongoDB initialized successfully");
    } catch (error) {
      console.error("❌ Failed to initialize MongoDB:", error);
      mongoInitialized = true;
      mongoConnected = false;
      // Don't crash the server - continue without MongoDB
      console.log("⚠ Continuing without MongoDB - results will not be persisted");
    }
  }
}

app.post("/api/analyze-commit", async (req, res) => {
  try {
    await initializeMongoDB();

    const { repositoryPath, commitHash, repoName } = req.body;

    if (!repositoryPath || !commitHash) {
      return res.status(400).json({
        error: "repositoryPath and commitHash are required",
      });
    }

    if (!repoName) {
      return res.status(400).json({
        error: "repoName is required",
      });
    }

    // Step 1: Analyze the commit
    console.log("[Step 1] Analyzing commit...");
    const analysis = await analyzeCommit(
      repositoryPath,
      commitHash
    );

    // Step 2: Build context for LLM
    console.log("[Step 2] Building LLM context...");
    const llmContext = buildLLMContext(analysis, repositoryPath);

    // Step 3: Send to LLM and get output
    console.log("[Step 3] Sending to LLM...");
    let llmResponse = null;
    let llmError = null;

    try {
      const llmClient = new LLMClient();
      const prompts = getPrompts();

      console.log("[Step 3] LLM client created successfully");
      console.log("[Step 3] Prompts loaded");

      llmResponse = await llmClient.generateJSON(
        prompts.systemPrompt,
        prompts.getUserPrompt(llmContext)
      );
      console.log("[Step 3] ✓ LLM response received successfully");
    } catch (llmErr) {
      llmError = llmErr instanceof Error ? llmErr.message : String(llmErr);
      console.error("[Step 3] ❌ LLM ERROR OCCURRED");
      console.error(`[Step 3] Error message: ${llmError}`);
      
      // Detailed error diagnosis
      if (llmError.includes("429")) {
        console.error("[Step 3] 🚨 ERROR TYPE: QUOTA EXCEEDED / RATE LIMITED");
        console.error("[Step 3] Action: Wait a few minutes before retrying");
      } else if (llmError.includes("403")) {
        console.error("[Step 3] 🚨 ERROR TYPE: PERMISSION DENIED");
        console.error("[Step 3] Action: Check API key validity and billing status");
      } else if (llmError.includes("401")) {
        console.error("[Step 3] 🚨 ERROR TYPE: UNAUTHORIZED");
        console.error("[Step 3] Action: Verify GEMINI_API_KEY is set correctly");
      } else if (llmError.includes("fetch failed") || llmError.includes("Network error")) {
        console.error("[Step 3] 🚨 ERROR TYPE: NETWORK/CONNECTION ERROR");
        console.error("[Step 3] Action: Check internet connection and Gemini API availability");
      } else if (llmError.includes("parse") || llmError.includes("JSON")) {
        console.error("[Step 3] 🚨 ERROR TYPE: RESPONSE PARSING ERROR");
        console.error("[Step 3] Action: Model may have returned invalid JSON");
      } else {
        console.error("[Step 3] 🚨 ERROR TYPE: UNKNOWN");
        console.error("[Step 3] Please check the error message above");
      }
    }

    const responseData: any = {
      success: true,
      commit: {
        hash: analysis.commit.hash,
        message: analysis.commit.message,
        author: analysis.commit.author,
        date: analysis.commit.date,
      },
      analysis: {
        filesChanged: analysis.summary.filesChanged,
        totalInsertions: analysis.summary.totalInsertions,
        totalDeletions: analysis.summary.totalDeletions,
      },
      context: llmContext,
    };

    if (llmResponse) {
      responseData.llmResponse = llmResponse;
    }

    if (llmError) {
      responseData.llmError = llmError;
    }

    // Save to MongoDB
    console.log(`[Step 4] Saving analysis result to MongoDB collection '${repoName}'...`);
    try {
      const documentId = await saveAnalysisResult(repoName, responseData);
      responseData.mongoId = documentId;
      console.log(`[Step 4] ✓ Analysis result saved with ID: ${documentId}`);
    } catch (mongoError) {
      console.error(`[Step 4] ❌ Failed to save to MongoDB:`, mongoError);
      responseData.mongoError = mongoError instanceof Error ? mongoError.message : String(mongoError);
    }

    res.json(responseData);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to analyze commit",
      details: error instanceof Error
        ? error.message
        : String(error),
    });
  }
});

app.post("/api/analyze-prioritize-generate", async (req, res) => {
  try {
    await initializeMongoDB();

    const { repositoryPath, commitHash, repoName } = req.body;

    if (!repositoryPath || !commitHash) {
      return res.status(400).json({
        error: "repositoryPath and commitHash are required",
      });
    }

    if (!repoName) {
      return res.status(400).json({
        error: "repoName is required",
      });
    }

    // ========================================
    // Step 1: Analyze commit
    // ========================================
    console.log("[Step 1/5] Analyzing commit...");
    const analysis = await analyzeCommit(repositoryPath, commitHash);
    console.log(`[Step 1/5] ✓ Found ${analysis.summary.filesChanged} changed files`);

    // ========================================
    // Step 1.5: Analyze dependency changes
    // ========================================
    console.log("[Step 1.5/5] Analyzing dependency changes...");
    const dependencyChanges = analyzeDependencyChanges(analysis.rawDiff);
    console.log(`[Step 1.5/5] ✓ Found ${dependencyChanges.length} dependency change(s)`);

    // ========================================
    // Step 2: Build LLM context
    // ========================================
    console.log("[Step 2/5] Building LLM context...");
    const llmContext = buildLLMContext(analysis, repositoryPath);
    console.log(`[Step 2/5] ✓ Context built with ${llmContext.candidateTests.length} candidate tests`);

    const llmClient = new LLMClient();

    // ========================================
    // Step 3: Prioritize tests
    // ========================================
    console.log("[Step 3/5] Prioritizing candidate tests with LLM...");
    let prioritizationResult: any;

    try {
      prioritizationResult = await prioritizeTests(llmContext, llmClient);
      console.log(`[Step 3/5] ✓ Prioritized ${prioritizationResult.tests.length} tests`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Step 3/5] ❌ Prioritization failed: ${msg}`);
      return res.status(500).json({
        error: "Test prioritization failed",
        details: msg,
      });
    }

    if (!prioritizationResult.tests || prioritizationResult.tests.length === 0) {
      console.log("[Step 3/5] No tests to prioritize, continuing with gap analysis...");
      
      // Continue to gap analysis even with no prioritized tests
    } else {
      console.log(`[Step 3/5] ✓ Prioritized ${prioritizationResult.tests.length} tests`);
    }

    // ========================================
    // Step 4: Build generation targets
    // ========================================
    console.log("[Step 4/5] Building generation targets...");
    const { targets: generationTargets, gapAnalyses } = await buildGenerationTargets(
      prioritizationResult.tests,
      llmContext,
      llmClient,
      analysis.rawDiff,
      repositoryPath,
      { topN: 5 }
    );
    console.log(`[Step 4/5] ✓ Built ${generationTargets.length} generation target(s) from ${gapAnalyses.length} analyzed symbol(s)`);

    let generationResult: any = { results: [] };

    if (generationTargets.length > 0) {
      // ========================================
      // Step 5: Generate tests
      // ========================================
      console.log("[Step 5/5] Generating test cases with LLM...");

      try {
        generationResult = await generateTests(generationTargets, llmClient);
        const generatedCount = generationResult.results.reduce(
          (sum: number, r: any) => sum + (r.generatedTests?.length ?? 0),
          0
        );
        const failedCount = generationResult.results.filter(
          (r: any) => r.error
        ).length;
        console.log(`[Step 5/5] ✓ Generated ${generatedCount} test cases (${failedCount} failed targets)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Step 5/5] ❌ Generation failed: ${msg}`);
        return res.status(500).json({
          error: "Test generation failed",
          details: msg,
        });
      }
    } else {
      console.log("[Step 5/5] No generation targets, skipping generation");
    }

    // ========================================
    // Step 5.5: Run prioritized existing tests
    // ========================================
    console.log("[Step 5.5/6] Running prioritized existing tests...");

    const prioritizedTestInputs = prioritizationResult.tests.map((test: any) => ({
      testFile: test.testFile,
      priority: test.priority,
    }));

    // Enrich with TestFileContext before running
    console.log("[Step 5.5/6] Mapping test suite context...");
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
        `[Step 5.5/6] ✓ Executed ${prioritizedExecution.testExecution.length} prioritized test(s): ${prioritizedPassed} passed, ${prioritizedFailed} failed`
      );
    }

    // ========================================
    // Step 6: Materialize and execute generated tests
    // ========================================
    console.log("[Step 6/6] Executing generated test cases...");

    const generatedTestInputs: GeneratedTestInput[] = [];

    for (const result of generationResult.results as any[]) {
      if (!result.generatedTests) continue;

      // Find the corresponding generation target to get sourceFile and isNewTestFile
      const target = generationTargets.find(
        (t) => t.symbol === result.targetSymbol
      );

      for (const generatedTest of result.generatedTests) {
        // Get source file content for repair context
        const sourceFileAbsolute = path.isAbsolute(target?.sourceFile ?? "")
          ? target?.sourceFile
          : path.resolve(repositoryPath, target?.sourceFile ?? "");
        let sourceContent = "";
        if (sourceFileAbsolute) {
          try {
            sourceContent = fs.readFileSync(sourceFileAbsolute, "utf8");
          } catch {
            // Source file not readable, will skip repair context
          }
        }

        generatedTestInputs.push({
          testFile: result.testFile,
          priority: 0,
          testCode: generatedTest.testCode,
          testName: generatedTest.name,
          targetSymbol: generatedTest.targetSymbol ?? result.targetSymbol,
          sourceFile: target?.sourceFile ?? "",
          isNewTestFile: target?.isNewTestFile ?? false,
          repairAttempt: 0,
          sourceFileContent: sourceContent,
        });
      }
    }

    console.log(
      `[Step 6/6] Prepared ${generatedTestInputs.length} generated test(s) for execution`
    );

    // Enrich generated test inputs with context before running
    console.log("[Step 6/6] Mapping test suite context for generated tests...");
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
        stopOnFailure: false,
        timeoutMs: 120_000,  // 2 min timeout (accounts for monorepo startup time)
        keepGeneratedTests: true,  // Keep files for inspection
      });

      // ========================================
      // Repair loop: retry failed tests with LLM fixes
      // ========================================
      console.log("[Step 6/6] Checking for tests that need repair...");
      
      const failedTests = generatedExecution.testExecution.filter(
        (r: any) => (r as any).needsRepair === true
      );
      
      if (failedTests.length > 0) {
        console.log(`[Step 6/6] Found ${failedTests.length} test(s) that need repair. Requesting fixes from LLM...`);
        
        const repairBatch: GeneratedTestInput[] = [];
        
        for (const failedTest of failedTests) {
          const originalInput = enrichedGeneratedInputs.find(
            (t) => t.testFile === failedTest.testFile && t.testName === failedTest.generatedTestName
          );
          
          if (originalInput) {
            // Build repair request for LLM
            const { buildTestRepairPrompt } = await import("./repository/test-generator.js");
            
            const repairPrompt = buildTestRepairPrompt({
              failedTestCode: originalInput.testCode,
              viestError: (failedTest as any).repairError || failedTest.stderr || "",
              targetFunctionName: originalInput.targetSymbol,
              sourceFileContent: originalInput.sourceFileContent ?? "",
              testFileName: originalInput.testFile,
              attemptNumber: ((originalInput.repairAttempt ?? 0) + 1),
              maxAttempts: 3,
            });
            
            console.log(`[Step 6/6] Sending repair request for "${originalInput.testName}" (attempt ${(originalInput.repairAttempt ?? 0) + 1}/3)`);
            
            // Add delay to respect rate limits (2 seconds between requests)
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Call LLM to repair the test
            const repairResponse = await llmClient.generateJSON<{
              repairedTestCode: string;
            }>(
              "You are a test repair assistant. Fix the failing test code based on the error message and context provided.",
              repairPrompt
            );
            
            if (repairResponse?.repairedTestCode) {
              // Create new input with repaired code and incremented attempt counter
              repairBatch.push({
                ...originalInput,
                testCode: repairResponse.repairedTestCode,
                repairAttempt: (originalInput.repairAttempt ?? 0) + 1,
              });
              console.log(`[Step 6/6] ✓ Received repaired test code for "${originalInput.testName}"`);
            }
          }
        }
        
        // Re-execute repaired tests
        if (repairBatch.length > 0) {
          console.log(`[Step 6/6] Re-executing ${repairBatch.length} repaired test(s)...`);
          
          const repairedExecution = await runPrioritizedTests(repairBatch, {
            repositoryRoot: repositoryPath,
            stopOnFailure: false,
            timeoutMs: 120_000,
            keepGeneratedTests: true,
          });
          
          // Replace failed results with repair results in generatedExecution
          for (const repaired of repairedExecution.testExecution) {
            const failedIndex = generatedExecution.testExecution.findIndex(
              (r: any) => r.testFile === repaired.testFile && r.generatedTestName === repaired.generatedTestName
            );
            if (failedIndex !== -1) {
              generatedExecution.testExecution[failedIndex] = repaired;
            }
          }
        }
      }

      // Calculate full breakdown instead of hiding other buckets
      const genSummary = {
        passed: generatedExecution.testExecution.filter((r: any) => r.status === "passed").length,
        failed: generatedExecution.testExecution.filter((r: any) => r.status === "failed").length,
        errors: generatedExecution.testExecution.filter((r: any) => r.status === "error").length,
        not_found: generatedExecution.testExecution.filter((r: any) => r.status === "not_found").length,
        skipped: generatedExecution.testExecution.filter((r: any) => r.status === "skipped").length,
      };

      console.log(
        `[Step 6/6] ✓ Executed ${generatedExecution.testExecution.length} generated test(s): ` +
        `${genSummary.passed} passed, ${genSummary.failed} failed, ${genSummary.errors} errors, ` +
        `${genSummary.not_found} not_found, ${genSummary.skipped} skipped`
      );

      // Per-test verdict, matching the format you want to see
      for (const r of generatedExecution.testExecution as any[]) {
        const icon = r.status === "passed" ? "✓" : r.status === "failed" ? "✗" : "⚠";
        console.log(`[Generated Test] ${r.generatedTestName}`);
        console.log(`  ${icon} ${r.status.toUpperCase()} (${r.duration.toFixed(2)}s)`);
        if (r.status !== "passed") {
          console.log(`  notes: ${r.notes ?? "(none)"}`);
          if (r.stderr) console.log(`  stderr (first 500 chars):\n${r.stderr.slice(0, 500)}`);
        }
      }
    }

    // ========================================
    // Prepare response
    // ========================================
    const generatedCount = generationResult.results.reduce(
      (sum: number, r: any) => sum + (r.generatedTests?.length ?? 0),
      0
    );
    const failedCount = generationResult.results.filter(
      (r: any) => r.error
    ).length;

    console.log("========================================");
    console.log("Pipeline execution completed");
    console.log("========================================");
    console.log("");
    console.log("EXISTING TEST RESULTS");
    console.log("========================================");
    const existingPassed = prioritizedExecution.testExecution.filter((r: any) => r.status === "passed").length;
    const existingExecuted = prioritizedExecution.testExecution.length;
    const existingPassRate = existingExecuted > 0 ? ((existingPassed / existingExecuted) * 100).toFixed(1) : "0.0";
    console.log(
      `Selected: ${prioritizedTestInputs.length}`
    );
    console.log(
      `Executed: ${existingExecuted}`
    );
    console.log(
      `Passed: ${existingPassed}`
    );
    console.log(
      `Pass Rate: ${existingPassRate}%`
    );
    console.log(
      `Failed: ${prioritizedExecution.testExecution.filter((r: any) => r.status === "failed").length}`
    );
    console.log("");
    console.log("GENERATED TEST RESULTS");
    console.log("========================================");
    const totalGenerated = generationResult.results.reduce(
      (sum: number, r: any) => sum + (r.generatedTests?.length ?? 0),
      0
    );
    const validGenerated = enrichedGeneratedInputs.length; // Tests that passed validation and were written
    const rejectedGenerated = totalGenerated - validGenerated; // Tests that were rejected during validation
    const generatedPassed = generatedExecution.testExecution.filter((r: any) => r.status === "passed").length;
    const generatedExecuted = generatedExecution.testExecution.length;
    const generatedPassRate = generatedExecuted > 0 ? ((generatedPassed / generatedExecuted) * 100).toFixed(1) : "0.0";
    const generationValidityRate = totalGenerated > 0 ? ((validGenerated / totalGenerated) * 100).toFixed(1) : "0.0";
    
    console.log(
      `Generated: ${totalGenerated}`
    );
    console.log(
      `Valid (passed validation): ${validGenerated}`
    );
    if (rejectedGenerated > 0) {
      console.log(
        `Rejected (failed validation): ${rejectedGenerated}`
      );
    }
    console.log(
      `Generation Validity Rate: ${generationValidityRate}%`
    );
    console.log(
      `Executed: ${generatedExecuted}`
    );
    console.log(
      `Passed: ${generatedPassed}`
    );
    console.log(
      `Execution Success Rate: ${generatedPassRate}%`
    );
    console.log(
      `Failed: ${generatedExecution.testExecution.filter((r: any) => r.status === "failed").length}`
    );
    console.log("========================================");

    const finalResponse: any = {
      success: true,
      commit: {
        hash: analysis.commit.hash,
        message: analysis.commit.message,
        author: analysis.commit.author,
        date: analysis.commit.date,
      },
      analysis: {
        filesChanged: analysis.summary.filesChanged,
        totalInsertions: analysis.summary.totalInsertions,
        totalDeletions: analysis.summary.totalDeletions,
        changedSymbols: llmContext.changedSymbols,
        dependencyChanges,
      },
      prioritization: {
        candidateTests: llmContext.candidateTests.length,
        prioritizedTests: prioritizationResult.tests,
      },
      gapAnalysis: {
        results: gapAnalyses,
        summary: {
          analyzedSymbols: gapAnalyses.length,
          totalChangedBehaviors: gapAnalyses.reduce((sum, g) => sum + g.changedBehaviors.length, 0),
          totalVerifiedGaps: gapAnalyses.reduce((sum, g) => sum + g.coverageGaps.length, 0),
        },
        rawDiff: analysis.rawDiff,
      },
      generation: {
        results: generationResult.results,
        summary: {
          targetCount: generationTargets.length,
          generatedCount,
          failedCount,
          successRate:
            generationTargets.length > 0
              ? (((generationTargets.length - failedCount) /
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
          passed: prioritizedExecution.testExecution.filter((r: any) => r.status === "passed").length,
          failed: prioritizedExecution.testExecution.filter((r: any) => r.status === "failed").length,
          errors: prioritizedExecution.testExecution.filter((r: any) => r.status === "error").length,
          not_found: prioritizedExecution.testExecution.filter((r: any) => r.status === "not_found").length,
          skipped: prioritizedExecution.testExecution.filter((r: any) => r.status === "skipped").length,
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
        verdicts: generatedExecution.testExecution.map((r: any) => ({
          name: r.generatedTestName,
          result: r.status === "passed" ? "PASSED" : r.status === "failed" ? "FAILED" : r.status.toUpperCase(),
          durationSeconds: r.duration,
          error: r.status !== "passed" ? (r.notes ?? r.stderr?.slice(0, 500)) : undefined,
        })),
        summary: {
          generated: generatedCount,
          executed: generatedExecution.testExecution.length,
          passed: generatedExecution.testExecution.filter((r: any) => r.status === "passed").length,
          failed: generatedExecution.testExecution.filter((r: any) => r.status === "failed").length,
          errors: generatedExecution.testExecution.filter((r: any) => r.status === "error").length,
          not_found: generatedExecution.testExecution.filter((r: any) => r.status === "not_found").length,
          skipped: generatedExecution.testExecution.filter((r: any) => r.status === "skipped").length,
        },
        stoppedEarly: generatedExecution.stoppedEarly,
      },
    };

    // Save to MongoDB
    if (mongoConnected) {
      console.log(`[MongoDB] Saving analysis result to collection '${repoName}'...`);
      try {
        const documentId = await saveAnalysisResult(repoName, finalResponse);
        finalResponse.mongoId = documentId;
        console.log(`[MongoDB] ✓ Result saved with ID: ${documentId}`);
      } catch (mongoError) {
        console.error(`[MongoDB] ❌ Failed to save to MongoDB:`, mongoError);
        finalResponse.mongoError = mongoError instanceof Error ? mongoError.message : String(mongoError);
      }
    } else {
      console.log("[MongoDB] ⚠ Skipping MongoDB save - MongoDB not connected");
      finalResponse.mongoError = "MongoDB connection failed during initialization";
    }

    res.json(finalResponse);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to analyze, prioritize, and generate tests",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Get all repositories from MongoDB
app.get("/api/repositories", async (req, res) => {
  try {
    await initializeMongoDB();
    const repos = await listRepositories();
    res.json({
      success: true,
      repositories: repos,
      count: repos.length,
    });
  } catch (error) {
    console.error("Failed to list repositories:", error);
    res.status(500).json({
      error: "Failed to list repositories",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Get all analysis results for a specific repository
app.get("/api/repositories/:repoName", async (req, res) => {
  try {
    await initializeMongoDB();
    const { repoName } = req.params;
    const results = await getAnalysisResults(repoName);
    res.json({
      success: true,
      repoName,
      count: results.length,
      results: results.map((r) => ({
        _id: r._id,
        savedAt: r.savedAt,
        savedAtTimestamp: r.savedAtTimestamp,
        commit: r.commit,
        analysis: r.analysis,
      })),
    });
  } catch (error) {
    console.error("Failed to get repository results:", error);
    res.status(500).json({
      error: "Failed to get repository results",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/run-generated-tests", async (req, res) => {
  try {
    await initializeMongoDB();

    const { repositoryPath, generatedTests, repoName } = req.body;

    if (!repositoryPath || !generatedTests || !Array.isArray(generatedTests)) {
      return res.status(400).json({
        error: "repositoryPath and generatedTests array are required",
      });
    }

    if (!repoName) {
      return res.status(400).json({
        error: "repoName is required",
      });
    }

    console.log(`[Test Execution] Running ${generatedTests.length} generated test(s)...`);

    // Convert to GeneratedTestInput format
    const inputs = generatedTests.map((test: any) => ({
      testFile: test.testFile,
      priority: test.priority || 0,
      testCode: test.testCode,
      testName: test.testName || test.name,
      targetSymbol: test.targetSymbol || "unknown",
    }));

    // Run the tests with materialization
    // keepGeneratedTests: true so you can inspect the generated files
    const results = await runPrioritizedTests(inputs, {
      repositoryRoot: repositoryPath,
      stopOnFailure: false,
      timeoutMs: 120_000, // 2 min timeout (accounts for monorepo startup time)
      keepGeneratedTests: true,  // Keep files for inspection
    });

    console.log(`[Test Execution] Completed: ${results.testExecution.length} test(s)`);

    // Calculate statistics
    const stats = {
      total: results.testExecution.length,
      passed: results.testExecution.filter(t => t.status === "passed").length,
      failed: results.testExecution.filter(t => t.status === "failed").length,
      errors: results.testExecution.filter(t => t.status === "error").length,
      not_found: results.testExecution.filter(t => t.status === "not_found").length,
      skipped: results.testExecution.filter(t => t.status === "skipped").length,
    };

    const finalResponse: any = {
      success: true,
      testExecution: results.testExecution.map(result => ({
        testFile: result.testFile,
        generatedTestName: result.generatedTestName,
        status: result.status,
        passed: result.status === "passed",
        duration: result.duration,
        framework: result.framework,
        notes: result.notes,
        error: result.status === "error" ? result.stderr : undefined,
      })),
      summary: stats,
      stoppedEarly: results.stoppedEarly,
      note: "Generated test files are preserved in __generated__/ subdirectories for inspection",
    };

    // Save to MongoDB
    console.log(`[MongoDB] Saving test results to collection '${repoName}'...`);
    try {
      const documentId = await saveAnalysisResult(repoName, finalResponse);
      finalResponse.mongoId = documentId;
      console.log(`[MongoDB] ✓ Test results saved with ID: ${documentId}`);
    } catch (mongoError) {
      console.error(`[MongoDB] ❌ Failed to save to MongoDB:`, mongoError);
      finalResponse.mongoError = mongoError instanceof Error ? mongoError.message : String(mongoError);
    }

    res.json(finalResponse);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to run generated tests",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/analyze-and-run", async (req, res) => {
  try {
    await initializeMongoDB();

    const { repositoryPath, commitHash, repoName } = req.body;

    if (!repositoryPath || !commitHash) {
      return res.status(400).json({
        error: "repositoryPath and commitHash are required",
      });
    }

    if (!repoName) {
      return res.status(400).json({
        error: "repoName is required",
      });
    }

    // Step 1: Analyze the commit
    console.log("[Step 1] Analyzing commit...");
    const analysis = await analyzeCommit(repositoryPath, commitHash);

    // Step 2: Build context for LLM
    console.log("[Step 2] Building LLM context...");
    const llmContext = buildLLMContext(analysis, repositoryPath);

    // Step 3: Send to LLM and get prioritized tests
    console.log("[Step 3] Sending to LLM for test prioritization...");
    let llmResponse = null;
    let llmError = null;

    try {
      const llmClient = new LLMClient();
      const prompts = getPrompts();

      console.log("[Step 3] LLM client created successfully");
      console.log(`[Step 3] Prompts loaded`);

      llmResponse = await llmClient.generateJSON(
        prompts.systemPrompt,
        prompts.getUserPrompt(llmContext)
      );
      console.log("[Step 3] ✓ LLM response received successfully");
    } catch (llmErr) {
      llmError = llmErr instanceof Error ? llmErr.message : String(llmErr);
      console.error("[Step 3] ❌ LLM ERROR OCCURRED");
      console.error(`[Step 3] Error message: ${llmError}`);
      
      // Detailed error diagnosis
      if (llmError.includes("429")) {
        console.error("[Step 3] 🚨 ERROR TYPE: QUOTA EXCEEDED / RATE LIMITED");
        console.error("[Step 3] Action: Wait a few minutes before retrying");
      } else if (llmError.includes("403")) {
        console.error("[Step 3] 🚨 ERROR TYPE: PERMISSION DENIED");
        console.error("[Step 3] Action: Check API key validity and billing status");
      } else if (llmError.includes("401")) {
        console.error("[Step 3] 🚨 ERROR TYPE: UNAUTHORIZED");
        console.error("[Step 3] Action: Verify GEMINI_API_KEY is set correctly");
      } else if (llmError.includes("fetch failed") || llmError.includes("Network error")) {
        console.error("[Step 3] 🚨 ERROR TYPE: NETWORK/CONNECTION ERROR");
        console.error("[Step 3] Action: Check internet connection and Gemini API availability");
      } else if (llmError.includes("parse") || llmError.includes("JSON")) {
        console.error("[Step 3] 🚨 ERROR TYPE: RESPONSE PARSING ERROR");
        console.error("[Step 3] Action: Model may have returned invalid JSON");
      } else {
        console.error("[Step 3] 🚨 ERROR TYPE: UNKNOWN");
        console.error("[Step 3] Please check the error message above");
      }
    }

    if (llmError || !llmResponse) {
      console.error(`[Step 3] LLM prioritization failed, aborting test execution`);
      return res.status(500).json({
        error: "Failed to get LLM prioritization",
        details: llmError,
        errorType: llmError?.includes("429") ? "QUOTA_EXCEEDED" : 
                   llmError?.includes("403") ? "PERMISSION_DENIED" :
                   llmError?.includes("401") ? "UNAUTHORIZED" :
                   llmError?.includes("Network") ? "NETWORK_ERROR" :
                   llmError?.includes("parse") ? "PARSE_ERROR" : "UNKNOWN",
      });
    }

    // Step 4: Extract tests from LLM response and run them
    console.log("[Step 4] Running prioritized tests...");
    const prioritizedTests = (llmResponse as any).testPrioritization?.tests || [];

    if (prioritizedTests.length === 0) {
      return res.json({
        success: true,
        commit: {
          hash: analysis.commit.hash,
          message: analysis.commit.message,
          author: analysis.commit.author,
          date: analysis.commit.date,
        },
        analysis: {
          filesChanged: analysis.summary.filesChanged,
          totalInsertions: analysis.summary.totalInsertions,
          totalDeletions: analysis.summary.totalDeletions,
        },
        llmPrioritization: prioritizedTests,
        testResults: {
          success: true,
          summary: {
            total: 0,
            passed: 0,
            failed: 0,
            errors: 0,
            not_found: 0,
            skipped: 0,
            stoppedEarly: false,
          },
          testExecution: [],
        },
      });
    }

    // Convert LLM response to test runner input
    const testInputs = prioritizedTests.map(
      (test: any) => ({
        testFile: test.testFile,
        priority: test.priority,
      })
    );

    // Enrich with TestFileContext before running
    console.log("[Step 4] Mapping test suite context...");
    const enrichedTestInputs = await enrichTestInputsWithContext(
      testInputs,
      repositoryPath
    );

    // Run tests in priority order
    const testRunResults = await runPrioritizedTests(enrichedTestInputs, {
      repositoryRoot: repositoryPath,
      stopOnFailure: false,
    });

    const passedCount = testRunResults.testExecution.filter(
      (t) => t.status === "passed"
    ).length;
    const failedCount = testRunResults.testExecution.filter(
      (t) => t.status === "failed"
    ).length;
    const errorCount = testRunResults.testExecution.filter(
      (t) => t.status === "error"
    ).length;
    const notFoundCount = testRunResults.testExecution.filter(
      (t) => t.status === "not_found"
    ).length;
    const skippedCount = testRunResults.testExecution.filter(
      (t) => t.status === "skipped"
    ).length;

    // Step 5: Return complete result
    console.log("[Step 4] Test execution completed");
    console.log("========================================");
    console.log("Full pipeline completed successfully");
    console.log("========================================");

    const finalData: any = {
      success: true,
      commit: {
        hash: analysis.commit.hash,
        message: analysis.commit.message,
        author: analysis.commit.author,
        date: analysis.commit.date,
      },
      analysis: {
        filesChanged: analysis.summary.filesChanged,
        totalInsertions: analysis.summary.totalInsertions,
        totalDeletions: analysis.summary.totalDeletions,
      },
      llmPrioritization: prioritizedTests,
      testResults: {
        success: true,
        summary: {
          total: testRunResults.testExecution.length,
          passed: passedCount,
          failed: failedCount,
          errors: errorCount,
          not_found: notFoundCount,
          skipped: skippedCount,
          stoppedEarly: testRunResults.stoppedEarly,
        },
        testExecution: testRunResults.testExecution,
      },
    };

    // Save to MongoDB
    console.log(`[MongoDB] Saving analysis result to collection '${repoName}'...`);
    try {
      const documentId = await saveAnalysisResult(repoName, finalData);
      finalData.mongoId = documentId;
      console.log(`[MongoDB] ✓ Result saved with ID: ${documentId}`);
    } catch (mongoError) {
      console.error(`[MongoDB] ❌ Failed to save to MongoDB:`, mongoError);
      finalData.mongoError = mongoError instanceof Error ? mongoError.message : String(mongoError);
    }

    res.json(finalData);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to analyze and run tests",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  console.log(`POST http://localhost:${PORT}/api/analyze-commit`);
  console.log(`GET http://localhost:${PORT}/api/health`);
  console.log("");
  
  // Try to initialize MongoDB on startup
  await initializeMongoDB();
  if (mongoConnected) {
    console.log("✓ MongoDB is ready");
  } else {
    console.log("⚠ MongoDB is not available - using in-memory storage only");
  }
});