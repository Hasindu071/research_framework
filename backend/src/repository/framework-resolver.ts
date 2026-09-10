import fs from "fs";
import path from "path";
import type { TestFramework } from "./frameworks.js";

// ======================================================
// TYPES
// ======================================================

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun" | "unknown";

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
// WORKSPACE DETECTION
// ======================================================

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
function configHasWorkspaceProjects(content: string): boolean {
  return /\b(projects|workspace)\s*:\s*/.test(content);
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

function frameworkFromDeps(pkg: any): TestFramework | null {
  if (!pkg) return null;
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const [name, deps] of Object.entries(DEP_NAMES) as [
    TestFramework,
    string[]
  ][]) {
    if (deps.some((d) => d in allDeps)) return name;
  }
  return null;
}

// ======================================================
// FRAMEWORK DETECTION FROM SCRIPTS
// ======================================================

function frameworkFromScripts(
  pkg: any
): { framework: TestFramework; script: string } | null {
  if (!pkg?.scripts) return null;
  for (const [scriptName, scriptCmd] of Object.entries(pkg.scripts) as [
    string,
    string
  ][]) {
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
 * 3. A "test"-like script in the nearest package.json (or repo root's).
 * 4. A framework dependency listed in the nearest package.json up the tree.
 *
 * Returns a resolution with confidence (0-1), evidence trail, and paths
 * expressed relative to `workspaceDir` — the directory tests should
 * actually be executed from, since config `include`/`exclude` patterns are
 * relative to the config's own directory, not the repo root.
 */
export function resolveFramework(
  testFile: string,
  repoRoot: string
): FrameworkResolution {
  const packageManager = detectPackageManager(repoRoot);
  const ancestorDirs = collectAncestorDirs(testFile, repoRoot);
  const testFileAbs = path.resolve(repoRoot, testFile);
  const nearestWorkspace = findNearestWorkspace(ancestorDirs);

  const evidence: string[] = [];
  let framework: TestFramework | null = null;
  let confidence = 0;
  let configFile: string | null = null;
  let workspaceDir = nearestWorkspace;
  let configVerified = false;
  let configIsWorkspace = false;

  // Strategy 1: Config file, verified against include/exclude (highest confidence).
  // Collect every candidate config across every framework, then walk them in
  // order of proximity to the test file (closest ancestor dir first) so a
  // nested workspace's config wins over one further up the tree.
  const allCandidates: ConfigCandidate[] = [];
  for (const fw of Object.keys(CONFIG_FILES) as TestFramework[]) {
    allCandidates.push(...findConfigCandidates(ancestorDirs, fw));
  }
  // ancestorDirs is already ordered nearest -> root, so sort candidates the
  // same way to preserve that priority.
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
        configIsWorkspace = configHasWorkspaceProjects(content);
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

  // A config existed nearby but didn't actually claim this test file. Note
  // it in the evidence trail for debugging, but don't use it to pick the
  // framework or the run directory.
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

  // Strategy 3: Test script in package.json
  if (!framework) {
    for (const dir of [nearestWorkspace, repoRoot]) {
      const fromScripts = frameworkFromScripts(readPkgJson(dir));
      if (fromScripts) {
        framework = fromScripts.framework;
        if (firstUnverifiedCandidate) {
          evidence.push(
            `config "${firstUnverifiedCandidate.file}" found but didn't match; ` +
            `falling back to package.json script "${fromScripts.script}"`
          );
        } else {
          evidence.push(
            `package.json script "${fromScripts.script}" in ${path.relative(repoRoot, dir) || "."} invokes ${fromScripts.framework}`
          );
        }
        confidence = 0.55;
        break;
      }
    }
  }

  // Strategy 4: Framework dependency
  if (!framework) {
    for (const dir of ancestorDirs) {
      const fromDeps = frameworkFromDeps(readPkgJson(dir));
      if (fromDeps) {
        framework = fromDeps;
        if (firstUnverifiedCandidate) {
          evidence.push(
            `config "${firstUnverifiedCandidate.file}" found but didn't match; ` +
            `falling back to dependency: ${fromDeps} in ${path.relative(repoRoot, dir) || "."}/package.json`
          );
        } else {
          evidence.push(
            `${fromDeps} listed as dependency in ${path.relative(repoRoot, dir) || "."}/package.json`
          );
        }
        confidence = 0.45;
        break;
      }
    }
  }

  if (!framework) {
    evidence.push(
      "no verified config, import, script, or dependency evidence found"
    );
  }

  // For anything resolved by strategies 2-4 (no verified config), fall back
  // to the nearest package.json dir as the run directory, same as before.
  if (!configVerified) {
    workspaceDir = nearestWorkspace;
  }

  const workspaceRelative = path.relative(repoRoot, workspaceDir) || ".";
  const testPathRelativeToWorkspace = path.relative(workspaceDir, testFileAbs);

  return {
    framework,
    packageManager,
    workspaceDir,
    workspaceRelative,
    configFile,
    testPathRelativeToWorkspace,
    confidence,
    evidence,
    configVerified,
    configIsWorkspace,
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
    return packageManager === "unknown"
      ? { command: "npm", args: ["run", "test", "--", testPath] }
      : { command: packageManager, args: ["test", testPath] };
  }

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