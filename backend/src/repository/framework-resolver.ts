import fs from "fs";
import path from "path";
import type { TestFramework } from "./frameworks.js";

// ======================================================
// TYPES
// ======================================================

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun" | "unknown";

/**
 * Complete context for a package/workspace, resolved from the test file's
 * location. This is the foundation — everything else derives from this.
 */
export interface PackageContext {
  /** Absolute path to the package directory (where package.json lives). */
  packageDir: string;
  /** Absolute path to package.json. */
  packageJsonPath: string;
  /** Package name from package.json (may be undefined for root). */
  packageName?: string;
  /** Package manager detected for this repository. */
  packageManager: PackageManager;
  /** All scripts from this package.json. */
  scripts: Record<string, string>;
  /** Dependencies + devDependencies combined. */
  allDeps: Record<string, string>;
}

export interface FrameworkResolution {
  framework: TestFramework | null;
  packageManager: PackageManager;
  workspaceDir: string; // absolute path to the dir tests should be run from
  workspaceRelative: string; // relative to repo root
  configFile: string | null; // relative to repo root
  /**
   * Test file path relative to `workspaceDir` (NOT repoRoot). This is what
   * should actually be passed on the command line once cwd = workspaceDir,
   * since include/exclude patterns in the config are resolved relative to
   * the config's own directory, not the repo root.
   */
  testPathRelativeToWorkspace: string;
  confidence: number; // 0-1 scale
  evidence: string[]; // breadcrumb trail for debugging
  /**
   * True only when we found a config file AND verified (via its
   * include/exclude patterns) that it actually claims this test file.
   * False means the framework was inferred by a weaker signal (imports,
   * scripts, deps) or a config was found but didn't match, so callers
   * should treat the resolution with more caution.
   */
  configVerified: boolean;
  /**
   * True if the verified config is a workspace/projects-based config
   * (not a leaf config). When true, the runner should NOT pass --config
   * and instead auto-discover from the workspace directory, to avoid
   * triggering root-level project glob validation errors.
   */
  configIsWorkspace: boolean;
  /**
   * Available test scripts in the owning package.json, in order of preference.
   * Empty if no test scripts found. Can be used to choose a more specific
   * test command than the generic framework invocation.
   */
  testScripts?: string[];
}

// ======================================================
// CONSTANTS
// ======================================================

const CONFIG_FILES: Record<TestFramework, string[]> = {
  vitest: [
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mts",
    "vitest.config.mjs",
    "vite.config.ts",
    "vite.config.js",
  ],
  jest: [
    "jest.config.js",
    "jest.config.ts",
    "jest.config.cjs",
    "jest.config.mjs",
  ],
  playwright: ["playwright.config.ts", "playwright.config.js"],
  mocha: [".mocharc.json", ".mocharc.js", ".mocharc.cjs", ".mocharc.yml"],
};

const DEP_NAMES: Record<TestFramework, string[]> = {
  vitest: ["vitest"],
  jest: ["jest"],
  playwright: ["@playwright/test", "playwright"],
  mocha: ["mocha"],
};

// Fallback include patterns used when a config doesn't declare its own
// (or we can't statically extract one). These mirror each framework's
// documented defaults, simplified to patterns our mini glob engine
// understands (no extglob).
const DEFAULT_INCLUDE: Record<TestFramework, string[]> = {
  vitest: ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
  jest: [
    "**/__tests__/**/*.{js,jsx,ts,tsx}",
    "**/*.{test,spec}.{js,jsx,ts,tsx}",
  ],
  playwright: ["**/*.{test,spec}.{js,ts,jsx,tsx,mjs}"],
  mocha: ["test/**/*.{js,cjs,mjs}"],
};

const DEFAULT_EXCLUDE: string[] = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
];

// ======================================================
// PACKAGE MANAGER DETECTION
// ======================================================

export function detectPackageManager(repoRoot: string): PackageManager {
  // Priority 1: Check root package.json's packageManager field
  const rootPkg = readPkgJson(repoRoot);
  if (rootPkg?.packageManager) {
    // Format is typically "pnpm@8.0.0", "yarn@3.6.0", etc.
    const pm = rootPkg.packageManager.split("@")[0];
    if (pm === "pnpm" || pm === "yarn" || pm === "npm" || pm === "bun") {
      return pm as PackageManager;
    }
  }

  // Priority 2: Lockfile detection (repo root)
  if (fs.existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(repoRoot, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(repoRoot, "package-lock.json"))) return "npm";
  if (
    fs.existsSync(path.join(repoRoot, "bun.lockb")) ||
    fs.existsSync(path.join(repoRoot, "bun.lock"))
  )
    return "bun";

  return "unknown";
}

// ======================================================
// WORKSPACE/PACKAGE DETECTION
// ======================================================

/**
 * Resolve the package context for a test file by walking up from its
 * location to find the nearest package.json (the owning package).
 * 
 * This is Step 1 of the new architecture — everything else flows from here.
 */
export function resolvePackageContext(
  testFile: string,
  repoRoot: string
): PackageContext {
  const ancestorDirs = collectAncestorDirs(testFile, repoRoot);
  const packageDir = findNearestWorkspace(ancestorDirs);
  const packageJsonPath = path.join(packageDir, "package.json");

  // Read the package
  const pkg = readPkgJson(packageDir) || {};
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const packageManager = detectPackageManager(repoRoot);

  return {
    packageDir,
    packageJsonPath,
    packageName: pkg.name,
    packageManager,
    scripts: pkg.scripts || {},
    allDeps,
  };
}

/**
 * Build list of ancestor directories from test file to repo root (inclusive).
 */
function collectAncestorDirs(testFile: string, repoRoot: string): string[] {
  const dirs: string[] = [];
  const rootResolved = path.resolve(repoRoot);
  let cur = path.dirname(path.resolve(repoRoot, testFile));

  while (true) {
    dirs.push(cur);
    if (cur === rootResolved) break;
    const parent = path.dirname(cur);
    if (parent === cur) break; // hit filesystem root without matching repoRoot
    cur = parent;
  }

  return dirs;
}

/**
 * Find the nearest package.json by walking up from test file.
 */
function findNearestWorkspace(dirs: string[]): string {
  for (const dir of dirs) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
  }
  return dirs[dirs.length - 1]!; // fallback to repo root (dirs always has at least one element)
}

// ======================================================
// PACKAGE.JSON HELPERS
// ======================================================

function readPkgJson(dir: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

// ======================================================
// MINI GLOB ENGINE
// ======================================================
// Deliberately small: we only need to support the glob syntax that shows up
// in real-world vitest/jest/playwright/mocha configs (`**`, `*`, `?`, and
// brace groups like `{js,ts}`). We do NOT support extglob (`?(...)`,
// `+(...)`) or negation — those are rare in `include`/`exclude` arrays and
// fall back gracefully to "doesn't match" rather than throwing.

function escapeRegexChar(c: string): string {
  return c.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        i += 1;
        continue;
      }
      const options = glob
        .slice(i + 1, end)
        .split(",")
        .map((opt) => opt.split("").map(ch => escapeRegexChar(ch)).join(""));
      re += `(?:${options.join("|")})`;
      i = end + 1;
      continue;
    }
    if (c) {
      re += escapeRegexChar(c);
    }
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function globMatch(glob: string, testPath: string): boolean {
  try {
    return globToRegExp(glob).test(testPath);
  } catch {
    return false;
  }
}

function matchesAny(patterns: string[], testPath: string): boolean {
  return patterns.some((p) => globMatch(p, testPath));
}

// ======================================================
// CONFIG FILE DISCOVERY
// ======================================================

interface ConfigCandidate {
  dir: string;
  file: string;
  framework: TestFramework;
}

function findConfigCandidates(
  dirs: string[],
  framework: TestFramework
): ConfigCandidate[] {
  const found: ConfigCandidate[] = [];
  for (const dir of dirs) {
    for (const candidate of CONFIG_FILES[framework]) {
      if (fs.existsSync(path.join(dir, candidate))) {
        found.push({ dir, file: candidate, framework });
      }
    }
  }
  return found;
}

/**
 * Best-effort extraction of all array-of-strings (or single string) values
 * assigned to `key` in a config file's source text. This is a textual
 * heuristic, not a real parser/evaluator — configs are TS/JS and we don't
 * want to execute arbitrary project code just to resolve a test. It handles
 * the common shapes:
 *   include: ['a', 'b']
 *   include: ["a"]
 *   include: 'a'
 *   test: { include: [...] }   <- matched regardless of nesting, since we
 *                                  just look for the key anywhere in the file
 *
 * When multiple occurrences exist (e.g., nested projects each with their own
 * include), returns a union of all matches. This is used to handle Vitest's
 * `projects` feature, where each project block has its own include patterns.
 */
function extractAllStringArraysAfterKey(content: string, key: string): string[] {
  const keyRegex = new RegExp(`\\b${key}\\s*:\\s*`, "g");
  let match: RegExpExecArray | null;
  const allStrings: Set<string> = new Set();

  while ((match = keyRegex.exec(content))) {
    const start = match.index + match[0].length;
    const next = content[start];

    if (next === "[") {
      // Find the matching closing bracket.
      let depth = 0;
      let end = start;
      for (; end < content.length; end++) {
        if (content[end] === "[") depth++;
        else if (content[end] === "]") {
          depth--;
          if (depth === 0) {
            end++;
            break;
          }
        }
      }
      const arrayText = content.slice(start, end);
      const strings = [...arrayText.matchAll(/['"`]([^'"`]+)['"`]/g)]
        .map((m) => m[1])
        .filter((s): s is string => s !== undefined);
      strings.forEach((s) => allStrings.add(s));
    } else if (next === "'" || next === '"' || next === "`") {
      const quote = next;
      const end = content.indexOf(quote, start + 1);
      if (end !== -1) {
        allStrings.add(content.slice(start + 1, end));
      }
    }
  }

  return Array.from(allStrings);
}

/**
 * Extract testDir values from a Playwright config.
 * testDir is a single path string, not an array.
 * Returns globs that can be used as include patterns.
 */
function extractPlaywrightTestDir(content: string): string[] {
  const testDirRegex = /\btestDir\s*:\s*['"`]([^'"`]+)['"`]/g;
  let match: RegExpExecArray | null;
  const dirs: Set<string> = new Set();

  while ((match = testDirRegex.exec(content))) {
    const dir = match[1];
    // Convert testDir to include pattern (e.g., "tests" → "tests/**/*.test.ts")
    dirs.add(`${dir}/**/*.{test,spec}.{js,ts,jsx,tsx,mjs}`);
  }

  return Array.from(dirs);
}

/**
 * Extract testMatch patterns from a config (used by Jest, Mocha, Playwright).
 * testMatch is an array of glob patterns.
 */
function extractTestMatchPatterns(content: string): string[] {
  return extractAllStringArraysAfterKey(content, "testMatch");
}

/**
 * Check if a config file declares a workspace/projects feature.
 * If it does, it's not a leaf config with its own include/exclude — it's a
 * router that delegates to sub-configs, and shouldn't be treated as
 * directly verifiable via DEFAULT_INCLUDE fallback.
 */
function configHasWorkspaceProjects(content: string, framework?: TestFramework): boolean {
  // For Playwright, "projects" means browser targets (chromium, firefox, webkit),
  // NOT a workspace configuration. Only "workspace" indicates a workspace config.
  if (framework === "playwright") {
    return /\bworkspace\s*:\s*/.test(content);
  }
  // For other frameworks (Vitest, Jest, etc.), both "projects" and "workspace"
  // indicate a workspace/multi-project configuration.
  return /\b(projects|workspace)\s*:\s*/.test(content);
}

/**
 * Read a config file and report whether it declares a workspace/projects
 * feature (e.g. Vitest's `projects`/`workspace`) — i.e. whether it's a
 * router rather than a leaf config. Exported so callers building a
 * FrameworkResolution from external context can make the same
 * --config vs. auto-discover decision that resolveFramework() makes.
 * 
 * For Playwright, only "workspace" indicates a workspace config;
 * "projects" refers to browser targets, not workspace routing.
 */
export function isWorkspaceConfigFile(configPathAbs: string, framework?: TestFramework): boolean {
  try {
    const content = fs.readFileSync(configPathAbs, "utf8");
    return configHasWorkspaceProjects(content, framework);
  } catch {
    return false;
  }
}

/**
 * Read a config file and pull out its include/exclude patterns, falling
 * back to framework defaults when nothing is declared or the file can't be
 * statically parsed.
 *
 * Returns null if the config is a workspace/projects config with no leaf
 * include patterns — it's a router, not a leaf config, and shouldn't be
 * verified via DEFAULT_INCLUDE fallback.
 */
function readConfigPatterns(
  configPath: string,
  framework: TestFramework
): { include: string[]; exclude: string[] } | null {
  let content = "";
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch {
    return { include: DEFAULT_INCLUDE[framework], exclude: DEFAULT_EXCLUDE };
  }

  // If this is a workspace/projects config, it delegates to sub-configs.
  // Don't treat it as a leaf config — it has no meaningful own include patterns.
  if (configHasWorkspaceProjects(content)) {
    // A workspace config without its own include/exclude shouldn't be verified
    // via DEFAULT_INCLUDE — that would match everything and hide the real leaf config.
    const include = extractAllStringArraysAfterKey(content, "include");
    const exclude = extractAllStringArraysAfterKey(content, "exclude");
    if (include.length === 0) {
      return null; // workspace config, no leaf patterns — skip it
    }
    // If it does have include patterns, use them (union of all nested projects' patterns)
    return {
      include: include.length > 0 ? include : DEFAULT_INCLUDE[framework],
      exclude: exclude.length > 0 ? [...exclude, ...DEFAULT_EXCLUDE] : DEFAULT_EXCLUDE,
    };
  }

  // Leaf config: union all include/exclude patterns (handles nested projects within a single file)
  let include = extractAllStringArraysAfterKey(content, "include");
  let exclude = extractAllStringArraysAfterKey(content, "exclude");

  // For Playwright, also extract testDir and testMatch patterns
  if (framework === "playwright") {
    const testDirPatterns = extractPlaywrightTestDir(content);
    const testMatchPatterns = extractTestMatchPatterns(content);
    
    // testDir takes precedence, then testMatch, then defaults
    if (testDirPatterns.length > 0) {
      include = [...include, ...testDirPatterns];
    } else if (testMatchPatterns.length > 0) {
      include = [...include, ...testMatchPatterns];
    }
  } else if (framework === "jest" || framework === "mocha") {
    // Jest and Mocha also use testMatch
    const testMatchPatterns = extractTestMatchPatterns(content);
    if (testMatchPatterns.length > 0) {
      include = [...include, ...testMatchPatterns];
    }
  }

  return {
    include: include.length > 0 ? include : DEFAULT_INCLUDE[framework],
    exclude: exclude.length > 0 ? [...exclude, ...DEFAULT_EXCLUDE] : DEFAULT_EXCLUDE,
  };
}

/**
 * Does the config at `candidate` actually claim `testFileAbs`? Patterns in
 * a config are resolved relative to that config's own directory (its
 * project root), not the repo root — this is the crux of the monorepo bug.
 *
 * Returns false if the config is a workspace router with no leaf patterns.
 */
function configMatchesTest(
  candidate: ConfigCandidate,
  testFileAbs: string
): boolean {
  const patterns = readConfigPatterns(
    path.join(candidate.dir, candidate.file),
    candidate.framework
  );

  // Workspace config with no leaf patterns — skip it, don't treat as a match
  if (!patterns) return false;

  const { include, exclude } = patterns;

  const relToConfig = path
    .relative(candidate.dir, testFileAbs)
    .split(path.sep)
    .join("/");

  // A test file outside the config's own directory tree can't belong to it.
  if (relToConfig.startsWith("..")) return false;

  if (matchesAny(exclude, relToConfig)) return false;
  return matchesAny(include, relToConfig);
}

// ======================================================
// FRAMEWORK DETECTION FROM DEPENDENCIES
// ======================================================

function frameworkFromDeps(allDeps: Record<string, string>): TestFramework | null {
  if (!allDeps) return null;
  for (const [name, deps] of Object.entries(DEP_NAMES) as [
    TestFramework,
    string[]
  ][]) {
    if (deps.some((d) => d in allDeps)) return name;
  }
  return null;
}

/**
 * Analyze a test script to determine if it's a "passthrough" script
 * that accepts a file argument, or a "wrapper" that doesn't.
 *
 * Passthrough examples:
 *   "vitest"
 *   "jest"
 *   "mocha"
 *   "vitest --ui"
 *   "jest --watch"
 *
 * Wrapper examples (should NOT pass file to):
 *   "yarn test:unit"        ← calls another script
 *   "npm run test:unit"     ← calls another script
 *   "nx test"               ← task runner
 *   "turbo test"            ← monorepo runner
 *   "node scripts/test.js"  ← custom script
 *   "ts-node test/index.ts" ← custom script
 *
 * For wrappers, the file argument should be passed through the framework CLI
 * (vitest/jest/etc.) directly, not to the wrapper script.
 */
function isPassthroughTestScript(scriptCmd: string): boolean {
  if (!scriptCmd) return false;

  // Normalize: trim and get the first word/command
  const trimmed = scriptCmd.trim();

  // Direct framework invocations are passthrough
  const passthroughFrameworks = ["vitest", "jest", "mocha", "playwright"];
  for (const fw of passthroughFrameworks) {
    // Match "vitest", "vitest --ui", "vitest run", but not "yarn vitest"
    if (new RegExp(`^${fw}(\\s|$)`).test(trimmed)) {
      return true;
    }
  }

  // Wrappers and task runners: never passthrough
  const wrapperPatterns = [
    /^yarn\s+/,        // yarn test:unit
    /^npm\s+/,         // npm run test
    /^pnpm\s+/,        // pnpm run test
    /^bun\s+/,         // bun run test
    /^npx\s+/,         // npx something
    /^nx\s+/,          // nx test
    /^turbo\s+/,       // turbo test
    /^node\s+/,        // node scripts/test.js
    /^ts-node\s+/,     // ts-node test/index.ts
    /^tsx\s+/,         // tsx test/index.ts
    /^node --/,        // node --loader ...
  ];

  for (const pattern of wrapperPatterns) {
    if (pattern.test(trimmed)) {
      return false;
    }
  }

  // Scripts that are custom executables or unclear — assume NOT passthrough
  // (safer to fall back to framework CLI than to break a custom script)
  return false;
}

/**
 * Extract test-related scripts from a package, returning the framework
 * they invoke (if any) and the script names in order of preference.
 * Returns most-specific first: test:unit, test:e2e, test
 */
function getTestScripts(pkg: any): string[] {
  if (!pkg?.scripts) return [];
  
  // Order by specificity: more-specific comes first
  const scriptNames = [
    "test:unit",
    "test:e2e",
    "test:component",
    "test:integration",
    "test",
  ];

  return scriptNames.filter((name) => name in pkg.scripts);
}

/**
 * Read the available test scripts (in priority order) from the package.json
 * in `dir`. Exported so callers who build a FrameworkResolution from an
 * externally-supplied TestFileContext (rather than via resolveFramework)
 * can still prefer the repository's own test script over a bare framework
 * CLI invocation.
 */
export function getTestScriptsForDir(dir: string): string[] {
  const pkg = readPkgJson(dir);
  return getTestScripts(pkg);
}

// ======================================================
// FRAMEWORK DETECTION FROM SCRIPTS
// ======================================================

function frameworkFromScripts(
  scripts: Record<string, string>
): { framework: TestFramework; script: string } | null {
  if (!scripts || Object.keys(scripts).length === 0) return null;
  for (const [scriptName, scriptCmd] of Object.entries(scripts)) {
    if (!/test/i.test(scriptName)) continue;
    for (const fw of Object.keys(DEP_NAMES) as TestFramework[]) {
      if (new RegExp(`\\b${fw}\\b`, "i").test(scriptCmd)) {
        return { framework: fw, script: scriptName };
      }
    }
  }
  return null;
}

// ======================================================
// FRAMEWORK DETECTION FROM IMPORTS
// ======================================================

function frameworkFromImports(testFileContent: string): TestFramework | null {
  const frameworks: Array<[TestFramework, string[]]> = [
    ["vitest", ['from "vitest"', "from 'vitest'"]],
    ["playwright", ['from "@playwright/test"', 'from \'@playwright/test\'']],
    ["jest", ['from "jest"', "from 'jest'"]],
    ["mocha", ['from "mocha"', "from 'mocha'"]],
  ];

  for (const [fw, imports] of frameworks) {
    if (imports.some((imp) => testFileContent.includes(imp))) {
      return fw;
    }
  }

  return null;
}

// ======================================================
// MAIN RESOLUTION
// ======================================================

/**
 * Resolve which framework owns a test file, using (in order of trust):
 * 1. A framework config file whose include/exclude patterns actually
 *    match this test file, searched from the test file's directory up to
 *    the repo root (closest verified match wins).
 * 2. The test file's own imports.
 * 3. A "test"-like script in the owning package.json.
 * 4. A framework dependency listed in the owning package.json.
 *
 * Returns a resolution with confidence (0-1), evidence trail, and paths
 * expressed relative to `workspaceDir` — the directory tests should
 * actually be executed from, since config `include`/`exclude` patterns are
 * relative to the config's own directory, not the repo root.
 * 
 * The key change: framework detection now prioritizes the owning package's
 * context, not the root package.json. This prevents root-level orchestration
 * commands from overriding package-specific test setup.
 */
export function resolveFramework(
  testFile: string,
  repoRoot: string
): FrameworkResolution {
  const ancestorDirs = collectAncestorDirs(testFile, repoRoot);
  const testFileAbs = path.resolve(repoRoot, testFile);
  const pkgContext = resolvePackageContext(testFile, repoRoot);
  
  const evidence: string[] = [];
  evidence.push(`resolved owning package: ${pkgContext.packageName || "(root)"} at ${path.relative(repoRoot, pkgContext.packageDir) || "."}`);

  let framework: TestFramework | null = null;
  let confidence = 0;
  let configFile: string | null = null;
  let workspaceDir = pkgContext.packageDir;
  let configVerified = false;
  let configIsWorkspace = false;

  // Strategy 1: Config file, verified against include/exclude (highest confidence).
  // Search from the test file upward, but prioritize configs within the owning package
  const allCandidates: ConfigCandidate[] = [];
  for (const fw of Object.keys(CONFIG_FILES) as TestFramework[]) {
    allCandidates.push(...findConfigCandidates(ancestorDirs, fw));
  }
  // ancestorDirs is already ordered nearest -> root, so sort candidates the same way
  allCandidates.sort(
    (a, b) => ancestorDirs.indexOf(a.dir) - ancestorDirs.indexOf(b.dir)
  );

  let firstUnverifiedCandidate: ConfigCandidate | null = null;

  for (const candidate of allCandidates) {
    if (!firstUnverifiedCandidate) firstUnverifiedCandidate = candidate;
    if (configMatchesTest(candidate, testFileAbs)) {
      framework = candidate.framework;
      workspaceDir = candidate.dir;
      configFile = path.relative(repoRoot, path.join(candidate.dir, candidate.file));
      configVerified = true;
      confidence = 0.95;

      // Check if this config is workspace/projects-based
      try {
        const content = fs.readFileSync(
          path.join(candidate.dir, candidate.file),
          "utf8"
        );
        configIsWorkspace = configHasWorkspaceProjects(content, candidate.framework);
      } catch {
        configIsWorkspace = false;
      }

      evidence.push(
        `config "${candidate.file}" in ${path.relative(repoRoot, candidate.dir) || "."} ` +
          `declares include/exclude patterns that match this test file`
      );
      if (configIsWorkspace) {
        evidence.push(
          `config is workspace/projects-based — will auto-discover from ${path.relative(repoRoot, candidate.dir) || "."}`
        );
      }
      break;
    }
  }

  if (!framework && firstUnverifiedCandidate) {
    evidence.push(
      `config "${firstUnverifiedCandidate.file}" found in ` +
        `${path.relative(repoRoot, firstUnverifiedCandidate.dir) || "."} but its ` +
        `include/exclude patterns do not match this test file — not used`
    );
  }

  // Strategy 2: Imports in the test file
  if (!framework) {
    try {
      const content = fs.readFileSync(testFileAbs, "utf8");
      const fromImports = frameworkFromImports(content);
      if (fromImports) {
        framework = fromImports;
        evidence.push(`test file imports from "${fromImports}"`);
        confidence = 0.7;
      }
    } catch {
      // unreadable file; fall through
    }
  }

  // Strategy 3: Test script in the owning package (NEW: prioritizes package context)
  if (!framework) {
    const fromScripts = frameworkFromScripts(pkgContext.scripts);
    if (fromScripts) {
      framework = fromScripts.framework;
      if (firstUnverifiedCandidate) {
        evidence.push(
          `config "${firstUnverifiedCandidate.file}" found but didn't match; ` +
          `falling back to package script "${fromScripts.script}"`
        );
      } else {
        evidence.push(
          `owning package script "${fromScripts.script}" invokes ${fromScripts.framework}`
        );
      }
      confidence = 0.65;
    }
  }

  // Strategy 4: Framework dependency in the owning package
  if (!framework) {
    const fromDeps = frameworkFromDeps(pkgContext.allDeps);
    if (fromDeps) {
      framework = fromDeps;
      if (firstUnverifiedCandidate) {
        evidence.push(
          `config "${firstUnverifiedCandidate.file}" found but didn't match; ` +
          `falling back to dependency: ${fromDeps} in owning package`
        );
      } else {
        evidence.push(
          `${fromDeps} listed in owning package dependencies`
        );
      }
      confidence = 0.55;
    }
  }

  // Strategy 5: Root-level framework dependency (lowest priority)
  // Only use if owning package had nothing
  if (!framework) {
    const rootPkg = readPkgJson(repoRoot);
    const rootAllDeps = { ...rootPkg?.dependencies, ...rootPkg?.devDependencies };
    const fromRootDeps = frameworkFromDeps(rootAllDeps);
    if (fromRootDeps) {
      framework = fromRootDeps;
      evidence.push(
        `${fromRootDeps} listed in root package dependencies (owning package had no test framework)`
      );
      confidence = 0.35;
    }
  }

  if (!framework) {
    evidence.push(
      "no verified config, import, script, or dependency evidence found"
    );
  }

  const workspaceRelative = path.relative(repoRoot, workspaceDir) || ".";
  const testPathRelativeToWorkspace = path.relative(workspaceDir, testFileAbs);
  
  // Extract available test scripts from the owning package
  const testScripts = getTestScripts(pkgContext.scripts);

  return {
    framework,
    packageManager: pkgContext.packageManager,
    workspaceDir,
    workspaceRelative,
    configFile,
    testPathRelativeToWorkspace,
    confidence,
    evidence,
    configVerified,
    configIsWorkspace,
    testScripts,
  };
}

// ======================================================
// COMMAND BUILDING
// ======================================================

function execPrefix(
  packageManager: PackageManager,
  bin: string
): { command: string; args: string[] } {
  switch (packageManager) {
    case "yarn":
      return { command: "yarn", args: ["exec", bin] };
    case "pnpm":
      return { command: "pnpm", args: ["exec", bin] };
    case "bun":
      return { command: "bunx", args: [bin] };
    default:
      return { command: "npx", args: [bin] };
  }
}

/**
 * Build the command to actually run a test.
 *
 * IMPORTANT: this assumes the caller will `spawn` with
 * `cwd: resolution.workspaceDir`. Test path arguments must therefore be
 * relative to `workspaceDir`.
 *
 * When an explicit `targetFileRelativeToWorkspace` is provided, it overrides
 * the `testPathRelativeToWorkspace` from the resolution. This is used when
 * running a specific generated test file instead of the whole suite.
 *
 * When the config is workspace/projects-based, we omit --config entirely
 * and let the framework auto-discover from the workspace directory, to avoid
 * triggering root-level project glob validation errors.
 * 
 * Strategy:
 * 1. If a framework-specific test script exists AND it's a passthrough
 *    (e.g., "vitest", not "yarn test:unit"), use it and append the test file.
 * 2. Otherwise, invoke the framework CLI directly with the test file.
 */
export function buildTestCommand(
  resolution: FrameworkResolution,
  targetFileRelativeToWorkspace?: string
): { command: string; args: string[] } {
  const {
    framework,
    packageManager,
    configFile,
    configIsWorkspace,
    testPathRelativeToWorkspace,
  } = resolution;

  // Use the override if provided, otherwise fall back to the resolved path
  const testPath = targetFileRelativeToWorkspace || testPathRelativeToWorkspace;

  if (!framework) {
    // No framework detected — try package.json test script as fallback,
    // but only if it's a passthrough script
    if (resolution.testScripts && resolution.testScripts.length > 0) {
      const pkg = readPkgJson(resolution.workspaceDir);
      const scripts = pkg?.scripts || {};
      const firstScript = resolution.testScripts[0]!;
      const firstScriptCmd = scripts[firstScript];

      if (firstScriptCmd && isPassthroughTestScript(firstScriptCmd)) {
        return buildPackageManagerCommand(packageManager, firstScript, [testPath]);
      }
    }

    // Fallback to npm test (via package manager)
    return buildPackageManagerCommand(packageManager, "test", [testPath]);
  }

  // Framework was detected. Check if we have a passthrough test script.
  if (resolution.testScripts && resolution.testScripts.length > 0) {
    const pkg = readPkgJson(resolution.workspaceDir);
    const scripts = pkg?.scripts || {};

    // Find the first passthrough script
    for (const scriptName of resolution.testScripts) {
      const scriptCmd = scripts[scriptName];
      if (scriptCmd && isPassthroughTestScript(scriptCmd)) {
        // This is a passthrough — we can safely pass the test file to it
        return buildPackageManagerCommand(packageManager, scriptName, [testPath]);
      }
    }

    // All test scripts are wrappers — fall through to direct framework invocation
  }

  // No passthrough script found, or no test scripts at all.
  // Fall back to direct framework CLI invocation.
  // If the config is workspace/projects-based, omit --config and auto-discover
  // from the workspace directory. This avoids triggering root config's project
  // glob validation which requires project matches to be config files.
  if (configIsWorkspace) {
    switch (framework) {
      case "vitest": {
        const base = execPrefix(packageManager, "vitest");
        return {
          command: base.command,
          args: [...base.args, "run", testPath],
        };
      }
      case "jest": {
        const base = execPrefix(packageManager, "jest");
        return {
          command: base.command,
          args: [...base.args, testPath],
        };
      }
      case "playwright": {
        const base = execPrefix(packageManager, "playwright");
        return {
          command: base.command,
          args: [...base.args, "test", testPath],
        };
      }
      case "mocha": {
        const base = execPrefix(packageManager, "mocha");
        return {
          command: base.command,
          args: [...base.args, testPath],
        };
      }
    }
  }

  // Leaf config: include --config flag
  let configArgs: string[] = [];
  if (configFile) {
    // Both configFile and workspaceRelative are repo-root-relative strings,
    // so treating them as paths and taking a relative() between them gives
    // us the config's path as seen from workspaceDir — without needing
    // repoRoot in this function's signature.
    const workspaceRel =
      resolution.workspaceRelative && resolution.workspaceRelative !== "."
        ? resolution.workspaceRelative
        : "";
    const configRelativeToWorkspace = path.relative(workspaceRel, configFile);
    if (!configRelativeToWorkspace.startsWith("..")) {
      configArgs = [
        "--config",
        configRelativeToWorkspace || path.basename(configFile),
      ];
    }
  }

  switch (framework) {
    case "vitest": {
      const base = execPrefix(packageManager, "vitest");
      return {
        command: base.command,
        args: [...base.args, "run", ...configArgs, testPath],
      };
    }
    case "jest": {
      const base = execPrefix(packageManager, "jest");
      return {
        command: base.command,
        args: [...base.args, ...configArgs, testPath],
      };
    }
    case "playwright": {
      const base = execPrefix(packageManager, "playwright");
      return {
        command: base.command,
        args: [...base.args, "test", ...configArgs, testPath],
      };
    }
    case "mocha": {
      const base = execPrefix(packageManager, "mocha");
      return {
        command: base.command,
        args: [...base.args, testPath],
      };
    }
  }
}

/**
 * Build a command that invokes a package script through the package manager.
 * This ensures the test runs in the same environment/context as package scripts.
 */
function buildPackageManagerCommand(
  packageManager: PackageManager,
  scriptName: string,
  extraArgs: string[]
): { command: string; args: string[] } {
  switch (packageManager) {
    case "yarn":
      return {
        command: "yarn",
        args: ["run", scriptName, ...extraArgs],
      };
    case "pnpm":
      return {
        command: "pnpm",
        args: ["run", scriptName, ...extraArgs],
      };
    case "npm":
      return {
        command: "npm",
        args: ["run", scriptName, "--", ...extraArgs],
      };
    case "bun":
      return {
        command: "bun",
        args: ["run", scriptName, ...extraArgs],
      };
    default:
      // Fallback to npm
      return {
        command: "npm",
        args: ["run", scriptName, "--", ...extraArgs],
      };
  }
}