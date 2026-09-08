import "dotenv/config";
import express from "express";
import { analyzeCommit } from "./repository/analyzer.js";
import { buildLLMContext } from "./repository/context-builder.js";
import { LLMClient } from "./repository/llm-client.js";
import { getPrompts } from "./repository/prompts.js";

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

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  console.log(`POST http://localhost:${PORT}/api/analyze-commit`);
  console.log(`GET http://localhost:${PORT}/api/health`);
});