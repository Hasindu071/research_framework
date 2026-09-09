import fs from "fs";
import path from "path";
import { spawn } from "child_process";

import type { TestFramework } from "./frameworks.js";
import {
  resolveFramework,
  buildTestCommand,
  type FrameworkResolution,
} from "./framework-resolver.js";

// ======================================================
// TYPES
// ======================================================

export type TestStatus = "passed" | "failed" | "error" | "skipped" | "not_found";

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
  /** Resolution with confidence and evidence trail. */
  resolution?: FrameworkResolution;
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
  playwright: [/No tests found/i, /Error: No tests found/i],
  mocha: [/0 passing/i, /No test files found/i],
};

const IMPORT_ERROR_PATTERNS = [
  /Failed to resolve import/i,
  /Cannot find module/i,
  /Module not found/i,
  /SyntaxError/i,
  /ERR_MODULE_NOT_FOUND/i,
  /Error: Could not resolve/i,
];

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

function detectImportOrSetupError(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`;
  return IMPORT_ERROR_PATTERNS.some((pattern) => pattern.test(combined));
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

// ======================================================
// RUN PRIORITIZED TESTS
// ======================================================

export async function runPrioritizedTests(
  tests: PrioritizedTestInput[],
  options: TestRunnerOptions
): Promise<TestRunSummary> {
  const ordered = [...tests].sort((a, b) => a.priority - b.priority);

  const testExecution: TestExecutionResult[] = [];
  let failureCount = 0;
  let stoppedEarly = false;

  for (const test of ordered) {
    const result = await runSingleTest(test, options);
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
  options: TestRunnerOptions
): Promise<TestExecutionResult> {
  const testFileAbs = path.resolve(options.repositoryRoot, test.testFile);

  // Check if the test file actually exists — catch candidate-generation issues
  if (!fs.existsSync(testFileAbs)) {
    return Promise.resolve({
      testFile: test.testFile,
      priority: test.priority,
      framework: null,
      command: "[SKIPPED] file not found",
      status: "skipped",
      duration: 0,
      exitCode: null,
      stdout: "",
      stderr: `Test file does not exist: ${testFileAbs}`,
      notes: "File does not exist — candidate generation error (file may have been deleted or glob pattern was incorrect)",
    });
  }

  const resolution = resolveFramework(test.testFile, options.repositoryRoot);

  if (!resolution.framework) {
    return Promise.resolve({
      testFile: test.testFile,
      priority: test.priority,
      framework: null,
      command: "[SKIPPED] no test framework could be resolved for this file",
      status: "skipped",
      duration: 0,
      exitCode: null,
      stdout: "",
      stderr: "",
      notes: resolution.evidence.join("; "),
      resolution,
    });
  }

  // Check if framework is installed
  if (!isFrameworkInstalled(resolution.framework, resolution.workspaceDir)) {
    return Promise.resolve({
      testFile: test.testFile,
      priority: test.priority,
      framework: resolution.framework,
      command: `[SKIPPED] ${resolution.framework} not installed`,
      status: "skipped",
      duration: 0,
      exitCode: null,
      stdout: "",
      stderr: `Framework not installed in workspace: ${resolution.framework}`,
      notes: `${resolution.framework} not installed in workspace`,
      resolution,
    });
  }

  const { command, args } = buildTestCommand(resolution);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commandLabel = `(cwd: ${resolution.workspaceRelative}) ${command} ${args.join(" ")}`;

  return new Promise((resolve) => {
    const start = Date.now();

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(command, args, {
      // Run from the resolved workspace, not the repo root — config
      // include/exclude patterns (and relative paths inside the config
      // itself) are resolved relative to this directory.
      cwd: resolution.workspaceDir,
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
      } else if (detectImportOrSetupError(stdout, stderr)) {
        // Test couldn't execute due to import/setup/environment error
        status = "error";
        notes = "Test execution failed during import/setup phase — test environment or dependencies could not be resolved";
      } else if (detectNoTestsExecuted(resolution.framework, stdout, stderr)) {
        // Framework ran but found no matching test files
        status = "not_found";
        notes = resolution.configVerified
          ? `${resolution.framework} reported no test files matched the configured pattern`
          : `${resolution.framework} reported no test files matched; the resolved config was not verified against this test file's path`;
      } else if (exitCode === 0) {
        status = "passed";
      } else if (exitCode === 127) {
        status = "error"; // Command not found
      }

      const result: TestExecutionResult = {
        testFile: test.testFile,
        priority: test.priority,
        framework: resolution.framework,
        command: commandLabel,
        status,
        duration,
        exitCode,
        stdout: truncate(stdout),
        stderr: timedOut
          ? `${truncate(stderr)}\n[killed: exceeded ${timeoutMs}ms timeout]`
          : truncate(stderr),
        resolution,
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
        framework: resolution.framework,
        command: commandLabel,
        status: "error",
        duration,
        exitCode: null,
        stdout: truncate(stdout),
        stderr: `${truncate(stderr)}\n${error.message}`,
        resolution,
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