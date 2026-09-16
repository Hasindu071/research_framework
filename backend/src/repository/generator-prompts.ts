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

Hard rules:
- Import path is CRITICAL: Use the EXACT import path provided in "Import path for tests (CRITICAL...)". Do not generate your own import path, do not modify it, do not try to infer a different path based on file names or guesses. The import path has been mathematically calculated from the test file location to the source file location. Any deviation will cause the tests to fail to resolve the import.
- Required imports are MANDATORY: If the section "Required imports (extracted from the changed code)" is provided, you MUST include ALL of those import statements at the very start of your response, BEFORE ANY it() blocks. These symbols are used in the changed code and the tests will fail if they're not imported. Do not invent or guess imports — only use the ones provided.
  CRITICAL: Place import statements ONLY at the absolute top of your entire testCode output, not repeated per test. All imports go at the beginning, then all it() calls follow. Example structure:
  import { createWithEqualityFn } from 'zustand/traditional';
  
  it('first test', () => { ... });
  
  it('second test', () => { ... });

- Do NOT generate a test for anything not listed in "Coverage gaps to fill", even if the source code suggests other edge cases exist, even if it seems related, even if you think it would improve coverage. Those judgments have already been made upstream by static analysis; your job is execution, not discovery.
- Every test case's "addressesGap" field must be copied VERBATIM, character-for-character, from the gap's label in the list you were given. Any test whose addressesGap doesn't exactly match a provided gap will be discarded before it ever reaches the codebase.
- If a gap's condition can't be tested with a small, well-defined test given the information you have, skip that gap entirely rather than inventing a broader or different test to cover it.
- Match the existing test file's framework, style, imports, and conventions exactly. If no existing test file is given, use idiomatic style for the stated framework.
- Write complete, runnable test code for each case — not descriptions, not pseudocode, not "// TODO: implement this."
- Do not invent APIs, imports, or fixtures that aren't implied by the changed code or the existing test file.
- CRITICAL: All variables used in test code MUST be defined before use. Never reference undefined variables like \`id\`, \`someValue\`, etc. If you need a test value, define it first.
- CRITICAL: Syntax correctness is essential. Generate valid JavaScript/TypeScript that will parse without errors:
  - NO double commas: (\`</>,, \` is WRONG, \`</>, \` is CORRECT)
  - NO trailing commas in function arguments: (\`render(...,)\` is WRONG, \`render(...)\` is CORRECT)
  - NO missing closing parens/brackets
  - NO malformed JSX
  - Every opening paren/bracket must have a matching close
  - Every comma must be followed by a value or newline, not another comma
- Mock placement (CRITICAL for vitest): ALL import statements and vi.mock() calls MUST appear at the very top of your entire testCode output, BEFORE any it() blocks. In vitest, vi.mock() must be at top-level module scope to work correctly. The file structure MUST be:
  1. import statements (for vitest, testing library, your symbol, AND any required imports listed in "Required imports")
  2. vi.mock() calls (if needed) — keep each mock on one line if possible, or format it complete and properly (opening paren on first line, closing paren with semicolon on last line)
  3. it()/test() blocks for all test cases
  Do NOT put vi.mock() inside it() blocks or nested anywhere — it will fail. Do NOT put vi.mock() inside test cases — they must be at the absolute top of the entire output, BEFORE any it() call.
  CRITICAL: Mock return values that are objects MUST be formatted correctly: the entire mock definition must parse as complete JavaScript. A mock statement must be complete with all braces and parentheses balanced.
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
      `## Required imports (extracted from the changed code)\n\nThese symbols are used in the changed code and MUST be imported in your generated tests:\n\n\`\`\`typescript\n${importsSection}\n\`\`\`\n\nAdd these imports at the very top of your test code, before any it() blocks but after any vi.mock() calls.`
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
    `## Task\nFor "${target.symbol}", generate exactly one test case per entry in "Coverage gaps to fill" above. CRITICAL: Use the import path provided in "Import path for tests (CRITICAL...)" — this is non-negotiable and has been mathematically calculated. ${componentsToMock.length > 0 ? `Also include vi.mock() statements for the components listed in "Components to stub" at the top of the file, before any describe() blocks.` : ""} Return only the JSON object described in the system prompt.`
  );

  return sections.join("\n\n");
}