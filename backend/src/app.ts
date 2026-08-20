import express from "express";
import { analyzeCommit } from "./repository/analyzer.js";

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

    const result = await analyzeCommit(
      repositoryPath,
      commitHash
    );

    res.json(result);

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

const PORT = 5000;

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});