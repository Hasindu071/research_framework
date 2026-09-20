import type { LLMContext } from "./context-builder.js";
import type { LLMClient } from "./llm-client.js";
import type { PrioritizedTest } from "./test-prioritizer.js";
import type { TestMatch } from "./test-analyzer.js";
import { resolveTargetTestFile } from "./test-file-writer.js";
import {
  TEST_GENERATOR_SYSTEM_PROMPT,
  buildTestGeneratorUserPrompt,
} from "./generator-prompts.js";
import type {
  TestGenerationTarget,
  GeneratedTestCase,
  TestGenerationResult,
  TestGenerationBatchResult,
} from "./generator-types.js";
import {
  analyzeCoverageGapsBatch,
  buildGapAnalysisInputsFromAnalysis,
  type TestGapAnalysis,
} from "./test-gap-analyzer.js";
import * as path from "path";
import fs from "fs";

/**
 * Result of building generation targets, including the gap analysis that
 * informed which targets to create.
 */
export interface GenerationTargetingResult {
  targets: TestGenerationTarget[];
  gapAnalyses: TestGapAnalysis[];
}

/** Raw shape we ask the LLM for — see generator-prompts.ts. */
interface RawGenerationResponse {
  testCases?: Partial<GeneratedTestCase>[];
}

const MAX_GENERATED_TESTS_PER_TARGET = 8;

// ======================================================
// TEMPLATE SIMILARITY SCORING
// ======================================================

const COMPONENT_EXTENSIONS = new Set(["tsx", "jsx"]);

function getExtension(filePath: string): string {
  const match = filePath.match(/\.([a-zA-Z0-9]+)$/);
  return match?.[1]?.toLowerCase() ?? "";
}

function isComponentFile(filePath: string): boolean {
  return COMPONENT_EXTENSIONS.has(getExtension(filePath));
}

/**
 * Rough signal that a test file actually renders a React component
 * (Testing Library / Enzyme), vs. testing plain logic.
 */
function looksLikeComponentTest(content: string): boolean {
  return /@testing-library\/react|from ["']enzyme["']|\brender\s*\(|\bscreen\.|\bmount\s*\(|\bshallow\s*\(/.test(
    content
  );
}

/**
 * Number of path segments that differ between two directories.
 * 0 = same directory, higher = further apart. Cheap "how nearby" signal.
 */
function directoryDistance(dirA: string, dirB: string): number {
  if (dirA === dirB) return 0;
  const segA = dirA.split(path.sep).filter(Boolean);
  const segB = dirB.split(path.sep).filter(Boolean);
  let common = 0;
  while (
    common < segA.length &&
    common < segB.length &&
    segA[common] === segB[common]
  ) {
    common++;
  }
  return segA.length - common + (segB.length - common);
}

interface TemplateCandidate {
  file: string;
  content: string;
}

/**
 * Score a candidate test file as a style template for `sourceFile`.
 * Higher is better. Replaces "first Vitest file we happen to find" with
 * a similarity ranking, so a component change doesn't get matched to a
 * plain-logic test file (or vice versa) just because both use Vitest.
 */
function scoreTemplateCandidate(
  candidate: TemplateCandidate,
  sourceFile: string,
  sourceIsComponent: boolean
): number {
  let score = 0;
  const candidateIsComponentExt = COMPONENT_EXTENSIONS.has(
    getExtension(candidate.file)
  );

  if (sourceIsComponent) {
    if (candidateIsComponentExt) score += 40;
    if (looksLikeComponentTest(candidate.content)) score += 40;
  } else {
    // Copying render()/screen. boilerplate into a plain-function test is
    // the wrong shape, so penalize component-flavored templates here too.
    if (!candidateIsComponentExt) score += 30;
    if (!looksLikeComponentTest(candidate.content)) score += 20;
  }

  const distance = directoryDistance(
    path.dirname(sourceFile),
    path.dirname(candidate.file)
  );
  score += Math.max(0, 20 - distance * 2);

  return score;
}

// ======================================================
// TEMPLATE DISCOVERY
// ======================================================

/**
 * Search the repository for a template test file matching the given framework.
 * Used when creating new test files from scratch. Ranks candidates by similarity
 * to the source file (extension family, component test detection, directory proximity).
 */
async function findTemplateTestFile(
  repositoryRoot: string,
  targetFramework: string,
  sourceFile: string,
  sourceIsComponent: boolean
): Promise<{ file: string; content: string } | null> {
  try {
    // Import fs to read files
    const fs = await import("fs");
    const path = await import("path");
    const { glob } = await import("glob");

    // Search for test files with common patterns
    const testPatterns = [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/tests/**/*.ts",
      "**/tests/**/*.tsx",
    ];

    const candidates: TemplateCandidate[] = [];

    outer: for (const pattern of testPatterns) {
      const testFiles = await glob(pattern, {
        cwd: repositoryRoot,
        ignore: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
        maxDepth: 10,
      });

      // Try to find a test file with matching framework
      for (const testFile of testFiles) {
        // Check framework based on filename and content
        const framework = inferFrameworkFromFileName(testFile);
        if (framework !== targetFramework) continue;

        try {
          const fullPath = path.join(repositoryRoot, testFile);
          const content = fs.readFileSync(fullPath, "utf-8");

          // Make sure it has actual test content, not just imports
          if (
            content.includes("it(") ||
            content.includes("test(") ||
            content.includes("describe(")
          ) {
            candidates.push({ file: testFile, content });
          }
        } catch {
          // Skip files we can't read
          continue;
        }

        if (candidates.length >= 60) break outer; // keep scoring cheap on big repos
      }
    }

    if (candidates.length === 0) {
      console.log(
        `[Test-Generator] No template test file found for framework "${targetFramework}"`
      );
      return null;
    }

    const ranked = candidates
      .map((c) => ({
        ...c,
        score: scoreTemplateCandidate(c, sourceFile, sourceIsComponent),
      }))
      .sort((a, b) => b.score - a.score);

    console.log(
      `[Test-Generator] Template ranking for "${sourceFile}" — top 3: ` +
        ranked
          .slice(0, 3)
          .map((r) => `${r.file} (${r.score})`)
          .join(", ")
    );

    if (ranked.length === 0) {
      return null;
    }

    return { 
      file: ranked[0]!.file, 
      content: ranked[0]!.content 
    };
  } catch (error) {
    console.log(
      `[Test-Generator] Template search failed (non-critical): ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

// ======================================================
// BUILD TARGETS FROM PRIORITIZED TESTS
// ======================================================

/**
 * Repair context for a failed test — sent to LLM to fix the issue
 */
export interface TestRepairRequest {
  failedTestCode: string;
  viestError: string;
  targetFunctionName: string;
  sourceFileContent: string;
  testFileName: string;
  attemptNumber: number;
  maxAttempts: number;
}

/**
 * Build a repair prompt for the LLM to fix a failed test
 */
export function buildTestRepairPrompt(request: TestRepairRequest): string {
  return `
## Test Repair Request

The following generated test failed during execution. Your task is to repair it.

### Attempt ${request.attemptNumber}/${request.maxAttempts}

### Failed Test Code
\`\`\`typescript
${request.failedTestCode}
\`\`\`

### Vitest Error
\`\`\`
${request.viestError}
\`\`\`

### Target Function Being Tested
\`\`\`typescript
${request.sourceFileContent}
\`\`\`

### Test File Name
${request.testFileName}

### Your Task
Fix the test code to resolve the error.

**Rules:**
1. Do NOT modify the production source code
2. Fix only the test code
3. Preserve all required imports and exports
4. Identify the root cause of the error and fix it
5. Do NOT mock @calcom/prisma/enums - preserve all enum exports
6. The test MUST call the target function and verify actual behavior
7. Return ONLY the corrected test code in a TypeScript code block

**If the error is about a missing export:**
- Check if you're mocking the entire module
- Use partial mocks with importOriginal() if needed
- Preserve all existing exports

**If the error is about undefined symbols:**
- Add missing imports
- Check the production file for the correct import paths
- Verify mock return values match expected types

Return the fixed test code:
`;
}

/**
 * Turns prioritized test results + LLMContext into concrete generation
 * targets. Each target is one changed symbol referenced by a prioritized
 * test that has at least one verified (Tier-1) coverage gap.
 *
 * Symbols with zero coverageGaps are skipped entirely — either they're
 * fully covered, or (currently) they only have Tier-2 unverified signals,
 * which we deliberately do not generate against yet.
 *
 * IMPORTANT: for each changed symbol we no longer trust "whichever
 * candidate test the prioritizer happened to rank first" as the file to
 * extend. `context.candidateTests` can contain several TestMatch entries
 * for the same source file (e.g. both a same-directory guess and a real
 * symbol-usage match). We instead resolve a single best target test file
 * per source file via resolveTargetTestFile(), using relationship strength
 * (symbol-usage > import > same-name > same-directory > locale-import >
 * dependency). If nothing matched at all, the target is flagged
 * `isNewTestFile: true` and a fresh co-located test file will be created
 * for it rather than falling back to some other file.
 *
 * Returns both the targets (for generation) and the full gap analyses
 * (for audit/reporting).
 */
export async function buildGenerationTargets(
  prioritized: PrioritizedTest[],
  context: LLMContext,
  llmClient: LLMClient,
  rawDiff: string,
  repositoryRoot: string,
  options: { topN?: number } = {}
): Promise<GenerationTargetingResult> {
  const topN = options.topN ?? prioritized.length;
  const chosenTestFiles = new Set(
    prioritized.slice(0, topN).map((test) => test.testFile)
  );

  const targets: TestGenerationTarget[] = [];
  const allGapAnalyses: TestGapAnalysis[] = [];
  // Dedup by symbol name — several candidate tests could all relate to the
  // same changed symbol; we only ever build one target for it.
  const seenSymbols = new Set<string>();

  // A changed symbol is "in scope" if:
  // 1. (Preferred) At least one of the top-N prioritized test files has a real relationship to its file, OR
  // 2. (Fallback) If there are no prioritized tests, all changed symbols are in scope
  //    (we'll generate tests directly for them)
  const relevantSymbols = context.changedSymbols.filter((symbol) => {
    // If we have prioritized tests, require a match
    if (chosenTestFiles.size > 0) {
      return context.candidateTests.some(
        (candidate) =>
          candidate.changedFile === symbol.file &&
          chosenTestFiles.has(candidate.testFile)
      );
    }
    // If we have NO prioritized tests, all changed symbols are fair game
    return true;
  });

  for (const symbol of relevantSymbols) {
    if (seenSymbols.has(symbol.name)) {
      console.log(
        `[Test-Generator] Skipping "${symbol.name}" — already built a target for this symbol`
      );
      continue;
    }

    // Validate that the source file actually exists
    const sourceFileAbsolute = path.isAbsolute(symbol.file)
      ? symbol.file
      : path.resolve(repositoryRoot, symbol.file);

    if (!fs.existsSync(sourceFileAbsolute)) {
      console.log(
        `[Test-Generator] Skipping "${symbol.name}" — source file does not exist: ${sourceFileAbsolute}`
      );
      continue;
    }

    // CRITICAL: Validate that the source file doesn't have unresolved imports
    // If the source file imports from non-existent paths (like ~/data-table/components),
    // any generated tests will fail at import time, before a single test runs.
    const sourceContent = fs.readFileSync(sourceFileAbsolute, "utf-8");
    const unresolvedImports = checkForUnresolvedImports(sourceContent, repositoryRoot);
    if (unresolvedImports.length > 0) {
      console.log(
        `[Test-Generator] ⚠️ SKIPPING "${symbol.name}" — source file has unresolved imports that will break test compilation:`
      );
      unresolvedImports.forEach(imp => {
        console.log(`[Test-Generator]    - "${imp}"`);
      });
      console.log(`[Test-Generator]    Tests cannot be generated for files with broken imports.`);
      continue;
    }

    // CRITICAL: Validate that the symbol is actually exported from the source file
    // If we're trying to import a symbol that isn't exported, the test will fail with ReferenceError
    const isExported = checkSymbolExported(sourceContent, symbol.name);
    if (!isExported) {
      console.log(
        `[Test-Generator] ⚠️ SKIPPING "${symbol.name}" — symbol is not exported from source file. Tests cannot import it.`
      );
      continue;
    }

    const matchesForFile = context.candidateTests.filter(
      (candidate) => candidate.changedFile === symbol.file
    ) as TestMatch[];

    const resolution = resolveTargetTestFile(symbol.file, matchesForFile);

    const gapInputs = buildGapAnalysisInputsFromAnalysis(
      [symbol],
      rawDiff,
      context
    );
    const gapAnalyses = await analyzeCoverageGapsBatch(gapInputs, llmClient);

    // Keep all gap analyses for reporting (regardless of whether gaps were found)
    allGapAnalyses.push(...gapAnalyses);

    const gapAnalysis = gapAnalyses.find((g) => g.targetSymbol === symbol.name);

    if (!gapAnalysis || gapAnalysis.coverageGaps.length === 0) {
      console.log(
        `[Test-Generator] Skipping "${symbol.name}" — ` +
          `${!gapAnalysis ? "no gap analysis found" : "no verified coverage gaps (fully covered, or only unverified Tier-2 signals present)"}`
      );
      continue;
    }

    seenSymbols.add(symbol.name);

    console.log(
      `[Test-Generator] Creating target for "${symbol.name}" with ${gapAnalysis.coverageGaps.length} verified gap(s) — ` +
        (resolution.isNewFile
          ? `no related test file found, will create "${resolution.testFile}"`
          : `extending "${resolution.testFile}" (${resolution.match?.relationship}, confidence ${resolution.match?.confidence})`)
    );

    const sourceCodeExcerpt = context.sourceCode.find((s) => s.file === symbol.file);
    const testFramework = inferFrameworkFromFileName(resolution.testFile);
    const sourceIsComponent = isComponentFile(symbol.file);
    
    // For new test files, find a template test file from the same framework to use as a style guide
    let testCodeExcerpt: { file: string; content: string } | undefined;
    let templateFile: string | undefined;
    let isTemplate = false;
    
    if (resolution.isNewFile) {
      const inCommitCandidates = context.testCode.filter(
        (t) => inferFrameworkFromFileName(t.file) === testFramework
      );

      let bestInCommit: {
        file: string;
        content: string;
        score: number;
      } | null = null;
      for (const c of inCommitCandidates) {
        const score = scoreTemplateCandidate(c, symbol.file, sourceIsComponent);
        if (!bestInCommit || score > bestInCommit.score) {
          bestInCommit = { ...c, score };
        }
      }

      // Don't accept a mediocre in-commit match just because it's nearby in
      // the diff — this is exactly how zod-utils.test.ts won before.
      const MIN_ACCEPTABLE_SCORE = sourceIsComponent ? 40 : 20;

      if (bestInCommit && bestInCommit.score >= MIN_ACCEPTABLE_SCORE) {
        testCodeExcerpt = { file: bestInCommit.file, content: bestInCommit.content };
        templateFile = bestInCommit.file;
        isTemplate = true;
        console.log(
          `[Test-Generator] Using in-commit template: ${templateFile} (score ${bestInCommit.score})`
        );
      } else {
        console.log(
          `[Test-Generator] No good in-commit template for "${testFramework}" ` +
            `(best score ${bestInCommit?.score ?? "n/a"}, need ${MIN_ACCEPTABLE_SCORE}). Searching repository...`
        );
        const repositoryTemplate = await findTemplateTestFile(
          repositoryRoot,
          testFramework,
          symbol.file,
          sourceIsComponent
        );

        if (repositoryTemplate) {
          testCodeExcerpt = repositoryTemplate;
          templateFile = repositoryTemplate.file;
          isTemplate = true;
          console.log(`[Test-Generator] Found repository template test file: ${templateFile}`);
        } else {
          console.log(
            `[Test-Generator] No template found for "${testFramework}". Generating from scratch.`
          );
        }
      }
    } else {
      testCodeExcerpt = context.testCode.find((t) => t.file === resolution.testFile);
    }

    const relatedPrioritizedEvidence = prioritized
      .filter((p) => matchesForFile.some((m) => m.testFile === p.testFile))
      .flatMap((p) => p.evidence);

    targets.push({
      symbol: symbol.name,
      sourceFile: symbol.file,
      testFile: resolution.testFile,
      changedCode: sourceCodeExcerpt?.content ?? "",
      sourceFileContent: sourceCodeExcerpt?.content ?? "",
      commitMessage: context.commit.message,
      existingTestFile: resolution.testFile,
      existingTestCode: testCodeExcerpt?.content ?? "",
      existingTestCodeIsTemplate: isTemplate,
      // NOTE: TestGenerationTarget in generator-types.ts needs this field
      // added — it's what test-runner.ts uses to decide whether to
      // scaffold a brand-new file or extend an existing one.
      isNewTestFile: resolution.isNewFile,
      framework: testFramework,
      notes: [
        `Symbol ${symbol.changeType}`,
        resolution.isNewFile
          ? templateFile
            ? `No related test file found — using ${templateFile} as style template`
            : "No related test file found for this source file — a new test file will be created from scratch"
          : `Selected as the single best related test file via "${resolution.match?.relationship}" relationship`,
        ...relatedPrioritizedEvidence,
      ],
      coverageGaps: gapAnalysis.coverageGaps,
    } as TestGenerationTarget);
  }

  return { targets, gapAnalyses: allGapAnalyses };
}

function inferFrameworkFromFileName(testFile: string): string {
  if (testFile.includes("playwright") || /\.e2e\./.test(testFile)) {
    return "playwright";
  }
  if (testFile.includes("jest")) {
    return "jest";
  }
  if (testFile.includes("vitest")) {
    return "vitest";
  }
  if (testFile.includes("mocha")) {
    return "mocha";
  }
  return "vitest"; // default
}

/**
 * Check if a source file has imports that would fail at runtime/compile time.
 * Returns a list of unresolved import paths.
 */
function checkForUnresolvedImports(sourceContent: string, repositoryRoot: string): string[] {
  const unresolvedImports: string[] = [];
  
  // Match all import statements
  const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*)\s+from\s+['"`]([^'"`]+)['"`]/g;
  let match;
  
  while ((match = importRegex.exec(sourceContent)) !== null) {
    const importPath = match[1];
    
    if (!importPath) continue;
    
    // Skip node_modules and @-scoped packages (these are assumed to be installed)
    if (importPath.startsWith("@") || importPath.includes("node_modules")) {
      continue;
    }
    
    // Check for path aliases that might not resolve
    // Common patterns: ~/, ./, ../, or bare package names without @ scope
    if (importPath.startsWith("~")) {
      // Alias import - would need tsconfig/vite config to resolve, assume problematic
      unresolvedImports.push(importPath);
    } else if (!importPath.startsWith(".") && !importPath.startsWith("/")) {
      // Bare package name without @ scope - might be missing
      // Skip common patterns that are known to work
      if (!importPath.match(/^(react|react-dom|next|@calcom|@coss|vitest|@testing-library)/)) {
        unresolvedImports.push(importPath);
      }
    }
  }
  
  return unresolvedImports;
}

/**
 * Check if a symbol is exported from the source file.
 * Looks for: export function/const/class Name, or export { Name }
 */
function checkSymbolExported(sourceContent: string, symbolName: string): boolean {
  // Check for direct export: export function Name, export const Name, export class Name
  const directExportRegex = new RegExp(`\\bexport\\s+(?:function|const|class|default)\\s+${symbolName}\\b`, "g");
  if (directExportRegex.test(sourceContent)) {
    return true;
  }
  
  // Check for export statement: export { Name, ... }
  const namedExportRegex = new RegExp(`\\bexport\\s*\\{[^}]*\\b${symbolName}\\b[^}]*\\}`, "g");
  if (namedExportRegex.test(sourceContent)) {
    return true;
  }
  
  return false;
}

// ======================================================
// GENERATE TESTS
// ======================================================

export async function generateTests(
  targets: TestGenerationTarget[],
  llmClient: LLMClient
): Promise<TestGenerationBatchResult> {
  if (targets.length === 0) {
    console.log("[Test-Generator] No generation targets, skipping LLM calls");
    return { results: [] };
  }

  console.log(`[Test-Generator] Generating tests for ${targets.length} target(s)`);

  const results: TestGenerationResult[] = [];

  for (const target of targets) {
    try {
      const result = await generateTestsForTarget(target, llmClient);
      results.push(result);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `[Test-Generator] ⚠️ Generation failed for "${target.symbol}" (${target.sourceFile})`
      );
      console.error(`[Test-Generator] Error: ${errorMsg}`);

      results.push({
        testFile: target.existingTestFile ?? inferTestFileName(target),
        targetSymbol: target.symbol,
        generatedTests: [],
        error: errorMsg,
      });
    }
  }

  return { results };
}

async function generateTestsForTarget(
  target: TestGenerationTarget,
  llmClient: LLMClient
): Promise<TestGenerationResult> {
  const userPrompt = buildTestGeneratorUserPrompt(target);
  console.log(
    `[Test-Generator] Requesting test cases for "${target.symbol}" (${userPrompt.length} chars prompt, ${target.coverageGaps.length} gap(s) to fill)`
  );

  const raw = await llmClient.generateJSON<RawGenerationResponse>(
    TEST_GENERATOR_SYSTEM_PROMPT,
    userPrompt
  );

  const generatedTests = validateAndNormalize(raw, target);

  console.log(
    `[Test-Generator] ✓ Got ${generatedTests.length}/${target.coverageGaps.length} verified test case(s) for "${target.symbol}"`
  );

  return {
    testFile: target.existingTestFile ?? inferTestFileName(target),
    targetSymbol: target.symbol,
    generatedTests,
  };
}

/**
 * Validate that the generated test actually references the target function.
 * Rejects tests that don't use the function being tested.
 */
function validateTargetFunctionUsed(
  testCode: string,
  targetFunctionName: string
): boolean {
  // Check if the target function name appears in the test code
  // This ensures we're testing the actual production function, not just mocking logic
  return testCode.includes(targetFunctionName);
}

// ======================================================
// VALIDATION
// ======================================================
//
// The LLM is trusted to write test *code*, not to decide what counts as
// a valid gap. Anything whose addressesGap doesn't exactly match a gap
// we actually identified gets dropped — this is the enforcement point
// that stops scope creep (the model deciding on its own that some other
// behavior "should" be tested too).

function validateAndNormalize(
  raw: RawGenerationResponse,
  target: TestGenerationTarget
): GeneratedTestCase[] {
  const validGapLabels = new Set(target.coverageGaps.map((g) => g.label));

  const rawCases = raw.testCases ?? [];
  const valid: GeneratedTestCase[] = [];
  const seenGaps = new Set<string>();
  const seenTestCode = new Set<string>(); // Track actual test code to prevent duplicates

  for (const testCase of rawCases) {
    if (
      !testCase.testCode ||
      typeof testCase.testCode !== "string" ||
      !testCase.testCode.trim()
    ) {
      continue;
    }

    if (!looksLikeTestCode(testCase.testCode)) {
      console.warn(
        `[Test-Generator] Dropping suspicious test case for "${target.symbol}" — doesn't look like test code`
      );
      continue;
    }

    // NEW VALIDATION: Check if the test actually calls the target function
    if (!validateTargetFunctionUsed(testCase.testCode, target.symbol)) {
      console.warn(
        `[Test-Generator] ⚠️ REJECTED: Test for "${target.symbol}" does not call the target function. ` +
        `Generated test must directly invoke ${target.symbol}(...), not just mock it or test surrounding logic.`
      );
      continue;
    }

    const gapLabel = testCase.addressesGap?.trim();
    if (!gapLabel || !validGapLabels.has(gapLabel)) {
      console.warn(
        `[Test-Generator] Dropping test for "${target.symbol}" — ` +
          `addressesGap "${gapLabel}" doesn't match any identified gap. ` +
          `Model likely expanded scope beyond the verified gap list. Valid gaps: ${Array.from(
            validGapLabels
          ).join(" | ")}`
      );
      continue;
    }

    if (seenGaps.has(gapLabel)) {
      console.log(`[Test-Generator] Skipping duplicate test for gap "${gapLabel}"`);
      continue;
    }

    // NEW: Check if the actual test code is already in the batch
    // Normalize the code to detect near-duplicates (whitespace variations)
    const normalizedCode = testCase.testCode
      .replace(/\s+/g, " ")
      .trim();
    
    if (seenTestCode.has(normalizedCode)) {
      console.warn(
        `[Test-Generator] ⚠️ DUPLICATE CODE: Dropping test for gap "${gapLabel}" ` +
        `(target "${target.symbol}") — identical code already in this batch. ` +
        `The LLM likely repeated itself. This prevents duplicate declarations.`
      );
      continue;
    }
    
    seenTestCode.add(normalizedCode);
    seenGaps.add(gapLabel);

    valid.push({
      name: testCase.name?.trim() || `test for ${gapLabel}`,
      purpose: testCase.purpose?.trim() || "No purpose provided by the model.",
      targetSymbol: testCase.targetSymbol?.trim() || target.symbol,
      testCode: testCase.testCode.trim(),
      addressesGap: gapLabel,
    });

    if (valid.length >= MAX_GENERATED_TESTS_PER_TARGET) {
      break;
    }
  }

  return valid;
}

function looksLikeTestCode(code: string): boolean {
  return /\b(it|test|describe)\s*\(/.test(code);
}

function inferTestFileName(target: TestGenerationTarget): string {
  if (target.existingTestFile) return target.existingTestFile;

  const parsed = target.sourceFile.replace(/\.(ts|tsx|js|jsx)$/, "");
  return `${parsed}.test.ts`;
}