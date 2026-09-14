// ======================================================
// AUTO-MOCK GENERATION FOR LOCAL COMPONENTS
// ======================================================

interface ComponentImportInfo {
  source: string;
  defaultName?: string;
  namedNames: string[];
}

const LOCAL_IMPORT_PATTERN = /^\.|^@calcom\/|^@components/;

/**
 * Parse a real source file's imports and return local/workspace
 * component-like imports (capitalized names) it pulls in.
 */
export function extractLocalComponentImports(
  sourceFileContent: string
): ComponentImportInfo[] {
  const importRegex =
    /import\s+(?:([\w$]+)\s*,?\s*)?(?:{([^}]+)})?\s*from\s+["']([^"']+)["']/g;
  const map = new Map<string, ComponentImportInfo>();
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(sourceFileContent)) !== null) {
    const [, defaultImport, namedImports, source] = match;
    if (!source || !LOCAL_IMPORT_PATTERN.test(source)) continue;

    const namedNames = (namedImports ?? "")
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0]?.trim() ?? "")
      .filter((n) => n && /^[A-Z]/.test(n));

    const isDefaultComponent = defaultImport && /^[A-Z]/.test(defaultImport);
    if (!isDefaultComponent && namedNames.length === 0) continue;

    const existing = map.get(source) ?? { source, namedNames: [] };
    if (isDefaultComponent) existing.defaultName = defaultImport;
    existing.namedNames = Array.from(new Set([...existing.namedNames, ...namedNames]));
    map.set(source, existing);
  }

  return Array.from(map.values());
}

function buildMockStub(info: ComponentImportInfo): string {
  const entries: string[] = [];
  if (info.defaultName) {
    entries.push(
      `default: (props: any) => require("react").createElement("div", { "data-testid": "mock-${info.defaultName}", ...props })`
    );
  }
  for (const name of info.namedNames) {
    entries.push(
      `${name}: (props: any) => require("react").createElement("div", { "data-testid": "mock-${name}", ...props })`
    );
  }
  return `vi.mock(${JSON.stringify(info.source)}, () => ({\n  ${entries.join(
    ",\n  "
  )}\n}));`;
}

/**
 * Safety net: given the real source file and the LLM's generated test code,
 * return vi.mock() statements for any local component import the LLM's test
 * did NOT already mock. One missed mock is enough to crash the whole render
 * with "Element type is invalid" — this makes mocking exhaustive instead of
 * relying on the LLM to spot every child.
 */
export function buildMissingMockStubs(
  sourceFileContent: string,
  generatedTestCode: string
): string[] {
  const allImports = extractLocalComponentImports(sourceFileContent);

  const alreadyMockedPaths = new Set<string>();
  const mockCallRegex = /vi\.mock\(\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = mockCallRegex.exec(generatedTestCode)) !== null) {
    if (m[1]) alreadyMockedPaths.add(m[1]);
  }

  return allImports
    .filter((info) => !alreadyMockedPaths.has(info.source))
    .map(buildMockStub);
}
