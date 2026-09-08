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

## Not yet built (per the design doc's phasing)

Phase 2 — test *generation* from changed code + existing tests + repo
conventions — is deliberately out of scope here so prioritization can be
evaluated on its own first.