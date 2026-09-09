# LLM test-prioritization pipeline

Implements the `context-builder.ts` → `llm-client.ts` → `test-prioritizer.ts`
step described in the design discussion, built directly on top of the
existing `analyzeCommit()` output (`analyzer.ts`, `dependencyAnalyzer.ts`,
`test-analyzer.ts`).

## One prerequisite change

`context-builder.ts` needs to consume the result of `analyzeCommit()`.
`analyzer.ts` currently doesn't export its `CommitAnalysis` interface, so
either:

- add `export` to `interface CommitAnalysis` in `analyzer.ts` and import it
  in `context-builder.ts`, replacing the local `CommitAnalysisLike`, **or**
- keep `CommitAnalysisLike` as-is — it's structurally compatible with
  `CommitAnalysis`, so `analyzeCommit()`'s return value can be passed in
  without the export, at the cost of the two types silently drifting apart
  if one changes later.

## Usage

```ts
import { analyzeCommit } from "./repository/analyzer.js";
import { buildLLMContext } from "./llm/context-builder.js";
import { LLMClient } from "./llm/llm-client.js";
import { prioritizeTests } from "./llm/test-prioritizer.js";

const analysis = await analyzeCommit(repositoryPath, commitHash);

const context = buildLLMContext(analysis, repositoryPath);

const llmClient = new LLMClient(); // reads GEMINI_API_KEY from env
const result = await prioritizeTests(context, llmClient);

for (const test of result.tests) {
  console.log(`${test.priority}. ${test.testFile} (${test.score})`);
  console.log(`   ${test.reason}`);
}
```

## Design notes

- **Context is capped, not exhaustive.** `buildLLMContext` truncates any
  single file's content (default 6,000 chars) and caps how many candidate
  tests' code gets included (default 15, weakest-confidence ones dropped
  first). This is the "don't send the entire repository" constraint —
  static analysis has already filtered to the relevant files; the context
  builder just keeps any one of them from blowing up the prompt.
- **`changedSymbols` only reports what's evidenced.** It merges detected
  renames (`analyzer.ts`'s `symbolChanges`) with symbols the test-analyzer
  already proved were touched by the commit (`changedSymbolsUsed` on each
  `TestMatch`). It does not try to independently re-derive "what changed"
  from the diff — that logic already exists in `test-analyzer.ts` and
  duplicating it here would risk the two falling out of sync.
- **The LLM cannot introduce new candidate tests.** `test-prioritizer.ts`
  validates every returned `testFile` against `context.candidateTests` and
  silently drops anything that doesn't match — ranking is the model's job,
  candidate discovery stays with static analysis (design doc point 6).
  Candidates the model fails to mention are still returned, ranked by their
  static-analysis confidence, so the output always covers every candidate.
- **`LLMClient` is intentionally minimal.** One method, no SDK dependency,
  Gemini's `responseMimeType: "application/json"` does the structured-output
  enforcement instead of regex/markdown-fence stripping.

## Full pipeline, including the test runner

```ts
import { analyzeCommit } from "./repository/analyzer.js";
import { buildLLMContext } from "./llm/context-builder.js";
import { LLMClient } from "./llm/llm-client.js";
import { prioritizeTests } from "./llm/test-prioritizer.js";
import {
  runPrioritizedTests,
  toPrioritizedTestInputs,
} from "./testing/test-runner.js";

const analysis = await analyzeCommit(repositoryPath, commitHash);
const context = buildLLMContext(analysis, repositoryPath);

const llmClient = new LLMClient();
const prioritization = await prioritizeTests(context, llmClient);

const { testExecution, stoppedEarly } = await runPrioritizedTests(
  toPrioritizedTestInputs(prioritization.tests),
  { repositoryRoot: repositoryPath }
);

for (const result of testExecution) {
  console.log(
    `${result.priority}. ${result.testFile} — ${result.status} (${result.duration}s)`
  );
}
```

## Test runner (`testing/`)

- **`frameworks.ts`** — detects the test framework from the repo's root
  `package.json` (checks for `vitest`, `@playwright/test`/`playwright`,
  `jest`, `mocha` in that order — Playwright first since a repo can have
  both an e2e and a unit framework installed) and maps `(framework,
  testFile)` to the shell command that runs it. Pass `{ framework }`
  explicitly to `runPrioritizedTests` to skip detection, or add a case
  here for a framework not yet supported.
- **`test-runner.ts`** — runs the prioritized tests **sequentially, one at
  a time, in priority order** (not in parallel, not "run everything at
  once") — that ordering is the thing being evaluated. For each test it
  records `status`, `duration`, `exitCode`, `command`, and truncated
  `stdout`/`stderr`, matching the design doc's execution schema.
  - **Mode A (default):** runs every prioritized test regardless of
    failures, since evaluation needs complete results, not just "where did
    it stop".
  - **Mode B:** pass `{ stopOnFailure: true }` to stop at the first
    non-passing test.
  - **Mode C:** pass `{ maxFailures: N }` to stop after N non-passing
    tests. Ignored if `stopOnFailure` is set.
  - `toPrioritizedTestInputs()` adapts `test-prioritizer.ts`'s output
    directly into what the runner expects, so no manual mapping is needed
    at the call site.

## Not yet built (per the design doc's phasing)

- **Test generation** (changed code + existing tests + repo conventions →
  new test scenarios) — deliberately out of scope until prioritization and
  execution are evaluated on their own.
- **`testing/test-discovery.ts`** — a standalone "list all test files in
  this repo" module. Right now `analyzeTests()` in `test-analyzer.ts`
  already does its own file-walking (`getAllFiles`/`isTestFile`); a
  separate discovery module only becomes worth extracting if the runner or
  something else needs test-file listing independent of that analysis.
- **Evaluation/baseline harness** (design doc steps ⑥–⑧: run against
  Cal.com, then Ghost, then compare against "run all tests" as a
  baseline) — this is the next real step once the runner has been
  exercised manually on at least one real commit.