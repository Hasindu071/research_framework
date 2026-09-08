import fs from "fs";
import path from "path";
import { Project, SyntaxKind, Node, type SourceFile } from "ts-morph";

/**
 * How a test was linked to a changed file, ordered here roughly by
 * strength of evidence (weakest to strongest):
 *   - "same-directory": co-located + related filename, positional only
 *   - "same-name": exact base filename match
 *   - "import": test resolvably imports the changed file
 *   - "symbol-usage": test calls a symbol actually defined in the
 *     changed file (AST-verified, not text search) — this is
 *     causal/behavioral evidence, not just naming/location
 *   - "locale-import": test imports a changed locale/translation file
 *   - "dependency": test covers a source file that imports a changed
 *     npm dependency
 */
export type TestRelationship =
  | "same-directory"
  | "same-name"
  | "import"
  | "symbol-usage"
  | "locale-import"
  | "dependency";

/**
 * A symbol (function/method/exported binding) that a test was found
 * to invoke, along with whether the commit's diff actually touched
 * that symbol's declaration line.
 *
 * `changed: true` is the strongest signal in this whole analyzer —
 * it means the test doesn't just happen to reference the file that
 * changed, it exercises the specific piece of behavior the commit
 * modified.
 */
export interface UsedSymbol {
  name: string;
  changed: boolean;
}

export interface TestMatch {
  testFile: string;
  changedFile: string;
  reason: string;
  confidence: number;
  relationship: TestRelationship;
  /**
   * Populated only for "symbol-usage" matches. Every symbol from the
   * changed file that the test actually calls (AST-verified), not
   * just the first one found.
   */
  symbols?: UsedSymbol[];
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
 * Escape a string for safe interpolation into a RegExp source.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const escapedPackage = escapeRegExp(packageName);

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
 * Shared ts-morph project used for AST-based (symbol-level) matching.
 * Created lazily and reused for the lifetime of the process: parsing
 * is the expensive part, and the same source/test files tend to get
 * looked at repeatedly across rules, so we cache parsed SourceFile
 * nodes on the project instead of re-parsing per call.
 *
 * NOTE: this caches by file path. If you run analyzeTests() as a
 * long-lived server process against a repo whose files change on
 * disk between calls, call resetSymbolAnalysisCache() first —
 * otherwise you'll get stale ASTs. For a one-shot CLI/CI analysis
 * this is not a concern.
 */
let sharedProject: Project | null = null;

function getProject(): Project {
  if (!sharedProject) {
    sharedProject = new Project({
      useInMemoryFileSystem: false,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
        // 4 === ts.JsxEmit.ReactJSX — hardcoded to avoid an extra
        // dependency on the `typescript` package just for one enum.
        jsx: 4,
      },
    });
  }

  return sharedProject;
}

export function resetSymbolAnalysisCache(): void {
  sharedProject = null;
}

/**
 * Get (or lazily parse) the ts-morph SourceFile node for a path.
 * Returns undefined for anything ts-morph can't parse (e.g. a
 * genuinely malformed file) rather than throwing — symbol-usage
 * matching is a bonus signal, not something the rest of the pipeline
 * should fail without.
 */
function getSourceFileNode(filePath: string): SourceFile | undefined {
  const project = getProject();

  const existing = project.getSourceFile(filePath);

  if (existing) {
    return existing;
  }

  try {
    return project.addSourceFileAtPath(filePath);
  } catch {
    return undefined;
  }
}

/**
 * Extract the names of symbols a source file exports that a test
 * could plausibly call directly: exported function declarations,
 * exported const/let bindings (arrow functions etc.), and methods on
 * exported classes.
 *
 * This is an AST walk, not a regex over the text — we only want real
 * declarations, not every substring in the file that looks like an
 * identifier. That distinction is exactly what fixed the earlier
 * false positives (a locale string or an unrelated identifier
 * shouldn't count as a "symbol").
 *
 * Known limitation: this doesn't currently resolve re-exports
 * (`export { listUsers } from "./other-file"`) back to their
 * original declaration — it only sees symbols declared directly in
 * this file.
 */
function extractExportedSymbolNames(sourceFileAbsolute: string): string[] {
  const sourceFile = getSourceFileNode(sourceFileAbsolute);

  if (!sourceFile) {
    return [];
  }

  const names = new Set<string>();

  try {
    for (const fn of sourceFile.getFunctions()) {
      const name = fn.getName();

      if (fn.isExported() && name) {
        names.add(name);
      }
    }

    for (const variableStatement of sourceFile.getVariableStatements()) {
      if (!variableStatement.isExported()) {
        continue;
      }

      for (const declaration of variableStatement.getDeclarations()) {
        names.add(declaration.getName());
      }
    }

    for (const cls of sourceFile.getClasses()) {
      if (!cls.isExported()) {
        continue;
      }

      const className = cls.getName();

      if (className) {
        names.add(className);
      }

      for (const method of cls.getMethods()) {
        names.add(method.getName());
      }
    }
  } catch {
    // Best-effort AST walk — fall back to whatever we collected
    // before hitting whatever caused the failure.
  }

  return Array.from(names);
}

/**
 * Check whether a test file contains real call expressions invoking
 * any of `symbolNames` — e.g. `repository.listUsers(...)` or
 * `listUsers(...)`. Walking call expressions (rather than searching
 * the raw text for the symbol name) means a symbol name that merely
 * appears in a comment, a string literal, or as an unrelated
 * identifier does not count as usage.
 *
 * Returns every distinct symbol name that is actually called, not
 * just the first one found — a test commonly exercises several
 * methods/functions from the same changed file (e.g. both `create()`
 * and `listUsers()`), and stopping at the first match was silently
 * dropping evidence for the rest.
 */
function findUsedSymbols(
  testFileAbsolute: string,
  symbolNames: string[]
): string[] {
  if (symbolNames.length === 0) {
    return [];
  }

  const testSourceFile = getSourceFileNode(testFileAbsolute);

  if (!testSourceFile) {
    return [];
  }

  const symbolSet = new Set(symbolNames);
  const used = new Set<string>();

  try {
    for (const call of testSourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression
    )) {
      const expression = call.getExpression();

      let calledName: string | undefined;

      if (Node.isPropertyAccessExpression(expression)) {
        // e.g. `new UserRepository(prismock).listUsers(...)`
        calledName = expression.getName();
      } else if (Node.isIdentifier(expression)) {
        // e.g. `listUsers(...)` called directly (named export)
        calledName = expression.getText();
      }

      if (calledName && symbolSet.has(calledName)) {
        used.add(calledName);
      }
    }
  } catch {
    // Best-effort — return whatever we collected before the failure.
    return Array.from(used);
  }

  return Array.from(used);
}

/**
 * Given the diff for the changed source file, determine which of its
 * exported symbol names were actually touched by the commit — i.e.
 * the symbol's name appears on an added line, which for a new or
 * modified function/method/const declaration will include the
 * signature line itself.
 *
 * This is a line-level heuristic, not a full AST diff: it checks for
 * a whole-word match of the symbol name on any added line, rather
 * than confirming that line is specifically the *declaration* line.
 * That means a symbol whose body was edited (declaration untouched,
 * but an added line inside it happens to reference the symbol name
 * again, e.g. in a recursive call or a log message) can also be
 * flagged as "changed" — which is still a reasonable signal ("this
 * function's implementation changed"), just slightly broader than
 * "this function's signature changed". Good enough for ranking
 * behavioral relevance; not a substitute for a real diff-to-AST
 * mapping if that precision is ever needed.
 */
function extractChangedSymbolNames(
  changedLines: {
    type: string;
    content: string;
  }[],
  candidateNames: string[]
): Set<string> {
  const changed = new Set<string>();

  if (candidateNames.length === 0 || changedLines.length === 0) {
    return changed;
  }

  const remaining = new Set(candidateNames);

  for (const line of changedLines) {
    if (remaining.size === 0) {
      break;
    }

    if (line.type !== "added") {
      continue;
    }

    for (const name of Array.from(remaining)) {
      const wordBoundaryRegex = new RegExp(`\\b${escapeRegExp(name)}\\b`);

      if (wordBoundaryRegex.test(line.content)) {
        changed.add(name);
        remaining.delete(name);
      }
    }
  }

  return changed;
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
 * Build the human-readable reason + confidence for a symbol-usage
 * match, given every symbol the test calls and which of those the
 * commit actually changed.
 *
 * Changed symbols are surfaced first and drive the confidence bump —
 * "the test calls the function this commit modified" is materially
 * stronger evidence than "the test calls some other function that
 * happens to live in the same file" — but we still report every
 * symbol used so nothing is silently dropped.
 */
function describeSymbolUsage(
  usedSymbols: string[],
  changedSymbolNames: Set<string>
): { reason: string; confidence: number; symbols: UsedSymbol[] } {
  const symbols: UsedSymbol[] = usedSymbols.map((name) => ({
    name,
    changed: changedSymbolNames.has(name),
  }));

  const changedNames = symbols.filter((s) => s.changed).map((s) => s.name);
  const unchangedNames = symbols.filter((s) => !s.changed).map((s) => s.name);

  if (changedNames.length > 0) {
    const changedList = changedNames.map((n) => `${n}()`).join(", ");
    let reason = `Test directly invokes ${changedList}, ${
      changedNames.length === 1 ? "which was" : "which were"
    } introduced or modified by this commit`;

    if (unchangedNames.length > 0) {
      reason += ` (also exercises pre-existing ${unchangedNames
        .map((n) => `${n}()`)
        .join(", ")})`;
    }

    return { reason, confidence: 0.99, symbols };
  }

  const usedList = usedSymbols.map((n) => `${n}()`).join(", ");

  return {
    reason: `Test directly invokes ${usedList}, defined in the changed source file`,
    confidence: 0.98,
    symbols,
  };
}

/**
 * Find tests associated with a source file.
 *
 * Rules 1–3 establish that a test is *plausibly* related, from
 * weakest positional evidence to strongest resolvable-path evidence.
 * Whichever rule fires, we then separately check for symbol-usage
 * evidence and upgrade the match if the test actually calls something
 * the changed file exports — that's stronger than any name/path
 * coincidence, regardless of which rule found the candidate. If any
 * of the used symbols were themselves changed by this commit, that's
 * upgraded again, since it's evidence the test exercises the specific
 * behavior the commit modified, not just some other export nearby.
 */
function findTestsForSourceFile(
  sourceFile: string,
  testFiles: string[],
  repositoryRoot: string,
  changedLines: {
    type: string;
    content: string;
  }[] = []
): TestMatch[] {
  const matches: TestMatch[] = [];

  const normalizedSourceFile = normalizePath(
    path.relative(repositoryRoot, sourceFile)
  );

  /**
   * Computed once per changed source file — doesn't depend on which
   * test file we're looking at.
   */
  const exportedSymbols = extractExportedSymbolNames(sourceFile);
  const changedSymbolNames = extractChangedSymbolNames(
    changedLines,
    exportedSymbols
  );

  for (const testFileAbsolute of testFiles) {
    const testFile = normalizePath(
      path.relative(repositoryRoot, testFileAbsolute)
    );

    let match: TestMatch | undefined;

    /**
     * RULE 1: Same filename.
     *
     * Example: Locations.tsx / Locations.test.tsx
     */
    if (hasMatchingTestName(normalizedSourceFile, testFile)) {
      match = {
        testFile,
        changedFile: normalizedSourceFile,
        relationship: "same-name",
        reason: "Test has the same base filename as the affected source file",
        confidence: 0.95,
      };
    } else if (testImportsFile(testFileAbsolute, sourceFile)) {
      /**
       * RULE 2: Test actually imports the changed file. Real
       * resolved-path evidence, not a text-mention heuristic.
       */
      match = {
        testFile,
        changedFile: normalizedSourceFile,
        relationship: "import",
        reason: "Test actually imports the affected source file",
        confidence: 0.95,
      };
    } else if (
      isSameDirectory(normalizedSourceFile, testFile) &&
      getBaseName(testFile)
        .toLowerCase()
        .includes(getBaseName(normalizedSourceFile).toLowerCase())
    ) {
      /**
       * RULE 3: Same directory + similar filename. Positional/naming
       * evidence, weaker than an actual import.
       */
      match = {
        testFile,
        changedFile: normalizedSourceFile,
        relationship: "same-directory",
        reason: "Test is in the same directory and has a related filename",
        confidence: 0.8,
      };
    }

    /**
     * There is deliberately no Rule 4 fallback here. We used to check
     * "does the test's text merely contain the source file's base
     * name" — that's how a locale string like "common" or a common
     * word in a filename produced unrelated matches. No evidence
     * beyond Rules 1–3 means no match.
     */
    if (!match) {
      continue;
    }

    /**
     * SYMBOL-USAGE UPGRADE: if the test actually calls one or more
     * symbols defined in the changed file, that's causal/behavioral
     * evidence — stronger than any name or path coincidence — so we
     * upgrade the match regardless of which rule above found it.
     * Symbols the commit itself changed push confidence higher still.
     */
    const usedSymbols = findUsedSymbols(testFileAbsolute, exportedSymbols);

    if (usedSymbols.length > 0) {
      const { reason, confidence, symbols } = describeSymbolUsage(
        usedSymbols,
        changedSymbolNames
      );

      match = {
        ...match,
        relationship: "symbol-usage",
        reason,
        confidence,
        symbols,
      };
    }

    matches.push(match);
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
      relationship: "locale-import",
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
        repositoryRoot,
        change.changedLines
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
        /**
         * Symbol-usage evidence from these tests isn't meaningful
         * for a dependency-driven match: the "commit" here is a
         * package.json bump, not an edit to `sourceFile` itself, so
         * there's no diff to check for changed symbols. We still
         * call findTestsForSourceFile() to reuse Rules 1–3, but the
         * resulting relationship/reason below is deliberately
         * overwritten to "dependency" rather than "symbol-usage".
         */
        const tests = findTestsForSourceFile(
          sourceFile,
          testFiles,
          repositoryRoot,
          []
        );

        for (const test of tests) {
          relatedTests.push({
            testFile: test.testFile,
            changedFile: changedFile,
            relationship: "dependency",
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