# AI-Powered Test Intelligence Framework - Complete Technical Guide

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [System Architecture Overview](#system-architecture-overview)
3. [Complete End-to-End Pipeline](#complete-end-to-end-pipeline)
4. [Detailed Module Breakdown](#detailed-module-breakdown)
5. [LLM Integration & Prompting](#llm-integration--prompting)
6. [Data Structures & Database Operations](#data-structures--database-operations)
7. [Test Prioritization Process](#test-prioritization-process)
8. [Test Generation Process](#test-generation-process)
9. [Test Execution & Validation](#test-execution--validation)
10. [Database Schema & Persistence](#database-schema--persistence)
11. [Configuration & Environment](#configuration--environment)

---

## Executive Summary

This is a **production-grade AI-powered test intelligence platform** built with TypeScript/Node.js that analyzes git commits and intelligently prioritizes, generates, and executes tests using large language models (LLM). The framework uses a multi-stage pipeline combining:

- **Static Code Analysis**: AST-based symbol tracking, git diff parsing, dependency analysis
- **LLM-Powered Ranking**: Google Gemini API (or Azure OpenAI) to intelligently rank tests by regression risk
- **Intelligent Test Generation**: LLM-generated test cases targeting specific coverage gaps
- **Automated Test Execution**: Framework-aware test runners (Jest, Vitest, Playwright, Mocha)
- **MongoDB Persistence**: Complete analysis results and test execution data stored per repository

**Key Innovation**: The framework treats the LLM as a *semantic ranker and generator*, not a source of truth. Every test must exist in static analysis first before the LLM can rank or generate it.

---

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                       REST API (Express.js)                    │
│  POST /api/analyze-commit                                      │
│  POST /api/analyze-prioritize-generate                         │
│  POST /api/analyze-and-run                                     │
│  GET  /api/repositories                                        │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 ├─────────────────────────────────────────────┐
                 │                                             │
        ┌────────▼────────┐                           ┌────────▼────────┐
        │ Static Analysis │                           │  LLM Integration│
        │ Layer           │                           │  Layer          │
        ├─────────────────┤                           ├─────────────────┤
        │ • Git diff      │                           │ • Gemini API    │
        │ • AST parsing   │                           │ • Azure OpenAI  │
        │ • Symbol track  │                           │ • Prioritize    │
        │ • Dependency    │                           │ • Generate      │
        │   analysis      │                           │ • Gap analysis  │
        └────────┬────────┘                           └────────┬────────┘
                 │                                             │
        ┌────────▼────────────────────────────────────────────▼────────┐
        │            Test Execution Engine                             │
        ├─────────────────────────────────────────────────────────────┤
        │ • Framework detection (Jest/Vitest/Playwright/Mocha)        │
        │ • Test merging & file writing                               │
        │ • Subprocess spawning and result parsing                    │
        │ • Alias resolution & mock injection                         │
        └────────┬─────────────────────────────────────────────────────┘
                 │
        ┌────────▼─────────────────┐
        │   MongoDB Database       │
        ├─────────────────────────┤
        │ • Analysis results      │
        │ • Test execution logs   │
        │ • Performance metrics   │
        │ • Repository metadata   │
        └─────────────────────────┘
```

---

## Complete End-to-End Pipeline

### Pipeline Trigger
A user makes a POST request to one of the API endpoints:

```typescript
POST /api/analyze-prioritize-generate
Content-Type: application/json

{
  "repositoryPath": "/path/to/git/repo",
  "commitHash": "abc123def456",
  "repoName": "my-project",
  "testCommand": "npm run test --"  // optional
}
```

### STEP 1: COMMIT ANALYSIS (`analyzer.ts`)

**Input**: `repositoryPath`, `commitHash`

**Process**:
1. Use `simple-git` to fetch commit metadata
2. Parse git diff to detect:
   - **File Changes**: Added, modified, deleted, renamed files
   - **Symbol Changes**: Function/class renames via diff heuristics
   - **Dependency Changes**: package.json, yarn.lock modifications
3. For each changed file:
   - Extract line-by-line diffs
   - Identify inserted/deleted/modified lines
   - Track binary vs. text files
4. Use TypeScript AST (`ts-morph`) to:
   - Find function/class/variable definitions
   - Detect usages of changed symbols
   - Map symbol changes to changed files
5. Run test analysis via `test-analyzer.ts`:
   - Find all test files in the repository
   - Match tests to changed source files using 6 relationship signals:
     - **symbol-usage** (strongest): Test references a changed symbol
     - **import**: Test imports the changed file
     - **same-name**: Test file named similarly to source
     - **same-directory**: Co-located in same directory
     - **locale-import**: Uses changed translation file
     - **dependency**: Tests a file importing changed npm package

**Output**: `CommitAnalysis` object

```typescript
interface CommitAnalysis {
  commit: {
    hash: string;           // e.g., "abc123def456"
    message: string;        // e.g., "Fix authentication flow"
    author: string;         // e.g., "john@example.com"
    date: string;          // ISO format timestamp
  };
  summary: {
    filesChanged: number;   // Total count
    totalInsertions: number;
    totalDeletions: number;
  };
  changes: FileChange[];   // One per changed file
  symbolChanges: SymbolChange[];
  symbolAnalysis: {
    symbolChange: SymbolChange;
    analysis: {...};  // AST-based analysis
  }[];
  dependencyChanges: DependencyChange[];
  testAnalysis: TestAnalysisResult;  // Candidate tests found
  rawDiff: string;         // Full git diff output
}

interface FileChange {
  file: string;
  status: "added" | "modified" | "deleted" | "renamed" | "unknown";
  binary: boolean;
  insertions: number;
  deletions: number;
  changedLines: {
    type: "added" | "deleted";
    content: string;
    newLineNumber?: number;
  }[];
}

interface SymbolChange {
  oldName: string;
  newName: string;
  file: string;
  type: "rename" | "modified";
}

interface DependencyChange {
  package: string;
  changeType: "added" | "upgraded" | "downgraded" | "removed";
  from?: string;
  to?: string;
}
```

---

### STEP 2: BUILD LLM CONTEXT (`context-builder.ts`)

**Input**: `CommitAnalysis`

**Process**: Transform raw analysis into LLM-friendly structure

```typescript
interface LLMContext {
  commit: {
    hash: string;
    message: string;
  };
  
  // Changed files summary
  changedFiles: {
    file: string;
    status: string;
  }[];
  
  // Changed symbols summary
  changedSymbols: {
    name: string;
    file: string;
    changeType: "renamed" | "modified";
  }[];
  
  // Dependency changes
  dependencyChanges: {
    package: string;
    changeType: string;
    from?: string;
    to?: string;
  }[];
  
  // Candidate tests ranked by confidence (keep top 15)
  candidateTests: {
    testFile: string;
    changedFile: string;
    relationship: string;  // e.g., "symbol-usage"
    impact?: string;
    confidence: number;    // 0-1
    symbols?: string[];
    symbolKinds?: {
      [symbol: string]: "function" | "class" | "method" | "constant" | "array" | "object" | "variable";
    };
  }[];
  
  // Source code excerpts (truncated to 6000 chars max per file)
  sourceCode: {
    file: string;
    content: string;
    truncated: boolean;
  }[];
  
  // Test file code excerpts
  testCode: {
    file: string;
    content: string;
    truncated: boolean;
  }[];
}
```

**Key Operations**:
- Truncate large files to 6000 characters
- Rank candidate tests by relationship strength
- Keep only top 15 candidate tests to stay within LLM token limits
- Format all data as clean JSON for LLM consumption

**Output**: `LLMContext` ready to send to LLM

---

### STEP 3: PRIORITIZE TESTS (Test Prioritizer)

**Input**: `LLMContext`, LLM API credentials

**System Prompt** (sent to LLM):
```
You are a test-prioritization assistant for a code-change impact
analysis tool. You will be given a git commit's metadata, the
symbols and dependencies it changed, a list of CANDIDATE TESTS that
static analysis has already identified as plausibly related, and the
relevant source/test code.

Your job is ONLY to rank the given candidate tests by how likely each
one is to catch a regression introduced by this commit. You are not
identifying new candidates and you are not writing tests.

Rules:
- Only rank tests that appear in "candidateTests". Never invent a
  test file that isn't in that list.
- "score" is a number from 0 to 1: how likely this test is to detect
  a regression from this specific commit.
- "priority" is a 1-based rank (1 = most important), consistent with
  the score ordering (highest score = priority 1).
- "reason" must reference concrete evidence from the provided code or
  context (a specific symbol, behavior, or relationship) — not a
  generic statement like "this test seems related".
```

**User Prompt** (sent to LLM):
```
Commit message: {commit.message}
Commit hash: {commit.hash}

Changed files:
[JSON of changedFiles]

Changed symbols:
[JSON of changedSymbols]

Dependency changes:
[JSON of dependencyChanges]

Candidate tests (rank ONLY these):
[JSON of candidateTests]

Changed source code:
--- File: {file} (truncated) ---
[code excerpt]
...

Candidate test code:
--- File: {testFile} ---
[test code]
...
```

**LLM Output** (expected JSON response):
```json
{
  "testPrioritization": {
    "tests": [
      {
        "testFile": "src/__tests__/auth.test.ts",
        "priority": 1,
        "score": 0.98,
        "reason": "Tests the getUserById() function which was modified in this commit to handle null userId. Test covers the exact code path changed.",
        "evidence": ["Direct symbol usage", "Validates getUserById behavior", "Covers null-checking logic"]
      },
      {
        "testFile": "src/__tests__/api.test.ts",
        "priority": 2,
        "score": 0.72,
        "reason": "Tests API endpoints that depend on getUserById. Score lower than direct test but still relevant.",
        "evidence": ["Dependency on changed function", "Integration test coverage"]
      }
    ]
  }
}
```

**Processing**:
1. Send HTTP request to LLM API (Google Gemini or Azure OpenAI)
2. Parse JSON response
3. Validate that returned tests exist in candidateTests list
4. Apply RELEVANCE_THRESHOLD (0.3 minimum score)
5. Filter out low-relevance tests
6. Sort by priority score

**Output**: `TestPrioritizationResult[]`

```typescript
interface PrioritizedTest {
  testFile: string;
  priority: number;          // 1 = highest
  score: number;            // 0-1
  reason: string;
  evidence: string[];
}
```

---

### STEP 4: COVERAGE GAP ANALYSIS (`test-gap-analyzer.ts`)

**Input**: Changed source code, existing test code, LLM client

**Purpose**: Identify what's NOT being tested in the changed code

**Process - Tier 1: Fallback Expressions** (Highest Confidence)
1. Detect fallback operators in changed code:
   - `??` (nullish coalescing)
   - `||` (logical OR)
   - `&&` (logical AND)
2. For each fallback, ask LLM:
   - "Is this fallback operator verified by the existing test?"
3. Mark unverified fallbacks as coverage gaps

**Process - Tier 2: General Behavioral Changes**
1. Extract all branches, loops, error handling from changed code
2. Ask LLM to identify changed behaviors:
   - Function return values changed?
   - Error handling flow changed?
   - Loop behavior changed?
3. Check existing test coverage

**Output**: `TestGapAnalysis` per symbol

```typescript
interface TestGapAnalysis {
  targetSymbol: string;
  sourceFile: string;
  
  changedBehaviors: {
    label: string;
    kind: "fallback" | "branch" | "loop" | "return" | "param" | "error-handling" | "other";
    evidence: string;
    cases: {
      condition: string;
      status: "covered" | "not-covered" | "unknown";
      evidence?: string;
    }[];
    overallStatus: "covered" | "not-covered" | "unknown";
  }[];
  
  existingCoverage: string[];  // Already tested behaviors
  
  coverageGaps: {
    label: string;
    kind: "fallback" | "branch" | "loop" | ...;
    evidence: string;
    condition: string;
  }[];
}
```

**Example Output**:
```typescript
{
  targetSymbol: "getUserById",
  sourceFile: "src/auth.ts",
  changedBehaviors: [
    {
      label: "Handles null userId",
      kind: "fallback",
      evidence: "Line 42: return userId ?? getDefaultUser()",
      cases: [
        { condition: "userId is null", status: "covered" },
        { condition: "userId is undefined", status: "not-covered" }
      ],
      overallStatus: "partially-covered"
    }
  ],
  coverageGaps: [
    {
      label: "Undefined userId fallback",
      kind: "fallback",
      evidence: "userId ?? operator not covered when userId === undefined",
      condition: "userId === undefined"
    }
  ]
}
```

---

### STEP 5: TEST GENERATION (`test-generator.ts`)

**Input**: Prioritized tests, coverage gaps, LLM client

**Phase 5A: Build Generation Targets**

For each covered symbol with coverage gaps:
1. Find best test file to extend:
   - Use prioritized test results if available
   - Otherwise resolve via relationship signals (symbol-usage > import > same-name > etc.)
   - If no match, create new test file
2. Find style template if creating new file:
   - Score existing test files by framework match
   - Use most similar test file as style reference
3. Gather context:
   - Changed code snippet
   - Source file content
   - Existing test code (or template)
   - Coverage gaps to fill

**Output**: `TestGenerationTarget[]`

```typescript
interface TestGenerationTarget {
  symbol: string;                    // e.g., "getUserById"
  sourceFile: string;                // e.g., "src/auth.ts"
  testFile: string;                  // e.g., "src/__tests__/auth.test.ts"
  changedCode: string;               // The actual diff
  sourceFileContent: string;         // Full source file
  commitMessage: string;
  existingTestFile: string;
  existingTestCode: string;          // Existing test code or template
  existingTestCodeIsTemplate: boolean;
  isNewTestFile: boolean;            // true = create new file
  framework: string;                 // "vitest" | "jest" | "playwright" | "mocha"
  notes: string[];
  coverageGaps: {
    label: string;
    kind: string;
    evidence: string;
    condition: string;
  }[];
}
```

**Phase 5B: Generate Test Cases via LLM**

For each target, send to LLM:

**System Prompt** (Highly Detailed):
```
You are a senior software engineer generating ONE targeted test case 
for a single changed function or symbol in an existing JavaScript/TypeScript 
test file.

======================================================
CRITICAL OUTPUT RULE
======================================================

The generated test will be inserted DIRECTLY into an EXISTING TEST FILE.

Therefore, your output MUST contain ONLY the new test case.

DO NOT generate:
- import statements
- export statements
- vi.mock() statements
- describe() blocks
- markdown code fences
- explanations
- comments outside the test
- the existing test file
- a complete replacement test file

The generated testCode MUST start with:
  it(
or:
  test(

Example:
  it('uses the fallback value', () => {
    const result = someFunction(null);
    expect(result).toBe('fallback');
  });

======================================================
ABSOLUTE testCode RULES
======================================================

The testCode:
1. MUST start with it( or test(
2. MUST contain exactly ONE test case
3. MUST NOT contain import statements
4. MUST NOT contain export statements
5. MUST NOT contain vi.mock()
6. MUST NOT contain describe()
7. MUST call the actual production symbol
8. MUST contain at least one meaningful expect() or assert()
9. MUST test the behavior described by the coverage gap

If the gap cannot be tested using the existing test file setup, 
SKIP that gap instead of inventing imports, mocks, APIs, or fixtures.

======================================================
EXISTING TEST FILE IS THE PRIMARY SOURCE OF TRUTH
======================================================

If an existing test file is provided, follow its patterns exactly:
- Copy its assertion style
- Copy its rendering style (for React tests)
- Copy its async patterns
- Copy its mocking approach
- Copy its variable naming
- Copy its test naming style

Do NOT introduce patterns that are not already used by the existing test file.

======================================================
TYPESCRIPT TYPE SAFETY
======================================================

The generated test MUST compile successfully as TypeScript.
Respect the actual TypeScript types shown in the provided source code.

If a value has a union type, you MUST narrow the type before accessing 
properties that are not available on every member.
```

**User Prompt**:
```
## CRITICAL OUTPUT RULE

You are generating a test that will be inserted directly into this 
existing test file:

{target.testFile}

Therefore, generate ONLY ONE test block.

DO NOT generate imports.
DO NOT generate export statements.
DO NOT generate vi.mock().
DO NOT generate describe().

Your testCode MUST start with:
  it(
or:
  test(

## ACTUAL PRODUCTION SYMBOL

The changed production symbol is: {target.symbol}

Source file: {target.sourceFile}

The generated test MUST call the actual production symbol.

## Changed code
```typescript
{target.changedCode}
```

## Existing test file — PRIMARY REFERENCE

File: {target.existingTestFile}

```typescript
{target.existingTestCode}
```

Match its style exactly:
- assertion style
- rendering style
- async behavior
- mock patterns
- cleanup patterns
- variable naming

## Coverage Gaps to Fill

{target.coverageGaps.map(gap => `
- Label: ${gap.label}
- Kind: ${gap.kind}
- Evidence: ${gap.evidence}
- Condition: ${gap.condition}
`).join('\n')}

Generate exactly ONE test for each gap.
```

**LLM Output** (expected):
```json
{
  "testCases": [
    {
      "name": "Returns fallback when userId is undefined",
      "purpose": "Verifies that getUserById uses nullish coalescing to return default user when userId is undefined",
      "targetSymbol": "getUserById",
      "addressesGap": "Undefined userId fallback",
      "testCode": "it('returns default user when userId is undefined', () => {\n  const result = getUserById(undefined);\n  expect(result).toEqual(expect.objectContaining({ id: 'default' }));\n});"
    }
  ]
}
```

**Validation**:
1. Verify testCode starts with `it(` or `test(`
2. Verify target symbol is actually called
3. Verify meaningful assertion exists (not just `expect(true).toBe(true)`)
4. Verify addressesGap exactly matches a provided coverage gap
5. Reject any test that generates new imports or mocks

**Output**: `GeneratedTestCase[]`

```typescript
interface GeneratedTestCase {
  name: string;
  purpose: string;
  targetSymbol: string;
  addressesGap: string;
  testCode: string;
}
```

---

### STEP 6: TEST EXECUTION (`test-runner.ts`)

**Input**: Prioritized tests + Generated tests, test command options

**Process**:

**For Existing Tests**:
1. Check if test file exists
2. Resolve test framework (Jest/Vitest/Playwright/Mocha)
3. Find nearest config file
4. Detect package manager (npm/yarn/pnpm)
5. Build test command: `npm run test -- <testFile>`
6. Spawn subprocess with timeout (default 2 minutes)
7. Capture stdout, stderr, exit code
8. Parse results to detect:
   - Pass/fail/error status
   - "No tests run" patterns
   - Import errors
   - Configuration errors

**For Generated Tests**:
1. Merge generated test code into existing test file
   - Or create new test file if `isNewTestFile: true`
2. Verify merge was successful by checking file content
3. Run test using same framework detection process
4. If test fails, optionally attempt repair (max 3 attempts)
5. If test passes or repair attempts exhausted:
   - Keep test if `keepGeneratedTests: true`
   - Otherwise revert to original file

**Output**: `TestExecutionResult[]`

```typescript
interface TestExecutionResult {
  testFile: string;
  priority: number;
  framework: string | null;
  command: string;
  status: "passed" | "failed" | "error" | "skipped" | "not_found";
  duration: number;                // ms
  exitCode: number | null;
  stdout: string;
  stderr: string;                  // Truncated to 20,000 chars
  notes?: string;
  generated?: boolean;             // true = LLM-generated
  generatedTestName?: string;
  keptInTestFile?: boolean;        // For generated tests
}
```

**Test Status Determination**:
- **passed**: Exit code 0 and no failure patterns in output
- **failed**: Exit code non-zero or "FAILED" in output
- **error**: Runtime error, import error, config error
- **skipped**: Framework not installed, config missing, file not found
- **not_found**: Test file doesn't exist

---

## Detailed Module Breakdown

### Core Analysis Modules

#### **analyzer.ts** - Git Commit Analysis
- **Main Export**: `analyzeCommit(repositoryPath, commitHash)`
- **Responsibilities**:
  - Use `simple-git` to fetch commit details
  - Parse full git diff line-by-line
  - Detect symbol renames via diff heuristics (old name → new name patterns)
  - Use `ts-morph` to analyze AST for symbol definitions and usages
  - Integrate with `dependencyAnalyzer` to detect package.json changes
  - Integrate with `test-analyzer` to find related tests
- **Key Functions**:
  - `analyzeCommit()` - Entry point
  - `parseDiff()` - Extract changed lines per file
  - `detectSymbolRenames()` - Identify function/class renames
  - `detectModifiedSymbols()` - Find symbols modified without rename

#### **symbol-analyzer.ts** - AST-Based Symbol Analysis
- **Main Export**: `analyzeSymbol(symbol, sourceFile, project)`
- **Responsibilities**:
  - Use TypeScript compiler to find symbol definitions
  - Trace symbol usages throughout codebase
  - Analyze symbol type (function, class, variable, constant, etc.)
  - Detect parameter changes, return type changes
  - Identify dependent symbols
- **Key Functions**:
  - `analyzeSymbol()` - Analyze a single symbol
  - `findSymbolDefinition()` - Locate symbol in AST
  - `findSymbolUsages()` - Find all references

#### **test-analyzer.ts** - Test/Source Matching
- **Main Export**: `analyzeTests(analysisResult, repositoryRoot, project)`
- **Responsibilities**:
  - Find all test files matching patterns: `*.test.ts`, `*.spec.ts`, `__tests__/**`
  - Link tests to changed source files via 6 relationship signals:
    1. **symbol-usage**: Test imports and calls a changed symbol
    2. **import**: Test imports changed file
    3. **same-name**: Filename matches (e.g., `auth.ts` ↔ `auth.test.ts`)
    4. **same-directory**: Test co-located with source
    5. **locale-import**: Test imports translation file that changed
    6. **dependency**: Test covers file that imports changed npm package
  - Rank relationships by confidence (symbol-usage = 1.0, dependency = 0.3)
- **Key Functions**:
  - `analyzeTests()` - Main entry
  - `findRelatedTests()` - Match tests to source file
  - `calculateTestRelevance()` - Score each match

#### **dependencyAnalyzer.ts** - NPM Dependency Changes
- **Responsibilities**:
  - Parse package.json diffs
  - Parse yarn.lock/package-lock.json diffs
  - Detect added, upgraded, downgraded, removed packages
  - Track version changes
- **Key Functions**:
  - `analyzeDependencyChanges(diff)`

#### **file-discovery.ts** - File Enumeration
- **Responsibilities**:
  - Recursively find all source files (`.ts`, `.tsx`, `.js`, `.jsx`)
  - Find all test files (`.test.ts`, `.spec.ts`, `__tests__/**`)
  - Respect `.gitignore` and ignore patterns
- **Key Functions**:
  - `discoverSourceFiles(repositoryRoot)`
  - `discoverTestFiles(repositoryRoot)`

---

### LLM & Context Modules

#### **context-builder.ts** - LLM Context Structuring
- **Main Export**: `buildLLMContext(analysis, repositoryRoot)`
- **Responsibilities**:
  - Transform `CommitAnalysis` into `LLMContext`
  - Truncate large files (max 6000 chars each)
  - Rank candidate tests by relationship strength
  - Keep only top 15 candidates (token limit optimization)
  - Extract code excerpts
- **Key Functions**:
  - `buildLLMContext()` - Main entry
  - `formatCandidateTest()` - Structure test metadata
  - `truncateCodeExcerpt()` - Shorten files intelligently

#### **llm-client.ts** - Unified LLM Interface
- **Main Export**: `createLLMClient()`
- **Supports**: Google Gemini API, Azure OpenAI
- **Responsibilities**:
  - Initialize LLM client with credentials from environment
  - Send requests with system + user prompts
  - Parse JSON responses
  - Handle retries on rate limits
  - Log API usage
- **Key Functions**:
  - `generateJSON<T>(systemPrompt, userPrompt)` - Make API call
  - Configurable via `LLM_PROVIDER` environment variable

#### **prompts.ts** - Test Prioritization Prompts
- **Exports**:
  - `TEST_PRIORITIZER_SYSTEM_PROMPT` - System instruction
  - `buildTestPrioritizerUserPrompt(context)` - User prompt builder
- **System Prompt** (500+ lines):
  - Instructs LLM to rank only provided candidates
  - Enforces 0-1 score with justification
  - Requires concrete evidence from code
  - Prevents LLM hallucination (no new test files)
- **User Prompt**:
  - Commit message, hash, changed files
  - Changed symbols, dependency changes
  - Candidate tests list
  - Source code excerpts
  - Test code excerpts

#### **generator-prompts.ts** - Test Generation Prompts
- **Exports**:
  - `TEST_GENERATOR_SYSTEM_PROMPT` - System instruction (1000+ lines)
  - `buildTestGeneratorUserPrompt(target)` - User prompt builder
- **System Prompt** (Extremely detailed):
  - Enforces testCode starts with `it(` or `test(`
  - Prohibits imports, exports, mocks, describe blocks
  - Requires actual production symbol call
  - Requires meaningful assertion (not tautology)
  - Enforces TypeScript type safety
  - Requires following existing test file style
  - Max 8 test cases per target
- **User Prompt**:
  - Target symbol name
  - Changed code snippet
  - Existing test file (or template)
  - Framework type
  - Coverage gaps to fill
  - Verified identifiers extracted from source

---

### Test Generation & Execution

#### **test-generator.ts** - Test Case Generation
- **Main Exports**:
  - `buildGenerationTargets()` - Create generation targets
  - `generateTests()` - Request LLM to generate test code
  - `GeneratedTestCase` interface
- **Responsibilities**:
  - Validate source files exist and have no unresolved imports
  - Validate symbol is exported
  - Resolve best test file to extend (or create new)
  - Find style template for new files
  - Request test generation from LLM
  - Validate generated tests:
    - Actual production function called
    - Meaningful assertions present
    - addressesGap matches provided gap exactly
- **Key Functions**:
  - `buildGenerationTargets()` - Build targets
  - `generateTestsForTarget()` - LLM request per target
  - `validateTargetFunctionUsed()` - Ensure symbol is called
  - `validateHasExplicitAssertion()` - Ensure meaningful assertion
  - `findTemplateTestFile()` - Find style template

#### **test-file-writer.ts** - Test File Merging
- **Main Exports**:
  - `mergeGeneratedTests()` - Insert tests into file
  - `revertMerge()` - Undo merge operation
- **Responsibilities**:
  - Parse existing test file (or create new file)
  - Find insertion point (end of file or after last test)
  - Inject generated test code
  - Preserve import statements, existing tests
  - Validate merge result
- **Key Functions**:
  - `mergeGeneratedTests(repo, testFile, isNew, sourceFile, tests, targetSymbol)`
  - `revertMerge(mergeResult)` - Undo changes

#### **test-runner.ts** - Test Execution (2276 lines)
- **Main Exports**:
  - `runPrioritizedTests()` - Execute multiple tests
  - `runExistingTest()` - Run a prioritized test
  - `runGeneratedTest()` - Run a generated test
- **Responsibilities**:
  - Detect test framework (Jest/Vitest/Playwright/Mocha)
  - Find nearest config file (vitest.config.ts, jest.config.js, etc.)
  - Resolve workspace-aware test execution
  - Spawn subprocess with timeout
  - Capture and parse test output
  - Detect framework installation
  - Handle import errors, config errors
  - Merge generated tests and run
  - Support custom test commands
  - Support test repair attempts
- **Key Functions**:
  - `runPrioritizedTests(tests, options)` - Main entry
  - `runSingleTest()` - Delegate to existing or generated runner
  - `runExistingTest()` - Execute prioritized test
  - `runGeneratedTest()` - Execute generated test with merge
  - `executeTestFile()` - Spawn subprocess
  - `spawnTestProcess()` - Low-level subprocess wrapper
  - `findNearestVitestConfig()` - Config resolution
  - `isFrameworkInstalled()` - Check dependencies

#### **framework-resolver.ts** - Test Framework Detection
- **Responsibilities**:
  - Detect test framework from:
    - Config files (vitest.config.ts, jest.config.js, etc.)
    - package.json scripts
    - Test file naming patterns
    - Workspace structure
  - Resolve test command for framework
  - Detect package manager (npm, yarn, pnpm)
  - Build framework-specific test commands
- **Supported Frameworks**: Vitest, Jest, Playwright, Mocha
- **Key Functions**:
  - `resolveFramework(testFile, repositoryRoot)`
  - `buildTestCommand(framework, config)`
  - `detectPackageManager(repositoryRoot)`

#### **test-suite-detector.ts** - Repository Test Structure
- **Responsibilities**:
  - Map entire repository test structure
  - Identify workspace configurations
  - Detect test directories
  - Associate tests with frameworks
- **Key Functions**:
  - `detectRepositoryTestSuite(repositoryRoot)`

#### **test-context-mapper.ts** - Test/Framework Association
- **Responsibilities**:
  - Map test files to their frameworks
  - Provide execution context for each test
- **Key Functions**:
  - `mapAllTestFiles(profile)`

#### **test-gap-analyzer.ts** - Coverage Gap Analysis
- **Main Export**: `analyzeCoverageGaps(input, llmClient)`
- **Responsibilities**:
  - Tier 1: Detect fallback expressions (??, ||, &&)
  - Ask LLM to verify if each fallback is covered
  - Tier 2: Detect general behavioral changes
  - Extract symbol-specific diffs
  - Identify coverage gaps
- **Key Functions**:
  - `analyzeCoverageGaps()` - Main entry
  - `analyzeCoverageGapsBatch()` - Batch analysis
  - `extractFallbackBehaviors()` - Tier 1 analysis

#### **test-prioritizer.ts** - Test Ranking
- **Main Export**: `prioritizeTests(context, llmClient)`
- **Responsibilities**:
  - Send LLM request to rank tests
  - Apply relevance threshold (0.3 minimum)
  - Validate returned tests exist in candidates
  - Return ranked test list
- **Key Functions**:
  - `prioritizeTests()` - Main entry
  - `validateAndNormalize()` - Validate LLM response

---

### Support & Configuration Modules

#### **alias-resolver.ts** - TypeScript Path Alias Resolution
- **Responsibilities**:
  - Resolve TypeScript path aliases (~/components, @/, etc.)
  - Handle vitest.config.ts alias configuration
  - Write temporary alias override configs
  - Clean up overrides after test execution
- **Key Functions**:
  - `extractUnresolvedAlias()` - Find missing alias
  - `resolveAliasTarget()` - Resolve to real path
  - `writeAliasOverrideConfig()` - Create vitest override

#### **auto-mock-generator.ts** - Mock Generation
- **Responsibilities**:
  - Generate mock objects for test compatibility
  - Auto-mock Prisma client
  - Generate fixture data
- **Key Functions**:
  - `generateAutoMock()`

#### **symbol-diff-extractor.ts** - Symbol-Specific Diffs
- **Responsibilities**:
  - Extract diff for a specific symbol
  - Find symbol location in file
  - Extract surrounding context
- **Key Functions**:
  - `extractSymbolDiff(symbol, diff)`
  - `findSymbolRange()`

#### **ts-config-validator.ts** - TypeScript Config
- **Responsibilities**:
  - Validate tsconfig.json
  - Check compilation settings
- **Key Functions**:
  - `validateTsConfig()`

#### **frameworks.ts** - Framework Definitions
- **Exports**:
  - Framework metadata (commands, patterns, config names)
  - Framework-specific test detection patterns

#### **generator-types.ts** - Type Definitions
- **Exports**: All TypeScript interfaces for generation pipeline

#### **mongodb-service.ts** - Database Integration
- **Responsibilities**:
  - Connect to MongoDB
  - Save analysis results
  - Query results by repository
  - List repositories
- **Key Functions**:
  - `connectMongoDB()` - Initialize connection
  - `saveAnalysisResult(repoName, data)` - Persist results
  - `getAnalysisResults(repoName)` - Query results
  - `getLatestAnalysisResult(repoName)` - Get latest
  - `listRepositories()` - List all repos

#### **commit-pipeline.ts** - Pipeline Orchestration
- **Main Export**: `analyzeAndTestCommit(options)`
- **Responsibilities**:
  - Orchestrate full pipeline
  - Coordinate between modules
  - Handle error states
- **Key Functions**:
  - `analyzeAndTestCommit()` - Execute full pipeline

#### **dataset-generator.ts** - Research Dataset Export
- **Responsibilities**:
  - Export results to CSV
  - Generate research datasets
- **Key Functions**:
  - `generateDataset()`

---

## LLM Integration & Prompting

### Google Gemini API Integration

**Initialization**:
```typescript
const llmClient = createLLMClient();
// Reads LLM_PROVIDER (default "gemini")
// Reads GEMINI_API_KEY from environment
```

**API Call Pattern**:
```typescript
const response = await llmClient.generateJSON<ResponseType>(
  TEST_PRIORITIZER_SYSTEM_PROMPT,    // System message (role: system)
  userPrompt                         // User message (role: user)
);
```

**HTTP Request**:
```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={GEMINI_API_KEY}

{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "{system_prompt}\n\n{user_prompt}"
        }
      ]
    }
  ],
  "generationConfig": {
    "temperature": 0,
    "topP": 1,
    "maxOutputTokens": 16384,
    "responseMimeType": "application/json"
  }
}
```

**Response**:
```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "{...valid JSON response...}"
          }
        ]
      },
      "finishReason": "STOP"
    }
  ]
}
```

### Test Prioritizer LLM Flow

1. **Build user prompt** from LLMContext:
   - Commit message, hash
   - Changed files list
   - Changed symbols list
   - Dependency changes
   - Candidate tests list (JSON)
   - Source code excerpts
   - Test code excerpts

2. **Send to LLM**:
   ```typescript
   const raw = await llmClient.generateJSON<RawLLMResponse>(
     TEST_PRIORITIZER_SYSTEM_PROMPT,
     buildTestPrioritizerUserPrompt(context)
   );
   ```

3. **LLM Returns**:
   ```json
   {
     "testPrioritization": {
       "tests": [
         {
           "testFile": "src/__tests__/auth.test.ts",
           "priority": 1,
           "score": 0.98,
           "reason": "Tests getUserById() modified in this commit...",
           "evidence": ["Direct symbol usage", "Validates null handling"]
         }
       ]
     }
   }
   ```

4. **Validate Response**:
   - Verify testFile exists in candidateTests
   - Verify score between 0-1
   - Verify priority is integer
   - Apply RELEVANCE_THRESHOLD (0.3)
   - Filter out low-relevance tests

5. **Return Ranked List**:
   ```typescript
   return {
     tests: normalizedTests,
     filtered: droppedTests
   };
   ```

### Test Generator LLM Flow

1. **Build user prompt** from TestGenerationTarget:
   - Critical output rule (no imports, no describe, etc.)
   - Production symbol name and location
   - Changed code snippet
   - Existing test file code (or template)
   - Framework type
   - Coverage gaps to fill
   - Verified identifiers

2. **Send to LLM**:
   ```typescript
   const raw = await llmClient.generateJSON<RawGenerationResponse>(
     TEST_GENERATOR_SYSTEM_PROMPT,
     buildTestGeneratorUserPrompt(target)
   );
   ```

3. **LLM Returns**:
   ```json
   {
     "testCases": [
       {
         "name": "Returns default user when userId is undefined",
         "purpose": "Verifies nullish coalescing with undefined",
         "targetSymbol": "getUserById",
         "addressesGap": "Undefined userId fallback",
         "testCode": "it('handles undefined userId', () => {\n  const result = getUserById(undefined);\n  expect(result).toEqual(...);\n});"
       }
     ]
   }
   ```

4. **Validate Each Test**:
   - Verify testCode starts with `it(` or `test(`
   - Verify only ONE test in testCode
   - Verify NO imports, NO exports, NO mocks
   - Verify production symbol is called
   - Verify meaningful assertion exists
   - Verify addressesGap exactly matches a provided gap
   - Reject tests that hallucinate new APIs

5. **Return Validated Tests**:
   ```typescript
   return {
     testFile: target.testFile,
     targetSymbol: target.symbol,
     generatedTests: validatedTests
   };
   ```

### Prompt Engineering Details

#### Test Prioritizer - Critical Rules
- **Only rank provided candidates**: "Never invent a test file that isn't in that list"
- **Base on code, not labels**: "A high-confidence static match can still be low-priority if the code shows it doesn't exercise changed behavior"
- **Concrete evidence required**: "Reference concrete evidence from code (specific symbol, behavior) — not generic statement"
- **JSON formatting strict**: "No markdown code fences, no trailing commas, no comments"

#### Test Generator - Critical Rules
- **Direct file insertion**: "Test will be inserted DIRECTLY into existing test file"
- **No imports**: "All required imports must already exist in provided test file"
- **No new mocks**: "Do NOT generate vi.mock() calls"
- **Call production symbol**: "The test MUST execute the actual production symbol"
- **Meaningful assertions**: "NOT accept tautology like expect(true).toBe(true)"
- **Follow existing style**: "Match its assertion style, rendering style, async pattern exactly"
- **Type safety**: "Do NOT use `as any` to bypass TypeScript errors"
- **Skip if blocked**: "If required setup doesn't exist, SKIP the gap instead of inventing"

---

## Data Structures & Database Operations

### MongoDB Connection

**Connection String Format**:
```
mongodb+srv://<username>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
```

**Environment Variables**:
```env
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB_NAME=research  # Default database name
```

**DNS Configuration**:
```typescript
// Framework automatically uses Google's public DNS for SRV lookups
dns.setServers(["8.8.8.8", "8.8.4.4"]);
```

### Data Persistence Flow

**Analysis Result Saved**:
```typescript
await saveAnalysisResult(repoName, {
  repositoryPath: string;
  commitHash: string;
  timestamp: Date;
  
  // Full commit analysis
  commitAnalysis: CommitAnalysis;
  
  // LLM context built from analysis
  llmContext: LLMContext;
  
  // Ranked tests from prioritizer
  prioritizationResult: TestPrioritizationResult;
  
  // Coverage gaps identified
  gapAnalyses: TestGapAnalysis[];
  
  // Generated tests
  generatedTests: GeneratedTestCase[];
  
  // Test execution results
  testResults: TestExecutionResult[];
  
  // Metadata
  savedAt: Date;
  savedAtTimestamp: number;
});
```

**MongoDB Collection Per Repository**:
- Collection name = `repoName` (e.g., "my-project")
- Each document = one commit analysis + execution
- Can query all analyses for a repository
- Can get latest analysis with `{sort: {savedAt: -1}}`

### Query Patterns

**Get All Results for Repository**:
```typescript
const results = await getAnalysisResults("my-project");
// Returns array of documents, one per commit analyzed
```

**Get Latest Result**:
```typescript
const latest = await getLatestAnalysisResult("my-project");
// Returns most recent document or null
```

**List All Repositories**:
```typescript
const repos = await listRepositories();
// Returns array of collection names
```

---

## Test Prioritization Process

### Step-by-Step Prioritization

1. **Input Validation**:
   - Verify candidateTests array not empty
   - If empty, return empty list immediately (skip LLM call)

2. **Build User Prompt**:
   ```
   Commit message: Fix authentication bug
   Commit hash: abc123def456
   
   Changed files:
   - src/auth.ts (modified)
   - src/types.ts (modified)
   
   Changed symbols:
   - getUserById (modified, src/auth.ts)
   - AuthError (modified, src/types.ts)
   
   Candidate tests (rank ONLY these):
   [
     {
       "testFile": "src/__tests__/auth.test.ts",
       "changedFile": "src/auth.ts",
       "relationship": "symbol-usage",
       "confidence": 0.95,
       "symbols": ["getUserById"]
     },
     ...
   ]
   
   Changed source code:
   --- File: src/auth.ts ---
   function getUserById(id) {
     if (!id) return null;  // <-- CHANGED
     return db.find(id);
   }
   
   Candidate test code:
   --- File: src/__tests__/auth.test.ts ---
   it('gets user by id', () => {
     const user = getUserById(123);
     expect(user).toBeDefined();
   });
   ```

3. **Send to LLM**:
   - System + User prompt via Gemini API
   - Set response format to JSON
   - Set temperature = 0 (deterministic)

4. **Parse Response**:
   ```json
   {
     "testPrioritization": {
       "tests": [
         {
           "testFile": "src/__tests__/auth.test.ts",
           "priority": 1,
           "score": 0.95,
           "reason": "Tests getUserById() which was modified to handle null IDs. Direct symbol usage.",
           "evidence": ["Direct symbol usage", "Validates getUserById return value", "Covers null-checking logic"]
         }
       ]
     }
   }
   ```

5. **Validate Each Test**:
   - Check testFile exists in candidateTests
   - Check score is 0-1 range
   - Check priority is integer >= 1
   - If testFile not found → drop test
   - If score < RELEVANCE_THRESHOLD (0.3) → move to filtered

6. **Return Results**:
   ```typescript
   {
     tests: [
       {
         testFile: "src/__tests__/auth.test.ts",
         priority: 1,
         score: 0.95,
         reason: "...",
         evidence: [...]
       }
     ],
     filtered: [
       // Tests below threshold
     ]
   }
   ```

### Handling LLM Errors

**Rate Limit (429)**:
```typescript
if (errorMsg.includes("429") || errorMsg.includes("quota")) {
  console.error("🚨 QUOTA EXCEEDED or RATE LIMITED detected");
  throw error;
}
```

**Authentication (401/403)**:
```typescript
if (errorMsg.includes("403") || errorMsg.includes("unauthorized")) {
  console.error("🚨 AUTHENTICATION/PERMISSION ERROR detected");
  throw error;
}
```

**Network Error**:
```typescript
if (errorMsg.includes("Network error")) {
  console.error("🚨 NETWORK ERROR detected - check connectivity");
  throw error;
}
```

---

## Test Generation Process

### Generation Pipeline

1. **Build Generation Targets**:
   ```
   For each changed symbol:
     - Find best test file to extend (or create new)
     - Validate source file exists and exports symbol
     - Validate source file has no unresolved imports
     - Find coverage gaps for this symbol
     - If gaps > 0:
       - Create TestGenerationTarget
       - Add to targets list
   ```

2. **Validate Source File**:
   ```typescript
   // Check file exists
   if (!fs.existsSync(sourceFileAbsolute)) {
     console.log("SKIPPED: source file does not exist");
     continue;
   }
   
   // Check for unresolved imports
   const unresolvedImports = checkForUnresolvedImports(sourceContent, repositoryRoot);
   if (unresolvedImports.length > 0) {
     console.log("SKIPPED: source file has unresolved imports");
     continue;
   }
   
   // Check symbol is declared
   const isDeclared = checkSymbolDeclared(sourceContent, symbolName);
   if (!isDeclared) {
     console.log("SKIPPED: symbol not declared in source file");
     continue;
   }
   ```

3. **Resolve Test File**:
   ```
   If prioritized test exists for this symbol:
     → Use prioritized test file
   Else if static matches exist:
     → Rank by relationship strength (symbol-usage > import > same-name > ...)
     → Use best match
   Else:
     → Create new test file in same directory as source
   ```

4. **Find Style Template** (for new files):
   ```
   Search repository for test files with:
     - Same framework (Vitest/Jest/Playwright/Mocha)
     - Similar file type (component vs. logic)
     - Nearby directory
   Score candidates:
     - Component match: +40 points
     - Component test style: +40 points
     - Directory proximity: +20 points
   Use highest-scored template
   ```

5. **Request Test Generation**:
   ```typescript
   const userPrompt = buildTestGeneratorUserPrompt(target);
   
   const raw = await llmClient.generateJSON<RawGenerationResponse>(
     TEST_GENERATOR_SYSTEM_PROMPT,
     userPrompt
   );
   ```

6. **Validate Generated Tests**:
   ```typescript
   For each generated test:
     - Check testCode starts with "it(" or "test("
     - Check exactly ONE test in testCode
     - Check target symbol is called: validateTargetFunctionUsed()
     - Check meaningful assertion exists: validateHasExplicitAssertion()
     - Check addressesGap matches provided gap
     - Check no imports/exports/mocks in testCode
   
   Keep only valid tests
   ```

7. **Output Generation Results**:
   ```typescript
   return {
     testFile: target.testFile,
     targetSymbol: target.symbol,
     generatedTests: [
       {
         name: "Returns default when id is null",
         purpose: "Verifies null handling",
         targetSymbol: "getUserById",
         addressesGap: "Null ID handling",
         testCode: "it('handles null id', () => {...});"
       }
     ]
   };
   ```

### Test Validation Logic

**Target Function Called**:
```typescript
function validateTargetFunctionUsed(testCode: string, targetFunctionName: string): boolean {
  return testCode.includes(targetFunctionName);
  // Ensures we're testing actual production code, not mocking everything
}
```

**Meaningful Assertion**:
```typescript
function validateHasExplicitAssertion(testCode: string): boolean {
  // Check for expect() or assert() calls
  const hasExpect = /\bexpect\s*\(/.test(testCode);
  const hasAssert = /\bassert\s*\(/.test(testCode);
  
  if (!hasExpect && !hasAssert) return false;
  
  // Ensure not just tautology: expect(true).toBe(true)
  const meaningfulPatterns = [
    /expect\s*\([^)]+\)\.\w+\s*\(/,  // expect().matcher()
    /\bassert\s*\([^)]+,?\s*[^)]*\)/,  // assert(condition, ...)
  ];
  
  return meaningfulPatterns.some(p => p.test(testCode));
}
```

---

## Test Execution & Validation

### Framework Detection

**Detection Priority**:
1. Config file existence (vitest.config.ts, jest.config.js)
2. package.json "type" field and test scripts
3. File naming patterns
4. Test directory structure
5. Default: Vitest

**Supported Frameworks**:
- **Vitest**: Modern, fast, Vite-native
- **Jest**: Industry standard
- **Playwright**: E2E testing
- **Mocha**: Traditional

### Test Command Building

**Vitest**:
```bash
npm run test -- path/to/test.ts
```

**Jest**:
```bash
npm run test -- path/to/test.ts
```

**Playwright**:
```bash
npm run test -- path/to/test.ts
```

**Mocha**:
```bash
npm run test -- path/to/test.ts
```

### Test Execution

**Subprocess Spawning**:
```typescript
const result = spawn(executable, args, {
  cwd: repositoryRoot,
  timeout: 120000,  // 2 minutes default
  stdio: ["pipe", "pipe", "pipe"]
});

// Capture output with max 20,000 chars
const stdout = output.slice(0, MAX_OUTPUT_CHARS);
const stderr = output.slice(0, MAX_OUTPUT_CHARS);
```

**Result Parsing**:
```
Exit Code 0 + No failure patterns → "passed"
Exit Code != 0 OR "FAILED" in output → "failed"
Error patterns (import, config, etc.) → "error"
"No tests found" pattern → "skipped"
File not found → "not_found"
```

### Error Detection Patterns

**Import Errors**:
```regex
/Failed to resolve import/
/Cannot find module/
/Module not found/
/SyntaxError/
/ERR_MODULE_NOT_FOUND/
```

**Config Errors**:
```regex
/Timed out waiting.*from config\./
/Error: Can't resolve config/
/Invalid config/
/TS5110/
/Option 'module' must be set/
```

**No Tests Executed**:
```regex
Vitest: /No test files found/
Jest: /No tests found/ or /Your test suite must contain at least one test/
```

### Generated Test Execution Flow

1. **Merge into File**:
   ```typescript
   const merge = mergeGeneratedTests(
     repositoryRoot,
     testFile,
     isNewTestFile,
     sourceFile,
     [{name, testCode}],
     targetSymbol
   );
   ```

2. **Verify Merge**:
   ```typescript
   const written = fs.readFileSync(merge.testFileAbsolute, 'utf8');
   
   // Check test name or code snippet found
   if (!written.includes(testName) && !written.includes(codeSnippet)) {
     throw new Error("Merge verification failed");
   }
   ```

3. **Run Test**:
   ```typescript
   const result = await executeTestFile(
     merge.testFileAbsolute,
     frameworkResolution,
     options
   );
   ```

4. **Handle Result**:
   ```
   If passed → Keep generated test ✓
   If failed AND repair attempts < 3 → Request repair from LLM
   If failed AND repair attempts >= 3 → Revert file
   If error → Revert file (compilation error)
   ```

5. **Revert if Needed**:
   ```typescript
   if (!options.keepGeneratedTests) {
     revertMerge(merge);  // Restore original file
   }
   ```

---

## Database Schema & Persistence

### MongoDB Document Structure

**Collection Name**: `{repoName}` (e.g., "my-project", "auth-service")

**Document Example**:
```json
{
  "_id": ObjectId("..."),
  "repositoryPath": "/path/to/repo",
  "commitHash": "abc123def456...",
  "timestamp": ISODate("2024-02-15T10:30:00Z"),
  
  "commitAnalysis": {
    "commit": {
      "hash": "abc123def456",
      "message": "Fix authentication bug in getUserById",
      "author": "dev@example.com",
      "date": "2024-02-15T10:15:00Z"
    },
    "summary": {
      "filesChanged": 2,
      "totalInsertions": 45,
      "totalDeletions": 12
    },
    "changes": [
      {
        "file": "src/auth.ts",
        "status": "modified",
        "binary": false,
        "insertions": 5,
        "deletions": 2,
        "changedLines": [
          {
            "type": "deleted",
            "content": "  if (id === undefined) return null;",
            "newLineNumber": null
          },
          {
            "type": "added",
            "content": "  const validId = id ?? generateId();",
            "newLineNumber": 42
          }
        ]
      }
    ],
    "symbolChanges": [
      {
        "oldName": "getUserById",
        "newName": "getUserById",
        "file": "src/auth.ts",
        "type": "modified"
      }
    ],
    "dependencyChanges": [
      {
        "package": "lodash",
        "changeType": "upgraded",
        "from": "4.17.20",
        "to": "4.17.21"
      }
    ],
    "testAnalysis": {
      "relatedTests": [
        {
          "testFile": "src/__tests__/auth.test.ts",
          "relationship": "symbol-usage",
          "confidence": 0.95,
          "symbols": ["getUserById"]
        }
      ]
    },
    "rawDiff": "diff --git a/src/auth.ts b/src/auth.ts..."
  },
  
  "llmContext": {
    "commit": {
      "hash": "abc123def456",
      "message": "Fix authentication bug"
    },
    "changedFiles": [
      {"file": "src/auth.ts", "status": "modified"}
    ],
    "changedSymbols": [
      {
        "name": "getUserById",
        "file": "src/auth.ts",
        "changeType": "modified"
      }
    ],
    "candidateTests": [
      {
        "testFile": "src/__tests__/auth.test.ts",
        "changedFile": "src/auth.ts",
        "relationship": "symbol-usage",
        "confidence": 0.95,
        "symbols": ["getUserById"],
        "symbolKinds": {
          "getUserById": "function"
        }
      }
    ],
    "sourceCode": [
      {
        "file": "src/auth.ts",
        "content": "function getUserById(id) {\n  const validId = id ?? generateId();\n  return db.find(validId);\n}",
        "truncated": false
      }
    ],
    "testCode": [
      {
        "file": "src/__tests__/auth.test.ts",
        "content": "it('gets user by id', () => {\n  const user = getUserById(123);\n  expect(user).toBeDefined();\n});",
        "truncated": false
      }
    ]
  },
  
  "prioritizationResult": {
    "tests": [
      {
        "testFile": "src/__tests__/auth.test.ts",
        "priority": 1,
        "score": 0.98,
        "reason": "Tests getUserById() which was modified to handle nullable IDs. Direct symbol usage with concrete assertion.",
        "evidence": [
          "Direct symbol usage",
          "Validates getUserById return value",
          "Covers null-coalescing behavior"
        ]
      }
    ],
    "filtered": []
  },
  
  "gapAnalyses": [
    {
      "targetSymbol": "getUserById",
      "sourceFile": "src/auth.ts",
      "changedBehaviors": [
        {
          "label": "Handles undefined ID with nullish coalescing",
          "kind": "fallback",
          "evidence": "const validId = id ?? generateId()",
          "cases": [
            {
              "condition": "id is null",
              "status": "covered"
            },
            {
              "condition": "id is undefined",
              "status": "not-covered"
            }
          ],
          "overallStatus": "partially-covered"
        }
      ],
      "existingCoverage": [
        "getUserById called with valid ID"
      ],
      "coverageGaps": [
        {
          "label": "Handles undefined ID",
          "kind": "fallback",
          "evidence": "id ?? operator behavior when id === undefined",
          "condition": "id === undefined"
        }
      ]
    }
  ],
  
  "generatedTests": [
    {
      "testFile": "src/__tests__/auth.test.ts",
      "targetSymbol": "getUserById",
      "generatedTests": [
        {
          "name": "Generates ID when undefined",
          "purpose": "Verifies nullish coalescing with undefined uses fallback",
          "targetSymbol": "getUserById",
          "addressesGap": "Handles undefined ID",
          "testCode": "it('generates ID when undefined', () => {\n  const user = getUserById(undefined);\n  expect(user).toBeDefined();\n  expect(user.id).toMatch(/^[a-z0-9]+$/);\n});"
        }
      ]
    }
  ],
  
  "testResults": [
    {
      "testFile": "src/__tests__/auth.test.ts",
      "priority": 1,
      "framework": "vitest",
      "command": "npm run test -- src/__tests__/auth.test.ts",
      "status": "passed",
      "duration": 245,
      "exitCode": 0,
      "stdout": "✓ src/__tests__/auth.test.ts (2 tests)",
      "stderr": "",
      "generated": false
    },
    {
      "testFile": "src/__tests__/auth.test.ts",
      "priority": 2,
      "framework": "vitest",
      "command": "npm run test -- src/__tests__/auth.test.ts",
      "status": "passed",
      "duration": 189,
      "exitCode": 0,
      "stdout": "✓ src/__tests__/auth.test.ts (1 tests, 1 generated)",
      "stderr": "",
      "generated": true,
      "generatedTestName": "Generates ID when undefined",
      "keptInTestFile": true
    }
  ],
  
  "savedAt": ISODate("2024-02-15T10:35:00Z"),
  "savedAtTimestamp": 1707988500000
}
```

### Querying Results

**Get All Analyses for Repository**:
```typescript
const db = getDB();
const results = await db.collection("my-project").find({}).toArray();
```

**Get Latest Analysis**:
```typescript
const latest = await db.collection("my-project")
  .findOne({}, { sort: { savedAt: -1 } });
```

**Query by Commit Hash**:
```typescript
const result = await db.collection("my-project")
  .findOne({ "commitAnalysis.commit.hash": "abc123..." });
```

**List All Repositories**:
```typescript
const collections = await db.listCollections().toArray();
const repos = collections.map(c => c.name);
```

---

## Configuration & Environment

### Required Environment Variables

```env
# Gemini API
GEMINI_API_KEY=AIzaSy...your_key...
LLM_PROVIDER=gemini

# MongoDB
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB_NAME=research

# Server
PORT=5000
NODE_ENV=development
```

### Optional Environment Variables

```env
# Azure OpenAI (if using Azure instead of Gemini)
LLM_PROVIDER=azure
AZURE_OPENAI_API_KEY=your_key
AZURE_OPENAI_ENDPOINT=https://your-instance.openai.azure.com/

# Logging
LOG_LEVEL=debug
```

### Sample .env File

```env
# ============================================
# LLM Configuration
# ============================================
GEMINI_API_KEY=AIzaSyClP1r3h4QNO7...your_actual_key...
LLM_PROVIDER=gemini

# ============================================
# MongoDB Configuration
# ============================================
MONGODB_URI=mongodb+srv://research_user:Secure123@research-cluster.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB_NAME=research

# ============================================
# Server Configuration
# ============================================
PORT=5000
NODE_ENV=development

# ============================================
# Optional: Azure OpenAI (uncomment if using)
# ============================================
# LLM_PROVIDER=azure
# AZURE_OPENAI_API_KEY=key-...
# AZURE_OPENAI_ENDPOINT=https://instance.openai.azure.com/
```

### Startup Script

```bash
#!/bin/bash

# Install dependencies
npm install

# Validate environment
if [ -z "$GEMINI_API_KEY" ]; then
  echo "❌ Error: GEMINI_API_KEY not set"
  exit 1
fi

if [ -z "$MONGODB_URI" ]; then
  echo "❌ Error: MONGODB_URI not set"
  exit 1
fi

# Start server
npm run dev
```

---

## Summary

This framework represents a complete end-to-end system for AI-powered test analysis and generation:

1. **Commits analyzed** → Git diff parsing, symbol detection, test matching
2. **LLM called** → Test prioritization based on regression risk
3. **Coverage gaps identified** → Tier-1 (fallback) and Tier-2 (behavioral) analysis
4. **Tests generated** → LLM writes test code filling gaps
5. **Tests validated** → Merge checks, framework detection, execution
6. **Results persisted** → MongoDB storage with full audit trail

The framework is production-ready with error handling, framework support (Jest/Vitest/Playwright/Mocha), and comprehensive logging for research and debugging purposes.

**Key architectural principles**:
- **LLM as ranker, not source**: All candidates pre-screened by static analysis
- **Deterministic test validation**: Rules-based validation of generated tests
- **Framework-agnostic execution**: Supports multiple test frameworks
- **Explainability**: Full audit trail stored in MongoDB
- **Resilience**: Error handling at every stage
- **Type safety**: Full TypeScript implementation
