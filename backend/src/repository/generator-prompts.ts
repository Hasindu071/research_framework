import type { TestGenerationTarget } from "./generator-types.js";

// ======================================================
// SYSTEM PROMPT
// ======================================================

export const TEST_GENERATOR_SYSTEM_PROMPT = `You are a senior software engineer generating targeted unit tests for a single changed function or symbol in a codebase.

You will be given:
- The symbol that changed and the file it lives in
- The actual changed code (diff or full body)
- An existing test file for that area of code, if one exists
- The test framework in use
- A list called "Coverage gaps to fill" — behaviors that static analysis has PROVEN are not exercised by any existing test, with the exact diff evidence for each

Your job is narrow and specific: generate exactly ONE test case per entry in "Coverage gaps to fill" — no more, no fewer.

Hard rules:
- Do NOT generate a test for anything not listed in "Coverage gaps to fill", even if the source code suggests other edge cases exist, even if it seems related, even if you think it would improve coverage. Those judgments have already been made upstream by static analysis; your job is execution, not discovery.
- Every test case's "addressesGap" field must be copied VERBATIM, character-for-character, from the gap's label in the list you were given. Any test whose addressesGap doesn't exactly match a provided gap will be discarded before it ever reaches the codebase.
- If a gap's condition can't be tested with a small, well-defined test given the information you have, skip that gap entirely rather than inventing a broader or different test to cover it.
- Match the existing test file's framework, style, imports, and conventions exactly. If no existing test file is given, use idiomatic style for the stated framework.
- Write complete, runnable test code for each case — not descriptions, not pseudocode, not "// TODO: implement this."
- Do not invent APIs, imports, or fixtures that aren't implied by the changed code or the existing test file.

Respond with ONLY a JSON object in this exact shape, and nothing else — no markdown fences, no commentary:

{
  "testCases": [
    {
      "name": "short descriptive test name",
      "purpose": "one sentence: what behavior this test verifies and why it matters given the change",
      "targetSymbol": "the symbol name this test exercises",
      "addressesGap": "copied verbatim from the gap label this test satisfies",
      "testCode": "complete, runnable test code as a string"
    }
  ]
}`;

// ======================================================
// USER PROMPT
// ======================================================

export function buildTestGeneratorUserPrompt(target: TestGenerationTarget): string {
  const sections: string[] = [];

  sections.push(`## Changed symbol\n${target.symbol} (in ${target.sourceFile})`);

  if (target.commitMessage) {
    sections.push(`## Commit message\n${target.commitMessage}`);
  }

  sections.push(`## Changed code\n\`\`\`\n${target.changedCode}\n\`\`\``);

  sections.push(`## Test framework\n${target.framework}`);

  if (target.existingTestFile && target.existingTestCode) {
    sections.push(
      `## Existing test file (${target.existingTestFile})\n\`\`\`\n${target.existingTestCode}\n\`\`\`\n\nMatch this file's style and conventions.`
    );
  } else {
    sections.push(
      `## Existing tests\nNone found for this symbol. Write idiomatic ${target.framework} tests from scratch.`
    );
  }

  sections.push(
    `## Coverage gaps to fill (generate EXACTLY one test per gap, no more, no fewer)\n` +
      target.coverageGaps
        .map(
          (g, i) =>
            `${i + 1}. ${g.condition}\n   originating change: \`${g.evidence}\`\n   addressesGap label to copy verbatim: "${g.label}"`
        )
        .join("\n\n")
  );

  if (target.notes && target.notes.length > 0) {
    sections.push(`## Static analysis notes\n${target.notes.map((n) => `- ${n}`).join("\n")}`);
  }

  sections.push(
    `## Task\nFor "${target.symbol}", generate exactly one test case per entry in "Coverage gaps to fill" above. Return only the JSON object described in the system prompt.`
  );

  return sections.join("\n\n");
}