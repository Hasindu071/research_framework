import { glob } from "glob";
import path from "path";

// ======================================================
// TYPES
// ======================================================

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
}

// ======================================================
// DISCOVER SOURCE FILES (PATHS ONLY)
// ======================================================

/**
 * Discover all source file PATHS in a repository.
 * This is a lightweight operation that does NOT load the files into memory.
 * Files will be loaded on-demand during analysis.
 */
export function discoverSourceFiles(
  repositoryPath: string
): DiscoveredFile[] {
  console.log("🔍 Discovering source file paths...");

  const files = glob.sync("**/*.{ts,tsx,js,jsx}", {
    cwd: repositoryPath,
    absolute: true,
    ignore: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/coverage/**",
    ],
  });

  console.log(`✓ Found ${files.length} source files`);

  const discoveredFiles: DiscoveredFile[] = files.map(filePath => ({
    absolutePath: filePath,
    relativePath: path.relative(repositoryPath, filePath),
  }));

  return discoveredFiles;
}
