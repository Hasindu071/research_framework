import fs from "fs";
import path from "path";
import {
  Node,
  Project,
  SyntaxKind,
  VariableDeclarationKind,
  type SourceFile,
  type VariableDeclaration,
} from "ts-morph";

/**
 * How a test was linked to a changed file, ordered here roughly by
 * strength of evidence (weakest to strongest):
 *   - "same-directory": co-located + related filename, positional only
 *   - "same-name": exact base filename match
 *   - "import": test resolvably imports the changed file
 *   - "symbol-usage": test references an element actually defined in
 *     the changed file (AST-verified, not text search) — this is
 *     causal/behavioral evidence, not just naming/location. Covers
 *     functions/methods/classes (via call/`new` expressions) *and*
 *     constants/arrays/objects/variables (via real identifier
 *     references), so a change like `MAX_RETRIES = 3 -> 5` or
 *     `allowedRoles = [...]` gaining an entry is picked up even
 *     though no function signature changed.
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
 * The kind of exported binding an element is. "function"/"method"/
 * "class" are matched via call/`new` expressions (behavioral
 * invocation). "constant"/"array"/"object"/"variable" are matched via
 * any real identifier reference, since they're read/compared rather
 * than called — e.g. `expect(MAX_RETRIES).toBe(3)` or
 * `allowedRoles.includes('author')`.
 */
export type ElementKind =
  | "function"
  | "method"
  | "class"
  | "constant"
  | "array"
  | "object"
  | "variable";

interface ExportedElement {
  name: string;
  kind: ElementKind;
}

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
/**
 * Whether a symbol-usage match exercises behavior the commit actually
 * changed ("direct") or merely calls/references some other,
 * unmodified export from the same file ("indirect") — e.g. shared
 * setup/helper methods on the same repository class, or an unrelated
 * constant exported from the same config file. This is the
 * distinction that matters for "what does this commit impact", as
 * opposed to "what shares a file with something that changed".
 */
export type SymbolImpact = "direct" | "indirect";

export interface TestMatch {
  testFile: string;
  changedFile: string;
  reason: string;
  confidence: number;
  relationship: TestRelationship;
  /**
   * Populated only for "symbol-usage" matches. Every element from the
   * changed file that the test actually references (AST-verified),
   * not just the first one found. Includes functions/methods/classes
   * as well as constants/arrays/objects/variables.
   */
  symbols?: string[];
  /**
   * Subset of `symbols` that the commit's diff actually touched.
   * Empty (not omitted) when the test uses the changed file but none
   * of the specific elements it references were modified — that
   * emptiness is itself meaningful, so callers shouldn't have to
   * distinguish "empty array" from "field absent".
   */
  changedSymbolsUsed?: string[];
  /**
   * Kind of each name appearing in `symbols`/`changedSymbolsUsed`
   * (function, method, class, constant, array, object, variable),
   * keyed by name. Lets downstream consumers (LLM context, reports)
   * describe *what kind* of change a test is tied to, e.g.
   * "MAX_RETRIES (constant)" vs. "listUsers() (function)".
   */
  symbolKinds?: Record<string, ElementKind>;
  /**
   * "direct": at least one referenced element was changed by this
   * commit. "indirect": the test references elements from the
   * changed file, but none of those specific elements were
   * themselves modified.
   */
  impact?: SymbolImpact;
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
    // Process both added AND deleted lines to catch version changes
    // For example, a version bump appears as:
    // - "shell-quote": "1.8.2"  (type: "deleted")
    // + "shell-quote": "1.8.4"  (type: "added")
    if (line.type !== "added" && line.type !== "deleted") {
      continue;
    }

    /**
     * Match package.json format:
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
 * Extract package names from yarn.lock changes.
 *
 * yarn.lock format:
 *
 * "shell-quote@npm:^1.8.1":
 *   version: 1.8.2
 *   resolution: "shell-quote@npm:1.8.2"
 */
function extractChangedDependenciesFromYarnLock(
  changedLines: {
    type: string;
    content: string;
  }[]
): string[] {
  const dependencies = new Set<string>();

  for (const line of changedLines) {
    if (line.type !== "added" && line.type !== "deleted") {
      continue;
    }

    /**
     * Match yarn.lock package entry:
     *
     * "shell-quote@npm:^1.8.1":
     *  or
     * "shell-quote@npm:1.8.4":
     */
    const match = line.content.match(
      /^\s*["']([^"'@]+)@/
    );

    if (!match?.[1]) {
      continue;
    }

    const packageName = match[1];

    // Avoid duplicates
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
 * Classify a single exported variable declaration by the shape of
 * its initializer. This is what lets a change to
 *
 *   export const MAX_RETRIES = 3;
 *   export const allowedRoles = ['admin', 'editor'];
 *   export const config = { timeout: 5000 };
 *
 * be recognized as a "constant"/"array"/"object" change respectively
 * — not just as an opaque "exported binding" that only matters if
 * something calls it like a function.
 *
 * Anything that isn't a literal (arrow/function expression, array
 * literal, object literal, or a plain literal for `const`) falls back
 * to "variable" — e.g. `let count = 0`, or `const x = someCall()`
 * whose value isn't known statically.
 */
function classifyVariableDeclaration(
  declaration: VariableDeclaration,
  declarationKind: VariableDeclarationKind
): ElementKind {
  const initializer = declaration.getInitializer();

  if (!initializer) {
    return declarationKind === VariableDeclarationKind.Const
      ? "constant"
      : "variable";
  }

  if (
    Node.isArrowFunction(initializer) ||
    Node.isFunctionExpression(initializer)
  ) {
    return "function";
  }

  if (Node.isArrayLiteralExpression(initializer)) {
    return "array";
  }

  if (Node.isObjectLiteralExpression(initializer)) {
    return "object";
  }

  const isSimpleLiteral =
    Node.isStringLiteral(initializer) ||
    Node.isNumericLiteral(initializer) ||
    Node.isNoSubstitutionTemplateLiteral(initializer) ||
    Node.isTemplateExpression(initializer) ||
    initializer.getKind() === SyntaxKind.TrueKeyword ||
    initializer.getKind() === SyntaxKind.FalseKeyword ||
    (Node.isPrefixUnaryExpression(initializer) &&
      Node.isNumericLiteral(initializer.getOperand()));

  if (declarationKind === VariableDeclarationKind.Const && isSimpleLiteral) {
    return "constant";
  }

  return "variable";
}

/**
 * Extract every element a source file exports that a test could
 * plausibly reference: exported function declarations, exported
 * const/let/var bindings (functions, constants, arrays, objects, or
 * plain variables), and methods/name on exported classes.
 *
 * This is an AST walk, not a regex over the text — we only want real
 * declarations, not every substring in the file that looks like an
 * identifier. That distinction is exactly what fixed the earlier
 * false positives (a locale string or an unrelated identifier
 * shouldn't count as an element).
 *
 * Known limitation: this doesn't currently resolve re-exports
 * (`export { listUsers } from "./other-file"`) back to their
 * original declaration — it only sees elements declared directly in
 * this file.
 */
function extractExportedElements(sourceFileAbsolute: string): ExportedElement[] {
  const sourceFile = getSourceFileNode(sourceFileAbsolute);

  if (!sourceFile) {
    return [];
  }

  const elements = new Map<string, ElementKind>();

  try {
    for (const fn of sourceFile.getFunctions()) {
      const name = fn.getName();

      if (fn.isExported() && name) {
        elements.set(name, "function");
      }
    }

    for (const variableStatement of sourceFile.getVariableStatements()) {
      if (!variableStatement.isExported()) {
        continue;
      }

      const declarationKind = variableStatement.getDeclarationKind();

      for (const declaration of variableStatement.getDeclarations()) {
        const name = declaration.getName();
        const kind = classifyVariableDeclaration(declaration, declarationKind);

        elements.set(name, kind);
      }
    }

    for (const cls of sourceFile.getClasses()) {
      if (!cls.isExported()) {
        continue;
      }

      const className = cls.getName();

      if (className) {
        elements.set(className, "class");
      }

      for (const method of cls.getMethods()) {
        elements.set(method.getName(), "method");
      }
    }
  } catch {
    // Best-effort AST walk — fall back to whatever we collected
    // before hitting whatever caused the failure.
  }

  return Array.from(elements.entries()).map(([name, kind]) => ({
    name,
    kind,
  }));
}

/**
 * Check whether a test file actually references any of `elements`.
 *
 * Functions/methods/classes are matched behaviorally — a real call
 * expression (`repository.listUsers(...)`, `listUsers(...)`) or a
 * `new ClassName(...)` — the same AST-verified approach as before.
 *
 * Constants/arrays/objects/variables are *not* called, they're read,
 * so we instead look for any real identifier reference to the name
 * (excluding the import specifier's own identifier, since importing
 * a name isn't "using" it). This is the piece that was missing:
 * `import { MAX_RETRIES } from './config'; expect(MAX_RETRIES).toBe(3)`
 * has zero call expressions on MAX_RETRIES, so the old call-only
 * check reported no usage at all for this extremely common pattern.
 *
 * Returns every distinct element actually referenced, not just the
 * first one found — a test commonly exercises several bindings from
 * the same changed file (e.g. both `MAX_RETRIES` and `allowedRoles`),
 * and stopping at the first match was silently dropping evidence for
 * the rest.
 */
function findUsedElements(
  testFileAbsolute: string,
  elements: ExportedElement[]
): ExportedElement[] {
  if (elements.length === 0) {
    return [];
  }

  const testSourceFile = getSourceFileNode(testFileAbsolute);

  if (!testSourceFile) {
    return [];
  }

  const byName = new Map(elements.map((element) => [element.name, element.kind]));
  const used = new Map<string, ElementKind>();

  try {
    // Functions / methods: real call expressions.
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

      if (!calledName) {
        continue;
      }

      const kind = byName.get(calledName);

      if (kind === "function" || kind === "method") {
        used.set(calledName, kind);
      }
    }

    // Classes: `new Foo(...)`.
    for (const newExpression of testSourceFile.getDescendantsOfKind(
      SyntaxKind.NewExpression
    )) {
      const expression = newExpression.getExpression();

      if (!Node.isIdentifier(expression)) {
        continue;
      }

      const name = expression.getText();
      const kind = byName.get(name);

      if (kind === "class") {
        used.set(name, kind);
      }
    }

    // Constants / arrays / objects / variables: any real identifier
    // reference, since these are read/compared rather than called.
    for (const identifier of testSourceFile.getDescendantsOfKind(
      SyntaxKind.Identifier
    )) {
      const name = identifier.getText();
      const kind = byName.get(name);

      if (
        kind !== "constant" &&
        kind !== "array" &&
        kind !== "object" &&
        kind !== "variable"
      ) {
        continue;
      }

      const parent = identifier.getParent();

      // Importing a name isn't "using" it on its own — skip the
      // import specifier/clause's own identifier so a plain
      // `import { MAX_RETRIES } from './config'` with no further
      // reference doesn't count as usage by itself.
      if (
        parent &&
        (Node.isImportSpecifier(parent) || Node.isImportClause(parent))
      ) {
        continue;
      }

      used.set(name, kind);
    }
  } catch {
    // Best-effort — return whatever we collected before the failure.
    return Array.from(used.entries()).map(([name, kind]) => ({ name, kind }));
  }

  return Array.from(used.entries()).map(([name, kind]) => ({ name, kind }));
}

/**
 * Given the diff for the changed source file, determine which of its
 * exported element names were actually touched by the commit — i.e.
 * the element's name appears on an added line, which for a new or
 * modified function/method/const/array/object declaration will
 * include the declaration line itself.
 *
 * This is a line-level heuristic, not a full AST diff: it checks for
 * a whole-word match of the name on any added line, rather than
 * confirming that line is specifically the *declaration* line. For a
 * value change like `MAX_RETRIES = 3` -> `MAX_RETRIES = 5`, or an
 * array literal gaining an entry, the declaration line itself is what
 * changed, so this still lines up with "this element's value
 * changed" — just slightly broader than "this exact line changed",
 * the same tradeoff already accepted for function/method changes.
 */
function extractChangedElementNames(
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
 * Build the human-readable reason, confidence, and impact
 * classification for a symbol/element-usage match, given every
 * element the test references and which of those the commit actually
 * changed.
 *
 * This is the direct/indirect split: a test that references an
 * element the commit modified is evidence the test exercises the
 * changed behavior ("direct impact") — whether that element is a
 * function it calls or a constant it compares against. A test that
 * merely references other, unmodified exports from the same file —
 * e.g. shared setup methods on the same repository class, or an
 * unrelated constant from the same config file — has a real
 * relationship to the file but not to the change itself ("indirect"),
 * and its confidence should reflect that.
 */
function describeElementUsage(
  usedElements: ExportedElement[],
  changedElementNames: Set<string>
): {
  reason: string;
  confidence: number;
  symbols: string[];
  changedSymbolsUsed: string[];
  symbolKinds: Record<string, ElementKind>;
  impact: SymbolImpact;
} {
  const symbolKinds: Record<string, ElementKind> = {};

  for (const element of usedElements) {
    symbolKinds[element.name] = element.kind;
  }

  const describe = (element: ExportedElement): string =>
    element.kind === "function" || element.kind === "method"
      ? `${element.name}()`
      : `${element.name} (${element.kind})`;

  const usedNames = usedElements.map((element) => element.name);
  const changedUsed = usedElements.filter((element) =>
    changedElementNames.has(element.name)
  );

  if (changedUsed.length > 0) {
    const changedList = changedUsed.map(describe).join(", ");
    const unchangedUsed = usedElements.filter(
      (element) => !changedElementNames.has(element.name)
    );

    let reason = `Test directly references ${changedList}, ${
      changedUsed.length === 1 ? "which was" : "which were"
    } introduced or modified by this commit`;

    if (unchangedUsed.length > 0) {
      reason += ` (also references pre-existing ${unchangedUsed
        .map(describe)
        .join(", ")})`;
    }

    return {
      reason,
      confidence: 0.99,
      symbols: usedNames,
      changedSymbolsUsed: changedUsed.map((element) => element.name),
      symbolKinds,
      impact: "direct",
    };
  }

  return {
    reason:
      "Test references elements defined in the changed source file, but none of the referenced elements were modified by this commit",
    confidence: 0.65,
    symbols: usedNames,
    changedSymbolsUsed: [],
    symbolKinds,
    impact: "indirect",
  };
}

/**
 * Find tests associated with a source file.
 *
 * Rules 1–3 establish that a test is *plausibly* related, from
 * weakest positional evidence to strongest resolvable-path evidence.
 * Whichever rule fires, we then separately check for element-usage
 * evidence and upgrade the match if the test actually references
 * something the changed file exports — that's stronger than any
 * name/path coincidence, regardless of which rule found the
 * candidate. If any of the used elements were themselves changed by
 * this commit, that's upgraded again, since it's evidence the test
 * exercises the specific behavior the commit modified, not just some
 * other export nearby.
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
   * test file we're looking at. Covers functions/methods/classes
   * *and* constants/arrays/objects/variables.
   */
  const exportedElements = extractExportedElements(sourceFile);
  const changedElementNames = extractChangedElementNames(
    changedLines,
    exportedElements.map((element) => element.name)
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
     * ELEMENT-USAGE UPGRADE: if the test actually references one or
     * more elements defined in the changed file — a function it
     * calls, a class it instantiates, or a constant/array/object it
     * reads — that's causal/behavioral evidence, stronger than any
     * name or path coincidence, so we upgrade the match regardless of
     * which rule above found it. Elements the commit itself changed
     * push confidence higher still.
     */
    const usedElements = findUsedElements(testFileAbsolute, exportedElements);

    if (usedElements.length > 0) {
      const { reason, confidence, symbols, changedSymbolsUsed, symbolKinds, impact } =
        describeElementUsage(usedElements, changedElementNames);

      match = {
        ...match,
        relationship: "symbol-usage",
        reason,
        confidence,
        symbols,
        changedSymbolsUsed,
        symbolKinds,
        impact,
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
 *    Includes both symbol changes (functions/methods/classes) and
 *    data/value changes (constants/arrays/objects/variables) — see
 *    findTestsForSourceFile().
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

    if (changedFile !== "package.json" && changedFile !== "yarn.lock") {
      continue;
    }

    const dependencies = changedFile === "yarn.lock"
      ? extractChangedDependenciesFromYarnLock(change.changedLines)
      : extractChangedDependencies(change.changedLines);

    console.log(
      `Dependencies detected in ${changedFile}: ${
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
         * Element-usage evidence from these tests isn't meaningful
         * for a dependency-driven match: the "commit" here is a
         * package.json bump, not an edit to `sourceFile` itself, so
         * there's no diff to check for changed elements. We still
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