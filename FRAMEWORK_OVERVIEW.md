# Research Framework Overview: How It Works with a Commit Hash

## **TL;DR - The Big Picture**

Your framework is an **intelligent test prioritization and generation system** that takes a git commit hash and:
1. **Analyzes** what code changed in that commit
2. **Identifies** which tests are relevant to those changes  
3. **Prioritizes** tests using an AI (Gemini LLM) to run the most important ones first
4. **Generates** new test cases for coverage gaps
5. **Executes** both existing and generated tests to measure impact

Think of it as: *"Given this code change, which tests should I run first, what's missing, and what new tests should I write?"*

---

## **Architecture Overview**

```
┌─────────────────────────────────────────────────────────────────┐
│                    EXPRESS API (app.ts)                         │
│                   Defines HTTP endpoints                         │
└──────────────────────┬──────────────────────────────────────────┘
                       │
        ┌──────────────┴──────────────┬─────────────────┐
        │                             │                 │
   Step 1: ANALYZE              Step 2: BUILD         Step 3: LLM
        │                        CONTEXT              PRIORITIZE
        │                             │                 │
        v                             v                 v
  ┌─────────────────┐         ┌──────────────┐     ┌──────────────┐
  │  analyzer.ts    │         │ context-     │     │test-          │
  │                 │────────→│ builder.ts   │────→│prioritizer.ts │
  │ • Parse diff    │         │              │     │               │
  │ • Find symbols  │         │ • Organize   │     │ • LLM ranks   │
  │ • Detect renames│         │   changes    │     │   tests       │
  │ • Link tests    │         │ • Build      │     │ • Validate    │
  └─────────────────┘         │   prompts    │     └──────────────┘
        ▲                      └──────────────┘            │
        │                                                   │
   Git Commit                                              │
   Analysis                                                │
        │                    ┌─────────────────────────────┘
        │                    │
   Dependency           Step 4: GAP ANALYSIS & GENERATION
   Analysis                │
        │                  v
        │           ┌──────────────────┐
        │           │test-gap-         │
        │           │analyzer.ts       │
        │           │                  │
        │           │ • Analyze gaps   │
        │           │   in coverage    │
        │           └────────┬─────────┘
        │                    │
        │            ┌───────v────────┐
        │            │ test-          │
        │            │ generator.ts   │
        │            │                │
        │            │ • Generate     │
        │            │   test code    │
        │            │   via LLM      │
        │            └────────┬───────┘
        │                     │
        │            Step 5: EXECUTION
        │                     │
        │            ┌────────v────────┐
        │            │test-runner.ts   │
        │            │                 │
        │            │ • Run existing  │
        │            │   prioritized   │
        │            │   tests         │
        │            │ • Run generated │
        │            │   tests         │
        │            │ • Collect       │
        │            │   results       │
        │            └────────┬────────┘
        │                     │
        └─────────────────────┴──→  HTTP Response JSON
```

---

## **Step-by-Step Walkthrough: What Happens When You Submit a Commit Hash**

### **Input**
```json
POST /api/analyze-prioritize-generate
{
  "repositoryPath": "/path/to/repo",
  "commitHash": "abc123def456"
}
```

---

### **Step 1: ANALYZE THE COMMIT** (`analyzer.ts`)

**What it does:**
- Calls `git show --patch` to get the full commit diff
- Parses the diff to extract:
  - **Files changed** (added, modified, deleted, renamed)
  - **Lines changed** (exact line numbers)
  - **Symbols changed** (function names, class names, etc.)
  - **Renames detected** (e.g., `oldFunctionName → newFunctionName`)
  
**Output example:**
```typescript
{
  commit: {
    hash: "abc123",
    message: "Fix login bug",
    author: "dev@company.com",
    date: "2024-09-11"
  },
  changes: [
    { file: "src/auth.ts", status: "modified", binary: false },
    { file: "src/utils.ts", status: "modified", binary: false }
  ],
  symbolChanges: [
    { oldName: "validateUser", newName: "validateUserCredentials", file: "src/auth.ts", type: "rename" }
  ],
  testAnalysis: {
    relatedTests: [
      { testFile: "tests/auth.test.ts", relationship: "direct", confidence: 0.95 },
      { testFile: "tests/user.test.ts", relationship: "indirect", confidence: 0.65 }
    ]
  }
}
```

---

### **Step 2: BUILD LLM CONTEXT** (`context-builder.ts`)

**What it does:**
- Takes the analysis and structures it for the LLM to understand
- **Truncates** large files (max 6,000 chars per file) so the prompt doesn't blow up
- **Ranks candidate tests** by confidence before deciding which ones to include (only top 15 by default)
- **Gathers code snippets**:
  - Changed source files
  - Related test files
- Prepares metadata about dependency changes
  
**This is the "prompt preparation" step** — formatting data so the LLM can make good decisions

**Output example:**
```typescript
{
  commit: { hash: "abc123", message: "Fix login bug" },
  changedFiles: [
    { file: "src/auth.ts", status: "modified" }
  ],
  changedSymbols: [
    { name: "validateUserCredentials", file: "src/auth.ts", changeType: "renamed" }
  ],
  candidateTests: [
    { testFile: "tests/auth.test.ts", relationship: "direct", confidence: 0.95, symbols: ["validateUserCredentials"] }
  ],
  sourceCode: [
    { file: "src/auth.ts", content: "// code snippet...", truncated: false }
  ],
  testCode: [
    { file: "tests/auth.test.ts", content: "// test code snippet...", truncated: false }
  ]
}
```

---

### **Step 3: PRIORITIZE TESTS** (`test-prioritizer.ts`)

**What it does:**
- Sends the context to **Google Gemini API** with the question:
  - *"Given these code changes, rank these tests by how likely they are to catch bugs"*
- The LLM returns a ranked list with:
  - **Priority order** (1, 2, 3, ...)
  - **Score** (0.0 - 1.0 confidence)
  - **Reason** (why this test is important)
  - **Evidence** (which symbols/files justify the ranking)

**Key detail:** The LLM can ONLY rank tests it already knows about (from Step 1). It can't invent new test files. If it tries, they're silently dropped.

**Output example:**
```json
{
  "tests": [
    {
      "testFile": "tests/auth.test.ts",
      "priority": 1,
      "score": 0.98,
      "reason": "Directly tests validateUserCredentials which was renamed",
      "evidence": ["Function renamed", "Login flow changes"]
    },
    {
      "testFile": "tests/user.test.ts",
      "priority": 2,
      "score": 0.65,
      "reason": "May be affected by auth module changes",
      "evidence": ["Indirect dependency"]
    }
  ]
}
```

---

### **Step 4: ANALYZE COVERAGE GAPS & BUILD GENERATION TARGETS** (`test-gap-analyzer.ts` + `buildGenerationTargets`)

**What it does:**
- For each prioritized test, analyzes:
  - What symbols are being tested?
  - What behaviors changed in the commit?
  - Are there gaps? (Changed behaviors not covered by existing tests)
  
- **Builds generation targets** — a list saying:
  - *"For symbol X in file Y, we need tests that cover behavior Z"*

**Output example:**
```typescript
{
  targets: [
    {
      symbol: "validateUserCredentials",
      sourceFile: "src/auth.ts",
      isNewTestFile: false,
      changedBehaviors: [
        "Now throws error on invalid format",
        "Returns credentials object on success"
      ],
      coverageGaps: [
        "Missing test for empty email",
        "Missing test for special characters in password"
      ]
    }
  ]
}
```

---

### **Step 5: GENERATE NEW TESTS** (`test-generator.ts`)

**What it does:**
- For each generation target, sends a new request to the LLM:
  - *"Write test cases for this function given these gaps and this example test code"*
- The LLM generates test code (actual JavaScript/TypeScript test functions)
- Tests are written to temporary files for execution

**Output example:**
```typescript
{
  results: [
    {
      targetSymbol: "validateUserCredentials",
      generatedTests: [
        {
          name: "should throw on empty email",
          testCode: "it('should throw on empty email', () => {\n  expect(() => validateUserCredentials('', 'password')).toThrow();\n});"
        },
        {
          name: "should handle special characters in password",
          testCode: "it('should handle special characters in password', () => {\n  const result = validateUserCredentials('user@test.com', 'p@$$w0rd!');\n  expect(result.password).toBe('p@$$w0rd!');\n});"
        }
      ]
    }
  ]
}
```

---

### **Step 5.5: RUN EXISTING TESTS** (`test-runner.ts`)

**What it does:**
- Takes the prioritized test list from Step 3
- Detects the test framework (Jest, Vitest, Playwright, Mocha)
- Runs each test **sequentially in priority order**
- Records for each test:
  - Status (passed, failed, error, skipped, not_found)
  - Duration
  - Exit code
  - stdout/stderr output

**Output example:**
```json
{
  "testExecution": [
    {
      "testFile": "tests/auth.test.ts",
      "status": "passed",
      "duration": 0.42,
      "framework": "jest",
      "notes": "All assertions passed"
    },
    {
      "testFile": "tests/user.test.ts",
      "status": "failed",
      "duration": 0.31,
      "framework": "jest",
      "notes": "Expected 'xyz' but got 'abc'",
      "error": "AssertionError: ..."
    }
  ]
}
```

---

### **Step 6: RUN GENERATED TESTS** (`test-runner.ts`)

**What it does:**
- Materializes the generated test code into actual test files
- Runs them using the same framework detection
- Reports which generated tests pass/fail
- Can optionally **keep the generated test files** for inspection

**Output example:**
```json
{
  "testExecution": [
    {
      "testFile": "tests/__generated__/auth.generated.test.ts",
      "generatedTestName": "should throw on empty email",
      "status": "passed",
      "duration": 0.15,
      "framework": "jest"
    },
    {
      "testFile": "tests/__generated__/auth.generated.test.ts",
      "generatedTestName": "should handle special characters in password",
      "status": "failed",
      "duration": 0.12,
      "framework": "jest",
      "error": "Expected undefined to be defined"
    }
  ]
}
```

---

## **Full Response Structure**

The final HTTP response includes:

```json
{
  "success": true,
  "commit": {
    "hash": "abc123",
    "message": "Fix login bug",
    "author": "dev@company.com",
    "date": "2024-09-11"
  },
  "analysis": {
    "filesChanged": 2,
    "totalInsertions": 45,
    "totalDeletions": 12,
    "changedSymbols": ["validateUserCredentials"]
  },
  "prioritization": {
    "candidateTests": 5,
    "prioritizedTests": [
      { "testFile": "tests/auth.test.ts", "priority": 1, "score": 0.98, ... }
    ]
  },
  "gapAnalysis": {
    "results": [
      { "symbol": "validateUserCredentials", "changedBehaviors": [...], "coverageGaps": [...] }
    ]
  },
  "generation": {
    "results": [...],
    "summary": {
      "targetCount": 1,
      "generatedCount": 3,
      "failedCount": 0,
      "successRate": "100%"
    }
  },
  "existingTestExecution": {
    "summary": {
      "selected": 5,
      "executed": 5,
      "passed": 4,
      "failed": 1
    },
    "results": [...]
  },
  "generatedTestExecution": {
    "summary": {
      "generated": 3,
      "executed": 3,
      "passed": 2,
      "failed": 1
    },
    "results": [...]
  }
}
```

---

## **Key Concepts for Your Supervisor**

### **1. Why Test Prioritization?**
- You don't always want to run *all* tests (too slow)
- You want to run the *most likely to fail* tests first
- This framework learns which tests matter most for each commit

### **2. Why Test Generation?**
- When code changes, gaps appear in test coverage
- Instead of manually writing tests, the LLM generates them
- Generated tests are validated by actually running them

### **3. The Safety Guardrails**
- The LLM can only prioritize/generate tests for code it was shown
- It can't invent new test files from thin air
- All generated tests are validated by executing them
- If a test fails, that's captured and reported

### **4. The Research Value**
This framework helps answer:
- **Does AI-powered test prioritization reduce test execution time?**
- **Can AI generate valid tests that catch real bugs?**
- **How accurate is LLM analysis of code coverage gaps?**
- **What's the performance vs. accuracy tradeoff?**

---

## **Available API Endpoints**

### **1. `/api/analyze-commit` (Simple Analysis)**
Just analyze a commit without prioritization or generation
```bash
POST /api/analyze-commit
{
  "repositoryPath": "/path/to/repo",
  "commitHash": "abc123"
}
```

### **2. `/api/analyze-prioritize-generate` (Full Pipeline)**
Run the entire pipeline: analyze → prioritize → generate → execute
```bash
POST /api/analyze-prioritize-generate
{
  "repositoryPath": "/path/to/repo",
  "commitHash": "abc123"
}
```

### **3. `/api/analyze-and-run` (Analyze + Execute Existing Tests)**
Analyze and run existing tests (no generation)
```bash
POST /api/analyze-and-run
{
  "repositoryPath": "/path/to/repo",
  "commitHash": "abc123"
}
```

### **4. `/api/run-generated-tests` (Just Execute Generated Tests)**
Run pre-generated tests
```bash
POST /api/run-generated-tests
{
  "repositoryPath": "/path/to/repo",
  "generatedTests": [...]
}
```

---

## **Technology Stack**

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Backend API** | Express.js (Node.js) | REST API server |
| **Commit Analysis** | simple-git, ts-morph | Parse diffs, analyze code structure |
| **Test Framework Detection** | package.json parsing | Detect Jest, Vitest, Playwright, Mocha |
| **LLM Integration** | Google Gemini API | Test prioritization and generation |
| **Language** | TypeScript | Type-safe implementation |
| **Test Runner** | Subprocess execution | Actually run tests and capture output |

---

## **Summary for Your Supervisor**

> *"This research framework automates intelligent test prioritization and generation. When given a git commit, it:*
> 1. *Analyzes what code changed and why*
> 2. *Uses static analysis to find related tests*
> 3. *Leverages an LLM to prioritize tests by impact*
> 4. *Identifies coverage gaps and generates missing tests*
> 5. *Executes both existing and generated tests to validate everything*
> 
> *The framework is built to answer whether AI can reliably improve testing efficiency and quality without manual intervention. All decisions are grounded in static analysis, and all generated tests are validated through execution."*

---

## **Environment Setup**

Required `.env` file:
```
GEMINI_API_KEY=your_api_key_here
PORT=5000
```

Run the server:
```bash
npm install
npm run dev
```

Visit endpoints at `http://localhost:5000/api/*`
