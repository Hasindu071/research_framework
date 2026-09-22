import "dotenv/config";
import express from "express";
import path from "path";
import { analyzeCommit } from "./repository/analyzer.js";
import { buildLLMContext } from "./repository/context-builder.js";
import { createLLMClient } from "./repository/llm-client.js";
import { getPrompts } from "./repository/prompts.js";
import { runPrioritizedTests, enrichTestInputsWithContext } from "./repository/test-runner.js";
import { analyzeAndTestCommit } from "./repository/commit-pipeline.js";
import { connectMongoDB, saveAnalysisResult, getAnalysisResults, listRepositories } from "./repository/mongodb-service.js";

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
      console.error("⚠ Failed to initialize MongoDB:", error);
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
      const llmClient = createLLMClient();
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

    const { repositoryPath, commitHash, repoName, testCommand, buildCommand } = req.body;

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

    if (!testCommand) {
      return res.status(400).json({
        error: "testCommand is required (e.g., 'pnpm run test' or 'npm test')",
      });
    }

    console.log("======================================");
    console.log(`Starting analysis for commit: ${commitHash}`);
    console.log(`Test command: ${testCommand}`);
    if (buildCommand) {
      console.log(`Build command: ${buildCommand}`);
    }
    console.log("======================================");

    // Use the pipeline as the single source of truth, pass testCommand and buildCommand
    const finalResponse = await analyzeAndTestCommit(repositoryPath, commitHash, testCommand, buildCommand);

    // Save everything to MongoDB (including enriched generated test metadata)
    console.log(`[MongoDB] Saving analysis result to collection '${repoName}'...`);
    try {
      const documentId = await saveAnalysisResult(repoName, finalResponse);
      finalResponse.mongoId = documentId;
      console.log(`[MongoDB] ✓ Result saved with ID: ${documentId}`);
    } catch (mongoError) {
      console.error(`[MongoDB] ❌ Failed to save to MongoDB:`, mongoError);
      finalResponse.mongoError = mongoError instanceof Error ? mongoError.message : String(mongoError);
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

// ======================================================
// FIX #7: DATASET GENERATION ENDPOINTS
// ======================================================

import { generateCSV, saveDataset, loadDataset, convertCommitResultToDatasetRow, type ResearchDatasetRow } from "./repository/dataset-generator.js";

/**
 * POST /api/dataset/generate
 * Generate CSV from commit results
 */
app.post("/api/dataset/generate", async (req, res) => {
  try {
    const { results, repositoryName } = req.body;

    if (!results || !Array.isArray(results)) {
      return res.status(400).json({
        error: "results array is required",
      });
    }

    const repoName = repositoryName || "default-repository";
    const rows: ResearchDatasetRow[] = results.map((result: any) =>
      convertCommitResultToDatasetRow(result, repoName)
    );

    const csv = generateCSV(rows);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="research-dataset-${Date.now()}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to generate dataset",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /api/dataset/save
 * Generate and save dataset to disk
 */
app.post("/api/dataset/save", async (req, res) => {
  try {
    const { results, repositoryName, outputPath } = req.body;

    if (!results || !Array.isArray(results)) {
      return res.status(400).json({
        error: "results array is required",
      });
    }

    const repoName = repositoryName || "default-repository";
    const savePath = outputPath || `./datasets/research-dataset-${Date.now()}.csv`;

    const rows: ResearchDatasetRow[] = results.map((result: any) =>
      convertCommitResultToDatasetRow(result, repoName)
    );

    await saveDataset(rows, savePath);

    res.json({
      success: true,
      message: `Dataset saved to ${savePath}`,
      rowCount: rows.length,
      outputPath: savePath,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to save dataset",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/dataset/export
 * Serve a previously saved CSV file
 */
app.get("/api/dataset/export", (_req, res) => {
  try {
    const { filePath } = _req.query;

    if (!filePath || typeof filePath !== "string") {
      return res.status(400).json({
        error: "filePath query parameter is required",
      });
    }

    const rows = loadDataset(filePath);

    if (rows.length === 0) {
      return res.status(404).json({
        error: "Dataset file not found or is empty",
      });
    }

    const csv = generateCSV(rows);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`);
    res.send(csv);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to export dataset",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Health check endpoint
app.get("/api/health", (_req, res) => {
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

    const { repositoryPath, generatedTests, repoName, testCommand } = req.body;

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

    if (!testCommand) {
      return res.status(400).json({
        error: "testCommand is required (e.g., 'pnpm run test' or 'npm test')",
      });
    }

    console.log(`[Test Execution] Running ${generatedTests.length} generated test(s) using command: ${testCommand}`);

    // Convert to GeneratedTestInput format
    const inputs = generatedTests.map((test: any) => ({
      testFile: test.testFile,
      priority: test.priority || 0,
      testCode: test.testCode,
      testName: test.testName || test.name,
      targetSymbol: test.targetSymbol || "unknown",
    }));

    // Run the tests with materialization using the provided testCommand
    // keepGeneratedTests: true so you can inspect the generated files
    const results = await runPrioritizedTests(inputs, {
      repositoryRoot: repositoryPath,
      testCommand, // Use the provided test command
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
      testCommand, // Include in response for reference
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

    const { repositoryPath, commitHash, repoName, testCommand, buildCommand } = req.body;

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

    if (!testCommand) {
      return res.status(400).json({
        error: "testCommand is required (e.g., 'pnpm run test' or 'npm test')",
      });
    }

    // Step 1: Analyze the commit
    console.log("[Step 1] Analyzing commit...");
    const analysis = await analyzeCommit(repositoryPath, commitHash);

    // Step 2: Build context for LLM
    console.log("[Step 2] Building LLM context...");
    const llmContext = buildLLMContext(analysis, repositoryPath);

    // Step 3: Send to LLM for test prioritization
    console.log("[Step 3] Sending to LLM for test prioritization...");
    let llmResponse = null;
    let llmError = null;

    try {
      const llmClient = createLLMClient();
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

    // Step 4: Extract tests from LLM response and run them with the provided testCommand
    console.log(`[Step 4] Running prioritized tests using command: ${testCommand}`);
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

    // Run tests in priority order using the provided testCommand
    const testRunResults = await runPrioritizedTests(enrichedTestInputs, {
      repositoryRoot: repositoryPath,
      testCommand, // Pass the custom test command
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