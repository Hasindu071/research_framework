import fs from "fs";
import path from "path";

// ======================================================
// PURPOSE
// ======================================================
//
// This module answers ONE question: "what test infrastructure does this
// repository actually have?" — package manager, monorepo layout, which
// test frameworks are in play, where their configs live, and where the
// test files are.
//
// It is intentionally the *first* stage of the pipeline. It knows nothing
// about which tests are "related" to a diff, which are "prioritized", or
// how to build a shell command to run one. Those are later stages
// (test-context-mapper.ts and, eventually, the executor) and they should
// consume this module's output rather than re-deriving any of it.
//
// Everything here is static, filesystem-only inspection — no LLM calls,
// no diff awareness. It should be safe and cheap to run once per pipeline
// invocation (or cache-and-reuse across a session), same repository in,
// same profile out.

// ======================================================
// TYPES
// ======================================================

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun" | "unknown";

/**
 * Frameworks this detector knows how to recognize. Kept as a plain string
 * union (not imported from elsewhere) so this module has zero dependency
 * on the rest of the pipeline and can be dropped into any project as-is.
 * If the host codebase already has an equivalent `TestFramework` type
 * (e.g. in frameworks.ts), that type should be structurally compatible
 * with this one — a `TestFramework` value from either can be used
 * wherever the other is expected.
 */
export type TestFramework = "vitest" | "jest" | "playwright" | "mocha";

/** A resolved workspace ("package") inside the repository. */
export interface WorkspacePackageInfo {
  /** package.json "name", or the directory name if unnamed. */
  name: string;
  /** Absolute path to the workspace directory. */
  absolutePath: string;
  /** Path relative to the repository root. "." for the repo root itself. */
  relativePath: string;
  /** Absolute path to this workspace's package.json. */
  packageJsonPath: string;
  /** Raw "scripts" from package.json (used to spot test commands). */
  scripts: Record<string, string>;
  /** Union of dependencies + devDependencies + peerDependencies names. */
  dependencyNames: Set<string>;
}

/** A test framework config file (or an inferred default) for one workspace. */
export interface DetectedTestConfig {
  framework: TestFramework;
  /**
   * Path to the config file, relative to the repository root.
   * Empty string means: no config file was found, but the framework is a
   * declared dependency of the workspace, so its built-in defaults apply.
   */
  configPath: string;
  /** Which workspace (by relativePath) this config belongs to. */
  workspaceRelativePath: string;
  /** Best-effort extracted "testDir" (playwright-style configs). */
  testDir?: string;
  /** Best-effort extracted include globs (vitest/jest/mocha-style configs). */
  includePatterns?: string[];
  /** Short human-readable trail explaining how this was detected. */
  evidence: string[];
}

/** A package.json script that looks like it runs tests, and for which framework. */
export interface DetectedTestCommand {
  workspaceRelativePath: string;
  scriptName: string;
  command: string;
  framework: TestFramework | null;
}

export interface RepositoryTestProfile {
  repositoryRoot: string;
  packageManager: PackageManager;
  isMonorepo: boolean;
  /**
   * All resolved workspaces. For a non-monorepo project this is a single
   * entry for the repo root. For a monorepo, the repo root itself is
   * deliberately NOT included here unless it also matched a workspace
   * glob — most monorepo roots hold no tests of their own.
   */
  workspaces: WorkspacePackageInfo[];
  /** Union of every framework detected anywhere in the repository. */
  frameworks: TestFramework[];
  configs: DetectedTestConfig[];
  testCommands: DetectedTestCommand[];
  /** Every test file found, as repo-relative paths. Unresolved/raw — see test-context-mapper.ts for per-file context. */
  testFiles: string[];
  /** Anything that looked off during detection (missing package.json for a glob match, etc.) but wasn't fatal. */
  warnings: string[];
}

// ======================================================
// PACKAGE MANAGER DETECTION
// ======================================================

const LOCKFILE_TO_MANAGER: Array<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

export function detectPackageManager(repositoryRoot: string): PackageManager {
  for (const [lockfile, manager] of LOCKFILE_TO_MANAGER) {
    if (fs.existsSync(path.join(repositoryRoot, lockfile))) {
      return manager;
    }
  }

  const rootPkg = readJsonSafe<{ packageManager?: string }>(
    path.join(repositoryRoot, "package.json")
  );
  const declared = rootPkg?.packageManager?.split("@")[0];
  if (declared === "pnpm" || declared === "yarn" || declared === "npm" || declared === "bun") {
    return declared;
  }

  return "unknown";
}

// ======================================================
// WORKSPACE DISCOVERY
// ======================================================

/**
 * Returns the raw workspace glob patterns declared by the repo, e.g.
 * ["apps/*", "ghost/*", "e2e"], regardless of which package manager
 * declared them. A leading "!" marks an exclusion pattern (pnpm/yarn
 * support this).
 */
export function getWorkspaceGlobs(repositoryRoot: string): string[] {
  const pnpmWorkspaceFile = path.join(repositoryRoot, "pnpm-workspace.yaml");
  if (fs.existsSync(pnpmWorkspaceFile)) {
    return parsePnpmWorkspaceYaml(fs.readFileSync(pnpmWorkspaceFile, "utf8"));
  }

  const rootPkg = readJsonSafe<{ workspaces?: string[] | { packages?: string[] } }>(
    path.join(repositoryRoot, "package.json")
  );
  if (Array.isArray(rootPkg?.workspaces)) {
    return rootPkg.workspaces;
  }
  if (rootPkg?.workspaces && Array.isArray((rootPkg.workspaces as { packages?: string[] }).packages)) {
    return (rootPkg.workspaces as { packages?: string[] }).packages ?? [];
  }

  return [];
}

/**
 * Minimal, purpose-built YAML reader for pnpm-workspace.yaml's `packages:`
 * list. This is NOT a general YAML parser — it only understands the one
 * shape pnpm-workspace.yaml actually uses in practice:
 *
 *   packages:
 *     - 'apps/*'
 *     - 'ghost/*'
 *     - 'e2e'
 *
 * Pulling in a full YAML dependency for one list is unnecessary weight;
 * if a repository's workspace file uses more exotic YAML, this will
 * simply return an empty list rather than mis-parsing it.
 */
function parsePnpmWorkspaceYaml(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const patterns: string[] = [];
  let inPackages = false;

  for (const rawLine of lines) {
    const line = stripYamlComment(rawLine);

    if (/^\s*packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }

    if (!inPackages) continue;

    const itemMatch = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (itemMatch?.[1]) {
      patterns.push(stripQuotes(itemMatch[1]));
      continue;
    }

    if (line.trim() === "") continue;

    // A non-indented, non-list-item line ends the packages block.
    if (!/^\s/.test(rawLine)) inPackages = false;
  }

  return patterns;
}

function stripYamlComment(line: string): string {
  // Naive but sufficient for this narrow use: pnpm-workspace.yaml entries
  // don't contain '#' inside quoted globs in practice.
  const hashIdx = line.indexOf("#");
  return hashIdx === -1 ? line : line.slice(0, hashIdx);
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Expands one glob pattern (relative to repositoryRoot) into matching directories. */
function expandWorkspaceGlob(repositoryRoot: string, pattern: string): string[] {
  const segments = pattern.replace(/\/+$/, "").split("/").filter(Boolean);
  let currentDirs = [repositoryRoot];

  for (const segment of segments) {
    const nextDirs: string[] = [];

    for (const dir of currentDirs) {
      if (segment === "**") {
        nextDirs.push(dir, ...listAllDirsRecursive(dir));
        continue;
      }

      if (!fs.existsSync(dir)) continue;

      if (segment.includes("*")) {
        const regex = globSegmentToRegex(segment);
        for (const entry of safeReaddir(dir)) {
          if (entry.isDirectory() && entry.name !== "node_modules" && regex.test(entry.name)) {
            nextDirs.push(path.join(dir, entry.name));
          }
        }
      } else {
        const candidate = path.join(dir, segment);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          nextDirs.push(candidate);
        }
      }
    }

    currentDirs = nextDirs;
  }

  return currentDirs;
}

function globSegmentToRegex(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function listAllDirsRecursive(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of safeReaddir(dir)) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      out.push(full);
      stack.push(full);
    }
  }
  return out;
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Resolves the repo's workspaces into loaded package.json info. */
export function discoverWorkspaces(
  repositoryRoot: string,
  warnings: string[]
): { workspaces: WorkspacePackageInfo[]; isMonorepo: boolean } {
  const globs = getWorkspaceGlobs(repositoryRoot);
  const isMonorepo = globs.length > 0;

  if (!isMonorepo) {
    const rootInfo = loadWorkspacePackageInfo(repositoryRoot, repositoryRoot);
    return { workspaces: rootInfo ? [rootInfo] : [], isMonorepo: false };
  }

  const included = new Set<string>();
  const excluded = new Set<string>();

  for (const pattern of globs) {
    const isExclusion = pattern.startsWith("!");
    const target = isExclusion ? pattern.slice(1) : pattern;
    const matches = expandWorkspaceGlob(repositoryRoot, target);
    for (const dir of matches) {
      (isExclusion ? excluded : included).add(dir);
    }
  }
  for (const dir of excluded) included.delete(dir);

  const workspaces: WorkspacePackageInfo[] = [];
  for (const dir of Array.from(included).sort()) {
    const info = loadWorkspacePackageInfo(repositoryRoot, dir);
    if (info) {
      workspaces.push(info);
    } else {
      warnings.push(
        `Workspace glob matched "${path.relative(repositoryRoot, dir) || "."}" but no readable package.json was found there — skipped.`
      );
    }
  }

  workspaces.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { workspaces, isMonorepo: true };
}

function loadWorkspacePackageInfo(
  repositoryRoot: string,
  workspaceDir: string
): WorkspacePackageInfo | null {
  const packageJsonPath = path.join(workspaceDir, "package.json");
  const pkg = readJsonSafe<{
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  }>(packageJsonPath);
  if (!pkg) return null;

  const dependencyNames = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);

  return {
    name: pkg.name ?? path.basename(workspaceDir) ?? workspaceDir,
    absolutePath: workspaceDir,
    relativePath: path.relative(repositoryRoot, workspaceDir) || ".",
    packageJsonPath,
    scripts: pkg.scripts ?? {},
    dependencyNames,
  };
}

// ======================================================
// FRAMEWORK DETECTION
// ======================================================

const FRAMEWORK_DEPENDENCY_MARKERS: Array<[TestFramework, string[]]> = [
  ["vitest", ["vitest"]],
  ["jest", ["jest", "@jest/core", "ts-jest", "babel-jest"]],
  ["playwright", ["@playwright/test", "playwright"]],
  ["mocha", ["mocha"]],
];

function detectFrameworksFromDependencies(ws: WorkspacePackageInfo): TestFramework[] {
  const found: TestFramework[] = [];
  for (const [framework, markers] of FRAMEWORK_DEPENDENCY_MARKERS) {
    if (markers.some((marker) => ws.dependencyNames.has(marker))) {
      found.push(framework);
    }
  }
  return found;
}

interface ConfigFilePattern {
  framework: TestFramework;
  patterns: RegExp[];
}

const CONFIG_FILE_PATTERNS: ConfigFilePattern[] = [
  { framework: "vitest", patterns: [/^vitest\.config\.(ts|js|mjs|cjs|mts|cts)$/] },
  { framework: "jest", patterns: [/^jest\.config\.(ts|js|mjs|cjs|json)$/] },
  { framework: "playwright", patterns: [/^playwright\.config\.(ts|js|mjs|cjs)$/] },
  { framework: "mocha", patterns: [/^\.mocharc(\.(ya?ml|json|jsonc|js|cjs))?$/, /^mocha\.opts$/] },
];

/**
 * Finds test-framework config files sitting directly inside a workspace
 * directory (top-level only — that's the near-universal convention), plus
 * any framework declared only as a dependency (no dedicated config file,
 * meaning framework defaults apply).
 */
function detectConfigsForWorkspace(
  repositoryRoot: string,
  ws: WorkspacePackageInfo
): DetectedTestConfig[] {
  const configs: DetectedTestConfig[] = [];
  const foundFrameworks = new Set<TestFramework>();

  for (const entry of safeReaddir(ws.absolutePath)) {
    if (!entry.isFile()) continue;
    for (const { framework, patterns } of CONFIG_FILE_PATTERNS) {
      if (patterns.some((p) => p.test(entry.name))) {
        const absoluteConfigPath = path.join(ws.absolutePath, entry.name);
        const relativeConfigPath = path.relative(repositoryRoot, absoluteConfigPath);
        const hints = extractConfigHints(framework, readFileSafe(absoluteConfigPath) ?? "");

        configs.push({
          framework,
          configPath: relativeConfigPath,
          workspaceRelativePath: ws.relativePath,
          ...hints,
          evidence: [`Found ${entry.name} in ${ws.relativePath === "." ? "repository root" : ws.relativePath}`],
        });
        foundFrameworks.add(framework);
      }
    }
  }

  // package.json "jest" / "mocha" embedded config blocks count as configs too.
  const embeddedPkg = readJsonSafe<Record<string, unknown>>(ws.packageJsonPath);
  if (embeddedPkg?.jest && !foundFrameworks.has("jest")) {
    configs.push({
      framework: "jest",
      configPath: path.relative(repositoryRoot, ws.packageJsonPath),
      workspaceRelativePath: ws.relativePath,
      evidence: [`Found "jest" key embedded in ${ws.relativePath}/package.json`],
    });
    foundFrameworks.add("jest");
  }
  if (embeddedPkg?.mocha && !foundFrameworks.has("mocha")) {
    configs.push({
      framework: "mocha",
      configPath: path.relative(repositoryRoot, ws.packageJsonPath),
      workspaceRelativePath: ws.relativePath,
      evidence: [`Found "mocha" key embedded in ${ws.relativePath}/package.json`],
    });
    foundFrameworks.add("mocha");
  }

  // Frameworks declared as dependencies but with no discoverable config
  // file still count — many setups run entirely on framework defaults.
  for (const framework of detectFrameworksFromDependencies(ws)) {
    if (foundFrameworks.has(framework)) continue;
    configs.push({
      framework,
      configPath: "",
      workspaceRelativePath: ws.relativePath,
      evidence: [
        `"${framework}" found in ${ws.relativePath === "." ? "repository root" : ws.relativePath}/package.json dependencies, no explicit config file found — framework defaults apply`,
      ],
    });
    foundFrameworks.add(framework);
  }

  return configs;
}

/** Best-effort regex extraction of testDir/include hints from a config file's raw text. */
function extractConfigHints(
  framework: TestFramework,
  content: string
): { testDir?: string; includePatterns?: string[] } {
  if (framework === "playwright") {
    const testDirMatch = /testDir\s*:\s*['"]([^'"]+)['"]/.exec(content);
    return testDirMatch?.[1] ? { testDir: normalizeConfigRelativePath(testDirMatch[1]) } : {};
  }

  if (framework === "mocha") {
    // .mocharc.yml / .mocharc.json both commonly use a top-level `spec:` key.
    const specMatch = /^\s*spec\s*:\s*['"]?([^'"\n]+)['"]?\s*$/m.exec(content);
    return specMatch?.[1] ? { includePatterns: [specMatch[1].trim()] } : {};
  }

  // vitest / jest: look for `include: [ ... ]`
  const includeBlockMatch = /include\s*:\s*\[([^\]]*)\]/.exec(content);
  if (!includeBlockMatch?.[1]) return {};

  const patterns = Array.from(includeBlockMatch[1].matchAll(/['"]([^'"]+)['"]/g)).map((m) => m[1]!);
  return patterns.length > 0 ? { includePatterns: patterns } : {};
}

function normalizeConfigRelativePath(value: string): string {
  return value.replace(/^\.\//, "").replace(/\/$/, "");
}

// ======================================================
// TEST COMMAND DETECTION
// ======================================================

const COMMAND_FRAMEWORK_MARKERS: Array<[TestFramework, RegExp]> = [
  ["playwright", /playwright/],
  ["vitest", /vitest/],
  ["jest", /\bjest\b/],
  ["mocha", /\bmocha\b/],
];

const TEST_SCRIPT_NAME_PATTERN = /^test(:.*)?$/;

function detectTestCommandsForWorkspace(ws: WorkspacePackageInfo): DetectedTestCommand[] {
  const commands: DetectedTestCommand[] = [];
  for (const [scriptName, command] of Object.entries(ws.scripts)) {
    if (!TEST_SCRIPT_NAME_PATTERN.test(scriptName)) continue;
    const framework = COMMAND_FRAMEWORK_MARKERS.find(([, pattern]) => pattern.test(command))?.[0] ?? null;
    commands.push({ workspaceRelativePath: ws.relativePath, scriptName, command, framework });
  }
  return commands;
}

// ======================================================
// TEST FILE DISCOVERY
// ======================================================

// STRICT pattern: only match files ending in .test.ts, .test.tsx, .spec.ts, .spec.tsx, etc.
// This MUST NOT match regular utility files like utils.ts, helpers.ts, etc.
// The pattern ensures:
// 1. Must have literal ".test." or ".spec." before the file extension
// 2. Extension must be one of: ts, tsx, js, jsx, mjs, cjs
// 3. No false positives on utils.ts, helpers.ts, or other non-test files
const TEST_FILE_NAME_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "out",
]);

export function findAllTestFiles(repositoryRoot: string): string[] {
  const results: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of safeReaddir(dir)) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && TEST_FILE_NAME_PATTERN.test(entry.name)) {
        results.push(path.relative(repositoryRoot, path.join(dir, entry.name)));
      }
    }
  };

  walk(repositoryRoot);
  return results.sort();
}

// ======================================================
// ENTRY POINT
// ======================================================

export function detectRepositoryTestSuite(repositoryRoot: string): RepositoryTestProfile {
  const warnings: string[] = [];
  const packageManager = detectPackageManager(repositoryRoot);
  const { workspaces, isMonorepo } = discoverWorkspaces(repositoryRoot, warnings);

  const configs: DetectedTestConfig[] = [];
  const testCommands: DetectedTestCommand[] = [];
  const frameworksSeen = new Set<TestFramework>();

  for (const ws of workspaces) {
    const wsConfigs = detectConfigsForWorkspace(repositoryRoot, ws);
    configs.push(...wsConfigs);
    for (const cfg of wsConfigs) frameworksSeen.add(cfg.framework);

    testCommands.push(...detectTestCommandsForWorkspace(ws));

    if (wsConfigs.length === 0) {
      warnings.push(
        `No test framework detected for workspace "${ws.relativePath}" (checked dependencies and top-level config files).`
      );
    }
  }

  const testFiles = findAllTestFiles(repositoryRoot);

  return {
    repositoryRoot,
    packageManager,
    isMonorepo,
    workspaces,
    frameworks: Array.from(frameworksSeen).sort(),
    configs,
    testCommands,
    testFiles,
    warnings,
  };
}

// ======================================================
// SMALL HELPERS
// ======================================================

function readJsonSafe<T>(filePath: string): T | null {
  const raw = readFileSafe(filePath);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

// ======================================================
// FORMATTING (human-readable report)
// ======================================================

const FRAMEWORK_DISPLAY_NAMES: Record<TestFramework, string> = {
  vitest: "Vitest",
  jest: "Jest",
  playwright: "Playwright",
  mocha: "Mocha",
};

export function formatFrameworkName(framework: TestFramework): string {
  return FRAMEWORK_DISPLAY_NAMES[framework];
}

export function formatRepositoryTestProfile(profile: RepositoryTestProfile): string {
  const lines: string[] = [];

  lines.push(`Package manager: ${profile.packageManager}`);
  lines.push("");
  lines.push(`Repository: ${profile.isMonorepo ? "Monorepo" : "Single package"}`);
  lines.push("");

  lines.push("Frameworks:");
  if (profile.frameworks.length === 0) {
    lines.push("- (none detected)");
  } else {
    for (const fw of profile.frameworks) lines.push(`- ${formatFrameworkName(fw)}`);
  }
  lines.push("");

  if (profile.isMonorepo) {
    lines.push("Workspaces:");
    if (profile.workspaces.length === 0) {
      lines.push("- (none resolved)");
    } else {
      for (const ws of profile.workspaces) lines.push(`- ${ws.relativePath}`);
    }
    lines.push("");
  }

  lines.push("Configs:");
  if (profile.configs.length === 0) {
    lines.push("- (none found)");
  } else {
    for (const cfg of profile.configs) {
      const target = cfg.configPath || `${cfg.workspaceRelativePath} (no config file — framework defaults)`;
      lines.push(`- ${formatFrameworkName(cfg.framework)} config → ${target}`);
    }
  }

  if (profile.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of profile.warnings) lines.push(`- ${w}`);
  }

  return lines.join("\n");
}