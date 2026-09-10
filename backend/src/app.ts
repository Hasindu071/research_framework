import "dotenv/config";
import express from "express";
import { analyzeCommit } from "./repository/analyzer.js";
import { buildLLMContext } from "./repository/context-builder.js";
import { LLMClient } from "./repository/llm-client.js";
import { getPrompts } from "./repository/prompts.js";
import { runPrioritizedTests, toPrioritizedTestInputs } from "./repository/test-runner.js";
import { prioritizeTests } from "./repository/test-prioritizer.js";
import { buildGenerationTargets, generateTests } from "./repository/test-generator.js";

const app = express();

app.use(express.json());

app.post("/api/analyze-commit", async (req, res) => {
  try {
    const { repositoryPath, commitHash } = req.body;

    if (!repositoryPath || !commitHash) {
      return res.status(400).json({
        error: "repositoryPath and commitHash are required",
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
    const { repositoryPath, commitHash } = req.body;

    if (!repositoryPath || !commitHash) {
      return res.status(400).json({
        error: "repositoryPath and commitHash are required",
      });
    }

    // ========================================
    // Step 1: Analyze commit
    // ========================================
    console.log("[Step 1/5] Analyzing commit...");
    const analysis = await analyzeCommit(repositoryPath, commitHash);
    console.log(`[Step 1/5] ✓ Found ${analysis.summary.filesChanged} changed files`);

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
      console.log("[Step 3/5] No tests to prioritize, returning early");
      // Even with no prioritized tests, run gap analysis for audit purposes
      console.log("[Step 4/5] Building gap analyses anyway for audit...");
      const { gapAnalyses } = buildGenerationTargets(
        [],
        llmContext,
        analysis.rawDiff,
        { topN: 5 }
      );
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
          changedSymbols: llmContext.changedSymbols,
          candidateTests: prioritizationResult.tests,
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
          results: [],
          summary: {
            targetCount: 0,
            generatedCount: 0,
            failedCount: 0,
            successRate: 0,
          },
        },
      });
    }

    // ========================================
    // Step 4: Build generation targets
    // ========================================
    console.log("[Step 4/5] Building generation targets...");
    const { targets: generationTargets, gapAnalyses } = buildGenerationTargets(
      prioritizationResult.tests,
      llmContext,
      analysis.rawDiff,
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
    console.log("Full pipeline completed successfully ✓");
    console.log("========================================");

    res.json({
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
    });
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

app.post("/api/analyze-and-run", async (req, res) => {
  try {
    const { repositoryPath, commitHash } = req.body;

    if (!repositoryPath || !commitHash) {
      return res.status(400).json({
        error: "repositoryPath and commitHash are required",
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

    // Run tests in priority order
    const testRunResults = await runPrioritizedTests(testInputs, {
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

    res.json({
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
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to analyze and run tests",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  console.log(`POST http://localhost:${PORT}/api/analyze-commit`);
  console.log(`GET http://localhost:${PORT}/api/health`);
});