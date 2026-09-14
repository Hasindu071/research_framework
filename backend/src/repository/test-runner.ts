import fs from "fs";
import path from "path";
import { spawn } from "child_process";

import type { TestFramework } from "./frameworks.js";
import {
  resolveFramework,
  buildTestCommand,
  detectPackageManager,
  getTestScriptsForDir,
  isWorkspaceConfigFile,
  type FrameworkResolution,
} from "./framework-resolver.js";
import {
  mergeGeneratedTests,
  revertMerge,
  type MergeResult,
} from "./test-file-writer.js";
import type { TestFileContext } from "./test-context-mapper.js";

// ======================================================
// TYPES
// ======================================================

export type TestStatus = "passed" | "failed" | "error" | "skipped" | "not_found";

export interface PrioritizedTestInput {
  testFile: string;
  priority: number;
  /** Optional: the mapped test context. If provided, uses this instead of re-resolving framework. */
  context?: TestFileContext;
}

export interface GeneratedTestInput extends PrioritizedTestInput {
  /** The generated test code (it/describe block). */
  testCode: string;
  /** The name/title of the test. */
  testName: string;
  /** The symbol this test was generated for. */
  targetSymbol: string;
  /** Repo-relative path of the source file the test targets — needed to
   * build the import statement if `testFile` doesn't exist yet. */
  sourceFile: string;
  /** True if `testFile` doesn't exist yet and must be scaffolded from scratch. */
  isNewTestFile: boolean;
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
  /**
   * True if the generated test(s) were left merged into the real test file
   * after this run (i.e. status was "passed", or keepGeneratedTests was
   * set). False means the file was reverted to its pre-merge state.
   */
  keptInTestFile?: boolean;
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
   * Keep a generated test merged into the real test file even if it didn't
   * pass. Useful for debugging a failing generation. Default: false — a
   * generated test that fails or errors is reverted out of the real file
   * so the repository is never left with a broken/red generated test.
   * Generated tests that pass are always kept, regardless of this flag.
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

/**
 * Enrich test inputs with TestFileContext by running the full test suite
 * detection and mapping pipeline.
 *
 * Generic over T so this works for both PrioritizedTestInput and
 * GeneratedTestInput (and anything else shaped like PrioritizedTestInput)
 * WITHOUT dropping extra fields. Previously this function unconditionally
 * rebuilt a bare {testFile, priority, context} object, which silently
 * stripped testCode/testName/sourceFile/isNewTestFile off generated test
 * inputs — causing generated tests to be routed to runExistingTest()
 * instead of runGeneratedTest(), so they were never merged into disk.
 */
export async function enrichTestInputsWithContext<T extends PrioritizedTestInput>(
  testInputs: T[],
  repositoryRoot: string
): Promise<(T & { context?: TestFileContext })[]> {
  try {
    const { detectRepositoryTestSuite } = await import("./test-suite-detector.js");
    const { mapAllTestFiles } = await import("./test-context-mapper.js");

    // Run the full detection + mapping pipeline
    const profile = detectRepositoryTestSuite(repositoryRoot);
    const allContexts = mapAllTestFiles(profile);

    // Build a map: testFile → TestFileContext
    const contextByFile = new Map<string, TestFileContext>();
    for (const ctx of allContexts) {
      contextByFile.set(ctx.testFile, ctx);
    }

    // Enrich each input with its context WITHOUT dropping any of its
    // existing fields (testCode, testName, sourceFile, isNewTestFile, etc.)
    return testInputs.map((input) => {
      const ctx = contextByFile.get(input.testFile);
      return ctx ? { ...input, context: ctx } : { ...input };
    });
  } catch (error) {
    console.error(
      "Failed to enrich test inputs with context:",
      error instanceof Error ? error.message : String(error)
    );
    // Graceful fallback: return inputs unchanged, framework resolution falls back to legacy logic
    return testInputs.map((input) => ({ ...input }));
  }
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
 * Execute a generated test.
 *
 * Unlike the previous implementation, this does NOT materialize the
 * generated test into a disposable `__generated__/generated_*.test.ts`
 * copy. Instead it merges the generated `it()` block(s) directly into the
 * real, related test file (via mergeGeneratedTests — extending it if it
 * exists, scaffolding it if it doesn't), runs that real file in place, and:
 *   - keeps the merge if the test passed (or keepGeneratedTests is set)
 *   - reverts the merge (restoring the original file, or deleting a newly
 *     created one) if the test failed/errored and keepGeneratedTests is not
 *     set — so a broken generated test never lingers in the repository.
 */
async function runGeneratedTest(
  generated: GeneratedTestInput,
  options: TestRunnerOptions
): Promise<TestExecutionResult> {
  let merge: MergeResult | undefined;

  try {
    console.log(
      `[Test-Writer] Writing 1 generated test to ${generated.testFile}`
    );

    merge = mergeGeneratedTests(
      options.repositoryRoot,
      generated.testFile,
      generated.isNewTestFile,
      generated.sourceFile,
      [{ name: generated.testName, testCode: generated.testCode }]
    );

    // Verify the merge actually landed on disk before trusting it enough
    // to execute. Read the file back rather than trusting the in-memory
    // MergeResult, since a writer bug could report success without
    // actually persisting the change.
    const writtenContent = fs.readFileSync(merge.testFileAbsolute, "utf8");
    const testNameFound = generated.testName && writtenContent.includes(generated.testName);
    const codeSnippet = generated.testCode.trim().slice(0, 60);
    const codeFound = codeSnippet.length > 0 && writtenContent.includes(codeSnippet);

    if (!testNameFound && !codeFound) {
      console.error(
        `[Test-Writer] ✗ Verification failed — "${generated.testName}" not found in ` +
          `${generated.testFile} after merge; aborting before execution`
      );
      maybeRevert(merge, "verification_failed", options);
      return {
        testFile: generated.testFile,
        priority: generated.priority,
        framework: null,
        command: "[FAILED] merge verification failed",
        status: "error",
        duration: 0,
        exitCode: null,
        stdout: "",
        stderr:
          `Generated test "${generated.testName}" was not found in ` +
          `${generated.testFile} after the merge step — the write may have ` +
          `failed silently. Aborting before execution.`,
        generated: true,
        generatedTestName: generated.testName,
        keptInTestFile: false,
      };
    }

    console.log(`[Test-Writer] ✓ Test successfully written to ${generated.testFile}`);

    const resolution = resolveFrameworkForMergedFile(generated, options);

    if (!resolution.framework) {
      maybeRevert(merge, "not_found_no_framework", options);
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
        keptInTestFile: !!options.keepGeneratedTests,
      };
    }

    if (!isFrameworkInstalled(resolution.framework, resolution.workspaceDir)) {
      maybeRevert(merge, "framework_missing", options);
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
        keptInTestFile: !!options.keepGeneratedTests,
      };
    }

    console.log(
      `[Step 6/6] Executing updated test file: ${generated.testFile} ` +
        `(cwd: ${resolution.workspaceRelative})...`
    );
    const result = await executeTestFile(merge.testFileAbsolute, resolution, options);

    // Keep generated tests if:
    // 1. They passed
    // 2. They errored (environment issue, not test failure) — allows debugging
    // 3. keepGeneratedTests option is set
    const keep = result.status === "passed" || result.status === "error" || !!options.keepGeneratedTests;

    if (!keep) {
      console.log(
        `[Test-Writer] Reverting "${generated.testName}" — test did not pass and keepGeneratedTests is false`
      );
      revertMerge(merge);
    }

    return {
      ...result,
      testFile: generated.testFile,
      priority: generated.priority,
      generated: true,
      generatedTestName: generated.testName,
      keptInTestFile: keep,
    } as TestExecutionResult;
  } catch (error) {
    if (merge && !options.keepGeneratedTests) {
      revertMerge(merge);
    }

    return {
      testFile: generated.testFile,
      priority: generated.priority,
      framework: null,
      command: "[FAILED] could not merge/execute generated test",
      status: "error",
      duration: 0,
      exitCode: null,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}`,
      generated: true,
      generatedTestName: generated.testName,
      keptInTestFile: merge ? !!options.keepGeneratedTests : false,
    } as TestExecutionResult;
  }
}

function maybeRevert(
  merge: MergeResult,
  _reason: string,
  options: TestRunnerOptions
): void {
  if (!options.keepGeneratedTests) {
    revertMerge(merge);
  }
}

/**
 * Framework resolution for a generated test. The test file's path/config is
 * unaffected by merging generated content into it — so we can resolve
 * against `generated.testFile` even for a brand-new file (the resolver
 * walks up from the file's directory to find config, same as any other
 * file in that location would).
 * 
 * If a TestFileContext is provided, use it directly without invoking the
 * legacy resolver, to ensure the merged file runs in the correct workspace
 * with the correct framework.
 */
function resolveFrameworkForMergedFile(
  generated: GeneratedTestInput,
  options: TestRunnerOptions
): FrameworkResolution {
  // If we have mapped context, use it directly
  if (generated.context && generated.context.framework) {
    const workspaceDir = path.resolve(
      options.repositoryRoot,
      generated.context.executionDirectory
    );
    const configAbs = generated.context.configPath
      ? path.resolve(options.repositoryRoot, generated.context.configPath)
      : null;

    return {
      framework: generated.context.framework,
      packageManager: detectPackageManager(options.repositoryRoot),
      workspaceDir,
      workspaceRelative: generated.context.executionDirectory,
      configFile: generated.context.configPath,
      testPathRelativeToWorkspace: generated.testFile,
      confidence: 1.0,
      evidence: ["Resolved from mapped TestFileContext", ...generated.context.warnings],
      configVerified: true,
      configIsWorkspace: configAbs ? isWorkspaceConfigFile(configAbs) : false,
      testScripts: getTestScriptsForDir(workspaceDir),
    };
  }

  // Fallback: use legacy framework resolution
  return resolveFramework(generated.testFile, options.repositoryRoot);
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

  // If we have mapped context, use it directly without invoking the legacy resolver
  if (test.context) {
    if (!test.context.framework) {
      return {
        testFile: test.testFile,
        priority: test.priority,
        framework: null,
        command: "[SKIPPED] no test framework was detected for this file's workspace",
        status: "skipped",
        duration: 0,
        exitCode: null,
        stdout: "",
        stderr: "",
        notes: test.context.warnings.join("; "),
      };
    }

    // Construct a full FrameworkResolution from the context
    const workspaceDir = path.resolve(
      options.repositoryRoot,
      test.context.executionDirectory
    );

    if (!isFrameworkInstalled(test.context.framework, workspaceDir)) {
      return {
        testFile: test.testFile,
        priority: test.priority,
        framework: test.context.framework,
        command: `[SKIPPED] ${test.context.framework} not installed`,
        status: "skipped",
        duration: 0,
        exitCode: null,
        stdout: "",
        stderr: `Framework not installed in workspace: ${test.context.framework}`,
        notes: `${test.context.framework} not installed in workspace`,
      };
    }

    // Build a resolution using the context
    const configAbs = test.context.configPath
      ? path.resolve(options.repositoryRoot, test.context.configPath)
      : null;

    const resolution: FrameworkResolution = {
      framework: test.context.framework,
      packageManager: detectPackageManager(options.repositoryRoot),
      workspaceDir,
      workspaceRelative: test.context.executionDirectory,
      configFile: test.context.configPath,
      testPathRelativeToWorkspace: path.relative(workspaceDir, testFileAbs),
      confidence: 1.0, // The mapper has already done the work
      evidence: ["Resolved from mapped TestFileContext", ...test.context.warnings],
      configVerified: true, // The mapper already verified this
      configIsWorkspace: configAbs ? isWorkspaceConfigFile(configAbs) : false,
      testScripts: getTestScriptsForDir(workspaceDir),
    };

    console.log(
      `[test-runner] Using mapped context for "${test.testFile}": framework="${test.context.framework}", ` +
      `packageManager="${resolution.packageManager}", workspace="${test.context.executionDirectory}", ` +
      `config="${test.context.configPath || "(default)"}", testScripts=[${(resolution.testScripts ?? []).join(", ")}]`
    );

    return executeTestFile(testFileAbs, resolution, options).then((partial) => ({
      ...partial,
      testFile: test.testFile,
      priority: test.priority,
    } as TestExecutionResult));
  }

  // Fallback: use legacy framework resolver if no context provided
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
 * `testFilePath` is an absolute path to the test file to run — either a
 * pre-existing file, or the real file a generated test was just merged
 * into. It will be converted to a path relative to
 * `resolution.workspaceDir` before passing to `buildTestCommand`.
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

  console.log(`[test-runner] Executing: ${commandLabel}`);

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

        console.log("========== TEST DEBUG ==========");
        console.log("Command:", commandLabel);
        console.log("Working directory:", resolution.workspaceDir);
        console.log("Test path:", testFilePath);
        console.log("Exit code:", exitCode);
        console.log("STDOUT:", stdout);
        console.log("STDERR:", stderr);
        console.log("================================");

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