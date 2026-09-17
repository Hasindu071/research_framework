import type { TestGenerationTarget } from "./generator-types.js";
import path from "path";

// ======================================================
// SYMBOL EXTRACTION FROM CHANGED CODE
// ======================================================

/**
 * Extract all identifiers that look like function or class names used in the changed code.
 * This helps us determine what needs to be imported in generated tests.
 * 
 * Matches patterns like:
 * - create(...) - function calls
 * - Object.is - static method references
 * - capitalizedIdentifier(...) - function calls
 */
export function extractUsedSymbols(changedCode: string): string[] {
  const symbols = new Set<string>();
  
  // Match identifiers followed by ( or . (function calls, method access)
  const identifierRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[\.(]/g;
  let match: RegExpExecArray | null;
  
  while ((match = identifierRegex.exec(changedCode)) !== null) {
    const symbol = match[1] || '';
    // Skip common keywords and React/test utilities
    if (symbol && !['if', 'for', 'while', 'const', 'let', 'var', 'function', 'return', 'async', 'await'].includes(symbol)) {
      symbols.add(symbol);
    }
  }
  
  // Also match standalone identifiers that are used as arguments or values
  // This catches things like: expect(getResponsesFromOldBooking).toBeDefined()
  const valueRegex = /(?:^|\s|\(|,|=|:|\?)([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\s*(?:\)|,|;|:|\.|\)|$|\n))/gm;
  while ((match = valueRegex.exec(changedCode)) !== null) {
    const symbol = match[1] || '';
    if (symbol && 
        !['if', 'for', 'while', 'const', 'let', 'var', 'function', 'return', 'async', 'await', 'true', 'false', 'null', 'undefined', 'this', 'new'].includes(symbol) &&
        symbol.length > 2) {  // Skip very short names
      symbols.add(symbol);
    }
  }
  
  return Array.from(symbols);
}

/**
 * Extract imports from source file and map symbols to their sources.
 * Returns a map of {symbol} -> {import source}.
 * 
 * Examples:
 * - { createWithEqualityFn: 'zustand/traditional' }
 * - { Object: 'builtin' }
 */
export function extractImportMap(sourceFileContent: string): Record<string, string> {
  const importMap: Record<string, string> = {};
  
  // Match various import styles
  const importRegex = /import\s+(?:{([^}]+)}|(\w+)|\*\s+as\s+(\w+))\s+from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  
  while ((match = importRegex.exec(sourceFileContent)) !== null) {
    const named = match[1];      // named imports: { foo, bar }
    const defaultImport = match[2]; // default import: foo
    const starAs = match[3];       // namespace: * as foo
    const source = match[4] || ''; // 'path/to/module'
    
    if (source) {
      if (defaultImport) {
        importMap[defaultImport] = source;
      }
      if (starAs) {
        importMap[starAs] = source;
      }
      if (named) {
        // Split named imports and add each one
        const names = (named as string).split(',');
        for (const name of names) {
          const cleanName = (name.trim().split(' as ')[0] ?? '').trim();
          if (cleanName) {
            importMap[cleanName] = source;
          }
        }
      }
    }
  }
  
  // Add builtins
  importMap['Object'] = 'builtin';
  importMap['Array'] = 'builtin';
  importMap['String'] = 'builtin';
  importMap['Number'] = 'builtin';
  importMap['Boolean'] = 'builtin';
  
  return importMap;
}

// ======================================================
// COMPONENT IMPORT EXTRACTION FOR AUTO-MOCKING
// ======================================================

/**
 * Extract capitalized (component-like) imports from workspace/relative paths.
 * These are what the LLM should stub out so a render test doesn't depend on
 * the full real dependency tree.
 * 
 * Includes:
 * - Relative imports: ./Foo, ../Foo
 * - Scoped packages: @calcom/*, @components/*, etc.
 * - Workspace monorepo imports: Any import that looks like a local path
 */
export function extractComponentImportsToMock(sourceFileContent: string): string[] {
  const importRegex = /import\s+(?:{([^}]+)}|(\w+)|\*\s+as\s+(\w+))\s+from\s+["']([^"']+)["']/g;
  const results = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(sourceFileContent)) !== null) {
    const named = match[1];
    const defaultImport = match[2];
    const starAs = match[3];
    const source = match[4];

    if (!source) continue;

    // Skip external packages (lodash, react, etc.) unless they're workspace packages
    const isExternalPackage = 
      !source.startsWith(".") &&
      !source.startsWith("@") &&
      !source.startsWith("@calcom") &&
      !source.startsWith("@components") &&
      !source.startsWith("app/") &&
      !source.startsWith("packages/");
    
    if (isExternalPackage) continue;

    // For relative imports, always include if there's a capitalized import
    if (source.startsWith(".")) {
      if (defaultImport && /^[A-Z]/.test(defaultImport)) {
        results.add(source);
      }
      if (starAs && /^[A-Z]/.test(starAs)) {
        results.add(source);
      }
      if (named) {
        const names = (named as string).split(",");
        for (const name of names) {
          const n = (name.trim().split(" as ")[0] ?? "").trim();
          if (n && /^[A-Z]/.test(n)) {
            results.add(source);
          }
        }
      }
      continue;
    }

    // For scoped packages (@calcom/*, @components/*, etc.) and workspace paths
    if (defaultImport && /^[A-Z]/.test(defaultImport)) {
      results.add(source);
    }
    if (starAs && /^[A-Z]/.test(starAs)) {
      results.add(source);
    }
    if (named) {
      const names = (named as string).split(",");
      for (const name of names) {
        const n = (name.trim().split(" as ")[0] ?? "").trim();
        if (n && /^[A-Z]/.test(n)) {
          results.add(source);
        }
      }
    }
  }

  return Array.from(results);
}

// ======================================================
// SYSTEM PROMPT
// ======================================================

export const TEST_GENERATOR_SYSTEM_PROMPT = `You are a senior software engineer generating targeted unit tests for a single changed function or symbol in a codebase.

You will be given:
- The symbol that changed and the file it lives in
- The actual changed code (diff or full body)
- The EXACT import path to use for this symbol (pre-calculated from test file location to source file location)
- A list of required imports that MUST be included (extracted from the changed code)
- An existing test file for that area of code, if one exists
- The test framework in use
- A list called "Coverage gaps to fill" — behaviors that static analysis has PROVEN are not exercised by any existing test, with the exact diff evidence for each

Your job is narrow and specific: generate exactly ONE test case per entry in "Coverage gaps to fill" — no more, no fewer.

Hard rules (in priority order):
1. MATCH THE EXISTING TEST PATTERN EXACTLY: If an existing test file is provided, this is your PRIMARY DIRECTIVE. Copy its exact approach to writing tests. Do not invent new patterns. If existing tests use \`{ findByText } = render(...)\` instead of \`screen.getByText\`, use that exact pattern. If existing tests avoid \`vi.advanceTimersByTimeAsync()\`, do not use it. If existing tests do NOT wrap components in \`StrictMode\`, do NOT add it. Follow the existing file's conventions 100%. The existing test file shows you EXACTLY what is acceptable in this codebase — your job is to match it perfectly, not to improve or deviate.
- Import path is CRITICAL: Use the EXACT import path provided in "Import path for tests (CRITICAL...)". Do not generate your own import path, do not modify it, do not try to infer a different path based on file names or guesses. The import path has been mathematically calculated from the test file location to the source file location. Any deviation will cause the tests to fail to resolve the import.
- Required imports are MANDATORY: If the section "Required imports (extracted from the changed code)" is provided, you MUST include ALL of those import statements at the very start of your response, BEFORE ANY it() blocks. These symbols are used in the changed code and the tests will fail if they're not imported. Do not invent or guess imports — only use the ones provided.
  CRITICAL: Place import statements ONLY at the absolute top of your entire testCode output, not repeated per test. All imports go at the beginning, then all it() calls follow. Example structure:
  import { createWithEqualityFn } from 'zustand/traditional';
  
  it('first test', () => { ... });
  
  it('second test', () => { ... });

- CRITICAL PROHIBITED PATTERNS (do NOT use these):
  * Do NOT wrap component tests in \`<StrictMode>...</StrictMode>\` unless the existing test file explicitly does this. StrictMode is rarely used in existing tests; check the template first. If the template does not use StrictMode, do not add it to your generated tests.
  * Do NOT use \`vi.advanceTimersByTimeAsync()\` unless the existing test file already uses it and shows \`vi.useFakeTimers()\` being called first. If you need to advance timers, ALWAYS call \`vi.useFakeTimers()\` in a \`beforeEach\` or at the start of the test. The pattern MUST be: \`vi.useFakeTimers(); ... vi.advanceTimersByTimeAsync(...);\`
  * Do NOT use \`screen.getByText(...)\` or \`screen.findByText(...)\` unless the existing test file does. If the existing file destructures \`{ getByText, findByText } = render(...)\` or \`{ findByText } = await screen.findByText(...)\`, follow that pattern exactly. Check what the existing tests use and do NOT mix patterns.
  * Do NOT invent new assertion patterns. Use \`expect()\` with the same matchers as the existing tests.
  * CRITICAL: Never import \`screen\` from @testing-library/react unless the existing test file explicitly uses it. Most tests destructure from render() instead. When in doubt, DO NOT import screen.

- Do NOT generate a test for anything not listed in "Coverage gaps to fill", even if the source code suggests other edge cases exist, even if it seems related, even if you think it would improve coverage. Those judgments have already been made upstream by static analysis; your job is execution, not discovery.
- Every test case's "addressesGap" field must be copied VERBATIM, character-for-character, from the gap's label in the list you were given. Any test whose addressesGap doesn't exactly match a provided gap will be discarded before it ever reaches the codebase.
- If a gap's condition can't be tested with a small, well-defined test given the information you have, skip that gap entirely rather than inventing a broader or different test to cover it.
- Match the existing test file's framework, style, imports, and conventions exactly. If no existing test file is given, use idiomatic style for the stated framework.
- Write complete, runnable test code for each case — not descriptions, not pseudocode, not "// TODO: implement this." Every test MUST:
  - Make actual assertions against the function or symbol behavior
  - Use real test data or mocks, not stub placeholders
  - Test the actual behavior described in the coverage gap
  - Return a meaningful result that can pass or fail based on the code being tested
  - NEVER write tests that just do expect(true).toBe(true) or similar no-op assertions
  
  CRITICAL: If you cannot write a real test given the information you have (e.g., you don't understand the function's behavior, dependencies are unclear), SKIP that gap entirely rather than generating a stub test. Stub tests that always pass are worse than no tests.
- Do not invent APIs, imports, or fixtures that aren't implied by the changed code or the existing test file.
- CRITICAL: All variables used in test code MUST be defined before use. Never reference undefined variables like \`id\`, \`someValue\`, etc. If you need a test value, define it first.
- CRITICAL: Scope matters — if you define a component inside a test with \`function Counter() { ... }\`, that component is ONLY scoped to that test block. DO NOT reference it from another test. If multiple tests need a component, define it ONCE outside all it() blocks, at the top level (but still inside the test file), OR use a beforeEach hook.
- CRITICAL: Syntax correctness is essential. Generate valid JavaScript/TypeScript that will parse without errors:
  - NO double commas: (\`</>,, \` is WRONG, \`</>, \` is CORRECT)
  - NO trailing commas in function arguments: (\`render(...,)\` is WRONG, \`render(...)\` is CORRECT)
  - NO missing closing parens/brackets
  - NO malformed JSX
  - Every opening paren/bracket must have a matching close
  - Every comma must be followed by a value or newline, not another comma
- Mock placement (CRITICAL for vitest): ALL import statements and vi.mock() calls MUST appear at the very top of your entire testCode output, BEFORE any it() blocks. In vitest, vi.mock() must be at top-level module scope to work correctly. The file structure MUST be:
  1. import statements (for vitest, testing library, your symbol, AND any required imports listed in "Required imports")
  2. vi.mock() calls (if needed) — CRITICAL: Mock return values MUST have balanced braces and parentheses. Every { must have a }, every ( must have a ). Test this by counting: if you have 3 opening braces, you must have exactly 3 closing braces. Unbalanced mocks will cause esbuild syntax errors.
  3. it()/test() blocks for all test cases
  Do NOT put vi.mock() inside it() blocks or nested anywhere — it will fail. Do NOT put vi.mock() inside test cases — they must be at the absolute top of the entire output, BEFORE any it() call.
  
  CRITICAL: Mock return values that are objects MUST be formatted correctly with all braces and parentheses balanced. NEVER leave a closing brace or paren off the end of a mock. ALWAYS count: { } must be equal, ( ) must be equal.
  
  **MOCK STRUCTURE RULES — MANDATORY:**
  
  Before you generate any mock, verify these rules:
  1. Every vi.mock() call is a complete statement: \`vi.mock(..., () => ({ ... }));\`
  2. Mock return functions ALWAYS return an object with balanced braces
  3. Example CORRECT mock (braces/parens balanced):
     \`\`\`
     vi.mock('@package/module', () => ({
       default: { functionName: vi.fn(() => ({ result: 'value' })) }
     }));
     \`\`\`
     Count: { = 4, } = 4, ( = 3, ) = 3 ✓
  
  4. Example WRONG mock (UNBALANCED — DO NOT generate this):
     \`\`\`
     vi.mock('@package/module', () => ({
       default: { functionName: vi.fn(() => ({ result: 'value' })  // MISSING } and );
     \`\`\`
     This will cause: SyntaxError: Unexpected end of input
  
  5. Before outputting ANY mock, manually verify:
     - Count opening braces { : _count_
     - Count closing braces } : _count_ (must equal opening)
     - Count opening parens ( : _count_
     - Count closing parens ) : _count_ (must equal opening)
     - If any count doesn't match, DO NOT include the mock
  
  6. For nested mocks with multiple levels:
     \`\`\`
     vi.mock('@components/Deep', () => ({
       Component: vi.fn(() => null),
       Helper: {
         method: vi.fn(() => ({}))
       }
     }));
     \`\`\`
     Always end outer mock with \`}));\` — verify the closing } and ) and ;
  
  Your testCode will be inserted into an outer describe() wrapper by the merger. Write imports, mocks, THEN it()/test() calls only.
- Do NOT wrap your test case(s) in a describe() block. The file merger already provides an outer describe() wrapper — your testCode must contain ONLY it()/test() call(s) (plus any vi.mock() calls and imports at the very top), never its own describe(). Your tests will be nested inside the scaffold's describe() automatically.

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
      "testCode": "imports and vi.mock() calls (ONE TIME at the start), then all it() test cases. No describe() wrapper. MUST be syntactically valid."
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

  // Extract component imports that should be auto-mocked
  const componentsToMock = extractComponentImportsToMock(target.sourceFileContent);
  
  // Extract symbols used in changed code and their import sources
  const usedSymbols = extractUsedSymbols(target.changedCode);
  const importMap = extractImportMap(target.sourceFileContent);
  
  // Build list of required imports for the LLM
  const requiredImports: Array<{ symbol: string; source: string }> = [];
  for (const symbol of usedSymbols) {
    if (importMap[symbol] && importMap[symbol] !== 'builtin') {
      requiredImports.push({ symbol, source: importMap[symbol] });
    }
  }

  const sections: string[] = [];

  sections.push(`## Changed symbol\n${target.symbol} (in ${target.sourceFile})`);

  sections.push(`## Import path for tests (CRITICAL — use EXACTLY this path)\nTest file location: ${target.testFile}\nSource file location: ${target.sourceFile}\n\nWhen writing test imports, use this relative path from the test file:\n\`\`\`typescript\nimport { ${target.symbol} } from '${relativeImportPath}';\n\`\`\`\n\nThis is the ONLY correct import path for this test. Do not generate any other import path, even if it looks correct. Use exactly: ${relativeImportPath}`);
  
  // Add section for required imports extracted from changed code
  if (requiredImports.length > 0) {
    const importsSection = requiredImports
      .map((imp) => `import { ${imp.symbol} } from '${imp.source}';`)
      .join('\n');
    
    sections.push(
      `## CRITICAL: Required imports (MUST be included — test will fail without these)\n\nThese symbols are USED IN THE CHANGED CODE and MUST be imported at the very TOP of your generated test code, BEFORE ANY it() blocks.\n\nIf you do not include these imports, the tests will fail with "ReferenceError: X is not defined" errors.\n\n\`\`\`typescript\n${importsSection}\n\`\`\`\n\nPlace these imports FIRST in your testCode output. Nothing else goes before these imports. Then add your it() test blocks.\n\nIf ANY import is missing, the tests WILL FAIL. These are not optional suggestions — they are MANDATORY.`
    );
  } else {
    // Even if no extracted imports, remind about the main symbol import
    sections.push(
      `## CRITICAL: Main symbol import (MUST be included at the start)\n\nYour tests MUST import the changed symbol:\n\n\`\`\`typescript\nimport { ${target.symbol} } from '${relativeImportPath}';\n\`\`\`\n\nPlace this import FIRST in your testCode output, before any it() blocks. Without this import, the test will fail.`
    );
  }

  if (target.commitMessage) {
    sections.push(`## Commit message\n${target.commitMessage}`);
  }

  sections.push(`## Changed code\n\`\`\`\n${target.changedCode}\n\`\`\``);

  sections.push(`## Test framework\n${target.framework}`);

  if (componentsToMock.length > 0) {
    const mockStatements = componentsToMock
      .map((source) => {
        // Generate a simple mock for this import
        const componentName = path.basename(source);
        return `vi.mock('${source}', () => ({ default: () => <div data-testid="${componentName}">Mocked</div> }));`;
      })
      .join("\n");

    sections.push(
      `## Components to stub (auto-mock these paths)\n\nThese imports come from the changed code and should be mocked so the test only exercises \`${target.symbol}\`'s own logic, not its full child tree. Mock each with a simple functional component:\n\n\`\`\`typescript\n${mockStatements}\n\`\`\`\n\nPlace all vi.mock() calls at the very top of the test file, BEFORE any describe() or it() blocks. This is critical for vitest to intercept the imports correctly.\n\nIMPORTANT: Also mock any imports that the source file itself has (not just child components). For example, if the source imports from @components/*, @calcom/*, or other workspace paths, those MUST be mocked too, even if they're not React components. Use simple mocks like () => ({}) for non-components, or stubs that return empty objects/functions.`
    );
  }

  if (target.existingTestFile && target.existingTestCode) {
    if (target.existingTestCodeIsTemplate) {
      sections.push(
        `## Style template (${target.existingTestFile})\n\`\`\`\n${target.existingTestCode}\n\`\`\`\n\nThis is a reference from an existing test file in the same framework (${target.framework}). Use it as a template for:\n- File structure\n- Import organization\n- Test setup patterns\n- Assertion style\n- Mocking patterns\n\nBut generate the actual test code for "${target.symbol}" from scratch using the import path provided in "Import path for tests (CRITICAL...)" above.`
      );
    } else {
      sections.push(
        `## Existing test file (${target.existingTestFile}) — CRITICAL REFERENCE\n\`\`\`\n${target.existingTestCode}\n\`\`\`\n\nCRITICAL: Match this file's style, patterns, and conventions EXACTLY. Use the same:\n- Import sources and organization\n- Test setup and cleanup patterns  \n- Assertion style and libraries\n- How to handle async operations, timers, and rendering\n- Variable naming conventions\n- Mock setup patterns\n- Do NOT wrap in StrictMode unless the existing tests do (most tests do NOT)\n- Do NOT use vi.advanceTimersByTimeAsync() unless you see vi.useFakeTimers() called first in the existing tests\n\nQUERY METHOD (CRITICAL): Check this file's test queries:\n- If the file IMPORTS \`screen\` from '@testing-library/react' and USES \`screen.getByText('...')\`, then USE THAT PATTERN\n- If the file DESTRUCTURES from render like \`const { getByText } = render(...)\`, then USE THAT PATTERN\n- If you see method calls like \`getByText\`, \`findByText\`, \`queryByText\` without 'screen.' prefix, those are destructured — do the same\n- DO NOT mix patterns — pick ONE based on what this file uses\n- DO NOT use \`screen.getByText\` if this file doesn't import screen\n\nDo not deviate from the existing test's patterns even if you think an alternative is better. Your generated tests must be indistinguishable in style from the existing tests.\n\nThe import path from "Import path for tests (CRITICAL...)" above applies — do not copy imports from the existing test file if they import the symbol from a different path.`
      );
    }
  } else {
    sections.push(
      `## Existing tests\nNone found for this symbol. Write idiomatic ${target.framework} tests from scratch. Use the import path provided in "Import path for tests (CRITICAL...)" above.\n\n**CRITICAL: No stub tests allowed.** Each test must:\n- Call the actual function or symbol being tested\n- Use real test data or setup\n- Make meaningful assertions that verify behavior\n- Return a result that can actually pass or fail\n- NEVER just do expect(true).toBe(true) or similar no-op assertions\n\nIf you cannot understand the function well enough to write a real test (missing documentation, unclear parameters, complex dependencies), SKIP that gap entirely and do NOT generate a placeholder.\n\nGuidelines:\n- Do NOT wrap components in StrictMode unless absolutely necessary for the test logic\n- If using timers (vi.advanceTimersByTimeAsync), MUST call vi.useFakeTimers() first\n- Use screen.getByText/findByText sparingly; prefer specific queries like getByTestId\n- If you use utility functions like \`sleep()\`, they MUST be either defined in the test OR imported from './test-utils'. Do NOT use undefined functions.\n- Keep test setup simple and focused on the changed behavior\n- For file system operations, use mocks like \`vi.mock('node:fs')\` if needed\n- For functions that read files or directories, provide mock data or use test fixtures`
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

  // Add pattern examples section emphasizing what NOT to do
  sections.push(`## Critical Pattern Rules (DO NOT deviate)

**Do NOT use these patterns — they will cause test failures:**

WRONG:
\`\`\`typescript
// Using undefined utility functions
it('test', async () => {
  await sleep(100);  // ERROR: sleep is not defined unless imported
});
\`\`\`

RIGHT:
\`\`\`typescript
// Import utility functions if they're needed
import { sleep } from './test-utils';

it('test', async () => {
  await sleep(100);  // Works — sleep is imported
});
\`\`\`

---

WRONG:
\`\`\`typescript
// Using StrictMode without existing test precedent
import { StrictMode } from 'react';
it('test', () => {
  render(<StrictMode><MyComponent /></StrictMode>);
});
\`\`\`

RIGHT (if StrictMode is not in existing tests):
\`\`\`typescript
it('test', () => {
  render(<MyComponent />);
});
\`\`\`

---

WRONG:
\`\`\`typescript
// Using screen.getByText without existing test precedent
import { screen, render } from '@testing-library/react';
it('test', () => {
  render(<MyComponent />);
  const el = screen.getByText('text');
});
\`\`\`

RIGHT (if existing tests destructure from render):
\`\`\`typescript
import { render } from '@testing-library/react';
it('test', () => {
  const { getByText } = render(<MyComponent />);
  const el = getByText('text');
});
\`\`\`

---

WRONG:
\`\`\`typescript
// Defining component inside one test and trying to use it in another
it('test 1', () => {
  function Counter() { return <div>count</div>; }
  render(<Counter />);
});
it('test 2', () => {
  render(<Counter />);  // ERROR: Counter is not defined here!
});
\`\`\`

RIGHT:
\`\`\`typescript
// Define component at the top level, before all it() blocks
function Counter() { return <div>count</div>; }

it('test 1', () => {
  render(<Counter />);
});
it('test 2', () => {
  render(<Counter />);  // Works — Counter is in scope
});
\`\`\`

---

**CRITICAL: Mock syntax errors (will break the test file):**

WRONG (UNBALANCED BRACES):
\`\`\`typescript
// Missing closing brace and paren — esbuild will fail to parse
vi.mock('@calcom/api', () => ({
  useQuery: vi.fn(() => ({ data: undefined })
}));
// ERROR: SyntaxError: Unexpected token, expected ";"
\`\`\`

To count: Count { and }: opening has 2, closing has 1 — NOT BALANCED! ✗

RIGHT (BALANCED BRACES):
\`\`\`typescript
// All braces and parens are balanced
vi.mock('@calcom/api', () => ({
  useQuery: vi.fn(() => ({ data: undefined }))
}));
\`\`\`

To count: Count { = 2, count } = 2 ✓. Count ( = 2, count ) = 2 ✓. ALL BALANCED!

---

WRONG (COMPLEX MOCK WITH UNBALANCED):
\`\`\`typescript
vi.mock('@components/Deep', () => ({
  Component: vi.fn(() => null),
  Helper: {
    method: vi.fn(() => ({}))  // MISSING closing paren and brace
}));
\`\`\`

RIGHT (COMPLEX MOCK BALANCED):
\`\`\`typescript
vi.mock('@components/Deep', () => ({
  Component: vi.fn(() => null),
  Helper: {
    method: vi.fn(() => ({}))
  }
}));
\`\`\`

---

**BEFORE OUTPUTTING ANY MOCK: Manually verify brace/paren balance:**
1. For each vi.mock() call you generate, count opening and closing characters
2. { must equal }
3. ( must equal )
4. If any mismatch, DO NOT output that mock — skip it entirely
5. Unbalanced mocks will cause the entire test file to fail to parse

**Structure reminder:** All imports, vi.mock() calls, and helper function/component definitions MUST come before any it() blocks.

**Always check the existing test file first and copy that pattern exactly.** Your generated tests must blend seamlessly with the existing code.`
  );


  if (target.notes && target.notes.length > 0) {
    sections.push(`## Static analysis notes\n${target.notes.map((n) => `- ${n}`).join("\n")}`);
  }

  sections.push(
    `## Task\nFor "${target.symbol}", generate exactly one test case per entry in "Coverage gaps to fill" above. CRITICAL: Use the import path provided in "Import path for tests (CRITICAL...)" — this is non-negotiable and has been mathematically calculated. ${componentsToMock.length > 0 ? `Also include vi.mock() statements for the components listed in "Components to stub" at the top of the file, before any describe() blocks.` : ""} Return only the JSON object described in the system prompt.`
  );

  return sections.join("\n\n");
}