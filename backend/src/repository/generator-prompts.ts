import type { TestGenerationTarget } from "./generator-types.js";
import path from "path";

// ======================================================
// SYMBOL EXTRACTION FROM CHANGED CODE
// ======================================================

/**
 * Extract all identifiers that look like function or class names used in the changed code.
 */
export function extractUsedSymbols(changedCode: string): string[] {
  const symbols = new Set<string>();

  const identifierRegex =
    /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[\.(]/g;

  let match: RegExpExecArray | null;

  while ((match = identifierRegex.exec(changedCode)) !== null) {
    const symbol = match[1] || "";

    if (
      symbol &&
      ![
        "if",
        "for",
        "while",
        "const",
        "let",
        "var",
        "function",
        "return",
        "async",
        "await",
      ].includes(symbol)
    ) {
      symbols.add(symbol);
    }
  }

  const valueRegex =
    /(?:^|\s|\(|,|=|:|\?)([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\s*(?:\)|,|;|:|\.|\)|$|\n))/gm;

  while ((match = valueRegex.exec(changedCode)) !== null) {
    const symbol = match[1] || "";

    if (
      symbol &&
      ![
        "if",
        "for",
        "while",
        "const",
        "let",
        "var",
        "function",
        "return",
        "async",
        "await",
        "true",
        "false",
        "null",
        "undefined",
        "this",
        "new",
      ].includes(symbol) &&
      symbol.length > 2
    ) {
      symbols.add(symbol);
    }
  }

  return Array.from(symbols);
}

// ======================================================
// IMPORT MAP
// ======================================================

export function extractImportMap(
  sourceFileContent: string
): Record<string, string> {
  const importMap: Record<string, string> = {};

  const importRegex =
    /import\s+(?:{([^}]+)}|(\w+)|\*\s+as\s+(\w+))\s+from\s+["']([^"']+)["']/g;

  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(sourceFileContent)) !== null) {
    const named = match[1];
    const defaultImport = match[2];
    const starAs = match[3];
    const source = match[4] || "";

    if (!source) continue;

    if (defaultImport) {
      importMap[defaultImport] = source;
    }

    if (starAs) {
      importMap[starAs] = source;
    }

    if (named) {
      const names = named.split(",");

      for (const name of names) {
        const cleanName = (
          name.trim().split(" as ")[0] ?? ""
        ).trim();

        if (cleanName) {
          importMap[cleanName] = source;
        }
      }
    }
  }

  importMap["Object"] = "builtin";
  importMap["Array"] = "builtin";
  importMap["String"] = "builtin";
  importMap["Number"] = "builtin";
  importMap["Boolean"] = "builtin";

  return importMap;
}

// ======================================================
// COMPONENT IMPORT EXTRACTION
// ======================================================

export function extractComponentImportsToMock(
  sourceFileContent: string
): string[] {
  const importRegex =
    /import\s+(?:{([^}]+)}|(\w+)|\*\s+as\s+(\w+))\s+from\s+["']([^"']+)["']/g;

  const results = new Set<string>();

  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(sourceFileContent)) !== null) {
    const named = match[1];
    const defaultImport = match[2];
    const starAs = match[3];
    const source = match[4];

    if (!source) continue;

    const isExternalPackage =
      !source.startsWith(".") &&
      !source.startsWith("@") &&
      !source.startsWith("app/") &&
      !source.startsWith("packages/");

    if (isExternalPackage) continue;

    if (source.startsWith(".")) {
      if (
        defaultImport &&
        /^[A-Z]/.test(defaultImport)
      ) {
        results.add(source);
      }

      if (starAs && /^[A-Z]/.test(starAs)) {
        results.add(source);
      }

      if (named) {
        const names = named.split(",");

        for (const name of names) {
          const n = (
            name.trim().split(" as ")[0] ?? ""
          ).trim();

          if (n && /^[A-Z]/.test(n)) {
            results.add(source);
          }
        }
      }

      continue;
    }

    if (
      defaultImport &&
      /^[A-Z]/.test(defaultImport)
    ) {
      results.add(source);
    }

    if (starAs && /^[A-Z]/.test(starAs)) {
      results.add(source);
    }

    if (named) {
      const names = named.split(",");

      for (const name of names) {
        const n = (
          name.trim().split(" as ")[0] ?? ""
        ).trim();

        if (n && /^[A-Z]/.test(n)) {
          results.add(source);
        }
      }
    }
  }

  return Array.from(results);
}

// ======================================================
// PRISMA IMPORT EXTRACTION
// ======================================================

export function extractPrismaImports(
  sourceFileContent: string
): Array<{
  statement: string;
  style: "default" | "named";
  name: string;
  source: string;
}> {
  const results: Array<{
    statement: string;
    style: "default" | "named";
    name: string;
    source: string;
  }> = [];

  const importRegex =
    /import\s+(?:{([^}]+)}|(\w+)|\*\s+as\s+(\w+))\s+from\s+["'](@?(?:@calcom\/)?prisma[^"']*|@prisma\/[^"']*)['"]/g;

  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(sourceFileContent)) !== null) {
    const named = match[1];
    const defaultImport = match[2];
    const starAs = match[3];
    const source = match[4] || "";

    if (!source) continue;

    if (defaultImport) {
      results.push({
        statement: `import ${defaultImport} from '${source}';`,
        style: "default",
        name: defaultImport,
        source,
      });
    }

    if (starAs) {
      results.push({
        statement: `import * as ${starAs} from '${source}';`,
        style: "default",
        name: starAs,
        source,
      });
    }

    if (named) {
      const names = named
        .split(",")
        .map((n) => n.trim());

      for (const nameClause of names) {
        const [importName] =
          nameClause.split(/\s+as\s+/);

        if (importName) {
          results.push({
            statement: `import { ${nameClause} } from '${source}';`,
            style: "named",
            name: importName,
            source,
          });
        }
      }
    }
  }

  return results;
}

// ======================================================
// SYSTEM PROMPT
// ======================================================

export const TEST_GENERATOR_SYSTEM_PROMPT = `
You are a senior software engineer generating ONE targeted test case for a single changed function or symbol in an existing JavaScript/TypeScript test file.

You will be given:

- The symbol that changed
- The source file containing the symbol
- The actual changed code
- The existing test file
- The test framework
- Coverage gaps that static analysis has identified
- The exact behavior that each test must verify

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
- existing imports
- existing helper functions
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
7. MUST NOT contain markdown fences
8. MUST NOT reproduce the existing test file
9. MUST call the actual production symbol
10. MUST contain at least one meaningful expect() or assert()
11. MUST test the behavior described by the coverage gap
12. MUST use only imports, mocks, helpers, and utilities already available in the existing test file
13. MUST follow the existing test file's style
14. MUST use real test data
15. MUST not create fake placeholder behavior

If the gap cannot be tested using the existing test file setup, SKIP that gap instead of inventing imports, mocks, APIs, or fixtures.

======================================================
ASSERTION REQUIREMENT
======================================================

Every generated test MUST contain at least one meaningful assertion.

VALID:

expect(result).toBe(expectedValue);

expect(result).toEqual(expectedObject);

expect(result).toContain(expectedValue);

expect(mockFunction).toHaveBeenCalledWith(expectedArgument);

expect(array).toHaveLength(3);

INVALID:

expect(true).toBe(true);

expect(false).toBe(false);

expect(result).toBeDefined();

expect(result).not.toBeNull();

A test containing only toBeDefined() or not.toBeNull() is NOT acceptable unless existence itself is explicitly the behavior being tested.

The assertion must verify the actual behavior described in "What to test".

======================================================
ACTUAL PRODUCTION FUNCTION
======================================================

The test MUST execute the actual production symbol.

For example:

it('returns the expected value', () => {
  const result = actualProductionFunction(input);
  expect(result).toBe(expected);
});

DO NOT recreate the production function inside the test.

DO NOT write fake logic such as:

const result = true;
expect(result).toBe(true);

The purpose of the generated test is to exercise the real production implementation.

======================================================
EXISTING TEST FILE IS THE PRIMARY SOURCE OF TRUTH
======================================================

If an existing test file is provided, follow its patterns exactly.

Copy its:

- assertion style
- rendering style
- async style
- mocking approach
- variable naming
- setup approach
- cleanup approach
- query style
- test naming style
- framework conventions

Do NOT introduce patterns that are not already used by the existing test file.

For example:

If the existing file uses:

const { getByText } = render(...);

then use that style.

Do NOT introduce:

screen.getByText(...)

unless the existing test file already uses screen.

If the existing test file does not use StrictMode, do NOT add StrictMode.

If the existing test file uses vi.useFakeTimers(), follow that pattern.

Do NOT introduce new timer APIs unless the existing test file already demonstrates them.

======================================================
NO NEW IMPORTS
======================================================

This is extremely important.

The existing test file already contains imports.

Therefore NEVER output:

import { useAtomsDevtools } from "...";

NEVER output:

import { render } from "@testing-library/react";

NEVER output:

import { expect } from "vitest";

NEVER output:

import { it } from "vitest";

NEVER output:

import { vi } from "vitest";

All required imports must already exist in the provided test file.

If the required symbol or dependency is not available, SKIP the gap.

======================================================
NO NEW MOCKS
======================================================

Do NOT generate vi.mock() calls.

Do NOT create new module mocks.

Use only mocks that already exist in the provided test file.

If the production code requires a dependency that is not already available through the existing test setup, skip the gap.

This prevents invented or invalid imports and mocks.

======================================================
NO DESCRIBE WRAPPER
======================================================

Do NOT generate:

describe('...', () => {
  it('...', () => {
    ...
  });
});

Only generate the individual test:

it('...', () => {
  ...
});

The existing file/merger will handle the surrounding structure.

======================================================
SYNTAX REQUIREMENTS
======================================================

The generated test MUST be valid JavaScript/TypeScript.

Make sure:

- parentheses are balanced
- braces are balanced
- brackets are balanced
- strings are closed
- JSX is valid when the existing test file uses JSX
- all variables are defined
- no undefined helper functions are introduced
- no undefined imports are introduced
- no fake APIs are introduced

======================================================
TYPESCRIPT TYPE SAFETY
======================================================

The generated test MUST compile successfully as TypeScript.

Respect the actual TypeScript types shown in the provided source
code and existing test file.

If a value has a union type, you MUST narrow the type before
accessing properties that are not available on every member.

For example, if a result may contain either \`v\` or \`e\`:

CORRECT:

if (result && 'v' in result) {
  expect(result.v).toBe(expectedValue);
}

CORRECT:

if (result && 'e' in result) {
  expect(result.e).toBe(expectedError);
}

WRONG:

expect(result.v).toBe(expectedValue);

WRONG:

expect(result.e).toBe(expectedError);

Do NOT access a property directly if TypeScript reports that the
property does not exist on the value's type.

Do NOT invent properties.

Do NOT use arbitrary type casts such as \`as any\` just to bypass
TypeScript errors.

If the required behavior cannot be tested without violating the
actual TypeScript types, SKIP that coverage gap.

======================================================
CONTROL-FLOW AND BEHAVIOR ACCURACY
======================================================

The coverage gap describes an internal production-code behavior,
not necessarily the direct action that should be asserted.

Before generating a test, trace the relevant production code
control flow and determine the exact sequence of inputs, API calls,
state changes, subscriptions, or events required to reach the
specified branch.

Do NOT assume that calling an API automatically triggers the
behavior described by the coverage gap.

For example, if the production code contains:

if (action.type === 'unsub') {...}

DO NOT simply expect an \`unsub\` action to occur.

First determine from the actual source code:

- what creates the \`unsub\` action
- what API call causes it
- what state or subscription must exist first
- what arguments are required
- what event causes the action to be dispatched
- what observable behavior proves that the branch was executed

The generated test MUST reproduce the real conditions required to
reach the target branch.

Do NOT invent an event, callback, action, or state transition.

If the exact control flow required to reach the coverage gap cannot
be established from the provided source code and existing test file,
SKIP the gap rather than guessing.

The assertion must verify the actual observable behavior produced by
the production implementation, not merely the expected internal
condition.

======================================================
COVERAGE GAP REQUIREMENT
======================================================

Generate exactly ONE test for each supplied coverage gap.

Do NOT invent additional tests.

Do NOT test unrelated behavior.

The coverage gap is the specification.

The test MUST directly exercise the behavior described in:

"What to test"

Trace the production control flow before writing the test.

The test must perform the real sequence of operations required to
reach the target branch or behavior.

Do NOT assert that an internal action/event occurred unless the
source code shows exactly how that action/event is produced.

The test should fail if the changed production behavior is broken,
while passing against the current implementation.

======================================================
ADDRESSES GAP
======================================================

The addressesGap field MUST be copied VERBATIM from the supplied coverage gap label.

Do not rewrite it.

Do not shorten it.

Do not change punctuation.

======================================================
JSON OUTPUT
======================================================

Return ONLY valid JSON.

No markdown.

No code fences.

No explanation.

Exact structure:

{
  "testCases": [
    {
      "name": "short descriptive test name",
      "purpose": "one sentence describing the behavior verified",
      "targetSymbol": "the symbol name",
      "addressesGap": "copied verbatim from the coverage gap label",
      "testCode": "it('...', () => { ... });"
    }
  ]
}

The testCode value MUST contain ONLY ONE test block.

The first characters of testCode MUST be:

it(

or:

test(

Never:

import

Never:

describe

Never:

export

Never:

\`\`\`

======================================================
FINAL SELF-CHECK
======================================================

Before returning the JSON, verify:

[ ] testCode starts with it( or test(
[ ] exactly one test case exists
[ ] no import statements exist
[ ] no export statements exist
[ ] no vi.mock() exists
[ ] no describe() exists
[ ] no markdown exists
[ ] actual production symbol is called
[ ] meaningful expect() or assert() exists
[ ] assertion verifies the requested behavior
[ ] all variables are defined
[ ] syntax is valid
[ ] addressesGap exactly matches the supplied label
[ ] TypeScript types are respected
[ ] union-type properties are narrowed before access
[ ] no \`as any\` or unsafe casts are used to bypass type errors
[ ] generated test should compile successfully

If any requirement cannot be satisfied, skip that gap instead of inventing code.
`;

// ======================================================
// USER PROMPT
// ======================================================

export function buildTestGeneratorUserPrompt(
  target: TestGenerationTarget
): string {
  // ----------------------------------------------------
  // Calculate relative production import path
  // ----------------------------------------------------

  const testDir = path.dirname(target.testFile);
  const sourceDir = path.dirname(target.sourceFile);
  const sourceBaseName = path.basename(
    target.sourceFile,
    path.extname(target.sourceFile)
  );

  let relativeImportPath: string;

  if (testDir === sourceDir) {
    relativeImportPath = `./${sourceBaseName}`;
  } else {
    const relativePath = path.relative(
      testDir,
      sourceDir
    );

    relativeImportPath = path
      .join(relativePath, sourceBaseName)
      .replace(/\\/g, "/");

    if (!relativeImportPath.startsWith(".")) {
      relativeImportPath = `./${relativeImportPath}`;
    }
  }

  // ----------------------------------------------------
  // These are kept for analysis/context only.
  // They are NOT instructions for the LLM to generate
  // imports or mocks.
  // ----------------------------------------------------

  const componentsToMock =
    extractComponentImportsToMock(
      target.sourceFileContent
    );

  const prismaImports =
    extractPrismaImports(
      target.sourceFileContent
    );

  const usedSymbols =
    extractUsedSymbols(target.changedCode);

  const importMap =
    extractImportMap(target.sourceFileContent);

  const requiredImports: Array<{
    symbol: string;
    source: string;
  }> = [];

  for (const symbol of usedSymbols) {
    if (
      importMap[symbol] &&
      importMap[symbol] !== "builtin"
    ) {
      requiredImports.push({
        symbol,
        source: importMap[symbol],
      });
    }
  }

  const sections: string[] = [];

  // ====================================================
  // MAIN RULE
  // ====================================================

  sections.push(`
## CRITICAL OUTPUT RULE

You are generating a test that will be inserted directly into this existing test file:

${target.testFile}

Therefore, generate ONLY ONE test block.

DO NOT generate imports.

DO NOT generate export statements.

DO NOT generate vi.mock().

DO NOT generate describe().

DO NOT generate markdown.

DO NOT generate the existing test file.

DO NOT generate helper functions outside the test.

Your testCode MUST start with:

it(

or:

test(

Example:

it('verifies the changed behavior', () => {
  const result = ${target.symbol}(...);
  expect(result).toEqual(...);
});

If you cannot write the test using the existing test file's imports and setup, skip the gap instead of inventing imports or mocks.
`);

  // ====================================================
  // ACTUAL PRODUCTION FUNCTION
  // ====================================================

  sections.push(`
## ACTUAL PRODUCTION SYMBOL

The changed production symbol is:

${target.symbol}

Source file:

${target.sourceFile}

The generated test MUST call the actual production symbol:

${target.symbol}

Do NOT recreate the production logic inside the test.

Do NOT use fake values as the result.

WRONG:

const result = true;
expect(result).toBe(true);

RIGHT:

const result = ${target.symbol}(...);
expect(result).toBe(...);
`);

  // ====================================================
  // EXTRACT VERIFIED IDENTIFIERS FROM SOURCE
  // ====================================================
  
  // Extract all function/method names from the changed code to provide verified identifiers
  const verifiedIdentifiersRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:\(|\.|\s*:)/g;
  const verifiedIdentifiers = new Set<string>();
  let match;
  while ((match = verifiedIdentifiersRegex.exec(target.changedCode)) !== null) {
    const identifier = match[1];
    if (identifier && !['function', 'const', 'let', 'var', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'throw', 'try', 'catch', 'finally', 'import', 'export', 'class', 'interface', 'type', 'enum', 'namespace', 'async', 'await', 'new', 'this', 'super', 'static', 'private', 'protected', 'public', 'readonly', 'abstract'].includes(identifier)) {
      verifiedIdentifiers.add(identifier);
    }
  }

  // Also extract from source file content if available
  if (target.sourceFileContent) {
    const sourceIdentifiersRegex = /\b(dev_[a-zA-Z_$][a-zA-Z0-9_$]*|get[A-Z]\w*|set[A-Z]\w*)\s*(?:\(|:)/g;
    let sourceMatch;
    while ((sourceMatch = sourceIdentifiersRegex.exec(target.sourceFileContent)) !== null) {
      const identifier = sourceMatch[1];
      if (identifier) {
        verifiedIdentifiers.add(identifier);
      }
    }
  }

  const verifiedIdentifiersList = Array.from(verifiedIdentifiers)
    .filter(id => id.match(/^[a-z]/)) // Prefer lowercase identifiers
    .slice(0, 20) // Limit to 20 items
    .map(id => `- \`${id}\``)
    .join('\n');

  // ====================================================
  // PRODUCTION SYMBOL LOCATION
  // ====================================================

  sections.push(`
## PRODUCTION SYMBOL LOCATION

Production source file:

${target.sourceFile}

Calculated import path from the existing test file:

${relativeImportPath}

IMPORTANT:

This path is provided only as context so you understand where the production symbol comes from.

DO NOT generate an import statement.

The existing test file already handles imports.
`);

  // ====================================================
  // CRITICAL API ACCURACY RULES
  // ====================================================

  sections.push(`
## CRITICAL API ACCURACY RULES

1. You MUST use only functions, methods, properties, variables,
   types, and APIs that actually appear in the provided source code,
   diff, or existing test code.

2. NEVER invent an API name.

3. NEVER modify an existing API name by adding prefixes, suffixes,
   version numbers, or arbitrary text.

4. If the source code contains:
   \`dev_get_atom_state\`
   
   you MUST use:
   \`dev_get_atom_state\`
   
   You MUST NOT generate:
   \`dev3_get_atom_state\`
   \`dev_rev3_get_atom_state\`
   \`dev_get_atom_state_rev3\`
   \`dev_get_atom_state35\`

5. Treat identifiers in the source code as exact identifiers.
   Copy them exactly.

6. NEVER access internal properties or private state. Only use public APIs.
   For example:
   - NEVER access \`.d\`, \`.v\`, \`.e\` on state objects
   - NEVER access internal memoization or cache properties
   - Only use public getter/setter methods or documented APIs

7. Before generating each test, verify that every function or
   property used by the test exists in the provided source code
   or existing test code.

7. Do not infer an API merely from a variable name, commit message,
   diff description, or version/revision label.

8. If an API cannot be verified from the provided evidence,
   do not use it in the generated test.
`);

  // ====================================================
  // VERIFIED SOURCE IDENTIFIERS
  // ====================================================

  if (verifiedIdentifiersList.length > 0) {
    sections.push(`
## VERIFIED SOURCE IDENTIFIERS

The following identifiers were extracted directly from the
repository and are verified to exist:

${verifiedIdentifiersList}

RULE:

Use these identifiers exactly as written.

Do NOT rename them.

Do NOT add revision numbers.

Do NOT create alternative names.

Do NOT use camelCase variations if the source uses snake_case.

Do NOT use snake_case variations if the source uses camelCase.

Example:

If source has: \`dev_get_atom_state()\`
Use: \`dev_get_atom_state()\`

❌ WRONG: \`dev3_get_atom_state()\`
❌ WRONG: \`devGetAtomState()\`
❌ WRONG: \`getAtomState()\`
`);
  }

  // ====================================================
  // KNOWN API METHODS - MORE SPECIFIC
  // ====================================================

  sections.push(`
## Known API Methods in Production

Based on the source code analysis:

${verifiedIdentifiersList.length > 0 
  ? verifiedIdentifiersList 
  : `- \`dev_subscribe_store(listener, 2)\` - NOT "dev3_subscribe_store"
- \`dev_get_mounted_atoms()\` - NOT "devGetMountedAtoms" or "dev_get_atoms"  
- \`dev_get_atom_state(atom)\` - NOT "getAtomState"`}

Do NOT invent API names.

Do NOT use variations like:
- ❌ dev3_subscribe_store
- ❌ devGetMountedAtoms
- ❌ dev_get_atoms
- ❌ getAtoms

Use the EXACT names as they appear in the source code.
`);

  // ====================================================
  // IMPORT PATH CONTEXT - REMOVED (moved above)
  // ====================================================

  sections.push(`
## Test framework

${target.framework}

Use the framework conventions already demonstrated in the existing test file.
`);

  // ====================================================
  // CHANGED CODE
  // ====================================================

  sections.push(`
## Changed symbol

${target.symbol}

## Changed code

\`\`\`
${target.changedCode}
\`\`\`
`);

  // ====================================================
  // EXISTING TEST
  // ====================================================

  if (
    target.existingTestFile &&
    target.existingTestCode
  ) {
    if (target.existingTestCodeIsTemplate) {
      sections.push(`
## Existing test style template

File:

${target.existingTestFile}

\`\`\`
${target.existingTestCode}
\`\`\`

Use this ONLY as a style reference.

Follow its:

- imports
- setup
- mocks
- assertions
- rendering pattern
- async pattern
- naming conventions
- query methods

DO NOT copy its imports into your output.

DO NOT generate imports.

DO NOT generate vi.mock() calls.

Your testCode must contain only ONE new it()/test() block.
`);
    } else {
      sections.push(`
## Existing test file — PRIMARY REFERENCE

File:

${target.existingTestFile}

\`\`\`
${target.existingTestCode}
\`\`\`

This existing file is the primary source of truth.

Match its style exactly.

Follow:

- import usage
- assertion style
- rendering style
- async behavior
- mock patterns
- cleanup patterns
- variable naming
- query methods
- test naming

IMPORTANT:

The existing imports are already available.

Do NOT generate imports.

The existing mocks are already available.

Do NOT generate vi.mock().

Do NOT generate describe().

Generate ONLY the new test block.
`);
    }
  } else {
    sections.push(`
## Existing tests

No existing test file was provided.

Because no existing test setup is available, be conservative.

Do NOT invent imports.

Do NOT invent mocks.

Do NOT invent helper utilities.

Only generate the test if the required dependencies and APIs are clearly available from the supplied context.

Otherwise skip the gap.
`);
  }

  // ====================================================
  // STATIC CONTEXT
  // ====================================================

  if (componentsToMock.length > 0) {
    sections.push(`
## Dependency information

Static analysis detected these component/dependency paths:

${componentsToMock.join("\n")}

IMPORTANT:

This is context only.

DO NOT generate vi.mock() statements.

Use only mocks already present in the existing test file.
`);
  }

  if (prismaImports.length > 0) {
    sections.push(`
## Prisma information

The production source contains these Prisma imports:

${prismaImports
  .map((imp) => imp.statement)
  .join("\n")}

IMPORTANT:

This is context only.

DO NOT generate Prisma imports.

DO NOT generate new Prisma mocks.

Use only Prisma mocks already present in the existing test file.
`);
  }

  if (requiredImports.length > 0) {
    sections.push(`
## Dependencies detected in changed code

Static analysis detected these dependencies:

${requiredImports
  .map(
    (imp) =>
      `- ${imp.symbol} from ${imp.source}`
  )
  .join("\n")}

IMPORTANT:

These are provided as context only.

DO NOT generate imports for them.

DO NOT invent imports.

Only use them if they are already available in the existing test file.
`);
  }

  // ====================================================
  // COMMIT MESSAGE
  // ====================================================

  if (target.commitMessage) {
    sections.push(`
## Commit message

${target.commitMessage}
`);
  }

  // ====================================================
  // COVERAGE GAPS
  // ====================================================

  sections.push(`
## Coverage gaps to fill

Generate EXACTLY ONE test for each coverage gap.

Do NOT generate additional tests.

IMPORTANT API CLARIFICATION:

Based on analysis of the production source code, verify these API names are used correctly:

${
  target.sourceFileContent.includes("dev_subscribe_store")
    ? `- ✓ Confirmed: dev_subscribe_store exists in source (requires 2 params: listener, revision)`
    : `- ⚠️ Note: dev_subscribe_store may not exist; check source`
}

${
  target.sourceFileContent.includes("dev_get_mounted_atoms")
    ? `- ✓ Confirmed: dev_get_mounted_atoms exists in source`
    : ""
}

Do NOT use these incorrect names:
- ❌ dev3_subscribe_store (wrong - should be dev_subscribe_store)
- ❌ devGetMountedAtoms (wrong - should be dev_get_mounted_atoms)
- ❌ dev_get_atoms (wrong - should be dev_get_mounted_atoms)

${target.coverageGaps
  .map(
    (g, i) => `
${i + 1}. **What to test:** ${g.condition}

Code change:

${g.evidence}

addressesGap label:

"${g.label}"
`
  )
  .join("\n")}
`);

  // ====================================================
  // OLD SECTION - REPLACED ABOVE
  // ====================================================

  // ====================================================
  // INTERNAL STATE ACCESS WARNING
  // ====================================================

  sections.push(`
## ⚠️ CRITICAL: DO NOT ACCESS INTERNAL STATE PROPERTIES

The following patterns will cause TypeScript compilation errors and test failures:

NEVER access these internal properties on state objects:
- ❌ state.v (internal value storage)
- ❌ state.d (internal dependencies)
- ❌ state.e (internal error storage)
- ❌ state.dev_* (internal development APIs)

Instead, use only:
- Public methods and getters
- Exported public APIs
- Standard expect() assertions

WRONG - WILL FAIL:

it('accesses internal state', () => {
  const state = store.get(atom);
  expect(state.v).toBe(123);  // ❌ Property 'v' doesn't exist on AtomState
});

RIGHT - USE PUBLIC APIs:

it('gets the atom value', () => {
  const value = store.get(atom);
  expect(value).toBe(123);
});

If you cannot write a test using only public APIs, skip the gap and do not generate a test.
`);

  // ====================================================
  // ASSERTION RULES
  // ====================================================

  sections.push(`
## Assertion requirements

Every generated test MUST contain a meaningful assertion.

The assertion must verify the behavior described in the coverage gap.

WRONG:

it('calls the function', () => {
  ${target.symbol}(...);
});

There is no assertion.

WRONG:

it('works', () => {
  const result = ${target.symbol}(...);
  expect(result).toBeDefined();
});

This is too weak unless existence itself is the behavior.

WRONG:

it('works', () => {
  expect(true).toBe(true);
});

This is tautological.

RIGHT:

it('uses the fallback value when input is null', () => {
  const result = ${target.symbol}(...);
  expect(result).toBe('expected-value');
});

The test must fail if the production behavior is broken.
`);

  // ====================================================
  // FINAL OUTPUT RULE
  // ====================================================

  sections.push(`
## FINAL TASK

For "${target.symbol}", generate exactly ONE test case for each supplied coverage gap.

Your generated test will be inserted directly into the existing test file.

Therefore:

- ONLY generate the test case.
- Start testCode with it( or test(.
- Do NOT generate imports.
- Do NOT generate exports.
- Do NOT generate vi.mock().
- Do NOT generate describe().
- Do NOT generate markdown.
- Do NOT reproduce the existing test file.
- Do NOT invent dependencies.
- Do NOT invent APIs.
- Use existing imports and existing mocks.
- Call the actual production symbol.
- Include a meaningful assertion.
- Verify the exact behavior described by the coverage gap.
- Copy addressesGap exactly.

Return ONLY the JSON object described in the system prompt.
`);

  return sections.join("\n\n");
}