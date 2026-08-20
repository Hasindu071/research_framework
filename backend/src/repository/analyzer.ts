import { simpleGit } from "simple-git";

export async function analyzeCommit(
  repositoryPath: string,
  commitHash: string
) {
  const git = simpleGit(repositoryPath);

  // Get commit information
  const log = await git.log({
    from: `${commitHash}^`,
    to: commitHash,
    maxCount: 1,
  });

  // Get the actual diff
  const diff = await git.diff([
    `${commitHash}^`,
    commitHash,
  ]);

  return {
    commit: {
      hash: log.latest?.hash,
      message: log.latest?.message,
      author: log.latest?.author_name,
      date: log.latest?.date,
    },

    diff,
  };
}