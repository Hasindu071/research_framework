import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import * as os from "os";

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
import {
  extractUnresolvedAlias,
  resolveAliasTarget,
  writeAliasOverrideConfig,
  cleanupOverrideConfig,
} from "./alias-resolver.js";

// ======================================================
// WORKSPACE-AWARE CONFIG RESOLUTION
// ======================================================

const VITEST_CONFIG_NAMES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vite.config.ts",
  "vite.config.mts",
];

function findNearestVitestConfig(
  testFileAbsolute: string,
  repositoryRoot: string
): { configPath: string; cwd: string } | null {
  let dir = path.dirname(testFileAbsolute);
  const rootResolved = path.resolve(repositoryRoot);

  let closestConfig: { configPath: string; cwd: string } | null = null;

  while (dir.startsWith(rootResolved)) {
    for (const name of VITEST_CONFIG_NAMES) {
      const candidate = path.join(dir, name);

      if (fs.existsSync(candidate)) {
        closestConfig = {
          configPath: candidate,
          cwd: dir,
        };

        return closestConfig;
      }
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      break;
    }

    dir = parent;
  }

  return closestConfig;
}

// ======================================================
// TYPES
// ======================================================

export type TestStatus =
  | "passed"
  | "failed"
  | "error"
  | "skipped"
  | "not_found";

export interface PrioritizedTestInput {
  testFile: string;
  priority: number;
  context?: TestFileContext;
}

export interface GeneratedTestInput extends PrioritizedTestInput {
  testCode: string;
  testName: string;
  targetSymbol: string;
  sourceFile: string;
  isNewTestFile: boolean;
  repairAttempt?: number;
  sourceFileContent?: string;
}

export interface TestExecutionResult {
  testFile: string;
  priority: number;
  framework: TestFramework | null;
  command: string;
  status: TestStatus;
  duration: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  notes?: string;
  resolution?: FrameworkResolution;
  generated?: boolean;
  generatedTestName?: string;
  keptInTestFile?: boolean;
}

export interface TestRunnerOptions {
  repositoryRoot: string;

  testCommand?: string;

  stopOnFailure?: boolean;

  maxFailures?: number;

  timeoutMs?: number;

  keepGeneratedTests?: boolean;
}

export interface TestRunSummary {
  testExecution: TestExecutionResult[];
  stoppedEarly: boolean;
}

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_OUTPUT_CHARS = 20_000;

// ======================================================
// PATH NORMALIZATION
// ======================================================

/**
 * Normalize repository-relative test paths.
 *
 * Windows:
 *   src\index.test.ts
 *
 * becomes:
 *   src/index.test.ts
 *
 * This is important because Jest/Vitest can interpret Windows
 * backslashes as escape characters in some command-line contexts.
 */
function normalizeTestPath(testPath: string): string {
  return testPath
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");
}

// ======================================================
// DETECT "NO TESTS RUN" PATTERNS
// ======================================================

const NO_TESTS_RUN_PATTERNS: Partial<Record<TestFramework, RegExp[]>> = {
  vitest: [/No test files found/i],
  jest: [
    /No tests found/i,
    /Your test suite must contain at least one test/i,
  ],
  playwright: [
    /No tests found/i,
    /Error: No tests found/i,
  ],
  mocha: [
    /0 passing/i,
    /No test files found/i,
  ],
};

const IMPORT_ERROR_PATTERNS = [
  /Failed to resolve import/i,
  /Cannot find module/i,
  /Module not found/i,
  /SyntaxError/i,
  /ERR_MODULE_NOT_FOUND/i,
  /Error: Could not resolve/i,
  /Failed to load custom Reporter/i,
  /Error: Failed to load url/i,
];

const CONFIG_ERROR_PATTERNS = [
  /Timed out waiting.*from config\./i,
  /Error: Can't resolve config/i,
  /Invalid config/i,
  /TS5110/i,
  /Option 'module' must be set/i,
  /error TS5\d+:/i,
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

function detectImportOrSetupError(
  stdout: string,
  stderr: string
): boolean {
  const combined = `${stdout}\n${stderr}`;

  return IMPORT_ERROR_PATTERNS.some((pattern) =>
    pattern.test(combined)
  );
}

function detectConfigError(
  stdout: string,
  stderr: string
): boolean {
  const combined = `${stdout}\n${stderr}`;

  return CONFIG_ERROR_PATTERNS.some((pattern) =>
    pattern.test(combined)
  );
}

// ======================================================
// CHECK FRAMEWORK INSTALLATION
// ======================================================

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

  let dir = workspaceDir;

  while (true) {
    const found = frameworkDeps[framework].some((dep) =>
      fs.existsSync(
        path.join(dir, "node_modules", dep)
      )
    );

    if (found) {
      return true;
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      break;
    }

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
  const ordered = [...tests].sort(
    (a, b) => a.priority - b.priority
  );

  const testExecution: TestExecutionResult[] = [];

  let failureCount = 0;
  let stoppedEarly = false;

  for (const test of ordered) {
    const result = await runSingleTest(test, options);

    testExecution.push(result);

    if (result.status !== "passed") {
      if (
        result.status === "failed" ||
        result.status === "error"
      ) {
        failureCount++;
      }

      if (
        options.stopOnFailure &&
        result.status !== "skipped"
      ) {
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

  return {
    testExecution,
    stoppedEarly,
  };
}

// ======================================================
// PRIORITIZED TEST ADAPTER
// ======================================================

export function toPrioritizedTestInputs(
  prioritized: any[]
): PrioritizedTestInput[] {
  return prioritized.map((test) => ({
    testFile: test.testFile,
    priority: test.priority,
  }));
}

// ======================================================
// ENRICH TEST INPUTS
// ======================================================

export async function enrichTestInputsWithContext<
  T extends PrioritizedTestInput
>(
  testInputs: T[],
  repositoryRoot: string
): Promise<(T & { context?: TestFileContext })[]> {
  try {
    const {
      detectRepositoryTestSuite,
    } = await import(
      "./test-suite-detector.js"
    );

    const {
      mapAllTestFiles,
    } = await import(
      "./test-context-mapper.js"
    );

    const profile =
      detectRepositoryTestSuite(repositoryRoot);

    const allContexts =
      mapAllTestFiles(profile);

    const contextByFile =
      new Map<string, TestFileContext>();

    for (const ctx of allContexts) {
      contextByFile.set(
        ctx.testFile,
        ctx
      );
    }

    return testInputs.map((input) => {
      const ctx =
        contextByFile.get(input.testFile);

      return ctx
        ? {
            ...input,
            context: ctx,
          }
        : {
            ...input,
          };
    });
  } catch (error) {
    console.error(
      "Failed to enrich test inputs with context:",
      error instanceof Error
        ? error.message
        : String(error)
    );

    return testInputs.map((input) => ({
      ...input,
    }));
  }
}

// ======================================================
// RUN SINGLE TEST
// ======================================================

async function runSingleTest(
  test:
    | PrioritizedTestInput
    | GeneratedTestInput,
  options: TestRunnerOptions
): Promise<TestExecutionResult> {
  if ("testCode" in test) {
    return runGeneratedTest(
      test as GeneratedTestInput,
      options
    );
  }

  return runExistingTest(
    test as PrioritizedTestInput,
    options
  );
}

// ======================================================
// RUN GENERATED TEST
// ======================================================

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
      !fs.existsSync(
        path.resolve(
          options.repositoryRoot,
          generated.testFile
        )
      ),
      generated.sourceFile,
      [
        {
          name: generated.testName,
          testCode: generated.testCode,
        },
      ],
      generated.targetSymbol
    );

    const writtenContent =
      fs.readFileSync(
        merge.testFileAbsolute,
        "utf8"
      );

    if (merge.finalContent === "") {
      console.log(
        `[Test-Writer] ℹ️ All tests were rejected during validation for "${generated.testName}"`
      );

      return {
        testFile: generated.testFile,
        priority: generated.priority,
        framework: null,
        command:
          "[SKIPPED] all generated tests were rejected during validation",
        status: "skipped",
        duration: 0,
        exitCode: null,
        stdout: "",
        stderr: "",
        notes:
          "Test failed validation checks (stub test, weak assertion, or doesn't call target function)",
        generated: true,
        generatedTestName:
          generated.testName,
        keptInTestFile: false,
      };
    }

    const testNameFound =
      generated.testName &&
      writtenContent.includes(
        generated.testName
      );

    const codeSnippet =
      generated.testCode
        .trim()
        .slice(0, 60);

    const codeFound =
      codeSnippet.length > 0 &&
      writtenContent.includes(
        codeSnippet
      );

    if (!testNameFound && !codeFound) {
      console.error(
        `[Test-Writer] ✗ Verification failed — "${generated.testName}" not found in ` +
          `${generated.testFile} after merge; aborting before execution`
      );

      maybeRevert(
        merge,
        "verification_failed",
        options
      );

      return {
        testFile: generated.testFile,
        priority: generated.priority,
        framework: null,
        command:
          "[FAILED] merge verification failed",
        status: "error",
        duration: 0,
        exitCode: null,
        stdout: "",
        stderr:
          `Generated test "${generated.testName}" was not found in ` +
          `${generated.testFile} after the merge step — the write may have ` +
          `failed silently. Aborting before execution.`,
        generated: true,
        generatedTestName:
          generated.testName,
        keptInTestFile: false,
      };
    }

    console.log(
      `[Test-Writer] ✓ Test successfully written to ${generated.testFile}`
    );

    // ======================================================
    // CUSTOM TEST COMMAND
    // ======================================================

    if (options.testCommand) {
      console.log(
        `[test-runner] Using custom test command for generated test`
      );

      const testFileAbs =
        merge.testFileAbsolute;

      const rawTestPathRelativeToRoot =
        path.relative(
          options.repositoryRoot,
          testFileAbs
        );

      // IMPORTANT:
      // Normalize Windows "\" → "/" before passing
      // the test path to Jest/Vitest.
      const testPathRelativeToRoot =
        normalizeTestPath(
          rawTestPathRelativeToRoot
        );

      console.log(
        `[test-runner] raw generated test path: ${rawTestPathRelativeToRoot}`
      );

      console.log(
        `[test-runner] normalized generated test path: ${testPathRelativeToRoot}`
      );

      const timeoutMs =
        options.timeoutMs ??
        DEFAULT_TIMEOUT_MS;

      const fullCommand =
        `${options.testCommand} ${testPathRelativeToRoot}`;

      console.log(
        `[test-runner] Executing: ${fullCommand}`
      );

      const cmdParts =
        options.testCommand.split(/\s+/);

      const executable =
        cmdParts[0]!;

      const baseArgs =
        cmdParts.slice(1);

      const args = [
        ...baseArgs,
        testPathRelativeToRoot,
      ];

      const result =
        await spawnTestProcess(
          executable,
          args,
          options.repositoryRoot,
          timeoutMs
        );

      const executionResult =
        buildExecutionResult(
          result,
          fullCommand,
          {
            framework: null,
            packageManager: "unknown",
            workspaceDir:
              options.repositoryRoot,
            workspaceRelative: ".",
            configFile: null,
            testPathRelativeToWorkspace:
              testPathRelativeToRoot,
            confidence: 1.0,
            evidence: [
              "Using custom test command from user",
            ],
            configVerified: false,
            configIsWorkspace: false,
            testScripts: [],
          },
          timeoutMs
        );

      const keep =
        executionResult.status ===
          "passed" ||
        executionResult.status ===
          "error" ||
        !!options.keepGeneratedTests;

      if (!keep) {
        console.log(
          `[Test-Writer] Reverting "${generated.testName}" — test did not pass and keepGeneratedTests is false`
        );

        revertMerge(merge);
      }

      return {
        ...executionResult,
        testFile: generated.testFile,
        priority: generated.priority,
        generated: true,
        generatedTestName:
          generated.testName,
        keptInTestFile: keep,
      } as TestExecutionResult;
    }

    // ======================================================
    // FRAMEWORK DETECTION
    // ======================================================

    const resolution =
      resolveFrameworkForMergedFile(
        generated,
        options
      );

    if (!resolution.framework) {
      maybeRevert(
        merge,
        "not_found_no_framework",
        options
      );

      return {
        testFile: generated.testFile,
        priority: generated.priority,
        framework: null,
        command:
          "[SKIPPED] no test framework could be resolved for this file",
        status: "skipped",
        duration: 0,
        exitCode: null,
        stdout: "",
        stderr: "",
        notes:
          resolution.evidence.join("; "),
        resolution,
        generated: true,
        generatedTestName:
          generated.testName,
        keptInTestFile:
          !!options.keepGeneratedTests,
      };
    }

    if (
      !isFrameworkInstalled(
        resolution.framework,
        resolution.workspaceDir
      )
    ) {
      maybeRevert(
        merge,
        "framework_missing",
        options
      );

      return {
        testFile: generated.testFile,
        priority: generated.priority,
        framework:
          resolution.framework,
        command:
          `[SKIPPED] ${resolution.framework} not installed`,
        status: "skipped",
        duration: 0,
        exitCode: null,
        stdout: "",
        stderr:
          `Framework not installed in workspace: ${resolution.framework}`,
        notes:
          `${resolution.framework} not installed in workspace`,
        resolution,
        generated: true,
        generatedTestName:
          generated.testName,
        keptInTestFile:
          !!options.keepGeneratedTests,
      };
    }

    console.log(
      `[Step 6/6] Executing updated test file: ${generated.testFile} ` +
        `(cwd: ${resolution.workspaceRelative})...`
    );

    const result =
      await executeTestFile(
        merge.testFileAbsolute,
        resolution,
        options
      );

    const repairAttempt =
      (generated.repairAttempt ?? 0) + 1;

    const MAX_REPAIR_ATTEMPTS = 3;

    if (
      result.status === "failed" &&
      repairAttempt < MAX_REPAIR_ATTEMPTS
    ) {
      console.log(
        `[Test-Repair] ⚠️ Test failed (attempt ${repairAttempt}/${MAX_REPAIR_ATTEMPTS}). Requesting repair from LLM...`
      );

      return {
        ...result,
        testFile: generated.testFile,
        priority: generated.priority,
        generated: true,
        generatedTestName:
          generated.testName,
        keptInTestFile: false,
        needsRepair: true,
        repairAttempt,
        repairError: result.stderr,
      } as any as TestExecutionResult;
    }

    const keep =
      result.status === "passed" ||
      result.status === "error" ||
      !!options.keepGeneratedTests;

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
      generatedTestName:
        generated.testName,
      keptInTestFile: keep,
    } as TestExecutionResult;
  } catch (error) {
    if (
      merge &&
      !options.keepGeneratedTests
    ) {
      revertMerge(merge);
    }

    return {
      testFile: generated.testFile,
      priority: generated.priority,
      framework: null,
      command:
        "[FAILED] could not merge/execute generated test",
      status: "error",
      duration: 0,
      exitCode: null,
      stdout: "",
      stderr:
        `${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      generated: true,
      generatedTestName:
        generated.testName,
      keptInTestFile:
        merge
          ? !!options.keepGeneratedTests
          : false,
    } as TestExecutionResult;
  }
}

// ======================================================
// MAYBE REVERT
// ======================================================

function maybeRevert(
  merge: MergeResult,
  _reason: string,
  options: TestRunnerOptions
): void {
  if (!options.keepGeneratedTests) {
    revertMerge(merge);
  }
}

// ======================================================
// RESOLVE FRAMEWORK FOR GENERATED TEST
// ======================================================

function resolveFrameworkForMergedFile(
  generated: GeneratedTestInput,
  options: TestRunnerOptions
): FrameworkResolution {
  if (
    generated.context &&
    generated.context.framework
  ) {
    const workspaceDir =
      path.resolve(
        options.repositoryRoot,
        generated.context.executionDirectory
      );

    const configAbs =
      generated.context.configPath
        ? path.resolve(
            options.repositoryRoot,
            generated.context.configPath
          )
        : null;

    return {
      framework:
        generated.context.framework,
      packageManager:
        detectPackageManager(
          options.repositoryRoot
        ),
      workspaceDir,
      workspaceRelative:
        generated.context
          .executionDirectory,
      configFile:
        generated.context.configPath,
      testPathRelativeToWorkspace:
        normalizeTestPath(
          generated.testFile
        ),
      confidence: 1.0,
      evidence: [
        "Resolved from mapped TestFileContext",
        ...generated.context.warnings,
      ],
      configVerified: true,
      configIsWorkspace:
        configAbs
          ? isWorkspaceConfigFile(
              configAbs
            )
          : false,
      testScripts:
        getTestScriptsForDir(
          workspaceDir
        ),
    };
  }

  return resolveFramework(
    generated.testFile,
    options.repositoryRoot
  );
}

// ======================================================
// RUN EXISTING TEST
// ======================================================

async function runExistingTest(
  test: PrioritizedTestInput,
  options: TestRunnerOptions
): Promise<TestExecutionResult> {
  const testFileAbs =
    path.resolve(
      options.repositoryRoot,
      test.testFile
    );

  if (!fs.existsSync(testFileAbs)) {
    return {
      testFile: test.testFile,
      priority: test.priority,
      framework: null,
      command:
        "[SKIPPED] file not found",
      status: "not_found",
      duration: 0,
      exitCode: null,
      stdout: "",
      stderr:
        `Test file does not exist: ${testFileAbs}`,
      notes:
        "File does not exist — candidate generation error (file may have been deleted or glob pattern was incorrect)",
    };
  }

  // ======================================================
  // CUSTOM TEST COMMAND
  // ======================================================

  if (options.testCommand) {
    const rawTestPathRelativeToRoot =
      path.relative(
        options.repositoryRoot,
        testFileAbs
      );

    const testPathRelativeToRoot =
      normalizeTestPath(
        rawTestPathRelativeToRoot
      );

    console.log(
      `[test-runner] raw existing test path: ${rawTestPathRelativeToRoot}`
    );

    console.log(
      `[test-runner] normalized existing test path: ${testPathRelativeToRoot}`
    );

    const timeoutMs =
      options.timeoutMs ??
      DEFAULT_TIMEOUT_MS;

    const fullCommand =
      `${options.testCommand} ${testPathRelativeToRoot}`;

    console.log(
      `[test-runner] Using custom test command for existing test: ${fullCommand}`
    );

    console.log(
      `[test-runner] Executing in: ${options.repositoryRoot}`
    );

    const cmdParts =
      options.testCommand.split(/\s+/);

    const executable =
      cmdParts[0]!;

    const baseArgs =
      cmdParts.slice(1);

    const args = [
      ...baseArgs,
      testPathRelativeToRoot,
    ];

    const result =
      await spawnTestProcess(
        executable,
        args,
        options.repositoryRoot,
        timeoutMs
      );

    const executionPartial =
      buildExecutionResult(
        result,
        fullCommand,
        {
          framework: null,
          packageManager: "unknown",
          workspaceDir:
            options.repositoryRoot,
          workspaceRelative: ".",
          configFile: null,
          testPathRelativeToWorkspace:
            testPathRelativeToRoot,
          confidence: 1.0,
          evidence: [
            "Using custom test command from user",
          ],
          configVerified: false,
          configIsWorkspace: false,
          testScripts: [],
        },
        timeoutMs
      );

    return {
      ...executionPartial,
      testFile: test.testFile,
      priority: test.priority,
    } as TestExecutionResult;
  }

  // ======================================================
  // FRAMEWORK DETECTION
  // ======================================================

  if (test.context) {
    if (!test.context.framework) {
      return {
        testFile: test.testFile,
        priority: test.priority,
        framework: null,
        command:
          "[SKIPPED] no test framework was detected for this file's workspace",
        status: "skipped",
        duration: 0,
        exitCode: null,
        stdout: "",
        stderr: "",
        notes:
          test.context.warnings.join(
            "; "
          ),
      };
    }

    const workspaceDir =
      path.resolve(
        options.repositoryRoot,
        test.context.executionDirectory
      );

    if (
      !isFrameworkInstalled(
        test.context.framework,
        workspaceDir
      )
    ) {
      return {
        testFile: test.testFile,
        priority: test.priority,
        framework:
          test.context.framework,
        command:
          `[SKIPPED] ${test.context.framework} not installed`,
        status: "skipped",
        duration: 0,
        exitCode: null,
        stdout: "",
        stderr:
          `Framework not installed in workspace: ${test.context.framework}`,
        notes:
          `${test.context.framework} not installed in workspace`,
      };
    }

    const configAbs =
      test.context.configPath
        ? path.resolve(
            options.repositoryRoot,
            test.context.configPath
          )
        : null;

    const resolution: FrameworkResolution =
      {
        framework:
          test.context.framework,
        packageManager:
          detectPackageManager(
            options.repositoryRoot
          ),
        workspaceDir,
        workspaceRelative:
          test.context.executionDirectory,
        configFile:
          test.context.configPath,
        testPathRelativeToWorkspace:
          normalizeTestPath(
            path.relative(
              workspaceDir,
              testFileAbs
            )
          ),
        confidence: 1.0,
        evidence: [
          "Resolved from mapped TestFileContext",
          ...test.context.warnings,
        ],
        configVerified: true,
        configIsWorkspace:
          configAbs
            ? isWorkspaceConfigFile(
                configAbs
              )
            : false,
        testScripts:
          getTestScriptsForDir(
            workspaceDir
          ),
      };

    console.log(
      `[test-runner] Using mapped context for "${test.testFile}": framework="${test.context.framework}", ` +
        `packageManager="${resolution.packageManager}", workspace="${test.context.executionDirectory}", ` +
        `config="${test.context.configPath || "(default)"}", ` +
        `testScripts=[${(
          resolution.testScripts ?? []
        ).join(", ")}]`
    );

    return executeTestFile(
      testFileAbs,
      resolution,
      options
    ).then(
      (partial) =>
        ({
          ...partial,
          testFile: test.testFile,
          priority: test.priority,
        } as TestExecutionResult)
    );
  }

  const resolution =
    resolveFramework(
      test.testFile,
      options.repositoryRoot
    );

  if (!resolution.framework) {
    return {
      testFile: test.testFile,
      priority: test.priority,
      framework: null,
      command:
        "[SKIPPED] no test framework could be resolved for this file",
      status: "skipped",
      duration: 0,
      exitCode: null,
      stdout: "",
      stderr: "",
      notes:
        resolution.evidence.join(
          "; "
        ),
      resolution,
    };
  }

  if (
    !isFrameworkInstalled(
      resolution.framework,
      resolution.workspaceDir
    )
  ) {
    return {
      testFile: test.testFile,
      priority: test.priority,
      framework:
        resolution.framework,
      command:
        `[SKIPPED] ${resolution.framework} not installed`,
      status: "skipped",
      duration: 0,
      exitCode: null,
      stdout: "",
      stderr:
        `Framework not installed in workspace: ${resolution.framework}`,
      notes:
        `${resolution.framework} not installed in workspace`,
      resolution,
    };
  }

  return executeTestFile(
    testFileAbs,
    resolution,
    options
  ).then(
    (partial) =>
      ({
        ...partial,
        testFile: test.testFile,
        priority: test.priority,
      } as TestExecutionResult)
  );
}

// ======================================================
// AUTO MOCK FUNCTION
// ======================================================

function injectAutoMockForUnresolvedImport(
  testFilePath: string,
  aliasPattern: string,
  stderr: string
): {
  success: boolean;
  backupContent?: string;
} {
  try {
    const match =
      stderr.match(
        /Failed to resolve import "([^"]+)"/
      );

    if (!match?.[1]) {
      return {
        success: false,
      };
    }

    const fullImportPath =
      match[1];

    const testContent =
      fs.readFileSync(
        testFilePath,
        "utf8"
      );

    const backup = testContent;

    let modifiedContent =
      testContent;

    const mockFactory = `(() => {
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
    default: {
      click: asyncNoop,
      type: asyncNoop,
      clear: asyncNoop,
      selectOptions: asyncNoop,
      deselectOptions: asyncNoop,
      upload: asyncNoop,
      keyboard: asyncNoop,
      pointer: asyncNoop,
      tripleClick: asyncNoop,
      dblClick: asyncNoop,
      hover: asyncNoop,
      unhover: asyncNoop,
      tab: asyncNoop,
    },
    click: asyncNoop,
    type: asyncNoop,
    clear: asyncNoop,
    selectOptions: asyncNoop,
    deselectOptions: asyncNoop,
    upload: asyncNoop,
    keyboard: asyncNoop,
    pointer: asyncNoop,
    tripleClick: asyncNoop,
    dblClick: asyncNoop,
    hover: asyncNoop,
    unhover: asyncNoop,
    tab: asyncNoop,
  };
})()`;

    modifiedContent =
      modifiedContent.replace(
        new RegExp(
          `import\\s+([\\w{},\\s*$]+?)\\s+from\\s+['"]${fullImportPath.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
          )}['"]`,
          "g"
        ),
        (match, imports) => {
          const isDefaultImport =
            !imports.includes("{");

          if (isDefaultImport) {
            return `const ${imports.trim()} = ${mockFactory};`;
          } else {
            const names =
              imports
                .split(",")
                .map(
                  (n: string) =>
                    n
                      .trim()
                      .split(" ")
                      .pop() || ""
                );

            return names
              .filter(
                (n: string) => n
              )
              .map(
                (name: string) =>
                  `const ${name} = async () => {};`
              )
              .join("\n");
          }
        }
      );

    modifiedContent =
      modifiedContent.replace(
        new RegExp(
          `import\\s+['"]${fullImportPath.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
          )}['"];`,
          "g"
        ),
        "// Side-effect import removed"
      );

    fs.writeFileSync(
      testFilePath,
      modifiedContent,
      "utf8"
    );

    console.log(
      `[test-runner] ✓ Injected mock for "${fullImportPath}" by replacing import statement with functional mock`
    );

    return {
      success: true,
      backupContent: backup,
    };
  } catch (err) {
    console.log(
      `[test-runner] Failed to inject auto-mock:`,
      err
    );

    return {
      success: false,
    };
  }
}

// ======================================================
// SPAWN TEST PROCESS
// ======================================================

export async function spawnTestProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  duration: number;
}> {
  return new Promise((resolve) => {
    const start = Date.now();

    let stdout = "";
    let stderr = "";

    let timedOut = false;
    let resolved = false;

    const shell =
      process.platform === "win32"
        ? true
        : true;

    const child = spawn(
      command,
      args,
      {
        cwd,
        shell,
        stdio: [
          "pipe",
          "pipe",
          "pipe",
        ],
        windowsHide: true,
        env: {
          ...process.env,
          CI: "true",
          confirmModulesPurge: "false",
        },
      }
    );

    const timer =
      setTimeout(() => {
        timedOut = true;

        child.kill("SIGTERM");

        setTimeout(() => {
          if (!resolved) {
            child.kill("SIGKILL");
          }
        }, 1000);
      }, timeoutMs);

    child.stdout?.on(
      "data",
      (chunk: Buffer) => {
        stdout += chunk.toString();
      }
    );

    child.stderr?.on(
      "data",
      (chunk: Buffer) => {
        stderr += chunk.toString();
      }
    );

    child.on(
      "close",
      (exitCode) => {
        if (!resolved) {
          resolved = true;

          clearTimeout(timer);

          const elapsed =
            (Date.now() - start) /
            1000;

          if (timedOut) {
            stderr =
              `${stderr}\n[TIMEOUT] Test did not complete within ${timeoutMs}ms`;
          }

          resolve({
            exitCode:
              timedOut
                ? null
                : exitCode,
            stdout,
            stderr,
            timedOut,
            duration: elapsed,
          });
        }
      }
    );

    child.on(
      "error",
      (error) => {
        if (!resolved) {
          resolved = true;

          clearTimeout(timer);

          const elapsed =
            (Date.now() - start) /
            1000;

          resolve({
            exitCode: null,
            stdout,
            stderr:
              `${stderr}\n[SPAWN ERROR] ${error.message}`,
            timedOut: false,
            duration: elapsed,
          });
        }
      }
    );
  });
}

// ======================================================
// EXECUTE TEST FILE
// ======================================================

async function executeTestFile(
  testFilePath: string,
  resolution: FrameworkResolution,
  options: TestRunnerOptions
): Promise<Partial<TestExecutionResult>> {
  const fileContent =
    fs.readFileSync(
      testFilePath,
      "utf8"
    );

  // ======================================================
  // E2E TEST DETECTION
  // ======================================================

  const isE2eTest =
    testFilePath.includes("/e2e/") ||
    testFilePath.includes("\\e2e\\") ||
    fileContent.includes(
      "@playwright/test"
    ) ||
    fileContent.includes(
      "import { test } from '@/helpers/playwright'"
    );

  if (isE2eTest) {
    console.log(
      `[test-runner] ℹ️ E2E TEST DETECTED: Running with Playwright CLI`
    );

    console.log(
      `[test-runner]    File: ${testFilePath}`
    );

    let e2eDir =
      path.dirname(testFilePath);

    while (
      e2eDir !==
      path.dirname(e2eDir)
    ) {
      if (
        fs.existsSync(
          path.join(
            e2eDir,
            "playwright.config.ts"
          )
        ) ||
        fs.existsSync(
          path.join(
            e2eDir,
            "playwright.config.js"
          )
        )
      ) {
        break;
      }

      e2eDir =
        path.dirname(e2eDir);
    }

    if (
      !fs.existsSync(
        path.join(
          e2eDir,
          "playwright.config.ts"
        )
      ) &&
      !fs.existsSync(
        path.join(
          e2eDir,
          "playwright.config.js"
        )
      )
    ) {
      e2eDir =
        path.dirname(testFilePath);

      while (
        e2eDir.includes("e2e") &&
        e2eDir !==
          path.dirname(e2eDir)
      ) {
        if (
          path.basename(
            e2eDir
          ) === "e2e"
        ) {
          break;
        }

        e2eDir =
          path.dirname(e2eDir);
      }
    }

    const testPathRelativeToE2e =
      normalizeTestPath(
        path.relative(
          e2eDir,
          testFilePath
        )
      );

    const timeoutMs =
      options.timeoutMs ??
      DEFAULT_TIMEOUT_MS;

    const commandLabel =
      `(cwd: ${e2eDir}) npx playwright test ${testPathRelativeToE2e}`;

    console.log(
      `[test-runner] Executing: ${commandLabel}`
    );

    const result =
      await spawnTestProcess(
        "npx",
        [
          "playwright",
          "test",
          testPathRelativeToE2e,
        ],
        e2eDir,
        timeoutMs
      );

    return buildExecutionResult(
      result,
      commandLabel,
      resolution,
      timeoutMs
    );
  }

  // ======================================================
  // STUB TEST DETECTION
  // ======================================================

  const isStubTest =
    /expect\s*\(\s*(?:true|false|1|0|null|undefined|'[^']*'|"[^"]*")\s*\)\s*\.toBe(?:Null|Undefined|NaN|Truthy|Falsy|InstanceOf|Defined|Called|CalledTimes|CalledWith|CalledOnce)?\s*\(\s*(?:true|false|1|0|null|undefined|'[^']*'|"[^"]*")\s*\)/.test(
      fileContent
    );

  if (isStubTest) {
    console.log(
      `[test-runner] ⚠️ STUB TEST DETECTED: This test doesn't verify real function behavior`
    );

    console.log(
      `[test-runner]    File: ${testFilePath}`
    );

    console.log(
      `[test-runner]    Skipping execution (stub tests always pass but don't provide value)`
    );

    return {
      exitCode: 1,
      status: "failed" as const,
      stdout:
        "SKIPPED: Stub test detected (expect(true).toBe(true) pattern)",
      stderr:
        "This test was generated without understanding the function behavior. It should be rewritten or skipped.",
      duration: 0,
      notes:
        "Stub test detected — no real function behavior verification. Generated test should be rewritten or skipped.",
    };
  }

  // ======================================================
  // CUSTOM TEST COMMAND
  // ======================================================

  if (options.testCommand) {
    const rawTestPathRelativeToWorkspace =
      path.relative(
        resolution.workspaceDir,
        testFilePath
      );

    const testPathRelativeToWorkspace =
      normalizeTestPath(
        rawTestPathRelativeToWorkspace
      );

    console.log(
      `[test-runner] raw test path: ${rawTestPathRelativeToWorkspace}`
    );

    console.log(
      `[test-runner] normalized test path: ${testPathRelativeToWorkspace}`
    );

    const timeoutMs =
      options.timeoutMs ??
      DEFAULT_TIMEOUT_MS;

    const fullCommand =
      `${options.testCommand} ${testPathRelativeToWorkspace}`;

    console.log(
      `[test-runner] Using custom test command: ${fullCommand}`
    );

    console.log(
      `[test-runner] Executing in: ${resolution.workspaceDir}`
    );

    const cmdParts =
      options.testCommand.split(/\s+/);

    const executable =
      cmdParts[0]!;

    const baseArgs =
      cmdParts.slice(1);

    const args = [
      ...baseArgs,
      testPathRelativeToWorkspace,
    ];

    const result =
      await spawnTestProcess(
        executable,
        args,
        resolution.workspaceDir,
        timeoutMs
      );

    return buildExecutionResult(
      result,
      fullCommand,
      resolution,
      timeoutMs
    );
  }

  // ======================================================
  // FRAMEWORK DETECTION
  // ======================================================

  let testPathRelativeToWorkspace =
    normalizeTestPath(
      path.relative(
        resolution.workspaceDir,
        testFilePath
      )
    );

  let {
    command,
    args,
  } = buildTestCommand(
    resolution,
    testPathRelativeToWorkspace
  );

  let executionCwd =
    resolution.workspaceDir;

  let originalConfigPath:
    string | null = null;

  // ======================================================
  // VITEST CONFIG
  // ======================================================

  if (
    resolution.framework ===
    "vitest"
  ) {
    const configLookup =
      findNearestVitestConfig(
        testFilePath,
        options.repositoryRoot
      );

    if (configLookup) {
      executionCwd =
        configLookup.cwd;

      originalConfigPath =
        configLookup.configPath;

      testPathRelativeToWorkspace =
        normalizeTestPath(
          path.relative(
            executionCwd,
            testFilePath
          )
        );

      ({
        command,
        args,
      } = buildTestCommand(
        resolution,
        testPathRelativeToWorkspace
      ));

      const isRootConfig =
        path.resolve(
          configLookup.cwd
        ) ===
        path.resolve(
          options.repositoryRoot
        );

      const configIdx =
        args.indexOf(
          "--config"
        );

      if (configIdx !== -1) {
        args = args
          .slice(
            0,
            configIdx
          )
          .concat(
            args.slice(
              configIdx + 2
            )
          );
      }

      if (!isRootConfig) {
        const configRelative =
          normalizeTestPath(
            path.relative(
              executionCwd,
              configLookup.configPath
            )
          );

        args = [
          ...args,
          "--config",
          configRelative,
        ];

        console.log(
          `[test-runner] Found package-level vitest config: ${configLookup.configPath}`
        );
      } else {
        console.log(
          `[test-runner] Root config found but not using --config flag to allow monorepo package discovery`
        );
      }
    }
  }

  const timeoutMs =
    options.timeoutMs ??
    DEFAULT_TIMEOUT_MS;

  const commandLabel =
    `(cwd: ${executionCwd}) ${command} ${args.join(" ")}`;

  // ======================================================
  // VITEST REPORTER
  // ======================================================

  if (
    resolution.framework ===
      "vitest" &&
    !args.some(
      (arg) =>
        arg.includes(
          "--reporter"
        )
    )
  ) {
    args.push(
      "--reporter=verbose"
    );

    console.log(
      `[test-runner] Added --reporter=verbose to override config reporters`
    );
  }

  console.log(
    `[test-runner] Executing: ${commandLabel}`
  );

  // ======================================================
  // INITIAL TEST RUN
  // ======================================================

  const result =
    await spawnTestProcess(
      command,
      args,
      executionCwd,
      timeoutMs
    );

  // ======================================================
  // VITEST ALIAS REMEDIATION
  // ======================================================

  if (
    resolution.framework ===
      "vitest" &&
    result.exitCode !== 0 &&
    !result.timedOut &&
    detectImportOrSetupError(
      result.stdout,
      result.stderr
    )
  ) {
    const unresolvedAlias =
      extractUnresolvedAlias(
        result.stderr
      );

    console.log(
      `[test-runner] ⚠️ IMPORT ERROR DETECTED. Extracted alias: "${unresolvedAlias}"`
    );

    if (unresolvedAlias) {
      console.log(
        `[test-runner] Detected unresolved import/alias. Attempting to inject auto-mock...`
      );

      if (originalConfigPath) {
        const aliasTarget =
          resolveAliasTarget(
            unresolvedAlias,
            path.dirname(
              testFilePath
            ),
            options.repositoryRoot
          );

        if (aliasTarget) {
          console.log(
            `[test-runner] Strategy 1: Resolved alias "${unresolvedAlias}" → "${aliasTarget}". Retrying with override config...`
          );

          const tmpDir =
            path.join(
              os.tmpdir(),
              "vitest-alias-overrides"
            );

          const overrideConfigPath =
            writeAliasOverrideConfig(
              originalConfigPath,
              unresolvedAlias,
              aliasTarget,
              tmpDir
            );

          try {
            let retryArgs =
              [...args];

            const configIdx =
              retryArgs.indexOf(
                "--config"
              );

            if (configIdx !== -1) {
              retryArgs =
                retryArgs
                  .slice(
                    0,
                    configIdx
                  )
                  .concat(
                    retryArgs.slice(
                      configIdx + 2
                    )
                  );
            }

            const configRelative =
              normalizeTestPath(
                path.relative(
                  executionCwd,
                  overrideConfigPath
                )
              );

            retryArgs = [
              ...retryArgs,
              "--config",
              configRelative,
            ];

            const retryLabel =
              `(cwd: ${executionCwd}, retry with alias override) ${command} ${retryArgs.join(" ")}`;

            console.log(
              `[test-runner] Retrying: ${retryLabel}`
            );

            const retryResult =
              await spawnTestProcess(
                command,
                retryArgs,
                executionCwd,
                timeoutMs
              );

            if (
              retryResult.exitCode ===
                0 ||
              !detectImportOrSetupError(
                retryResult.stdout,
                retryResult.stderr
              )
            ) {
              console.log(
                `[test-runner] Retry succeeded with alias override config`
              );

              return buildExecutionResult(
                retryResult,
                retryLabel,
                resolution,
                timeoutMs
              );
            }
          } finally {
            cleanupOverrideConfig(
              overrideConfigPath
            );
          }
        }
      }
    }
  }

  return buildExecutionResult(
    result,
    commandLabel,
    resolution,
    timeoutMs
  );
}

// ======================================================
// BUILD EXECUTION RESULT
// ======================================================

function buildExecutionResult(
  spawnResult: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    duration: number;
  },
  commandLabel: string,
  resolution: FrameworkResolution,
  timeoutMs: number
): Partial<TestExecutionResult> {
  console.log(
    "========== TEST DEBUG =========="
  );

  console.log(
    "Command:",
    commandLabel
  );

  console.log(
    "Exit code:",
    spawnResult.exitCode
  );

  console.log(
    "Duration:",
    spawnResult.duration,
    "seconds"
  );

  console.log(
    "STDOUT:",
    spawnResult.stdout
  );

  console.log(
    "STDERR:",
    spawnResult.stderr
  );

  console.log(
    "================================"
  );

  // IMPORTANT:
  // Use the real wall-clock duration captured
  // by spawnTestProcess().
  //
  // Only use timeoutMs when the process actually
  // timed out.
  const duration =
    spawnResult.timedOut
      ? timeoutMs / 1000
      : spawnResult.duration;

  let status: TestStatus =
    "failed";

  let notes:
    | string
    | undefined;

  // ======================================================
  // STATUS MAPPING
  // ======================================================

  if (spawnResult.timedOut) {
    status = "error";
  } else if (
    detectConfigError(
      spawnResult.stdout,
      spawnResult.stderr
    )
  ) {
    status = "error";

    const combined =
      `${spawnResult.stdout}\n${spawnResult.stderr}`;

    if (
      combined.includes(
        "TS5110"
      ) ||
      combined.includes(
        "Option 'module' must be set"
      )
    ) {
      notes =
        "TypeScript configuration error: 'module' option must match 'moduleResolution' in tsconfig.json — fix the configuration and retry";

      console.log(
        "[test-runner] ⚠️ TypeScript config mismatch detected (TS5110)"
      );

      console.log(
        "[test-runner] Fix: Ensure tsconfig.json has matching 'module' and 'moduleResolution' options"
      );
    } else {
      notes =
        "Test execution failed due to configuration or environment error — no actual test assertions ran";
    }
  } else if (
    detectImportOrSetupError(
      spawnResult.stdout,
      spawnResult.stderr
    )
  ) {
    status = "error";

    notes =
      "Test execution failed during import/setup phase — test environment or dependencies could not be resolved";
  } else if (
    detectNoTestsExecuted(
      resolution.framework,
      spawnResult.stdout,
      spawnResult.stderr
    )
  ) {
    status = "not_found";

    notes =
      resolution.configVerified
        ? `${resolution.framework} reported no test files matched the configured pattern`
        : `${resolution.framework} reported no test files matched; the resolved config was not verified against this test file's path`;
  } else if (
    spawnResult.exitCode === 0
  ) {
    status = "passed";
  } else if (
    spawnResult.exitCode === 127
  ) {
    status = "error";
  }

  const result:
    Partial<TestExecutionResult> = {
      framework:
        resolution.framework,

      command:
        commandLabel,

      status,

      duration,

      exitCode:
        spawnResult.exitCode,

      stdout:
        truncate(
          spawnResult.stdout
        ),

      stderr:
        spawnResult.timedOut
          ? `${truncate(
              spawnResult.stderr
            )}\n[killed: exceeded ${timeoutMs}ms timeout]`
          : truncate(
              spawnResult.stderr
            ),

      resolution,
    };

  if (notes !== undefined) {
    result.notes = notes;
  }

  return result;
}

// ======================================================
// TRUNCATE OUTPUT
// ======================================================

function truncate(
  output: string
): string {
  if (
    output.length <=
    MAX_OUTPUT_CHARS
  ) {
    return output;
  }

  return `${output.slice(
    0,
    MAX_OUTPUT_CHARS
  )}\n...[truncated, ${
    output.length -
    MAX_OUTPUT_CHARS
  } more chars]`;
}