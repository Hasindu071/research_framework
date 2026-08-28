
import fs from "fs";
import path from "path";

export interface TestMatch {
  testFile: string;
  changedFile: string;
  reason: string;
  confidence: number;
}

export interface TestAnalysisResult {
  relatedTests: TestMatch[];
}

/**
 * Supported source/test file extensions.
 */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/**
 * Check whether a file is a test file.
 */
function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");

  return (
    /\.test\.(ts|tsx|js|jsx)$/.test(normalized) ||
    /\.spec\.(ts|tsx|js|jsx)$/.test(normalized) ||
    /(^|\/)__tests__(\/|$)/.test(normalized)
  );
}

/**
 * Check whether a file is a source file that we can analyze.
 */
function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

/**
 * Recursively find files in the repository.
 *
 * We ignore directories that are not useful for source/test analysis.
 */
function getAllFiles(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) {
    return files;
  }

  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === ".next" ||
      entry.name === "dist" ||
      entry.name === "build" ||
      entry.name === "coverage" ||
      entry.name === ".turbo"
    ) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      getAllFiles(fullPath, files);
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Normalize Windows paths to repository-style paths.
 */
function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/**
 * Get a file name without its extension.
 *
 * Examples:
 *
 * Locations.tsx       -> Locations
 * Locations.test.tsx -> Locations
 * Locations.spec.tsx -> Locations
 */
function getBaseName(filePath: string): string {
  const fileName = path.basename(filePath);

  return fileName
    .replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/, "")
    .replace(/\.(ts|tsx|js|jsx)$/, "");
}

/**
 * Determine whether a test file has the same base name
 * as a changed source file.
 */
function hasMatchingTestName(
  changedFile: string,
  testFile: string
): boolean {
  return getBaseName(changedFile) === getBaseName(testFile);
}

/**
 * Determine whether the test is located in the same directory
 * as the changed source file.
 */
function isSameDirectory(
  changedFile: string,
  testFile: string
): boolean {
  return path.dirname(normalizePath(changedFile)) ===
    path.dirname(normalizePath(testFile));
}

/**
 * Extract the package name from an import/require statement.
 *
 * Examples:
 *
 * import x from "i18next-fs-backend"
 *
 * require("i18next-fs-backend")
 *
 * @scope/package
 * package
 */
function sourceImportsPackage(
  content: string,
  packageName: string
): boolean {
  const escapedPackage = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const importRegex = new RegExp(
    `(?:from\\s+|import\\s*\\(|require\\s*\\()\\s*["']${escapedPackage}["']`,
    "m"
  );

  return importRegex.test(content);
}

/**
 * Extract package names from a package.json dependency object.
 *
 * We use this when package.json itself changed.
 */
function extractChangedDependencies(
  changedLines: {
    type: string;
    content: string;
  }[]
): string[] {
  const dependencies = new Set<string>();

  for (const line of changedLines) {
    if (line.type !== "added") {
      continue;
    }

    /**
     * Match:
     *
     * "i18next-fs-backend": "^2.6.6"
     */
    const match = line.content.match(
      /^\s*["']([^"']+)["']\s*:\s*["']([^"']+)["']/
    );

    if (!match?.[1]) {
      continue;
    }

    const packageName = match[1];

    /**
     * Ignore Yarn resolution keys such as:
     *
     * brace-expansion@^2.0.2
     */
    if (packageName.includes("@") && !packageName.startsWith("@")) {
      continue;
    }

    dependencies.add(packageName);
  }

  return Array.from(dependencies);
}

/**
 * Find source files that import a specific dependency.
 */
function findFilesImportingPackage(
  packageName: string,
  sourceFiles: string[]
): string[] {
  const result: string[] = [];

  for (const file of sourceFiles) {
    /**
     * Don't analyze test files here.
     * We first find production/source files that use
     * the dependency, then find tests for those files.
     */
    if (isTestFile(file)) {
      continue;
    }

    try {
      const content = fs.readFileSync(file, "utf8");

      if (sourceImportsPackage(content, packageName)) {
        result.push(file);
      }
    } catch {
      // Ignore files that cannot be read.
    }
  }

  return result;
}

/**
 * Find tests associated with a source file.
 */
function findTestsForSourceFile(
  sourceFile: string,
  testFiles: string[],
  repositoryRoot: string
): TestMatch[] {
  const matches: TestMatch[] = [];

  const normalizedSourceFile = normalizePath(
    path.relative(repositoryRoot, sourceFile)
  );

  for (const testFileAbsolute of testFiles) {
    const testFile = normalizePath(
      path.relative(repositoryRoot, testFileAbsolute)
    );

    /**
     * RULE 1:
     *
     * Same filename.
     *
     * Example:
     *
     * Locations.tsx
     * Locations.test.tsx
     */
    if (hasMatchingTestName(normalizedSourceFile, testFile)) {
      matches.push({
        testFile,
        changedFile: normalizedSourceFile,
        reason: "Test has the same base filename as the affected source file",
        confidence: 0.95,
      });

      continue;
    }

    /**
     * RULE 2:
     *
     * Same directory + similar filename.
     */
    if (
      isSameDirectory(normalizedSourceFile, testFile) &&
      getBaseName(testFile)
        .toLowerCase()
        .includes(getBaseName(normalizedSourceFile).toLowerCase())
    ) {
      matches.push({
        testFile,
        changedFile: normalizedSourceFile,
        reason:
          "Test is in the same directory and has a related filename",
        confidence: 0.85,
      });

      continue;
    }

    /**
     * RULE 3:
     *
     * Test imports the affected source file.
     */
    try {
      const content = fs.readFileSync(testFileAbsolute, "utf8");

      const sourceBaseName = getBaseName(normalizedSourceFile);

      /**
       * We deliberately use the source filename here,
       * rather than blindly searching for "package.json".
       */
      const sourceFileName = path.basename(
        normalizedSourceFile
      ).replace(/\.(ts|tsx|js|jsx)$/, "");

      if (
        content.includes(sourceBaseName) ||
        content.includes(sourceFileName)
      ) {
        matches.push({
          testFile,
          changedFile: normalizedSourceFile,
          reason: "Test references the affected source module",
          confidence: 0.75,
        });
      }
    } catch {
      // Ignore unreadable files.
    }
  }

  return matches;
}

/**
 * Analyze tests related to changed files.
 *
 * This analyzer handles two major scenarios:
 *
 * 1. Normal source-code changes
 *    Example:
 *
 *    Locations.tsx
 *       ↓
 *    Locations.test.tsx
 *
 * 2. Dependency changes
 *    Example:
 *
 *    package.json
 *       ↓
 *    i18next-fs-backend
 *       ↓
 *    source file importing i18next-fs-backend
 *       ↓
 *    tests for that source file
 */
export function analyzeTests(
  changes: {
    file: string;
    changedLines: {
      type: string;
      content: string;
    }[];
  }[],
  repositoryRoot: string
): TestAnalysisResult {
  console.log("======================================");
  console.log("Starting test analysis");
  console.log("======================================");

  const allFiles = getAllFiles(repositoryRoot);

  const testFiles = allFiles.filter(isTestFile);

  const sourceFiles = allFiles.filter(
    (file) => isSourceFile(file) && !isTestFile(file)
  );

  console.log(`Test files found: ${testFiles.length}`);
  console.log(`Source files found: ${sourceFiles.length}`);

  const relatedTests: TestMatch[] = [];

  /**
   * ============================================================
   * CASE 1: NORMAL SOURCE FILE CHANGES
   * ============================================================
   */
  for (const change of changes) {
    const changedFile = normalizePath(change.file);

    /**
     * Skip package manager files here.
     * They are handled separately below.
     */
    if (
      changedFile === "package.json" ||
      changedFile === "yarn.lock" ||
      changedFile === "package-lock.json" ||
      changedFile === "pnpm-lock.yaml"
    ) {
      continue;
    }

    /**
     * Find tests for the changed source file.
     */
    const changedAbsolutePath = path.resolve(
      repositoryRoot,
      changedFile
    );

    const matches = findTestsForSourceFile(
      changedAbsolutePath,
      testFiles,
      repositoryRoot
    );

    for (const match of matches) {
      relatedTests.push({
        ...match,
        changedFile,
      });
    }
  }

  /**
   * ============================================================
   * CASE 2: DEPENDENCY CHANGES
   * ============================================================
   *
   * For package.json we DO NOT search for tests that mention
   * "package.json".
   *
   * Instead:
   *
   * package.json
   *      ↓
   * dependency name
   *      ↓
   * source files importing dependency
   *      ↓
   * tests for those source files
   */
  for (const change of changes) {
    const changedFile = normalizePath(change.file);

    if (changedFile !== "package.json") {
      continue;
    }

    const dependencies = extractChangedDependencies(
      change.changedLines
    );

    console.log(
      `Dependencies detected in package.json: ${
        dependencies.length
      }`
    );

    for (const dependency of dependencies) {
      console.log(`Searching for dependency: ${dependency}`);

      const affectedSourceFiles = findFilesImportingPackage(
        dependency,
        sourceFiles
      );

      console.log(
        `Source files importing ${dependency}: ${
          affectedSourceFiles.length
        }`
      );

      for (const sourceFile of affectedSourceFiles) {
        const tests = findTestsForSourceFile(
          sourceFile,
          testFiles,
          repositoryRoot
        );

        for (const test of tests) {
          relatedTests.push({
            testFile: test.testFile,
            changedFile: changedFile,
            reason:
              `Test covers source file that imports dependency "${dependency}"`,
            confidence: 0.8,
          });
        }
      }
    }
  }

  /**
   * ============================================================
   * REMOVE DUPLICATES
   * ============================================================
   */
  const uniqueTests = new Map<string, TestMatch>();

  for (const match of relatedTests) {
    const key = `${match.changedFile}::${match.testFile}`;

    const existing = uniqueTests.get(key);

    /**
     * Keep the strongest relationship if the same test
     * was discovered through multiple rules.
     */
    if (
      !existing ||
      match.confidence > existing.confidence
    ) {
      uniqueTests.set(key, match);
    }
  }

  const result = Array.from(uniqueTests.values());

  console.log(`Related tests found: ${result.length}`);

  console.log("======================================");
  console.log("Test analysis completed");
  console.log("======================================");

  return {
    relatedTests: result,
  };
}

