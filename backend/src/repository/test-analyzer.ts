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
 *
 * Handles all naming conventions found in the repo:
 *   - *.test.ts(x) / *.spec.ts(x)
 *   - *.timezone.test.ts   (still ends in ".test.ts", already covered)
 *   - *.integration-test.ts   (NOTE: hyphen before "test", not a dot —
 *     needs its own pattern, the old regex never matched this)
 *   - *.e2e.ts(x)   (was completely unhandled before)
 *   - anything inside a __tests__/ directory
 */
function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");

  return (
    /\.test\.(ts|tsx|js|jsx)$/.test(normalized) ||
    /\.spec\.(ts|tsx|js|jsx)$/.test(normalized) ||
    /\.e2e\.(ts|tsx|js|jsx)$/.test(normalized) ||
    /\.integration-test\.(ts|tsx|js|jsx)$/.test(normalized) ||
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
 * Check whether a file is a localization/translation file.
 *
 * These are JSON files, but they are NOT "source code" in the sense
 * that matters for our matching rules: they aren't imported the way
 * a .ts module is, they don't have a natural "test with the same
 * basename", and their content is just translation strings — running
 * them through the code-matching rules is what produced false
 * positives like `common.json` matching `next-i18next.config.test.ts`
 * purely because the word "common" appears somewhere in that file.
 */
function isLocaleFile(filePath: string): boolean {
  const normalized = normalizePath(filePath);

  return (
    /\.json$/.test(normalized) &&
    /(^|\/)(locales?|i18n|translations)(\/|$)/.test(normalized)
  );
}

type FileCategory = "code" | "locale" | "dependency" | "unknown";

const DEPENDENCY_FILES = new Set([
  "package.json",
  "yarn.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
]);

/**
 * Route a changed file to the right analysis strategy instead of
 * shoving everything through the code-matching path. This is the
 * fix for CASE 1 previously calling findTestsForSourceFile() on
 * every non-package changed file, including JSON locale files,
 * markdown, YAML, etc.
 */
function categorizeFile(filePath: string): FileCategory {
  const normalized = normalizePath(filePath);

  if (DEPENDENCY_FILES.has(normalized)) {
    return "dependency";
  }

  if (isLocaleFile(normalized)) {
    return "locale";
  }

  if (isSourceFile(normalized)) {
    return "code";
  }

  return "unknown";
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
 * Get a file name without its extension and without any
 * test-related suffix.
 *
 * Examples:
 *
 * Locations.tsx                    -> Locations
 * Locations.test.tsx               -> Locations
 * Locations.spec.tsx               -> Locations
 * Locations.e2e.ts                 -> Locations
 * handleNewBooking.integration-test.ts -> handleNewBooking
 * Locations.timezone.test.tsx      -> Locations
 *
 * NOTE: order matters here. The more specific "compound" suffixes
 * (".integration-test.", ".timezone.test.") must be stripped BEFORE
 * the generic ".test./.spec./.e2e." pattern, otherwise the generic
 * pattern only strips the trailing ".test.ts" and leaves a mismatched
 * base name like "Locations.timezone".
 */
function getBaseName(filePath: string): string {
  const fileName = path.basename(filePath);

  return fileName
    .replace(/\.integration-test\.(ts|tsx|js|jsx)$/, "")
    .replace(/\.timezone\.test\.(ts|tsx|js|jsx)$/, "")
    .replace(/\.(test|spec|e2e)\.(ts|tsx|js|jsx)$/, "")
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
 * import "i18next-fs-backend"          (side-effect import — was missing)
 * require("i18next-fs-backend")
 * import("i18next-fs-backend")
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
    `(?:from\\s+|import\\s*\\(|import\\s+|require\\s*\\()\\s*["']${escapedPackage}["']`,
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
 * Extract relative import/require specifiers from a file's content.
 *
 * We only care about relative specifiers (starting with "." or "/")
 * because those are the ones that can point at another file inside
 * the repo — package imports like "react" or "i18next-fs-backend"
 * are handled separately by sourceImportsPackage().
 */
function extractRelativeImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];

  const importRegex =
    /(?:from\s+|import\s*\(|import\s+|require\s*\()\s*["'](\.[^"']+)["']/g;

  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(content)) !== null) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

/**
 * Resolve a relative import specifier found inside `fromFileAbsolute`
 * to the set of absolute paths it could plausibly point at, mirroring
 * how bundlers/TS resolve extensionless and index imports.
 */
function resolveImportCandidates(
  fromFileAbsolute: string,
  specifier: string
): string[] {
  const resolvedBase = path.resolve(path.dirname(fromFileAbsolute), specifier);

  const candidates = [resolvedBase];

  for (const extension of [...SOURCE_EXTENSIONS, ".json"]) {
    candidates.push(`${resolvedBase}${extension}`);
    candidates.push(path.join(resolvedBase, `index${extension}`));
  }

  return candidates;
}

/**
 * Real evidence check: does `testFileAbsolute` actually import
 * `targetFileAbsolute`, based on resolving its relative import
 * specifiers — not just on the target's basename appearing as text
 * somewhere in the test file.
 */
function testImportsFile(
  testFileAbsolute: string,
  targetFileAbsolute: string
): boolean {
  let content: string;

  try {
    content = fs.readFileSync(testFileAbsolute, "utf8");
  } catch {
    return false;
  }

  const normalizedTarget = normalizePath(path.normalize(targetFileAbsolute));

  for (const specifier of extractRelativeImportSpecifiers(content)) {
    const candidates = resolveImportCandidates(testFileAbsolute, specifier);

    if (
      candidates.some(
        (candidate) => normalizePath(path.normalize(candidate)) === normalizedTarget
      )
    ) {
      return true;
    }
  }

  return false;
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
     * Test actually imports the changed file. This is real evidence
     * (a resolved import path), not a text-mention heuristic, so it
     * gets the same top confidence as an exact filename match.
     */
    if (testImportsFile(testFileAbsolute, sourceFile)) {
      matches.push({
        testFile,
        changedFile: normalizedSourceFile,
        reason: "Test actually imports the affected source file",
        confidence: 0.95,
      });

      continue;
    }

    /**
     * RULE 3:
     *
     * Same directory + similar filename. Positional/naming evidence,
     * weaker than an actual import, so it sits below the two rules
     * above.
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
        confidence: 0.8,
      });

      continue;
    }

    /**
     * There is deliberately no Rule 4 here. We used to fall back to
     * "does the test's text merely contain the source file's base
     * name" — that's how a locale string like "common" or a common
     * word in a source filename produced unrelated matches. No
     * evidence beyond Rules 1–3 means no match.
     */
  }

  return matches;
}

/**
 * Find tests related to a changed localization/translation file.
 *
 * Locale JSON files aren't "imported" the way TS modules are in most
 * i18next setups (they're loaded by namespace/path at runtime), and
 * they don't have a natural same-named test file. Rather than fall
 * back to scanning test file text for the namespace name (which is
 * exactly the false-positive source — "common" appearing anywhere),
 * we only report a match when a test file demonstrably imports the
 * JSON file directly. No import evidence => no match, on purpose.
 */
function findTestsForLocaleFile(
  localeFile: string,
  testFiles: string[],
  repositoryRoot: string
): TestMatch[] {
  const matches: TestMatch[] = [];

  const normalizedLocaleFile = normalizePath(
    path.relative(repositoryRoot, localeFile)
  );

  for (const testFileAbsolute of testFiles) {
    if (!testImportsFile(testFileAbsolute, localeFile)) {
      continue;
    }

    const testFile = normalizePath(
      path.relative(repositoryRoot, testFileAbsolute)
    );

    matches.push({
      testFile,
      changedFile: normalizedLocaleFile,
      reason: "Test directly imports the changed locale/translation file",
      confidence: 0.9,
    });
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
     * A changed TEST file is not a production file that itself needs
     * tests. Without this guard, a changed UserRepository.test.ts
     * gets run through findTestsForSourceFile() like it was source
     * code, matching other tests that merely share its base name
     * (e.g. UserRepository.integration-test.ts) — and in the worst
     * case matching itself (testFile === changedFile). We still want
     * to know a test changed; we just don't go looking for "tests
     * for the test".
     */
    if (isTestFile(changedFile)) {
      continue;
    }

    const category = categorizeFile(changedFile);

    /**
     * Dependency files (package.json, lockfiles) are handled
     * separately below via dependency analysis.
     */
    if (category === "dependency") {
      continue;
    }

    const changedAbsolutePath = path.resolve(
      repositoryRoot,
      changedFile
    );

    let matches: TestMatch[];

    if (category === "code") {
      matches = findTestsForSourceFile(
        changedAbsolutePath,
        testFiles,
        repositoryRoot
      );
    } else if (category === "locale") {
      matches = findTestsForLocaleFile(
        changedAbsolutePath,
        testFiles,
        repositoryRoot
      );
    } else {
      /**
       * "unknown" — markdown, YAML, images, config files with no
       * dedicated analysis strategy, etc. There is no evidence-based
       * way to match these to tests yet, so we skip them rather than
       * falling back to the code-matching heuristics (which is how
       * a README or a .env.example used to pick up unrelated test
       * matches).
       */
      continue;
    }

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