import type { TestGenerationTarget } from "./generator-types.js";
import path from "path";

// ======================================================
// SYSTEM PROMPT
// ======================================================

export const TEST_GENERATOR_SYSTEM_PROMPT = `You are a senior software engineer generating targeted unit tests for a single changed function or symbol in a codebase.

You will be given:
- The symbol that changed and the file it lives in
- The actual changed code (diff or full body)
- The EXACT import path to use for this symbol (pre-calculated from test file location to source file location)
- An existing test file for that area of code, if one exists
- The test framework in use
- A list called "Coverage gaps to fill" — behaviors that static analysis has PROVEN are not exercised by any existing test, with the exact diff evidence for each

Your job is narrow and specific: generate exactly ONE test case per entry in "Coverage gaps to fill" — no more, no fewer.

Hard rules:
- Import path is CRITICAL: Use the EXACT import path provided in "Import path for tests (CRITICAL...)". Do not generate your own import path, do not modify it, do not try to infer a different path based on file names or guesses. The import path has been mathematically calculated from the test file location to the source file location. Any deviation will cause the tests to fail to resolve the import.
- Do NOT generate a test for anything not listed in "Coverage gaps to fill", even if the source code suggests other edge cases exist, even if it seems related, even if you think it would improve coverage. Those judgments have already been made upstream by static analysis; your job is execution, not discovery.
- Every test case's "addressesGap" field must be copied VERBATIM, character-for-character, from the gap's label in the list you were given. Any test whose addressesGap doesn't exactly match a provided gap will be discarded before it ever reaches the codebase.
- If a gap's condition can't be tested with a small, well-defined test given the information you have, skip that gap entirely rather than inventing a broader or different test to cover it.
- Match the existing test file's framework, style, imports, and conventions exactly. If no existing test file is given, use idiomatic style for the stated framework.
- Write complete, runnable test code for each case — not descriptions, not pseudocode, not "// TODO: implement this."
- Do not invent APIs, imports, or fixtures that aren't implied by the changed code or the existing test file.
- Mock placement (CRITICAL for vitest): ALL import statements and vi.mock() calls MUST appear at the very top of the test file, BEFORE any describe() or it() blocks. In vitest, vi.mock() must be at top-level module scope to work correctly. The file structure MUST be:
  1. import statements (for vitest, testing library, and your symbol)
  2. vi.mock() calls (if needed) — keep each mock on one line if possible, or format it complete and properly (opening paren on first line, closing paren with semicolon on last line)
  3. describe() blocks with it() test cases
  Do NOT put vi.mock() inside describe() blocks or nested anywhere — it will fail.
  CRITICAL: Mock return values that are objects MUST be formatted correctly: the entire mock definition must parse as complete JavaScript. A mock statement must be complete with all braces and parentheses balanced.

JSON formatting (CRITICAL):
Return ONLY valid, strict JSON — no markdown code fences, no comments, no trailing commas.

WRONG:
{
  "testCases": [
    {
      "name": "test 1",
      "testCode": "it('test') { expect(true).toBe(true); }",
    }
  ]
}

RIGHT:
{
  "testCases": [
    {
      "name": "test 1",
      "testCode": "it('test') { expect(true).toBe(true); }"
    }
  ]
}

Every array and object must have no comma after its final element. No markdown code fences around the JSON.

Response format (exact shape required):
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
  // Calculate relative import path from test file to source file
  const testDir = path.dirname(target.testFile);
  const sourceDir = path.dirname(target.sourceFile);
  const sourceBaseName = path.basename(target.sourceFile, path.extname(target.sourceFile));
  
  let relativeImportPath: string;
  if (testDir === sourceDir) {
    // Same directory: use ./filename
    relativeImportPath = `./${sourceBaseName}`;
  } else {
    // Different directory: calculate relative path
    const relativePath = path.relative(testDir, sourceDir);
    relativeImportPath = path.join(relativePath, sourceBaseName).replace(/\\/g, "/");
    if (!relativeImportPath.startsWith(".")) {
      relativeImportPath = `./${relativeImportPath}`;
    }
  }

  const sections: string[] = [];

  sections.push(`## Changed symbol\n${target.symbol} (in ${target.sourceFile})`);

  sections.push(`## Import path for tests (CRITICAL — use EXACTLY this path)\nTest file location: ${target.testFile}\nSource file location: ${target.sourceFile}\n\nWhen writing test imports, use this relative path from the test file:\n\`\`\`typescript\nimport { ${target.symbol} } from '${relativeImportPath}';\n\`\`\`\n\nThis is the ONLY correct import path for this test. Do not generate any other import path, even if it looks correct. Use exactly: ${relativeImportPath}`);

  if (target.commitMessage) {
    sections.push(`## Commit message\n${target.commitMessage}`);
  }

  sections.push(`## Changed code\n\`\`\`\n${target.changedCode}\n\`\`\``);

  sections.push(`## Test framework\n${target.framework}`);

  if (target.existingTestFile && target.existingTestCode) {
    if (target.existingTestCodeIsTemplate) {
      sections.push(
        `## Style template (${target.existingTestFile})\n\`\`\`\n${target.existingTestCode}\n\`\`\`\n\nThis is a reference from an existing test file in the same framework (${target.framework}). Use it as a template for:\n- File structure\n- Import organization\n- Test setup patterns\n- Assertion style\n- Mocking patterns\n\nBut generate the actual test code for "${target.symbol}" from scratch using the import path provided in "Import path for tests (CRITICAL...)" above.`
      );
    } else {
      sections.push(
        `## Existing test file (${target.existingTestFile})\n\`\`\`\n${target.existingTestCode}\n\`\`\`\n\nMatch this file's style and conventions. Use the import path from "Import path for tests (CRITICAL...)" above — do not copy imports from the existing test file if they import the symbol from a different path.`
      );
    }
  } else {
    sections.push(
      `## Existing tests\nNone found for this symbol. Write idiomatic ${target.framework} tests from scratch. Use the import path provided in "Import path for tests (CRITICAL...)" above.`
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
    `## Task\nFor "${target.symbol}", generate exactly one test case per entry in "Coverage gaps to fill" above. CRITICAL: Use the import path provided in "Import path for tests (CRITICAL...)" — this is non-negotiable and has been mathematically calculated. Return only the JSON object described in the system prompt.`
  );

  return sections.join("\n\n");
}