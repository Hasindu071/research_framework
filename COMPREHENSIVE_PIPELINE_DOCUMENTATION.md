# LLM-Powered Intelligent Test Prioritization & Generation Framework

## Project Overview

This is a research framework that implements an intelligent test-prioritization and test-generation pipeline for code repositories. The system analyzes git commits to identify changed code, uses static analysis to find related tests, leverages an LLM (Gemini) to intelligently prioritize which tests are most likely to catch regressions, generates new test cases for uncovered scenarios, and executes tests in priority order.

**Architecture**: TypeScript/Node.js backend with Express API, MongoDB persistence, and integration with the Google Gemini LLM API.

---

## Table of Contents
1. [High-Level Pipeline Overview](#high-level-pipeline-overview)
2. [Detailed Pipeline Architecture Diagram](#detailed-pipeline-architecture-diagram)
3. [Data Flow Diagram](#data-flow-diagram)
4. [Core Stages of the Pipeline](#core-stages-of-the-pipeline)
5. [Test Discovery Heuristics](#test-discovery-heuristics)
6. [Active vs Inactive Modules](#active-vs-inactive-modules)
7. [Commit Analysis & Identification](#commit-analysis--identification)
8. [Commit Diff Processing](#commit-diff-processing)
9. [Gap Analysis](#gap-analysis)
10. [LLM Prompts & Integration](#llm-prompts--integration)
11. [Test Prioritization](#test-prioritization)
12. [Test Generation](#test-generation)
13. [Test Execution & Results](#test-execution--results)
14. [API Endpoints](#api-endpoints)
15. [Configuration & Environment](#configuration--environment)

---

## High-Level Pipeline Overview

```
╔════════════════════════════════════════════════════════════════════════════════╗
║                   FULL END-TO-END PIPELINE ARCHITECTURE                       ║
╚════════════════════════════════════════════════════════════════════════════════╝

                          ┌────────────────────────┐
                          │  INPUT                 │
                          │ ├─ Repository Path     │
                          │ ├─ Commit Hash         │
                          │ └─ Repository Name     │
                          └────────────┬───────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │  STAGE 1: COMMIT ANALYSIS           │
                    │  analyzer.ts                        │
                    ├──────────────────────────────────── │
                    │  ✓ Extract commit metadata          │
                    │  ✓ Parse git diff                   │
                    │  ✓ Analyze symbol changes           │
                    │  └─ Output: CommitAnalysis          │
                    └──────────────────┬──────────────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │  STAGE 2: TEST DISCOVERY            │
                    │  test-analyzer.ts                   │
                    ├──────────────────────────────────── │
                    │  ✓ Find related tests               │
                    │  ✓ Extract symbol usage             │
                    │  ✓ Calculate confidence scores      │
                    │  └─ Output: TestMatch[]             │
                    └──────────────────┬──────────────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │  STAGE 3: CONTEXT BUILDING          │
                    │  context-builder.ts                 │
                    ├──────────────────────────────────── │
                    │  ✓ Structure LLM context            │
                    │  ✓ Rank candidate tests             │
                    │  ✓ Include code excerpts            │
                    │  └─ Output: LLMContext              │
                    └──────────────────┬──────────────────┘
                                       │
                  ┌────────────────────┼────────────────────┐
                  │                    │                    │
         ┌────────▼─────────┐  ┌──────▼─────────┐  ┌──────▼──────────┐
         │ STAGE 4:          │  │ STAGE 5:       │  │ STAGE 6:        │
         │ TEST              │  │ DEPENDENCY     │  │ GAP ANALYSIS    │
         │ PRIORITIZATION    │  │ ANALYSIS       │  │                 │
         │                   │  │                │  │ test-gap-       │
         │ test-prioritizer  │  │ dependencyAn   │  │ analyzer.ts     │
         │ llm-client        │  │ alyzer.ts      │  │                 │
         │ prompts           │  │                │  │ ✓ Extract       │
         │                   │  │ ✓ Parse        │  │   behaviors     │
         │ ✓ Call Gemini     │  │   package.json │  │ ✓ Find gaps     │
         │ ✓ Rank tests      │  │ ✓ Parse yarn.  │  │ ✓ Generate      │
         │ ✓ Validate        │  │   lock         │  │   assertions    │
         │                   │  │ ✓ Detect       │  │                 │
         │ Output:           │  │   changes      │  │ Output:         │
         │ PrioritizedTest[] │  │                │  │ TestGapAnalysis │
         └────────┬──────────┘  └────────┬───────┘  │ []              │
                  │                      │          └────────┬────────┘
                  │                      │                   │
                  └──────────────────────┼───────────────────┘
                                        │
                    ┌───────────────────▼─────────────────┐
                    │ STAGE 7: GENERATION TARGET BUILDING │
                    │ test-generator.ts                   │
                    ├──────────────────────────────────── │
                    │ ✓ Convert gaps to targets           │
                    │ ✓ Find template test files          │
                    │ ✓ Prepare LLM prompts               │
                    │ └─ Output: TestGenerationTarget[]   │
                    └───────────────────┬─────────────────┘
                                        │
                    ┌───────────────────▼─────────────────┐
                    │ STAGE 8: TEST GENERATION            │
                    │ test-generator.ts + LLM             │
                    ├──────────────────────────────────── │
                    │ ✓ Call Gemini API                   │
                    │ ✓ Generate test code                │
                    │ ✓ Validate syntax & completeness    │
                    │ ✓ Auto-repair failures (up to 3x)   │
                    │ └─ Output: GenerationResult[]       │
                    └───────────────────┬─────────────────┘
                                        │
                    ┌───────────────────▼──────────────────────────────┐
                    │ STAGE 9: TEST EXECUTION                          │
                    │ test-runner.ts + framework-resolver.ts           │
                    ├────────────────────────────────────────────────  │
                    │ ✓ Detect framework (Vitest/Jest/Playwright)     │
                    │ ✓ Execute prioritized tests sequentially         │
                    │ ✓ Execute generated tests                        │
                    │ ✓ Optional: Repair failing tests                 │
                    │ └─ Output: TestExecutionResult[]                 │
                    └───────────────────┬──────────────────────────────┘
                                        │
                    ┌───────────────────▼──────────────────────────────┐
                    │ STAGE 10: RESULTS AGGREGATION & PERSISTENCE      │
                    │ app.ts + mongodb-service.ts                      │
                    ├────────────────────────────────────────────────  │
                    │ ✓ Aggregate all results                          │
                    │ ✓ Calculate metrics                              │
                    │ ✓ Save to MongoDB                                │
                    │ └─ Output: JSON Response                         │
                    └───────────────────┬──────────────────────────────┘
                                        │
                                   ┌────▼────┐
                                   │  API    │
                                   │Response │
                                   └─────────┘
```

---

## Detailed Pipeline Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    COMPLETE DATA TRANSFORMATION FLOW                         │
└──────────────────────────────────────────────────────────────────────────────┘


INPUT DATA SOURCES                  PROCESSING STAGES                 OUTPUT DATA

┌─────────────────┐                                               ┌──────────────┐
│  .git Directory │                                               │  Prioritized │
│  └─ Commit Data │───┐                                           │  Tests List  │
└─────────────────┘   │     ┌──────────────────────────────┐     └──────────────┘
                      │     │  STAGE 1-3                   │          ▲
┌─────────────────┐   │────▶│  Static Analysis            │          │
│  Source Files   │   │     │  └─ Commits, Tests, Context │         (Priority)
│  └─ .ts, .tsx   │───┤     │                              │
└─────────────────┘   │     └─────────────┬────────────────┘          ▲
                      │                  │                           │
┌─────────────────┐   │     ┌──────────────▼────────────────┐    ┌───────────────┐
│  Test Files     │───┼────▶│  STAGE 4-5                   │   │  Generated    │
│  └─ .test.ts    │   │     │  LLM Prioritization &        │───│  Tests Code   │
└─────────────────┘   │     │  Dependency Analysis         │   └───────────────┘
                      │     │                              │         ▲
┌─────────────────┐   │     └─────────────┬────────────────┘         │
│ package.json    │───┘     ┌──────────────▼────────────────┐         │
│ yarn.lock       │────────▶│  STAGE 6-7                   │   (New Tests)
│ .env            │         │  Gap Analysis & Generation    │
└─────────────────┘         │  Target Building             │
                            └─────────────┬────────────────┘
                                          │
                                          │
                            ┌──────────────▼────────────────┐
                            │  STAGE 8                       │
                            │  LLM Test Generation          │
                            │  └─ Generates new test code   │
                            └─────────────┬────────────────┘
                                          │
                                          │
                            ┌──────────────▼────────────────┐
                            │  STAGE 9                       │
                            │  Test Execution              │
                            │  └─ Runs all tests           │
                            └─────────────┬────────────────┘
                                          │
                                          │
                            ┌──────────────▼────────────────┐
                            │  STAGE 10                      │
                            │  Results Aggregation          │
                            │  └─ Combine all data          │
                            └─────────────┬────────────────┘
                                          │
                                          ▼
                            ┌──────────────────────────┐
                            │  MongoDB Database        │
                            │  (Persistence)          │
                            └──────────────────────────┘
```

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        DATA TRANSFORMATION PIPELINE                         │
└─────────────────────────────────────────────────────────────────────────────┘


PIPELINE DATA OBJECTS & TRANSFORMATIONS:

  1. RAW INPUT                          2. COMMIT ANALYSIS
     ┌─────────────────────┐              ┌────────────────────┐
     │ Repository Path     │              │ CommitAnalysis     │
     │ Commit Hash         │   STAGE 1    ├────────────────────┤
     │ Repository Name     │────────────▶ │ commit: {          │
     └─────────────────────┘              │   hash, message    │
                                          │   author, date     │
                                          │ }                  │
                                          │ changes: []        │
                                          │ symbolChanges: []  │
                                          │ rawDiff: string    │
                                          └────────────────────┘
                                                   │
                                                   │ STAGE 2
                                                   ▼
     ┌────────────────────────────────┐  ┌──────────────────────┐
     │ Test Discovery Results         │  │ TestAnalysisResult   │
     │                                │  ├──────────────────────┤
     │ Each test file is ranked by    │  │ relatedTests: {      │
     │ confidence score based on:     │  │   testFile: string   │
     │ • Direct symbol usage    (95%)│  │   changedFile        │
     │ • Same directory         (85%)│  │   relationship       │
     │ • Name match             (75%)│  │   confidence         │
     │ • Dependency-related     (80%)│  │   symbols?: []       │
     │                                │  │ }[]                  │
     └────────────────────────────────┘  └──────────────────────┘
                                                   │
                                                   │ STAGE 3
                                                   ▼
     ┌────────────────────────────────┐  ┌──────────────────────┐
     │ LLM Context Prepared           │  │ LLMContext           │
     │                                │  ├──────────────────────┤
     │ • Ranked candidate tests       │  │ commit: {}           │
     │ • Top 15 tests (by confidence) │  │ changedFiles: []     │
     │ • Changed source code excerpts │  │ changedSymbols: []   │
     │   (6000 chars max each)        │  │ candidateTests: []   │
     │ • Test code excerpts           │  │ sourceCode: []       │
     │   (6000 chars max each)        │  │ testCode: []         │
     │ • Changed symbols list         │  │                      │
     │ • Dependency changes           │  │ Ready for LLM!       │
     └────────────────────────────────┘  └──────────────────────┘
                                                   │
                    ┌──────────────────────────────┼─────────────────┐
                    │                              │                 │
         STAGE 4A   │              STAGE 5        │          STAGE 6│
                    ▼              PARALLEL       │                 ▼
     ┌────────────────────────────┐       ▼       │    ┌──────────────────────┐
     │ LLM Prioritization Output  │    ┌─────────────┐  │ Gap Analysis Results │
     ├────────────────────────────┤    │ Dependency  │  ├──────────────────────┤
     │ PrioritizedTest[] {        │    │ Changes:    │  │ TestGapAnalysis[] {  │
     │   testFile                 │    │             │  │   symbol             │
     │   priority (1,2,3...)      │    │ • Added     │  │   sourceFile         │
     │   score (0.0-1.0)          │    │ • Removed   │  │   changedBehaviors[] │
     │   reason (from LLM)        │    │ • Upgraded  │  │   coverageGaps[] {   │
     │   evidence []              │    │ • Downgrade │  │     id               │
     │ }[]                        │    │ • Changed   │  │     description      │
     │                            │    │             │  │     testableAssertion│
     │ Sorted by priority!        │    └─────────────┘  │   }                  │
     └────────────────────────────┘                     │ }[]                  │
                    │                                    │                      │
                    │                                    └──────────────────────┘
                    │                                              │
                    └──────────────────┬───────────────────────────┘
                                       │
                           STAGE 7     ▼
                    ┌──────────────────────────────┐
                    │ Generation Targets Built     │
                    ├──────────────────────────────┤
                    │ TestGenerationTarget[] {     │
                    │   symbol                     │
                    │   sourceFile                 │
                    │   testFile                   │
                    │   isNewTestFile              │
                    │   templateTestFile           │
                    │   templateContent            │
                    │ }[]                          │
                    └─────────────────┬────────────┘
                                      │
                            STAGE 8   ▼
                    ┌──────────────────────────────┐
                    │ LLM Generated Tests          │
                    ├──────────────────────────────┤
                    │ GenerationResult[] {         │
                    │   targetSymbol               │
                    │   testFile                   │
                    │   generatedTests[] {         │
                    │     name                     │
                    │     testCode                 │
                    │   }                          │
                    │ }[]                          │
                    └─────────────────┬────────────┘
                                      │
                            STAGE 9   ▼
                    ┌──────────────────────────────┐
                    │ Test Execution Results       │
                    ├──────────────────────────────┤
                    │ TestExecutionResult[] {      │
                    │   testFile                   │
                    │   framework                  │
                    │   status (passed/failed/...) │
                    │   duration                   │
                    │   exitCode                   │
                    │   stdout/stderr              │
                    │ }[]                          │
                    └─────────────────┬────────────┘
                                      │
                            STAGE 10  ▼
                    ┌──────────────────────────────┐
                    │ Final Response (JSON)        │
                    ├──────────────────────────────┤
                    │ {                            │
                    │   success: boolean           │
                    │   commit: {}                 │
                    │   analysis: {}               │
                    │   prioritization: {}         │
                    │   gapAnalysis: {}            │
                    │   generation: {}             │
                    │   existingTestExecution: {}  │
                    │   generatedTestExecution: {} │
                    │   mongoId?: string           │
                    │ }                            │
                    └──────────────────────────────┘
```

---

## Test Discovery Heuristics

```
┌──────────────────────────────────────────────────────────────────────────────┐
│              TEST DISCOVERY MATCHING RULES (Heuristics)                      │
└──────────────────────────────────────────────────────────────────────────────┘


CHANGED FILE: src/utils/parse.ts
       │
       │
       ├─────────────────────────────────────────────────────────────────────┐
       │                    APPLY MATCHING RULES                             │
       │                                                                     │
       │  ┌──────────────────────────────┐                                   │
       │  │ RULE 1: SAME DIRECTORY       │                                   │
       │  │ Confidence: 0.85             │                                   │
       │  │ ───────────────────────────  │                                   │
       │  │ src/utils/parse.ts           │                                   │
       │  │        │                     │                                   │
       │  │        ├─▶ src/utils/parse.test.ts          ✓ MATCH            │
       │  │        ├─▶ src/utils/parse.spec.ts          ✓ MATCH            │
       │  │        └─▶ src/utils/parse.integration.ts   ✓ MATCH            │
       │  │                                                                 │
       │  └──────────────────────────────┘                                   │
       │                                                                     │
       │  ┌──────────────────────────────┐                                   │
       │  │ RULE 2: BASE NAME MATCHING   │                                   │
       │  │ Confidence: 0.75             │                                   │
       │  │ ───────────────────────────  │                                   │
       │  │ parse.ts                     │                                   │
       │  │   │                          │                                   │
       │  │   ├─▶ parse.test.ts          ✓ MATCH                           │
       │  │   ├─▶ parse-test.ts          ✓ MATCH                           │
       │  │   ├─▶ parse.integration.ts   ✓ MATCH                           │
       │  │   └─▶ parseUtils.test.ts     ✗ NO MATCH (different name)       │
       │  │                                                                 │
       │  └──────────────────────────────┘                                   │
       │                                                                     │
       │  ┌──────────────────────────────┐                                   │
       │  │ RULE 3: SYMBOL USAGE         │                                   │
       │  │ Confidence: 0.95             │                                   │
       │  │ ───────────────────────────  │                                   │
       │  │ Does test file IMPORT or     │                                   │
       │  │ MOCK symbols from changed    │                                   │
       │  │ source file?                 │                                   │
       │  │                              │                                   │
       │  │ import { parseConfig }       │                                   │
       │  │   from "../utils/parse"      │                                   │
       │  │                    ✓ MATCH (highest confidence)                 │
       │  │                                                                 │
       │  └──────────────────────────────┘                                   │
       │                                                                     │
       │  ┌──────────────────────────────┐                                   │
       │  │ RULE 4 (Special): DEPENDENCY │                                   │
       │  │ Confidence: 0.80             │                                   │
       │  │ ───────────────────────────  │                                   │
       │  │ Only applies when package.   │                                   │
       │  │ json or yarn.lock changes:   │                                   │
       │  │                              │                                   │
       │  │ package.json changed ─────┐  │                                   │
       │  │                           │  │                                   │
       │  │ Find dependency: lodash ──┼─▶├─▶ Source files importing        │
       │  │                           │  │   lodash                        │
       │  │                           │  │       │                         │
       │  │                           └──┼───────├─▶ tests for those       │
       │  │                              │       │   source files         │
       │  │                              │       ✓ MATCH                   │
       │  │                              │                                 │
       │  └──────────────────────────────┘                                   │
       │                                                                     │
       │  ┌──────────────────────────────┐                                   │
       │  │ DEDUPLICATION                │                                   │
       │  │ ───────────────────────────  │                                   │
       │  │ If same test matches via     │                                   │
       │  │ multiple rules, keep match   │                                   │
       │  │ with HIGHEST confidence      │                                   │
       │  │                              │                                   │
       │  │ E.g.:                        │                                   │
       │  │ parse.test.ts matched via:   │                                   │
       │  │   - Rule 1 (0.85)           │                                   │
       │  │   - Rule 2 (0.75)           │                                   │
       │  │   - Rule 3 (0.95) ◄── WINNER│                                   │
       │  │ Final confidence: 0.95       │                                   │
       │  │                              │                                   │
       │  └──────────────────────────────┘                                   │
       │                                                                     │
       └─────────────────────────────────────────────────────────────────────┘
              │
              ▼
    ┌──────────────────────┐
    │ CANDIDATE TESTS      │
    │ (Ranked by conf.)    │
    ├──────────────────────┤
    │ 1. parse.test.ts (0.95) │
    │ 2. parse.spec.ts (0.85) │
    │ 3. parse.integration.ts (0.75)
    │ ... more tests ...   │
    └──────────────────────┘


SPECIAL CASE: TESTS ARE NOT APPLIED TO CHANGED TEST FILES

If parse.test.ts itself changes:
  ✗ Does NOT apply Rule 1 (no "tests for the test")
  ✗ Does NOT apply Rule 2/3 (no circular logic)
  ✓ But IS included in results as an important changed test
```

---

## Core Stages of the Pipeline

### Stage 1: Commit Analysis (`analyzer.ts`)

**Purpose**: Extract what changed in the commit.

**Key Functions**:
- `analyzeCommit(repositoryPath: string, commitHash: string)` - Main entry point
- `parseDiff(rawDiff: string)` - Parse git diff into structured format
- `detectModifiedSymbols()` - Find which functions/classes were modified
- `detectSymbolRenames()` - Find renamed symbols using AST & diff heuristics

**What It Does**:
1. Runs `git show <commitHash> --stat` to get changed files
2. Runs `git diff <commitHash>~1 <commitHash>` to get full diff
3. Parses diff hunks using regex to extract:
   - Changed files with status (added/modified/deleted/renamed)
   - Changed lines (with context)
   - Binary file markers
4. Uses AST analysis (ts-morph) to detect symbol changes:
   - Function renames (old name → new name)
   - Modified symbols (same name, different implementation)
5. Calls test analyzer to find related tests
6. Returns `CommitAnalysis` object with all metadata

**Output Structure**:
```typescript
interface CommitAnalysis {
  commit: {
    hash: string;
    message: string;
    author: string;
    date: string;
  };
  changes: {
    file: string;
    status: "added" | "modified" | "deleted" | "renamed" | "unknown";
    binary: boolean;
  }[];
  symbolChanges: {
    oldName: string;
    newName: string;
    file: string;
    type: "rename" | "modified";
  }[];
  dependencyChanges: DependencyChange[];
  testAnalysis: {
    relatedTests: TestMatch[];
  };
  rawDiff: string;  // Full git diff for later analysis
}
```

---

### Stage 2: Test Analysis & Discovery (`test-analyzer.ts`)

**Purpose**: Find which existing tests are related to the changed files.

**Key Functions**:
- `analyzeTests(changes, repositoryPath)` - Main entry point
- `findTestsForSourceFile()` - Find tests matching a changed source file
- `extractChangedSymbols()` - Extract symbol usage from test code
- `categorizeFile()` - Categorize file type (code, locale, dependency, unknown)

**What It Does**:

**Case 1: Source File Changes**
1. Scans repository for all test files (files matching `*.test.ts`, `*.spec.ts`, `.test.tsx`, etc.)
2. For each changed source file:
   - Applies categorization: "code", "locale", "dependency", or "unknown"
   - For "code" category: Uses heuristics to find related tests (see Test Discovery Heuristics section)
   - For "locale" category: Special handling for i18n/translation files
   - For "unknown" category: Skipped (no evidence-based matching)
3. Extracts symbols used by each matching test from the test code
4. Returns list of matching tests with confidence scores

**Case 2: Dependency Changes**
1. When `package.json` or `yarn.lock` changes:
   - Extracts which dependencies were added/removed/changed
   - Finds all source files that import those dependencies
   - For each source file: finds tests that test that source file
   - Tags these with "dependency" relationship
2. This creates a chain: `package.json` → `dependency` → `source files` → `tests`

**Deduplication**:
- If same test is discovered through multiple rules, keeps the match with highest confidence
- Removes self-matches (changed test file matching itself)

**Output**: `TestAnalysisResult` with array of `TestMatch` objects:
```typescript
interface TestMatch {
  testFile: string;
  changedFile: string;
  relationship: "symbol-usage" | "same-directory" | "name-match" | "dependency";
  reason?: string;
  confidence: number;  // 0.0-1.0
  symbols?: string[];  // Symbols used by this test
  symbolKinds?: Record<string, ElementKind>;  // Type of each symbol
  changedSymbolsUsed?: string[];  // Which of the changed symbols does this test use?
}
```

---

### Stage 3: Context Building (`context-builder.ts`)

**Purpose**: Prepare structured LLM context from analysis results.

**Key Functions**:
- `buildLLMContext(analysis, repositoryRoot, options)` - Main entry point

**What It Does**:
1. Takes `CommitAnalysis` output from Stage 1
2. Extracts structured information:
   - Changed files list
   - Changed symbols (merges renames + modified symbols detected in tests)
   - Dependency changes
   - Candidate tests (ranked by confidence, max 15 by default)
3. Reads code excerpts:
   - Changed source files (capped at 6000 chars per file)
   - Top 15 candidate test files by confidence
4. Truncation logic:
   - Large files are automatically capped to prevent prompt bloat
   - Tests ranked by confidence, weakest dropped first if over limit
   - Flags which excerpts were truncated in metadata

**Output**: `LLMContext` object ready for LLM prompt:
```typescript
interface LLMContext {
  commit: {
    hash: string;
    message: string;
  };
  changedFiles: ChangedFileSummary[];
  changedSymbols: ChangedSymbolSummary[];
  dependencyChanges: DependencyChangeSummary[];
  candidateTests: CandidateTestSummary[];
  sourceCode: CodeExcerpt[];
  testCode: CodeExcerpt[];
}
```

---

### Stage 4: Test Prioritization (`test-prioritizer.ts`)

**Purpose**: Use LLM to rank candidate tests by likelihood of catching regressions.

```
┌─────────────────────────────────────────────────────────────────────┐
│            TEST PRIORITIZATION RANKING PROCESS                      │
└─────────────────────────────────────────────────────────────────────┘

STATIC BASELINE SCORES (from test-analyzer.ts):
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Direct symbol usage        ────────────────────── 0.95         │
│  Same directory             ────────────────────── 0.85         │
│  Name match                 ────────────────────── 0.75         │
│  Dependency-related         ────────────────────── 0.80         │
│  No match                   ────────────────────── 0.0          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                            │
                            │ All candidates sent to LLM
                            ▼

LLM RANKING PROCESS:
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Input to LLM:                                                  │
│  ├─ Commit message & metadata                                  │
│  ├─ Changed files & symbols                                    │
│  ├─ All candidate tests                                        │
│  ├─ Source code excerpts (first 6000 chars)                   │
│  └─ Test code excerpts (top 15 tests)                         │
│                                                                  │
│  LLM Analysis:                                                  │
│  ├─ Does test actually exercise changed code?                 │
│  ├─ What scenarios does test cover?                           │
│  ├─ How likely to catch regression in THIS commit?            │
│  └─ Return score (0.0-1.0) + reason                           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                            │
                            ▼

VALIDATION & FALLBACK:
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  For each LLM-ranked test:                                      │
│  ├─ Is testFile in candidateTests? ──Yes──▶ Keep              │
│  └─ Is hallucinated? ──Yes──▶ Drop                            │
│                                                                  │
│  For unranked tests:                                            │
│  ├─ Include at bottom                                          │
│  └─ Use static confidence score                                │
│                                                                  │
│  Sort all by score descending                                   │
│  Assign priority: 1, 2, 3...                                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                            │
                            ▼

OUTPUT RANKED LIST:
┌──────────────────────────────────────────────────────────────────┐
│  Priority │ TestFile              │ Score │ Reason               │
├───────────┼──────────────────────┼───────┼──────────────────────┤
│     1     │ validate.test.ts      │ 0.98  │ "Directly tests the" │
│           │                       │       │  "modified function" │
├───────────┼──────────────────────┼───────┼──────────────────────┤
│     2     │ login.test.ts         │ 0.92  │ "Tests validation"   │
│           │                       │       │  "utilities used by" │
├───────────┼──────────────────────┼───────┼──────────────────────┤
│     3     │ integration.test.ts   │ 0.75  │ "Integration test"   │
│           │                       │       │  "in same directory" │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

KEY INSIGHT:
Tests are executed in this priority order (1, 2, 3...) to maximize
early detection of regressions. If test 1 fails, you know immediately
that the change broke something critical.
```

**Key Functions**:
- `prioritizeTests(context, llmClient)` - Main entry point

**What It Does**:
1. Skips LLM call if no candidate tests (optimization)
2. Builds user prompt from context using `buildTestPrioritizerUserPrompt()`
3. Calls `llmClient.generateJSON()` with:
   - System prompt: Instructions for test prioritization
   - User prompt: Commit details + changed symbols + candidate tests + code excerpts
4. LLM returns ranked tests with scores (0-1) and reasoning
5. Validates output:
   - Drops any tests not in candidate list (prevents hallucination)
   - Removes duplicates (keeps first occurrence)
   - Includes unranked candidates at bottom with fallback scores
6. Assigns priority numbers (1 = highest priority)

**Output**: `TestPrioritizationResult`:
```typescript
interface PrioritizedTest {
  testFile: string;
  priority: number;
  score: number;  // 0.0-1.0
  reason: string;  // Concrete reasoning from LLM
  evidence: string[];  // Supporting evidence tags
}
```

---

### Stage 5: Dependency Analysis (`dependencyAnalyzer.ts`)

**Purpose**: Extract dependency changes from git diff.

```
┌──────────────────────────────────────────────────────────────────┐
│           DEPENDENCY CHANGE DETECTION FLOW                       │
└──────────────────────────────────────────────────────────────────┘


GIT DIFF INPUT:
┌──────────────────────────────────────────────────────────────────┐
│  diff --git a/package.json b/package.json                        │
│  ─────────────────────────────────────────────────────────────  │
│  - "lodash": "^4.17.20"         ◄─ Removed version              │
│  + "lodash": "^4.17.21"         ◄─ Added version                │
│  - "express": "^4.17.1"         ◄─ Removed (downgrade)          │
│  + "express": "^4.16.0"                                          │
│  + "axios": "^0.21.0"           ◄─ New dependency added         │
│                                                                  │
│  diff --git a/yarn.lock b/yarn.lock                              │
│  ─────────────────────────────────────────────────────────────  │
│  -"react@npm:^17.0.0":          ◄─ Old entry                    │
│  -  version: 17.0.2                                              │
│  +"react@npm:^18.0.0":          ◄─ New entry                    │
│  +  version: 18.1.0                                              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                            │
                            ▼

PARSE & CATEGORIZE:
┌──────────────────────────────────────────────────────────────────┐
│  "lodash" ^4.17.20 → ^4.17.21 ─────▶ UPGRADED (minor version)  │
│  "express" ^4.17.1 → ^4.16.0 ─────▶ DOWNGRADED (patch version) │
│  "axios" (new) ────────────────────▶ ADDED                      │
│  (some dependency removed) ────────▶ REMOVED                    │
│  "react" 17.0.2 → 18.1.0 ────────▶ UPGRADED (major version)   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                            │
                            ▼

VERSION COMPARISON LOGIC:
┌──────────────────────────────────────────────────────────────────┐
│  Compare semantic versions: X.Y.Z                               │
│                                                                  │
│  4.17.20 vs 4.17.21:                                            │
│  ├─ Major (4 vs 4):  SAME                                       │
│  ├─ Minor (17 vs 17): SAME                                      │
│  └─ Patch (20 vs 21): UPGRADED ◄─ Result: UPGRADED            │
│                                                                  │
│  4.17.1 vs 4.16.0:                                              │
│  ├─ Major (4 vs 4):  SAME                                       │
│  ├─ Minor (17 vs 16): DOWNGRADED ◄─ Result: DOWNGRADED        │
│  └─ (skip patch)                                                │
│                                                                  │
│  17.0.2 vs 18.1.0:                                              │
│  ├─ Major (17 vs 18): UPGRADED ◄─ Result: UPGRADED            │
│  └─ (skip minor/patch)                                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                            │
                            ▼

DEDUPLICATE & OUTPUT:
┌──────────────────────────────────────────────────────────────────┐
│  DependencyChange[] {                                            │
│    ├─ {                                                          │
│    │   package: "lodash",                                        │
│    │   changeType: "upgraded",                                  │
│    │   from: "^4.17.20",                                         │
│    │   to: "^4.17.21",                                           │
│    │   source: "package.json"                                    │
│    │ },                                                          │
│    ├─ {                                                          │
│    │   package: "express",                                       │
│    │   changeType: "downgraded",                                │
│    │   from: "^4.17.1",                                          │
│    │   to: "^4.16.0",                                            │
│    │   source: "package.json"                                    │
│    │ },                                                          │
│    ├─ {                                                          │
│    │   package: "axios",                                         │
│    │   changeType: "added",                                     │
│    │   to: "^0.21.0",                                            │
│    │   source: "package.json"                                    │
│    │ },                                                          │
│    └─ {                                                          │
│        package: "react",                                         │
│        changeType: "upgraded",                                  │
│        from: "17.0.2",                                           │
│        to: "18.1.0",                                             │
│        source: "yarn.lock"                                       │
│      }                                                           │
│  }                                                               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘


USAGE FLOW:
(See Stage 2) These dependency changes trigger test discovery:

  package.json changed
       │
       ├─▶ Extract: "lodash" upgraded
       │
       ├─▶ Find: All source files importing lodash
       │
       ├─▶ Find: All test files that test those source files
       │
       └─▶ Add: These tests as candidates with "dependency" relationship
```

**Key Functions**:
- `analyzeDependencyChanges(rawDiff)` - Main entry point
- `analyzePackageJson(rawDiff)` - Parse package.json diffs
- `analyzeYarnLock(rawDiff)` - Parse yarn.lock diffs

**What It Does**:
1. Scans diff for changes to `package.json`:
   - Detects added dependencies (new lines with `"package": "version"`)
   - Detects removed dependencies (removed lines)
   - Detects version changes (same package, different version)
2. Scans diff for changes to `yarn.lock`:
   - Similar logic but handles yarn's format
3. Determines change type:
   - "upgraded" (version increased)
   - "downgraded" (version decreased)
   - "changed" (couldn't determine direction)
4. Deduplicates results

**Output**: Array of `DependencyChange`:
```typescript
interface DependencyChange {
  package: string;
  changeType: "added" | "removed" | "upgraded" | "downgraded" | "changed" | "unchanged";
  from?: string;  // Old version
  to?: string;    // New version
  source: "package.json" | "yarn.lock";
}
```

---

### Stage 6: Gap Analysis (`test-gap-analyzer.ts`)

**Purpose**: Identify test coverage gaps for changed code.

```
┌──────────────────────────────────────────────────────────────────────┐
│               COVERAGE GAP IDENTIFICATION PROCESS                    │
└──────────────────────────────────────────────────────────────────────┘


CHANGED CODE (from diff):
┌──────────────────────────────────────────────────────────────────────┐
│  function validateToken(token: string) {                             │
│    try {                                                             │
│      ✗ if (!token) throw new Error("Token required");    [NEW]      │
│      ✗ if (isExpired(token)) throw new Error("Expired"); [NEW]      │
│      const decoded = jwt.verify(token, SECRET);                     │
│      ✗ return { ...decoded, verified: true };           [MODIFIED]  │
│    } catch (error) {                                                 │
│      ✗ console.error("Auth error:", error);             [NEW]       │
│      return null;                                                    │
│    }                                                                 │
│  }                                                                    │
│                                                                      │
│  ✗ = Changed code (not in previous version)                          │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                            │
                            ▼

EXTRACT BEHAVIORS:
┌──────────────────────────────────────────────────────────────────────┐
│  NEW BEHAVIORS IDENTIFIED:                                           │
│  ┌─ Behavior 1: Empty token check                                   │
│  │  Code: if (!token) throw new Error("Token required");           │
│  │  Type: Conditional + Error                                       │
│  │                                                                   │
│  ├─ Behavior 2: Expired token check                                 │
│  │  Code: if (isExpired(token)) throw new Error("Expired");        │
│  │  Type: Conditional + Error                                       │
│  │                                                                   │
│  ├─ Behavior 3: Verified flag in return                             │
│  │  Code: return { ...decoded, verified: true };                   │
│  │  Type: Modified return value                                     │
│  │                                                                   │
│  └─ Behavior 4: Error logging                                       │
│     Code: console.error("Auth error:", error);                     │
│     Type: Error handling                                             │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                            │
                            ▼

CHECK FOR EXISTING COVERAGE:
┌──────────────────────────────────────────────────────────────────────┐
│  Scan existing test files for assertions:                            │
│                                                                      │
│  Behavior 1 (Empty token):                                           │
│  Search: "expect(...).toThrow", "expect(...).toBe(null)"            │
│  Find: "expect(() => validateToken('')) .toThrow()"  ✓ COVERED    │
│                                                                      │
│  Behavior 2 (Expired token):                                         │
│  Search: "expect(...).toThrow", "isExpired"                         │
│  Find: None found  ✗ UNCOVERED → GAP IDENTIFIED                    │
│                                                                      │
│  Behavior 3 (Verified flag):                                         │
│  Search: "verified", "expect(...).toHaveProperty"                   │
│  Find: "expect(result.verified).toBe(true)"  ✓ COVERED            │
│                                                                      │
│  Behavior 4 (Error logging):                                         │
│  Search: "console.error", "expect.*error"                           │
│  Find: None found (low priority)  ✗ UNCOVERED → LOW-CONFIDENCE GAP │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                            │
                            ▼

GENERATE TESTABLE ASSERTIONS:
┌──────────────────────────────────────────────────────────────────────┐
│  For each identified gap:                                            │
│                                                                      │
│  GAP 1: Expired token error not tested                               │
│  ──────────────────────────────────────────────────────────────────  │
│  Testable Assertion:                                                 │
│  "expect(() => validateToken(expiredToken)).toThrow('Expired')"    │
│                                                                      │
│  GAP 2: Error logging not tested                                     │
│  ──────────────────────────────────────────────────────────────────  │
│  Testable Assertion (lower confidence):                              │
│  "expect(console.error).toHaveBeenCalledWith(expect.any(Error))"   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                            │
                            ▼

OUTPUT GAP ANALYSIS:
┌──────────────────────────────────────────────────────────────────────┐
│  TestGapAnalysis {                                                   │
│    symbol: "validateToken",                                          │
│    sourceFile: "src/auth/validate.ts",                               │
│                                                                      │
│    changedBehaviors: [                                               │
│      { code: "if (!token) throw...", verified: true },              │
│      { code: "if (isExpired) throw...", verified: false },          │
│      { code: "return { ...verified: true }", verified: true },      │
│      { code: "console.error...", verified: false }                  │
│    ],                                                                │
│                                                                      │
│    coverageGaps: [                                                   │
│      {                                                               │
│        id: "gap_1",                                                  │
│        symbol: "validateToken",                                      │
│        description: "Missing test for expired token error",         │
│        testableAssertion: "expect(() => validateToken(...))        │
│                             .toThrow('Expired')",                   │
│        verifiedUntested: true                                       │
│      },                                                              │
│      {                                                               │
│        id: "gap_2",                                                  │
│        symbol: "validateToken",                                      │
│        description: "Missing test for error logging",               │
│        testableAssertion: "expect(console.error)                    │
│                             .toHaveBeenCalledWith(...)",            │
│        verifiedUntested: false  (lower confidence)                  │
│      }                                                               │
│    ]                                                                 │
│  }                                                                    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘


This gap analysis is used to generate new test cases that target
the identified coverage gaps, ensuring comprehensive testing of
newly added behaviors.
```

**Key Functions**:
- `analyzeCoverageGaps()` - Analyze gaps for a single symbol
- `extractFallbackBehaviors()` - Find fallback/error handling code not tested
- `extractLexicalBehaviors()` - Find condition branches not tested
- `verifyFallbackCoverage()` - Check if tests already cover fallback paths

**What It Does**:

This is a sophisticated analysis that examines changed code to identify untested scenarios:

1. **Extract Changed Behaviors**:
   - Analyzes diff hunks to find added/modified code
   - Identifies new conditional branches (if/else)
   - Identifies new fallback handlers (try/catch, error conditions)
   - Identifies new function calls that might fail

2. **Identify Behavior Types**:
   - **Conditional behaviors**: `if (condition) { ... }`
   - **Fallback behaviors**: `catch (err)`, `return defaultValue`
   - **Function call behaviors**: New external function calls that could fail

3. **Check for Existing Coverage**:
   - Scans existing test files for coverage of these behaviors
   - Looks for assertions that match the fallback condition
   - Determines which scenarios have no test coverage yet

4. **Generate Gaps**:
   - Creates gap entries for uncovered behaviors
   - Includes testable assertions (actual code a test could write)
   - Marks which tests would cover each gap

**Output**: `TestGapAnalysis` for each symbol:
```typescript
interface TestGapAnalysis {
  symbol: string;
  sourceFile: string;
  changedBehaviors: ChangedBehavior[];  // All identified behaviors
  coverageGaps: CoverageGap[];  // Uncovered behaviors
}

interface CoverageGap {
  id: string;
  symbol: string;
  description: string;  // Human-readable gap description
  conditionCode: string;  // The condition from the diff
  testableAssertion: string;  // How a test could verify this
  verifiedUntested: boolean;  // Confidence it's not already tested
}
```

**Used For**: Generating target functions to test in Stage 7

---

### Stage 7: Test Generation (`test-generator.ts`)

**Purpose**: Generate new test cases for coverage gaps.

```
┌──────────────────────────────────────────────────────────────────────┐
│             TEST GENERATION WORKFLOW                                 │
└──────────────────────────────────────────────────────────────────────┘


INPUT: Coverage gaps from Stage 6
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  STEP 1: BUILD GENERATION TARGETS                                    │
│  ────────────────────────────────────────────────────────────────    │
│  For each gap:                                                       │
│                                                                      │
│  Gap: Missing test for expired token error                           │
│   │                                                                  │
│   ├─▶ Target symbol: validateToken                                  │
│   ├─▶ Source file: src/auth/validate.ts                             │
│   ├─▶ Proposed test file: src/auth/validate.test.ts                 │
│   ├─▶ Is new test file? No (file already exists)                    │
│   └─▶ Priority: High (error handling scenario)                      │
│                                                                      │
│  Output: TestGenerationTarget[]                                      │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  STEP 2: FIND STYLE TEMPLATES                                        │
│  ────────────────────────────────────────────────────────────────    │
│  For each target, score candidate test files:                        │
│                                                                      │
│  Scoring:                                                            │
│  ├─ Same directory as source: +100                                  │
│  ├─ Same framework (Vitest vs Jest): +50                            │
│  ├─ Similar naming pattern: +25                                     │
│  └─ Proximity: factor                                               │
│                                                                      │
│  Candidates:                                                         │
│  ├─ src/auth/validate.test.ts        Score: 100+50+25 = 175 ✓TOP  │
│  ├─ src/auth/auth.test.ts            Score: 100                     │
│  ├─ src/auth/login.test.ts           Score: 100                     │
│  └─ src/services/validate.test.ts    Score: 25+50                  │
│                                                                      │
│  Winner: src/auth/validate.test.ts                                  │
│  Extract: Import patterns, test framework, setup/teardown           │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  STEP 3: BUILD LLM PROMPT                                            │
│  ────────────────────────────────────────────────────────────────    │
│  Include:                                                            │
│  ├─ Target function definition (full code)                          │
│  ├─ Gap description (what to test)                                  │
│  ├─ Template test code (style reference)                            │
│  ├─ Source file content (function implementation)                   │
│  └─ Required mocks for dependencies                                 │
│                                                                      │
│  Example template test pattern:                                      │
│  ─────────────────────────────────────                               │
│  it("should handle specific case", () => {                          │
│    const input = ...;                                               │
│    const result = validateToken(input);                             │
│    expect(result).toBe(...);                                        │
│  });                                                                 │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  STEP 4: LLM GENERATES TEST                                          │
│  ────────────────────────────────────────────────────────────────    │
│  LLM sees:                                                           │
│  • "Generate test for expired token case"                           │
│  • Template showing Vitest syntax with describe/it                  │
│  • Function that checks token expiration                            │
│  • What assertion to write                                          │
│                                                                      │
│  LLM generates:                                                      │
│  ─────────────────────────────────────────────────────────────────  │
│  it("should throw error for expired token", () => {                │
│    const expiredToken = createToken({ exp: Date.now() - 1000 });  │
│    expect(() => {                                                   │
│      validateToken(expiredToken);                                   │
│    }).toThrow("Expired");                                           │
│  });                                                                 │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  STEP 5: VALIDATION                                                  │
│  ────────────────────────────────────────────────────────────────    │
│  Check 1: Syntax - Is it valid JavaScript/TypeScript?              │
│  Result: ✓ PASS (valid describe/it blocks)                         │
│                                                                      │
│  Check 2: Completeness - Has all required parts?                   │
│  Result: ✓ PASS (has test, setup, assertions)                      │
│                                                                      │
│  Check 3: Target - Does it test the target function?               │
│  Result: ✓ PASS (calls validateToken)                              │
│                                                                      │
│  Check 4: Imports - Can dependencies be resolved?                  │
│  Result: ✓ PASS (no exotic imports needed)                         │
│                                                                      │
│  Overall: ✓ VALIDATION PASSED                                       │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  STEP 6: OUTPUT                                                      │
│  ────────────────────────────────────────────────────────────────    │
│                                                                      │
│  GenerationResult {                                                  │
│    targetSymbol: "validateToken",                                    │
│    testFile: "src/auth/validate.test.ts",                            │
│    generatedTests: [                                                 │
│      {                                                               │
│        name: "should throw error for expired token",                │
│        testCode: "it(\"should throw...\") { ... }"                 │
│      }                                                               │
│    ]                                                                 │
│  }                                                                    │
│                                                                      │
│  Ready for execution!                                               │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Key Functions**:
- `buildGenerationTargets()` - Convert gaps into test generation targets
- `generateTests()` - Call LLM to generate test code
- `generateTestsForTarget()` - Generate tests for a single target
- `validateAndNormalize()` - Validate generated test code
- `findTemplateTestFile()` - Find a template test file to match code style

**What It Does**:

1. **Build Generation Targets**:
   - For each coverage gap identified in Stage 6
   - Determines which changed symbol the gap belongs to
   - Identifies the source file and test file to write to
   - Determines if it needs a new test file or adding to existing one
   - Finds a "template" test file to match coding style

2. **Find Template Test Files**:
   - Scores candidate test files by:
     - Same directory (highest score)
     - Same framework (Vitest, Jest, Playwright)
     - Similar test naming style
     - Proximity to source file
   - Uses highest-scoring template as style reference

3. **Build LLM Prompts** (via `generator-prompts.ts`):
   - Sends changed code to LLM
   - Sends test gap description
   - Sends template test code as style guide
   - Asks LLM to generate test code matching the template style

4. **LLM Generation**:
   - LLM generates test code as JSON response
   - Validates syntax (is it valid JavaScript/TypeScript?)
   - Validates completeness (does it import dependencies?)
   - Validates logic (does it actually test the target function?)

5. **Auto-Repair Loop**:
   - If generated tests fail at execution time (Stage 9)
   - Collects error messages
   - Sends repair request to LLM with error context
   - Up to 3 repair attempts per failing test

**Generated Test Validation**:
```typescript
- Check for syntax errors (parseable as code)
- Check for missing imports (all dependencies available?)
- Check for target function usage (actually testing something?)
- Check for complete blocks (test, setup, teardown all valid)
```

**Output**: `GenerationResult` for each target:
```typescript
interface GenerationResult {
  targetSymbol: string;
  testFile: string;
  generatedTests?: {
    name: string;
    testCode: string;
    targetSymbol: string;
  }[];
  error?: string;
}
```

---

### Stage 8: Test Execution (`test-runner.ts`)

**Purpose**: Execute tests in priority order and collect results.

```
┌──────────────────────────────────────────────────────────────────────┐
│           TEST EXECUTION SEQUENCE DIAGRAM                            │
└──────────────────────────────────────────────────────────────────────┘


PRIORITIZED TESTS (from Stage 4):
┌──────────────────────────────────────────────────────────────────────┐
│  Priority │ TestFile              │ Score                            │
├───────────┼──────────────────────┼────────────────────────────────  │
│     1     │ src/auth/validate.test.ts  │ 0.98                       │
│     2     │ src/auth/login.test.ts     │ 0.92                       │
│     3     │ src/auth/integration.test.ts  │ 0.75                    │
│     ...   │ ...                   │ ...                              │
└──────────────────────────────────────────────────────────────────────┘
                            │
                            ▼ EXECUTE SEQUENTIALLY (NOT PARALLEL!)
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ┌─ TEST 1 (Priority 1)                                             │
│  │  validate.test.ts                                                │
│  │  ├─ Command: npm test -- src/auth/validate.test.ts             │
│  │  ├─ Framework detected: vitest                                   │
│  │  ├─ Execution: 2.3 seconds                                       │
│  │  ├─ Exit code: 0                                                 │
│  │  ├─ Output: "✓ All tests passed"                                │
│  │  └─ Result: ✓ PASSED                                            │
│  │
│  │  ┌─ TEST 2 (Priority 2)  ◄─ NEXT (only after test 1 completes) │
│  │  │  login.test.ts                                               │
│  │  │  ├─ Command: npm test -- src/auth/login.test.ts             │
│  │  │  ├─ Framework detected: vitest                               │
│  │  │  ├─ Execution: 1.8 seconds                                   │
│  │  │  ├─ Exit code: 0                                             │
│  │  │  ├─ Output: "✓ All tests passed"                            │
│  │  │  └─ Result: ✓ PASSED                                        │
│  │  │
│  │  │  ┌─ TEST 3 (Priority 3) ◄─ NEXT                             │
│  │  │  │  integration.test.ts                                      │
│  │  │  │  ├─ Command: npm test -- src/auth/integration.test.ts   │
│  │  │  │  ├─ Framework detected: vitest                           │
│  │  │  │  ├─ Execution: 3.1 seconds                               │
│  │  │  │  ├─ Exit code: 1 (non-zero)                              │
│  │  │  │  ├─ Output: "✗ 1 test failed"                           │
│  │  │  │  └─ Result: ✗ FAILED                                    │
│  │  │  │
│  │  │  │  Optional: stopOnFailure=true?                           │
│  │  │  │  └─ STOP HERE, don't run remaining tests               │
│  │  │  │
│  │  │  │  Or continue...                                          │
│  │  │  │
│  │  │  │  ┌─ TEST 4 (Priority 4)                                 │
│  │  │  │  │  ...                                                  │
│  │  │  │  └─ Result: ...                                         │
│  │  │  │
│  │  │  └─ Continue for all tests in priority order                │
│  │  │
│  │  └─ All existing tests completed                               │
│  │
│  └─ Now execute GENERATED tests (same sequential logic)            │
│
└──────────────────────────────────────────────────────────────────────┘
                            │
                            ▼


EXECUTION MODES:

Mode A (DEFAULT):
  • Run all tests regardless of failures
  • Good for collecting complete data
  • Useful for evaluation/trending

Mode B (stopOnFailure=true):
  • Stop at first failure
  • Good for CI/CD pipelines
  • Fast feedback on regressions

Mode C (maxFailures=N):
  • Stop after N failures
  • Balance between A and B
  • Example: Stop after 3 failures


RESULT COLLECTION:
┌──────────────────────────────────────────────────────────────────────┐
│  TestExecutionResult[] {                                             │
│    ├─ {                                                              │
│    │   testFile: "src/auth/validate.test.ts",                        │
│    │   priority: 1,                                                  │
│    │   framework: "vitest",                                          │
│    │   status: "passed",                                             │
│    │   duration: 2.3,                                                │
│    │   durationMs: 2300,                                             │
│    │   exitCode: 0,                                                  │
│    │   command: "npm test -- src/auth/validate.test.ts",            │
│    │   stdout: "✓ All tests passed"                                │
│    │ },                                                              │
│    ├─ {                                                              │
│    │   testFile: "src/auth/login.test.ts",                           │
│    │   priority: 2,                                                  │
│    │   status: "passed",                                             │
│    │   duration: 1.8,                                                │
│    │   ...                                                           │
│    │ },                                                              │
│    ├─ {                                                              │
│    │   testFile: "src/auth/integration.test.ts",                     │
│    │   priority: 3,                                                  │
│    │   status: "failed",  ◄─ FAILURE                               │
│    │   duration: 3.1,                                                │
│    │   exitCode: 1,                                                  │
│    │   stderr: "AssertionError: Expected true to be false",         │
│    │   ...                                                           │
│    │ },                                                              │
│    └─ ...                                                            │
│  }                                                                    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

KEY INSIGHT: Tests are executed ONE AT A TIME in priority order.
If the highest-priority test fails, you know immediately there's
a critical issue with the prioritization (or the test itself).
```

**Key Functions**:
- `runPrioritizedTests()` - Run ordered list of tests
- `runSingleTest()` - Execute one test file
- `enrichTestInputsWithContext()` - Map test files to test suites/contexts

**What It Does**:

1. **Framework Detection** (via `framework-resolver.ts`):
   - Reads `package.json` to detect installed frameworks
   - Checks for `vitest`, `@playwright/test`, `jest`, `mocha` (in that order)
   - For each test file, resolves which framework to use
   - Determines correct shell command to run

2. **Sequential Execution**:
   - Sorts tests by priority (lowest number = highest priority)
   - Runs tests ONE AT A TIME, not in parallel
   - Collects results for each test
   - Optional stop-on-failure mode
   - Optional max-failures threshold

3. **Per-Test Execution**:
   - Constructs command: `npm/yarn test <testFile>`
   - Sets timeout (default 120s for monorepo startup time)
   - Captures stdout, stderr, exit code
   - Calculates duration
   - Determines status:
     - "passed": exit code 0 and assertions passed
     - "failed": exit code non-zero or test assertion failed
     - "error": timeout or runtime error
     - "not_found": test file doesn't exist
     - "skipped": test explicitly skipped

4. **Result Aggregation**:
   - Returns all results in priority order
   - Indicates if execution stopped early (stopOnFailure or maxFailures hit)

**Output**: `TestRunSummary`:
```typescript
interface TestExecutionResult {
  testFile: string;
  generatedTestName?: string;  // For generated tests
  framework?: string;  // vitest, jest, playwright, etc.
  status: "passed" | "failed" | "error" | "not_found" | "skipped";
  duration: number;  // seconds
  durationMs: number;  // milliseconds
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  command?: string;
  notes?: string;
}

interface TestRunSummary {
  testExecution: TestExecutionResult[];
  stoppedEarly: boolean;
}
```

---

### Stage 9: LLM-Based Test Repair (within Stage 8)

**Purpose**: Automatically fix generated tests that fail at runtime.

```
┌──────────────────────────────────────────────────────────────────────┐
│            AUTO-REPAIR LOOP FOR FAILING TESTS                        │
└──────────────────────────────────────────────────────────────────────┘


INITIAL TEST EXECUTION (Stage 8):
┌──────────────────────────────────────────────────────────────────────┐
│  Generated test: "should throw error for expired token"              │
│                                                                      │
│  Test code:                                                          │
│  ────────────────────────────────────────────────────────────────    │
│  it("should throw error for expired token", () => {                │
│    const expiredToken = createToken({ exp: Date.now() - 1000 });  │
│    expect(() => {                                                   │
│      validateToken(expiredToken);                                   │
│    }).toThrow("Expired");                                           │
│  });                                                                 │
│  ────────────────────────────────────────────────────────────────    │
│                                                                      │
│  Execution result: ✗ FAILED                                         │
│  Error message:                                                      │
│  ────────────────────────────────────────────────────────────────    │
│  "TypeError: createToken is not a function"                         │
│  ────────────────────────────────────────────────────────────────    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                            │
                            ▼

REPAIR ATTEMPT 1/3:
┌──────────────────────────────────────────────────────────────────────┐
│  Prepare repair request for LLM:                                     │
│                                                                      │
│  • Failed test code                                                  │
│  • Error message: "TypeError: createToken is not a function"        │
│  • Target function: validateToken                                   │
│  • Source file content (let LLM see how to create token)            │
│  • Attempt: 1/3                                                     │
│                                                                      │
│  Send to LLM: "Fix this test. The error is: createToken not found. │
│   Here's the source file to understand the token format."          │
│                                                                      │
│  LLM responds:                                                       │
│  ────────────────────────────────────────────────────────────────    │
│  "The issue is createToken doesn't exist. Looking at the source,   │
│   I see jwt.sign() is used. Fix:"                                  │
│                                                                      │
│  Repaired test:                                                      │
│  ────────────────────────────────────────────────────────────────    │
│  it("should throw error for expired token", () => {                │
│    const expiredToken = jwt.sign(                                   │
│      { exp: Math.floor(Date.now() / 1000) - 1000 },               │
│      SECRET                                                         │
│    );                                                               │
│    expect(() => {                                                   │
│      validateToken(expiredToken);                                   │
│    }).toThrow("Expired");                                           │
│  });                                                                 │
│  ────────────────────────────────────────────────────────────────    │
│                                                                      │
│  Re-execute...                                                       │
│  Result: ✓ PASSED                                                   │
│                                                                      │
│  Success! Stop repair loop.                                         │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

If still failing after repair 1:

                            │
                            ▼

REPAIR ATTEMPT 2/3 (if needed):
┌──────────────────────────────────────────────────────────────────────┐
│  Repeat process with new error message                               │
│  E.g., "Secret is undefined" → LLM fixes import                     │
└──────────────────────────────────────────────────────────────────────┘

If still failing after repair 2:

                            │
                            ▼

REPAIR ATTEMPT 3/3 (final):
┌──────────────────────────────────────────────────────────────────────┐
│  One last repair attempt                                             │
│  If fails: Mark as "failed" and move on                              │
│           (Don't keep retrying, respect API limits)                 │
└──────────────────────────────────────────────────────────────────────┘


SUMMARY OF AUTO-REPAIR:
┌──────────────────────────────────────────────────────────────────────┐
│  ├─ Generated test fails                                             │
│  ├─ Attempt 1/3: Fix + re-run (if pass → stop)                      │
│  ├─ Attempt 2/3: Fix + re-run (if pass → stop)                      │
│  ├─ Attempt 3/3: Fix + re-run (if pass → stop)                      │
│  └─ If still failing: Mark as failed, report in results             │
│                                                                      │
│  Benefits:                                                           │
│  • Improves generation success rate                                  │
│  • No manual intervention needed                                     │
│  • Captures error context for fixes                                  │
│  • Respects API rate limits (max 3 attempts)                         │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Key Functions**:
- `buildTestRepairPrompt()` - Build prompt for LLM repair request
- Called from `app.ts` in the repair loop section

**What It Does**:

1. **Detect Failed Tests**:
   - After executing generated tests, collect failures
   - Extract error messages from stderr

2. **Build Repair Prompt**:
   - Includes the failing test code
   - Includes the error message from Vitest/Jest
   - Includes the target function name
   - Includes the source file content
   - Includes attempt number (up to 3)

3. **Call LLM**:
   - Sends repair prompt to Gemini
   - LLM analyzes error and suggests fixes
   - LLM returns repaired test code

4. **Re-Execute**:
   - Writes repaired test to temp file
   - Runs test again
   - If still fails, can attempt repair again (up to 3 total attempts)
   - If passes, marks as successful

---

### Stage 10: Results Aggregation & Persistence

**Purpose**: Collect all results and save to database.

```
┌──────────────────────────────────────────────────────────────────────┐
│         RESULTS AGGREGATION & PERSISTENCE PIPELINE                   │
└──────────────────────────────────────────────────────────────────────┘


COLLECT FROM ALL STAGES:
┌──────────────────────────────────────────────────────────────────────┐
│  ├─ Stage 1: CommitAnalysis                                          │
│  │  └─ commit metadata, files changed, symbols changed              │
│  │                                                                   │
│  ├─ Stage 4: TestPrioritizationResult                               │
│  │  └─ prioritized tests with scores & reasons                     │
│  │                                                                   │
│  ├─ Stage 5: DependencyChange[]                                      │
│  │  └─ dependency changes (added/removed/upgraded)                 │
│  │                                                                   │
│  ├─ Stage 6: TestGapAnalysis[]                                       │
│  │  └─ gaps identified per symbol                                   │
│  │                                                                   │
│  ├─ Stage 7: TestGenerationTarget[]                                  │
│  │  └─ targets to generate tests for                                │
│  │                                                                   │
│  ├─ Stage 8: GenerationResult[]                                      │
│  │  └─ generated test code & metadata                               │
│  │                                                                   │
│  └─ Stage 9: TestExecutionResult[]                                   │
│     └─ execution results for all tests                              │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                            │
                            ▼

CALCULATE METRICS:
┌──────────────────────────────────────────────────────────────────────┐
│  For EXISTING tests:                                                 │
│  ├─ Selected: 10                                                     │
│  ├─ Executed: 10                                                     │
│  ├─ Passed: 8                                                        │
│  ├─ Failed: 2                                                        │
│  ├─ Pass rate: 80.0%                                                │
│  └─ Total duration: 7.2 seconds                                     │
│                                                                      │
│  For GENERATED tests:                                                │
│  ├─ Generated: 5                                                     │
│  ├─ Valid (passed validation): 5                                    │
│  ├─ Executed: 5                                                     │
│  ├─ Passed: 4                                                        │
│  ├─ Failed: 1 (then repaired → passed)                              │
│  ├─ Success rate: 80.0%                                             │
│  ├─ Total duration: 2.1 seconds                                     │
│  └─ Validity rate: 100.0%                                           │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                            │
                            ▼

BUILD RESPONSE OBJECT:
┌──────────────────────────────────────────────────────────────────────┐
│  {                                                                    │
│    "success": true,                                                   │
│    "commit": {                                                        │
│      "hash": "abc123...",                                             │
│      "message": "Fix auth bug",                                       │
│      "author": "John Doe",                                            │
│      "date": "2024-01-15T10:30:00Z"                                   │
│    },                                                                 │
│    "analysis": {                                                      │
│      "filesChanged": 3,                                               │
│      "totalInsertions": 45,                                           │
│      "totalDeletions": 12,                                            │
│      "changedSymbols": [...],                                         │
│      "dependencyChanges": [...]                                       │
│    },                                                                 │
│    "prioritization": {                                                │
│      "candidateTests": 10,                                            │
│      "prioritizedTests": [...]                                        │
│    },                                                                 │
│    "gapAnalysis": {                                                   │
│      "results": [...],                                                │
│      "summary": {                                                     │
│        "analyzedSymbols": 5,                                          │
│        "totalChangedBehaviors": 12,                                   │
│        "totalVerifiedGaps": 3                                         │
│      }                                                                │
│    },                                                                 │
│    "generation": {                                                    │
│      "results": [...],                                                │
│      "summary": {                                                     │
│        "targetCount": 3,                                              │
│        "generatedCount": 5,                                           │
│        "failedCount": 0,                                              │
│        "successRate": "100.0%"                                        │
│      }                                                                │
│    },                                                                 │
│    "existingTestExecution": {                                         │
│      "results": [...],                                                │
│      "summary": {                                                     │
│        "selected": 10,                                                │
│        "executed": 10,                                                │
│        "passed": 8,                                                   │
│        "failed": 2,                                                   │
│        "passRate": "80.0%"                                            │
│      }                                                                │
│    },                                                                 │
│    "generatedTestExecution": {                                        │
│      "results": [...],                                                │
│      "summary": {                                                     │
│        "generated": 5,                                                │
│        "executed": 5,                                                 │
│        "passed": 5,                                                   │
│        "failed": 0,                                                   │
│        "passRate": "100.0%"                                           │
│      }                                                                │
│    }                                                                  │
│  }                                                                    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                            │
                            ▼

SAVE TO MONGODB:
┌──────────────────────────────────────────────────────────────────────┐
│  Database: research (from MONGODB_DB_NAME env)                       │
│  Collection: my-repo (from repoName parameter)                       │
│                                                                      │
│  Document: {                                                         │
│    _id: ObjectId("507f1f77bcf86cd799439011"),                       │
│    ...all response data above...,                                    │
│    savedAt: 2024-01-15T10:35:00Z,                                    │
│    savedAtTimestamp: 1705315800000                                   │
│  }                                                                    │
│                                                                      │
│  Persisted for later analysis, trending, baseline comparison        │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                            │
                            ▼

RETURN TO CLIENT:
┌──────────────────────────────────────────────────────────────────────┐
│  HTTP Response (200 OK) with:                                        │
│  ├─ All analysis results                                             │
│  ├─ All test prioritization data                                     │
│  ├─ All test execution data                                          │
│  ├─ MongoDB document ID (mongoId field)                              │
│  └─ Ready for visualization or further processing                    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Key Functions**:
- `saveAnalysisResult()` (MongoDB service) - Save to MongoDB
- Express endpoints in `app.ts` - Return results to client

**What It Does**:

1. **Aggregates Results**:
   - Existing test prioritization results
   - Existing test execution results  
   - Gap analysis details
   - Generated test targets
   - Generated test code
   - Generated test execution results
   - Repair loop details

2. **Calculates Metrics**:
   - Pass rates
   - Execution times
   - Success statistics
   - Coverage gaps covered

3. **Saves to MongoDB**:
   - Uses database name from `MONGODB_DB_NAME` env var (default: "research")
   - Creates collection named after repository (from `repoName` param)
   - Inserts document with all results + metadata
   - Returns MongoDB document ID

4. **Returns to Client**:
   - Returns comprehensive JSON response
   - Includes all analysis stages' outputs
   - Summarizes key metrics

---

## Active vs Inactive Modules

```
┌──────────────────────────────────────────────────────────────────────┐
│               MODULE USAGE IN PIPELINE                               │
└──────────────────────────────────────────────────────────────────────┘

✅ ACTIVE (Used in Final Pipeline):
├─ analyzer.ts                         Stage 1: Commit analysis
├─ test-analyzer.ts                    Stage 2: Test discovery
├─ context-builder.ts                  Stage 3: Context building
├─ llm-client.ts                       Stages 4,7,8,9: LLM calls
├─ test-prioritizer.ts                 Stage 4: Test prioritization
├─ dependencyAnalyzer.ts               Stage 5: Dependency analysis
├─ test-gap-analyzer.ts                Stage 6: Gap analysis
├─ test-generator.ts                   Stages 7,8: Generation
├─ test-runner.ts                      Stage 9: Execution
├─ framework-resolver.ts               Stage 9: Framework detection
├─ file-discovery.ts                   Stages 1,2,6: File discovery
├─ mongodb-service.ts                  Stage 10: Persistence
├─ auto-mock-generator.ts              Stage 8: Mock generation
├─ symbol-analyzer.ts                  Stage 6: Symbol analysis
├─ prompts.ts                          Stages 4,7,8: LLM prompts
└─ app.ts                              API endpoints

⚠️ PARTIALLY ACTIVE (Context-dependent):
├─ alias-resolver.ts                   Used if project has path aliases
└─ frameworks.ts                        Part of framework detection

Total lines of active code: ~7,500
Pipeline stages using LLM: 3 (prioritization, generation, repair)
```

---

## Summary Table

| File | Stage | Lines | Purpose | Status |
|------|-------|-------|---------|--------|
| analyzer.ts | 1 | 900+ | Commit analysis & diff parsing | ✓ Active |
| test-analyzer.ts | 2 | 1,200+ | Find related tests | ✓ Active |
| context-builder.ts | 3 | 300+ | Build LLM context | ✓ Active |
| llm-client.ts | 4,7,8,9 | 350+ | Gemini API integration | ✓ Active |
| prompts.ts | 4 | 200+ | System & user prompts | ✓ Active |
| test-prioritizer.ts | 4 | 200+ | LLM-based prioritization | ✓ Active |
| dependencyAnalyzer.ts | 5 | 350+ | Dependency change detection | ✓ Active |
| test-gap-analyzer.ts | 6 | 2,200+ | Coverage gap analysis | ✓ Active |
| test-generator.ts | 7,8 | 1,800+ | Test generation & validation | ✓ Active |
| test-runner.ts | 9 | 1,200+ | Test execution | ✓ Active |
| framework-resolver.ts | 9 | 1,000+ | Framework detection | ✓ Active |
| file-discovery.ts | 2 | 50+ | File discovery | ✓ Active |
| mongodb-service.ts | 10 | 150+ | MongoDB persistence | ✓ Active |
| auto-mock-generator.ts | 8 | 100+ | Mock generation | ✓ Active |
| symbol-analyzer.ts | 6 | 250+ | Symbol analysis | ✓ Active |
| app.ts | All | 700+ | Express server & endpoints | ✓ Active |

---

## Configuration & Environment

### Environment Variables Required

```bash
# Gemini API Configuration (REQUIRED)
GEMINI_API_KEY=<your-gemini-api-key>

# MongoDB Configuration (OPTIONAL - for persistence)
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB_NAME=research  # Default: "research"

# Optional: Port configuration (Express server)
PORT=3000  # Default: 3000
```

### Running the Server

```bash
# Install dependencies
npm install

# Development mode with auto-reload
npm run dev

# Server starts on http://localhost:3000
# Endpoints available at http://localhost:3000/api/...
```

---

## Conclusion

This comprehensive framework implements an intelligent, LLM-powered test prioritization and generation pipeline with extensive diagrams and visual documentation. It combines:

✅ **Static analysis precision** - Find related tests using heuristics  
✅ **LLM semantic reasoning** - Prioritize by regression likelihood  
✅ **Coverage gap identification** - Find untested scenarios  
✅ **Automatic test generation** - Create new test cases  
✅ **Auto-repair capability** - Fix failing generated tests  
✅ **Sequential execution** - Execute in priority order  
✅ **Comprehensive persistence** - Save all results to MongoDB  
✅ **Detailed visualization** - ASCII diagrams for understanding  

The pipeline is production-ready and can accelerate software testing by ensuring the most critical tests run first.
