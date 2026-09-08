import type { LLMContext } from "./context-builder.js";

// ======================================================
// SYSTEM PROMPT
// ======================================================
//
// Kept strict and narrow on purpose (design doc point 6): the model
// is a semantic *prioritizer* over evidence static analysis already
// gathered, not a free-form judge of "which tests are related". It
// must not invent test files, and it must justify every ranking.

export const TEST_PRIORITIZER_SYSTEM_PROMPT = `
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
- Base your ranking on the actual code shown, not just the
  relationship label (e.g. "symbol-usage" vs "same-directory").
  A high-confidence static match can still be a low-priority test if
  the code shows it doesn't actually exercise the changed behavior,
  and vice versa.
- "score" is a number from 0 to 1: how likely this test is to detect
  a regression from this specific commit.
- "priority" is a 1-based rank (1 = most important), consistent with
  the score ordering (highest score = priority 1).
- "reason" must reference concrete evidence from the provided code or
  context (a specific symbol, behavior, or relationship) — not a
  generic statement like "this test seems related".
- "evidence" is a short list of concrete tags supporting the reason
  (e.g. "Direct symbol usage", "Validates pagination behavior").
- Respond with JSON only, matching this exact shape:

{
  "testPrioritization": {
    "tests": [
      {
        "testFile": "string, must match a candidateTests[].testFile",
        "priority": 1,
        "score": 0.98,
        "reason": "string",
        "evidence": ["string", "..."]
      }
    ]
  }
}
`.trim();

// ======================================================
// GET PROMPTS
// ======================================================

export function getPrompts() {
  return {
    systemPrompt: TEST_PRIORITIZER_SYSTEM_PROMPT,
    getUserPrompt: buildTestPrioritizerUserPrompt,
  };
}

// ======================================================
// USER PROMPT
// ======================================================

export function buildTestPrioritizerUserPrompt(context: LLMContext): string {
  const sections: string[] = [];

  sections.push(`Commit message: ${context.commit.message}`);
  sections.push(`Commit hash: ${context.commit.hash}`);

  sections.push("\nChanged files:");
  sections.push(JSON.stringify(context.changedFiles, null, 2));

  if (context.changedSymbols.length > 0) {
    sections.push("\nChanged symbols:");
    sections.push(JSON.stringify(context.changedSymbols, null, 2));
  }

  if (context.dependencyChanges.length > 0) {
    sections.push("\nDependency changes:");
    sections.push(JSON.stringify(context.dependencyChanges, null, 2));
  }

  sections.push("\nCandidate tests (rank ONLY these):");
  sections.push(JSON.stringify(context.candidateTests, null, 2));

  if (context.sourceCode.length > 0) {
    sections.push("\nChanged source code:");
    for (const excerpt of context.sourceCode) {
      sections.push(formatExcerpt(excerpt));
    }
  }

  if (context.testCode.length > 0) {
    sections.push("\nCandidate test code:");
    for (const excerpt of context.testCode) {
      sections.push(formatExcerpt(excerpt));
    }
  }

  return sections.join("\n");
}

function formatExcerpt(excerpt: {
  file: string;
  content: string;
  truncated: boolean;
}): string {
  const header = `--- File: ${excerpt.file}${
    excerpt.truncated ? " (truncated)" : ""
  } ---`;

  return `${header}\n${excerpt.content}\n`;
}