import fs from "fs";
import path from "path";

// ======================================================
// VITEST ALIAS RESOLUTION UTILITIES
// ======================================================

/**
 * Extract an unresolved alias from a vitest/vite error stderr.
 * Examples: 
 *   "Failed to resolve import "@components/Foo"" → "@components/*"
 *   "Cannot find module "@calcom/ui"" → "@calcom/*"
 * Returns null if no clear alias pattern is found.
 */
export function extractUnresolvedAlias(stderr: string): string | null {
  // Try multiple patterns to catch different error formats
  let match = stderr.match(/Failed to resolve import "([^"]+)"/);
  if (!match?.[1]) {
    // Also try: Cannot find module
    match = stderr.match(/Cannot find module '([^']+)'/);
  }
  if (!match?.[1]) {
    // Also try: Module not found
    match = stderr.match(/Module not found: ([^\s]+)/);
  }
  
  if (!match?.[1]) return null;
  
  const specifier = match[1];
  
  // Extract the package part (e.g., "@components" or "@calcom/lib")
  // For "@foo/bar/baz", we want "@foo/bar/*"
  // For "@components", we want "@components/*"
  const segments = specifier.split("/");
  
  // If it starts with @ and has segments, create a wildcard pattern
  if (specifier.startsWith("@") && segments.length >= 1) {
    if (segments.length === 1) {
      return `${segments[0]}/*`;
    }
    // For scoped packages like @calcom/lib, use first two segments
    return `${segments[0]}/${segments[1]}/*`;
  }
  
  // For non-scoped packages like "lodash", return "lodash/*"
  if (segments.length >= 1 && !specifier.startsWith("@")) {
    return `${segments[0]}/*`;
  }
  
  return null;
}

/**
 * Walk up from startDir looking for a tsconfig.json (or tsconfig.base.json)
 * with a "paths" entry for this alias. Returns the resolved directory path
 * for the alias target, or null if not found.
 * 
 * For monorepos, walks all the way up to find the root tsconfig.base.json
 * which usually has workspace-level alias mappings.
 */
export function resolveAliasTarget(
  aliasPattern: string,
  startDir: string,
  repositoryRoot: string
): string | null {
  let dir = startDir;
  const rootResolved = path.resolve(repositoryRoot);
  
  // Keep track of all configs found so we can check them in reverse order
  // (check package config first, then workspace level configs)
  const configsFound: Array<{ path: string; dir: string }> = [];

  while (dir.startsWith(rootResolved)) {
    for (const name of ["tsconfig.json", "tsconfig.base.json"]) {
      const configPath = path.join(dir, name);
      if (fs.existsSync(configPath)) {
        configsFound.push({ path: configPath, dir });
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Check configs from closest (package level) to furthest (workspace root)
  for (const { path: configPath, dir: configDir } of configsFound) {
    try {
      // Strip comments to make JSON parse-able
      const stripped = fs
        .readFileSync(configPath, "utf8")
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      const parsed = JSON.parse(stripped);
      const paths = parsed.compilerOptions?.paths as
        | Record<string, string[]>
        | undefined;
      
      // Try exact match first (e.g., "@components/*" matches "@components/*")
      if (paths?.[aliasPattern]?.[0]) {
        const target = paths[aliasPattern][0].replace("/*", "");
        return path.resolve(configDir, target);
      }
      
      // Also try matching without the wildcard (e.g., "@components" matches "@components/*")
      const withoutWildcard = aliasPattern.replace(/\/\*$/, "");
      if (withoutWildcard !== aliasPattern && paths?.[aliasPattern]?.[0]) {
        const target = paths[aliasPattern][0].replace("/*", "");
        return path.resolve(configDir, target);
      }
    } catch (err) {
      // Continue to next config if parse fails
      continue;
    }
  }

  return null;
}

/**
 * Write a temporary vitest config that layers a resolve.alias fix on top of
 * the original config, for a single retry when a run fails on an unresolved
 * alias. This uses mergeConfig to preserve all other settings from the base.
 *
 * Returns the path to the override config file (in tmpDir).
 */
export function writeAliasOverrideConfig(
  originalConfigPath: string,
  aliasPattern: string,
  aliasTargetAbsolute: string,
  tmpDir: string
): string {
  fs.mkdirSync(tmpDir, { recursive: true });
  const overridePath = path.join(
    tmpDir,
    `vitest.alias-override.${Date.now()}.mts`
  );
  const aliasKey = aliasPattern.replace(/\/\*$/, "");

  const configImport = originalConfigPath.replace(/\\/g, "/");
  const aliasTarget = aliasTargetAbsolute.replace(/\\/g, "/");

  fs.writeFileSync(
    overridePath,
    `import { defineConfig, mergeConfig } from "vitest/config";
import base from "${configImport}";

export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: {
        "${aliasKey}": "${aliasTarget}"
      }
    }
  })
);
`,
    "utf8"
  );

  return overridePath;
}

/**
 * Clean up a temporary override config file.
 */
export function cleanupOverrideConfig(overridePath: string): void {
  try {
    if (fs.existsSync(overridePath)) {
      fs.unlinkSync(overridePath);
    }
  } catch {
    // Ignore cleanup errors
  }
}
