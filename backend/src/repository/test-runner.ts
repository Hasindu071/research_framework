import fs from "fs";
import path from "path";
import { spawn } from "child_process";

import type { TestFramework } from "./frameworks.js";

// ======================================================
// TYPES
// ======================================================

export type TestStatus = "passed" | "failed" | "error" | "skipped";

export interface PrioritizedTestInput {
  testFile: string;
  priority: number;
}

export interface TestExecutionResult {
  testFile: string;
  priority: number;
  framework: TestFramework | null;
  command: string;
  status: TestStatus;
  /** Wall-clock duration in seconds. */
  duration: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when status is "skipped" — explains why nothing ran. */
  notes?: string;
}

export interface TestRunnerOptions {
  repositoryRoot: string;
  /**
   * Mode B: stop the run as soon as a test doesn't pass.
   * Default: false (Mode A — run every prioritized test, per the
   * design doc's "you need complete results for evaluation").
   */
  stopOnFailure?: boolean;
  /**
   * Mode C: stop after this many non-passing results. Ignored if
   * `stopOnFailure` is set.
   */
  maxFailures?: number;
  /** Per-test kill timeout, in ms. Default 2 minutes. */
  timeoutMs?: number;
}

export interface TestRunSummary {
  testExecution: TestExecutionResult[];
  /** True if maxFailures/stopOnFailure cut the run short. */
  stoppedEarly: boolean;
}

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_OUTPUT_CHARS = 20_000;

// ======================================================
// DETECT "NO TESTS RUN" PATTERNS
// ======================================================

const NO_TESTS_RUN_PATTERNS: Partial<Record<TestFramework, RegExp[]>> = {
  vitest: [/No test files found/i],
  jest: [/No tests found/i, /Your test suite must contain at least one test/i],
  playwright: [/No tests found/i],
  mocha: [/0 passing/i, /No test files found/i],
};

function detectNoTestsExecuted(
  framework: TestFramework | null,
  stdout: string,
  stderr: string
): boolean {
  if (!framework) return false;
  const patterns = NO_TESTS_RUN_PATTERNS[framework];
  if (!patterns) return false;
  const combined = `${stdout}\n${stderr}`;
  return patterns.some((pattern) => pattern.test(combined));
}

// ======================================================
// FRAMEWORK DETECTION PER TEST FILE
// ======================================================

interface FrameworkDetector {
  name: TestFramework;
  deps: string[];
}

const FRAMEWORK_DETECTORS: FrameworkDetector[] = [
  { name: "playwright", deps: ["@playwright/test", "playwright"] },
  { name: "vitest", deps: ["vitest"] },
  { name: "jest", deps: ["jest"] },
  { name: "mocha", deps: ["mocha"] },
];

/**
 * Find the workspace/package directory for a test file by looking for package.json.
 */
function findWorkspaceDir(
  testFile: string,
  repositoryRoot: string
): string {
  let currentDir = path.dirname(path.resolve(repositoryRoot, testFile));

  while (currentDir.startsWith(repositoryRoot)) {
    const packageJsonPath = path.join(currentDir, "package.json");

    if (fs.existsSync(packageJsonPath)) {
      return currentDir;
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  // Fallback to repository root
  return repositoryRoot;
}

/**
 * Detect framework for a specific test file by checking:
 * 1. The actual imports in the test file (most reliable)
 * 2. Then the package.json of the workspace it belongs to
 */
function detectFrameworkForTest(
  testFile: string,
  repositoryRoot: string
): TestFramework | null {
  const absolutePath = path.resolve(repositoryRoot, testFile);

  // Step 1: Check the test file's actual imports
  try {
    const content = fs.readFileSync(absolutePath, "utf8");

    // Check imports/requires in the file
    if (
      content.includes("import * as test from 'vitest'") ||
      content.includes('import { test') ||
      content.includes("import { describe, it, expect") ||
      content.includes("from 'vitest'") ||
      content.includes('from "vitest"') ||
      content.includes("import { render") && content.includes("from 'vitest'")
    ) {
      return "vitest";
    }

    if (
      content.includes("import { test") && content.includes("from '@playwright/test'") ||
      content.includes('from "@playwright/test"')
    ) {
      return "playwright";
    }

    if (
      content.includes("import { describe, it") && content.includes("from 'jest'") ||
      content.includes('from "jest"')
    ) {
      return "jest";
    }

    if (
      content.includes("import { describe, it") && content.includes("from 'mocha'") ||
      content.includes('from "mocha"')
    ) {
      return "mocha";
    }
  } catch {
    // Fall through to package.json detection
  }

  // Step 2: Fall back to package.json detection
  let currentDir = path.dirname(absolutePath);

  while (currentDir.startsWith(repositoryRoot)) {
    const packageJsonPath = path.join(currentDir, "package.json");

    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        const allDeps = {
          ...pkg.dependencies,
          ...pkg.devDependencies,
        };

        for (const detector of FRAMEWORK_DETECTORS) {
          if (detector.deps.some((dep) => dep in allDeps)) {
            return detector.name;
          }
        }
      } catch {
        // Continue up the tree
      }
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  // Step 3: Check root package.json
  try {
    const rootPackageJson = path.join(repositoryRoot, "package.json");
    if (fs.existsSync(rootPackageJson)) {
      const pkg = JSON.parse(fs.readFileSync(rootPackageJson, "utf8"));
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };

      for (const detector of FRAMEWORK_DETECTORS) {
        if (detector.deps.some((dep) => dep in allDeps)) {
          return detector.name;
        }
      }
    }
  } catch {
    // Ignore
  }

  return null;
}

/**
 * Check if a test framework is actually installed (present in node_modules).
 * Walks up the directory tree to handle pnpm's nested node_modules and hoisting.
 */
function isFrameworkInstalled(
  framework: TestFramework | null,
  workspaceDir: string
): boolean {
  if (!framework) return false;

  const frameworkDeps: Record<TestFramework, string[]> = {
    vitest: ["vitest"],
    jest: ["jest"],
    playwright: ["@playwright/test", "playwright"],
    mocha: ["mocha"],
  };

  // Walk up looking for an actual installed module
  // (handles pnpm's nested node_modules and workspace hoisting to repo root)
  let dir = workspaceDir;
  while (true) {
    const found = frameworkDeps[framework].some((dep) =>
      fs.existsSync(path.join(dir, "node_modules", dep))
    );
    if (found) return true;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return false;
}
/**
 * Determine package manager to use (npm, yarn, pnpm, or npx).
 * Check for lock files in the repository.
 */
function detectPackageManager(
  repositoryRoot: string
): "npm" | "yarn" | "pnpm" | "npx" {
  if (fs.existsSync(path.join(repositoryRoot, "yarn.lock"))) {
    return "yarn";
  }
  if (fs.existsSync(path.join(repositoryRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (fs.existsSync(path.join(repositoryRoot, "package-lock.json"))) {
    return "npm";
  }
  // Default fallback
  return "npx";
}

/**
 * Build the test command for a specific framework.
 */
function buildTestCommand(
  framework: TestFramework,
  testFile: string,
  packageManager: string
): { command: string; args: string[] } {
  // Different package managers have different ways to invoke binaries:
  // - yarn: use "yarn exec" or directly invoke with yarn
  // - pnpm: use "pnpm exec" for workspace binaries
  // - npm: use "npx" for binaries
  
  const isYarn = packageManager === "yarn";
  const isPnpm = packageManager === "pnpm";
  
  switch (framework) {
    case "vitest":
      if (isYarn) {
        return { command: "yarn", args: ["exec", "vitest", "run", testFile] };
      } else if (isPnpm) {
        return { command: "pnpm", args: ["exec", "vitest", "run", testFile] };
      }
      return { command: "npx", args: ["vitest", "run", testFile] };

    case "jest":
      if (isYarn) {
        return { command: "yarn", args: ["exec", "jest", testFile] };
      } else if (isPnpm) {
        return { command: "pnpm", args: ["exec", "jest", testFile] };
      }
      return { command: "npx", args: ["jest", testFile] };

    case "playwright":
      if (isYarn) {
        return { command: "yarn", args: ["exec", "playwright", "test", testFile] };
      } else if (isPnpm) {
        return { command: "pnpm", args: ["exec", "playwright", "test", testFile] };
      }
      return { command: "npx", args: ["playwright", "test", testFile] };

    case "mocha":
      if (isYarn) {
        return { command: "yarn", args: ["exec", "mocha", testFile] };
      } else if (isPnpm) {
        return { command: "pnpm", args: ["exec", "mocha", testFile] };
      }
      return { command: "npx", args: ["mocha", testFile] };

    default:
      if (isYarn) {
        return { command: "yarn", args: ["exec", "test", testFile] };
      } else if (isPnpm) {
        return { command: "pnpm", args: ["test", testFile] };
      }
      return { command: "npm", args: ["run", "test", "--", testFile] };
  }
}

// ======================================================
// RUN PRIORITIZED TESTS
// ======================================================

export async function runPrioritizedTests(
  tests: PrioritizedTestInput[],
  options: TestRunnerOptions
): Promise<TestRunSummary> {
  const ordered = [...tests].sort((a, b) => a.priority - b.priority);
  const packageManager = detectPackageManager(options.repositoryRoot);

  const testExecution: TestExecutionResult[] = [];
  let failureCount = 0;
  let stoppedEarly = false;

  for (const test of ordered) {
    const result = await runSingleTest(test, options, packageManager);
    testExecution.push(result);

    if (result.status !== "passed") {
      if (result.status === "failed" || result.status === "error") {
        failureCount++;
      }

      if (options.stopOnFailure && result.status !== "skipped") {
        stoppedEarly = true;
        break;
      }

      if (
        options.maxFailures !== undefined &&
        failureCount >= options.maxFailures
      ) {
        stoppedEarly = true;
        break;
      }
    }
  }

  return { testExecution, stoppedEarly };
}

/**
 * Convenience adapter: takes the LLM prioritizer's output directly.
 */
export function toPrioritizedTestInputs(
  prioritized: any[]
): PrioritizedTestInput[] {
  return prioritized.map((test) => ({
    testFile: test.testFile,
    priority: test.priority,
  }));
}

// ======================================================
// RUN A SINGLE TEST
// ======================================================

function runSingleTest(
  test: PrioritizedTestInput,
  options: TestRunnerOptions,
  packageManager: string
): Promise<TestExecutionResult> {
  const framework = detectFrameworkForTest(
    test.testFile,
    options.repositoryRoot
  );

  // Find the workspace directory for this test
  // But prefer the repository root for running commands
  let workspaceDir = findWorkspaceDir(test.testFile, options.repositoryRoot);
  
  // For yarn/npm/pnpm, always run from repo root where package manager is set up
  if (packageManager !== "npx") {
    workspaceDir = options.repositoryRoot;
  }

  // Check if framework is installed
  if (framework && !isFrameworkInstalled(framework, workspaceDir)) {
    return Promise.resolve({
      testFile: test.testFile,
      priority: test.priority,
      framework,
      command: `[SKIPPED] ${framework} not installed`,
      status: "skipped",
      duration: 0,
      exitCode: null,
      stdout: "",
      stderr: `Framework not installed in workspace: ${framework}`,
      notes: `${framework} not installed in workspace`,
    });
  }
  
  // Make test file path relative to repository root for running
  const testFileRelative = path.relative(options.repositoryRoot, path.resolve(options.repositoryRoot, test.testFile));
  
  const { command, args } = framework
    ? buildTestCommand(framework, testFileRelative, packageManager)
    : { command: packageManager, args: ["test", testFileRelative] };

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commandLabel = `${command} ${args.join(" ")}`;

  return new Promise((resolve) => {
    const start = Date.now();

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: options.repositoryRoot,
      shell: process.platform === "win32",
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);

      const duration = (Date.now() - start) / 1000;

      // Exit code mapping:
      // 0 = success
      // 1 = test assertion failed
      // 127 = command not found
      // others = error
      let status: TestStatus = "failed";
      let notes: string | undefined;

      if (timedOut) {
        status = "error";
      } else if (exitCode === 0) {
        if (detectNoTestsExecuted(framework, stdout, stderr)) {
          status = "skipped";
          notes = `${framework} reported no test files matched — nothing was actually executed`;
        } else {
          status = "passed";
        }
      } else if (exitCode === 127) {
        status = "error"; // Command not found
      }

      const result: TestExecutionResult = {
        testFile: test.testFile,
        priority: test.priority,
        framework,
        command: commandLabel,
        status,
        duration,
        exitCode,
        stdout: truncate(stdout),
        stderr: timedOut
          ? `${truncate(stderr)}\n[killed: exceeded ${timeoutMs}ms timeout]`
          : truncate(stderr),
      };

      if (notes !== undefined) {
        result.notes = notes;
      }

      resolve(result);
    });

    child.on("error", (error) => {
      clearTimeout(timer);

      const duration = (Date.now() - start) / 1000;

      resolve({
        testFile: test.testFile,
        priority: test.priority,
        framework,
        command: commandLabel,
        status: "error",
        duration,
        exitCode: null,
        stdout: truncate(stdout),
        stderr: `${truncate(stderr)}\n${error.message}`,
      });
    });
  });
}

function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return output;
  }

  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated, ${
    output.length - MAX_OUTPUT_CHARS
  } more chars]`;
}