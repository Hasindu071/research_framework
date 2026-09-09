import "dotenv/config";
import express from "express";
import { analyzeCommit } from "./repository/analyzer.js";
import { buildLLMContext } from "./repository/context-builder.js";
import { LLMClient } from "./repository/llm-client.js";
import { getPrompts } from "./repository/prompts.js";
import { runPrioritizedTests, toPrioritizedTestInputs } from "./repository/test-runner.js";

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

      llmResponse = await llmClient.generateJSON(
        prompts.systemPrompt,
        prompts.getUserPrompt(llmContext)
      );
      console.log("[Step 3] LLM response received successfully");
    } catch (llmErr) {
      llmError = llmErr instanceof Error ? llmErr.message : String(llmErr);
      console.error("[Step 3] LLM error:", llmError);
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

      llmResponse = await llmClient.generateJSON(
        prompts.systemPrompt,
        prompts.getUserPrompt(llmContext)
      );
      console.log("[Step 3] LLM response received successfully");
    } catch (llmErr) {
      llmError = llmErr instanceof Error ? llmErr.message : String(llmErr);
      console.error("[Step 3] LLM error:", llmError);
    }

    if (llmError || !llmResponse) {
      return res.status(500).json({
        error: "Failed to get LLM prioritization",
        details: llmError,
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