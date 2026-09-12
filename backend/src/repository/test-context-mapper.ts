import path from "path";
import type {
  DetectedTestConfig,
  RepositoryTestProfile,
  TestFramework,
  WorkspacePackageInfo,
} from "./test-suite-detector.js";

// ======================================================
// PURPOSE
// ======================================================
//
// test-suite-detector.ts answers "what test infrastructure exists in this
// repo?". This module answers the next question, per test file: "which
// *specific* piece of that infrastructure owns this file?"
//
// This is the piece that was previously missing: a flat list of 1709 test
// file paths carries none of this. Two files with identical basenames in
// different workspaces (or even the same workspace, two frameworks) need
// different commands run from different directories — you cannot know
// that from the path string alone. This module resolves that ambiguity
// once, up front, so every later stage (prioritization, execution) can
// work off of an actual TestFileContext instead of re-guessing.

// ======================================================
// TYPES
// ======================================================

export type TestSuiteCategory = "unit" | "component" | "integration" | "api" | "e2e" | "unknown";

/** Everything needed to run one specific test file correctly. */
export interface TestFileContext {
  /** Repo-relative path, e.g. "apps/admin/src/editor/card-config.test.ts". */
  testFile: string;
  /** Owning workspace's repo-relative path, e.g. "apps/admin". Null if the file isn't inside any detected workspace. */
  workspace: string | null;
  /** Owning workspace's package.json "name", if resolved. */
  workspaceName: string | null;
  /** The framework that should run this file, if one could be resolved. */
  framework: TestFramework | null;
  /** Heuristic classification, e.g. "e2e", "api", "component". */
  category: TestSuiteCategory;
  /** Repo-relative path to the config file that governs this test, or null if the framework relies on defaults. */
  configPath: string | null;
  /**
   * Same value as `framework` today — kept as a separate field because
   * "which framework recognizes this file" and "which tool actually gets
   * invoked" can diverge later (e.g. a workspace-level test runner that
   * wraps several frameworks). Downstream code should read `runner`, not
   * assume it always equals `framework`.
   */
  runner: TestFramework | null;
  /** Repo-relative directory the test command should be executed from. */
  executionDirectory: string;
  /** Anything uncertain about this resolution (ambiguous framework match, no owning workspace, etc.). */
  warnings: string[];
}

export interface TestSuiteGroup {
  category: TestSuiteCategory;
  categoryLabel: string;
  framework: TestFramework | null;
  workspaces: Set<string>;
  testFileCount: number;
}

// ======================================================
// WORKSPACE OWNERSHIP
// ======================================================

/** Finds the workspace with the longest repo-relative path prefix matching `testFile`. */
function findOwningWorkspace(
  workspaces: WorkspacePackageInfo[],
  testFile: string
): WorkspacePackageInfo | null {
  let best: WorkspacePackageInfo | null = null;
  let bestPrefixLength = -1;

  for (const ws of workspaces) {
    const prefix = ws.relativePath === "." ? "" : `${ws.relativePath}/`;
    if (!testFile.startsWith(prefix)) continue;
    if (prefix.length > bestPrefixLength) {
      best = ws;
      bestPrefixLength = prefix.length;
    }
  }

  return best;
}

// ======================================================
// FRAMEWORK/CONFIG RESOLUTION WITHIN A WORKSPACE
// ======================================================

/**
 * Best-effort glob → RegExp for the include/spec patterns pulled out of
 * config files (e.g. "src/**\/*.test.ts"). Not a full glob implementation —
 * just enough to match "**", "*", and literal path segments, which covers
 * the patterns these config files realistically contain.
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (".+^${}()|[]\\".includes(c!)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

function configMatchesFile(config: DetectedTestConfig, workspaceRelativeTestPath: string): boolean {
  if (config.testDir) {
    const normalizedTestDir = config.testDir.replace(/^\.\//, "").replace(/\/$/, "");
    return workspaceRelativeTestPath.startsWith(`${normalizedTestDir}/`);
  }
  if (config.includePatterns && config.includePatterns.length > 0) {
    return config.includePatterns.some((pattern) => globToRegExp(pattern).test(workspaceRelativeTestPath));
  }
  // No hints extracted from the config file — can't rule it in or out.
  return false;
}

/**
 * Resolves which of a workspace's (possibly several) detected configs
 * governs a given test file.
 */
function resolveConfigForFile(
  configsInWorkspace: DetectedTestConfig[],
  workspaceRelativeTestPath: string
): { config: DetectedTestConfig | null; warnings: string[] } {
  if (configsInWorkspace.length === 0) {
    return { config: null, warnings: [] };
  }

  if (configsInWorkspace.length === 1) {
    return { config: configsInWorkspace[0]!, warnings: [] };
  }

  // Multiple frameworks/configs in one workspace — try to disambiguate by
  // matching each config's own include/testDir hints against this file.
  const matches = configsInWorkspace.filter((cfg) => configMatchesFile(cfg, workspaceRelativeTestPath));

  if (matches.length === 1) {
    return { config: matches[0]!, warnings: [] };
  }

  if (matches.length > 1) {
    return {
      config: matches[0]!,
      warnings: [
        `Multiple configs (${matches.map((m) => m.framework).join(", ")}) matched this file's path; picked "${matches[0]!.framework}" arbitrarily.`,
      ],
    };
  }

  // Nothing matched on path hints — fall back to the first detected config
  // for the workspace, but flag it as a guess.
  return {
    config: configsInWorkspace[0]!,
    warnings: [
      `Workspace has ${configsInWorkspace.length} test frameworks (${configsInWorkspace.map((c) => c.framework).join(", ")}) ` +
        `and none of their include/testDir patterns matched this file; defaulted to "${configsInWorkspace[0]!.framework}".`,
    ],
  };
}

// ======================================================
// SUITE CATEGORY CLASSIFICATION
// ======================================================
//
// Heuristic only — same spirit as the Tier-2 lexical signals in
// test-gap-analyzer.ts: useful for grouping/reporting, not asserted as
// ground truth. Playwright is the one strong signal (e2e is really what
// it's for); everything else is a guess based on path conventions.

export const CATEGORY_DISPLAY_LABELS: Record<TestSuiteCategory, string> = {
  unit: "Unit/component",
  component: "Unit/component",
  integration: "Integration",
  api: "API",
  e2e: "E2E",
  unknown: "Unknown",
};

function classifySuiteCategory(
  framework: TestFramework | null,
  workspaceRelativePath: string | null,
  testFile: string
): TestSuiteCategory {
  const lowerFile = testFile.toLowerCase();
  const lowerWs = (workspaceRelativePath ?? "").toLowerCase();

  if (framework === "playwright" || /(^|\/)e2e(\/|$)/.test(lowerFile) || /(^|\/)e2e(\/|$)/.test(lowerWs)) {
    return "e2e";
  }
  if (/(^|\/)api(\/|$)/.test(lowerFile)) {
    return "api";
  }
  if (/(^|\/)integration(\/|$)/.test(lowerFile)) {
    return "integration";
  }
  if (framework === "vitest" || framework === "jest") {
    return lowerWs.startsWith("apps/") || lowerWs === "apps" ? "component" : "unit";
  }
  if (framework === "mocha") {
    return "unit";
  }
  return "unknown";
}

// ======================================================
// PER-FILE RESOLUTION
// ======================================================

export function mapTestFileToContext(
  profile: RepositoryTestProfile,
  testFile: string
): TestFileContext {
  const warnings: string[] = [];
  const workspace = findOwningWorkspace(profile.workspaces, testFile);

  if (!workspace) {
    warnings.push("No detected workspace owns this file; treating the repository root as its execution context.");
    const category = classifySuiteCategory(null, null, testFile);
    return {
      testFile,
      workspace: null,
      workspaceName: null,
      framework: null,
      category,
      configPath: null,
      runner: null,
      executionDirectory: ".",
      warnings,
    };
  }

  const workspaceRelativeTestPath = path.relative(workspace.absolutePath, path.resolve(profile.repositoryRoot, testFile));
  const configsInWorkspace = profile.configs.filter((c) => c.workspaceRelativePath === workspace.relativePath);
  const { config, warnings: resolutionWarnings } = resolveConfigForFile(configsInWorkspace, workspaceRelativeTestPath);
  warnings.push(...resolutionWarnings);

  if (!config) {
    warnings.push(`No test framework was detected for workspace "${workspace.relativePath}".`);
  }

  const framework = config?.framework ?? null;
  const category = classifySuiteCategory(framework, workspace.relativePath, testFile);

  return {
    testFile,
    workspace: workspace.relativePath,
    workspaceName: workspace.name,
    framework,
    category,
    configPath: config?.configPath ? config.configPath : null,
    runner: framework,
    executionDirectory: workspace.relativePath,
    warnings,
  };
}

/** Resolves every test file the detector found. This is what the prioritizer/generator should consume going forward, instead of a flat path list. */
export function mapAllTestFiles(profile: RepositoryTestProfile): TestFileContext[] {
  return profile.testFiles.map((testFile) => mapTestFileToContext(profile, testFile));
}

// ======================================================
// GROUPING (for reporting — "Test suites: ..." section)
// ======================================================

export function groupTestFilesBySuite(contexts: TestFileContext[]): TestSuiteGroup[] {
  const groups = new Map<string, TestSuiteGroup>();

  for (const ctx of contexts) {
    const key = `${ctx.category}::${ctx.framework ?? "unknown"}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        category: ctx.category,
        categoryLabel: CATEGORY_DISPLAY_LABELS[ctx.category],
        framework: ctx.framework,
        workspaces: new Set<string>(),
        testFileCount: 0,
      };
      groups.set(key, group);
    }
    if (ctx.workspace) group.workspaces.add(ctx.workspace);
    group.testFileCount++;
  }

  return Array.from(groups.values()).sort((a, b) => b.testFileCount - a.testFileCount);
}

// ======================================================
// FORMATTING
// ======================================================

export function formatTestFileContext(ctx: TestFileContext): string {
  const lines = [
    `Test: ${ctx.testFile}`,
    "",
    `Workspace: ${ctx.workspace ?? "(none — repository root)"}`,
    "",
    `Framework: ${ctx.framework ?? "(unknown)"}`,
    "",
    `Configuration: ${ctx.configPath ?? "(no config file — framework defaults)"}`,
    "",
    `Runner: ${ctx.runner ?? "(unknown)"}`,
    "",
    `Execution directory: ${ctx.executionDirectory}`,
  ];
  if (ctx.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const w of ctx.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

export function formatTestSuiteGroups(groups: TestSuiteGroup[]): string {
  const lines = ["Test suites:"];
  if (groups.length === 0) {
    lines.push("- (none)");
    return lines.join("\n");
  }
  for (const g of groups) {
    const fw = g.framework ? ` (${g.framework})` : "";
    const wsCount = g.workspaces.size;
    lines.push(
      `- ${g.categoryLabel}${fw}: ${wsCount} workspace${wsCount === 1 ? "" : "s"}, ${g.testFileCount} test file${g.testFileCount === 1 ? "" : "s"}`
    );
  }
  return lines.join("\n");
}