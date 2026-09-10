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

/**
 * A generated test: extends PrioritizedTestInput with the generated test code
 * and metadata about what it tests.
 */
export interface GeneratedTestInput extends PrioritizedTestInput {
  /** The generated test code (it/describe block). */
  testCode: string;
  /** The name/title of the test. */
  testName: string;
  /** The symbol this test was generated for. */
  targetSymbol: string;
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
  /** True if this test was generated (not pre-existing). */
  generated?: boolean;
  /** The generated test name (if generated). */
  generatedTestName?: string;
  /** Path to temporary file if materialized (for cleanup). */
  tempFile?: string;
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
  /**
   * Keep materialized generated-test files on disk instead of deleting them
   * after the run. Useful for debugging. Default: false.
   */
  keepGeneratedTests?: boolean;
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

const CONFIG_ERROR_PATTERNS = [
  /Timed out waiting.*from config\./i, // Playwright webServer or other config timeout
  /Error: Can't resolve config/i,
  /Invalid config/i,
];

// ======================================================
// MATERIALIZE GENERATED TESTS
// ======================================================

/**
 * Takes a generated test code snippet and materializes it into a real test file.
 * Strategy: copy the target test file, append the generated test to it,
 * write to a __generated__/ subdirectory beside the original test file,
 * then execute.
 *
 * Returns the absolute path to the temporary test file so it can be
 * cleaned up after execution. The __generated__/ directory stays on disk
 * (for debris inspection if keepGeneratedTests is true); this function just
 * creates the specific file.
 *
 * Returns the temporary file path so it can be cleaned up after execution.
 */
function materializeGeneratedTest(
  generated: GeneratedTestInput,
  options: TestRunnerOptions
): string {
  const originalPath = path.resolve(options.repositoryRoot, generated.testFile);

  if (!fs.existsSync(originalPath)) {
    throw new Error(`Cannot materialize: original test file not found: ${originalPath}`);
  }

  const originalContent = fs.readFileSync(originalPath, "utf8");

  // Generate a unique temp filename with context
  const timestamp = Date.now();
  const safe = generated.testName.replace(/[^a-z0-9]/gi, "_").slice(0, 30);
  const tempFileName = `generated_${timestamp}_${safe}.test.ts`;

  // Write it in a __generated__/ subdirectory beside the original test file.
  // This keeps it in the same directory tree (so relative imports still resolve)
  // but all in one place (easy to .gitignore, easy to clean if needed).
  const generatedDir = path.join(path.dirname(originalPath), "__generated__");
  fs.mkdirSync(generatedDir, { recursive: true });
  const tempPath = path.join(generatedDir, tempFileName);

  // Append the generated test to the original file content
  const combined = `${originalContent}\n\n// ============ GENERATED TEST ============\n${generated.testCode}\n`;

  fs.writeFileSync(tempPath, combined, "utf8");

  console.log("========================================");
  console.log("[Generated Test] FILE CREATED");
  console.log("[Generated Test] Path:", tempPath);
  console.log("[Generated Test] Exists:", fs.existsSync(tempPath));
  console.log("========================================");

  return tempPath;
}

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

function detectConfigError(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`;
  return CONFIG_ERROR_PATTERNS.some((pattern) => pattern.test(combined));
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
  tests: (PrioritizedTestInput | GeneratedTestInput)[],
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

/**
 * Dispatcher: handles both pre-existing and generated tests.
 */
async function runSingleTest(
  test: PrioritizedTestInput | GeneratedTestInput,
  options: TestRunnerOptions
): Promise<TestExecutionResult> {
  // Check if this is a generated test
  if ("testCode" in test) {
    return runGeneratedTest(test as GeneratedTestInput, options);
  }
  return runExistingTest(test as PrioritizedTestInput, options);
}

/**
 * Execute a generated test: materialize it and run it.
 * The generated file is deleted only when keepGeneratedTests is false.
 */
async function runGeneratedTest(
  generated: GeneratedTestInput,
  options: TestRunnerOptions
): Promise<TestExecutionResult> {
  let tempPath: string | undefined;

  try {
    // Materialize: copy original + append generated test code
    tempPath = materializeGeneratedTest(generated, options);

    // The temp file is now at tempPath, but we need it relative to repositoryRoot
    // for framework resolution. Since temp files are in /tmp, we need special handling.
    const resolution = resolveFramework(
      generated.testFile, // Use original file for framework detection
      options.repositoryRoot
    );

    if (!resolution.framework) {
      return {
        testFile: generated.testFile,
        priority: generated.priority,
        framework: null,
        command: "[SKIPPED] no test framework could be resolved for this file",
        status: "skipped",
        duration: 0,
        exitCode: null,
        stdout: "",
        stderr: "",
        notes: resolution.evidence.join("; "),
        resolution,
        generated: true,
        generatedTestName: generated.testName,
        tempFile: tempPath,
      };
    }

    // Check if framework is installed
    if (!isFrameworkInstalled(resolution.framework, resolution.workspaceDir)) {
      return {
        testFile: generated.testFile,
        priority: generated.priority,
        framework: resolution.framework,
        command: `[SKIPPED] ${resolution.framework} not installed`,
        status: "skipped",
        duration: 0,
        exitCode: null,
        stdout: "",
        stderr: `Framework not installed in workspace: ${resolution.framework}`,
        notes: `${resolution.framework} not installed in workspace`,
        resolution,
        generated: true,
        generatedTestName: generated.testName,
        tempFile: tempPath,
      };
    }

    // Execute the temp file using the same framework
    const result = await executeTestFile(tempPath, resolution, options);

    return {
      ...result,
      testFile: generated.testFile,
      priority: generated.priority,
      generated: true,
      generatedTestName: generated.testName,
      tempFile: tempPath,
    } as TestExecutionResult;
  } catch (error) {
    return {
      testFile: generated.testFile,
      priority: generated.priority,
      framework: null,
      command: "[FAILED] could not materialize generated test",
      status: "error",
      duration: 0,
      exitCode: null,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}`,
      generated: true,
      generatedTestName: generated.testName,
      tempFile: tempPath,
    } as TestExecutionResult;
  } finally {
    // Clean up temp file unless keepGeneratedTests is enabled
    if (tempPath && !options.keepGeneratedTests && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Execute a pre-existing test file.
 */
async function runExistingTest(
  test: PrioritizedTestInput,
  options: TestRunnerOptions
): Promise<TestExecutionResult> {
  const testFileAbs = path.resolve(options.repositoryRoot, test.testFile);

  // Check if the test file actually exists — catch candidate-generation issues
  if (!fs.existsSync(testFileAbs)) {
    return {
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
    };
  }

  const resolution = resolveFramework(test.testFile, options.repositoryRoot);

  if (!resolution.framework) {
    return {
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
    };
  }

  // Check if framework is installed
  if (!isFrameworkInstalled(resolution.framework, resolution.workspaceDir)) {
    return {
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
    };
  }

  return executeTestFile(testFileAbs, resolution, options).then((partial) => ({
    ...partial,
    testFile: test.testFile,
    priority: test.priority,
  } as TestExecutionResult));
}

/**
 * Core test execution: spawn the framework command and capture results.
 * 
 * `testFilePath` is an absolute path to the test file to run. It will be
 * converted to a path relative to `resolution.workspaceDir` before passing
 * to `buildTestCommand`, so that the framework runs it correctly regardless
 * of whether it's a regular test file or a generated one in __generated__/.
 */
async function executeTestFile(
  testFilePath: string,
  resolution: FrameworkResolution,
  options: TestRunnerOptions
): Promise<Partial<TestExecutionResult>> {
  // Convert absolute testFilePath to workspace-relative path
  const testPathRelativeToWorkspace = path.relative(
    resolution.workspaceDir,
    testFilePath
  );

  const { command, args } = buildTestCommand(
    resolution,
    testPathRelativeToWorkspace
  );

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
      } else if (detectConfigError(stdout, stderr)) {
        // Configuration/environment error (e.g., Playwright webServer timeout)
        status = "error";
        notes = "Test execution failed due to configuration or environment error — no actual test assertions ran";
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

      const result: Partial<TestExecutionResult> = {
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
        framework: resolution.framework,
        command: commandLabel,
        status: "error" as const,
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