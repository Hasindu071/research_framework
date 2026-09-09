import fs from "fs";
import path from "path";

// ======================================================
// TYPES
// ======================================================

export type TestFramework = "vitest" | "jest" | "playwright" | "mocha";

export interface FrameworkCommand {
  command: string;
  args: string[];
}

// ======================================================
// DETECTION
// ======================================================
//
// Cal.com and Ghost don't use the same test setup, and future
// target repos won't either — so we detect from package.json rather
// than hard-coding one framework. Order matters where a repo could
// plausibly have more than one dependency present (e.g. Playwright
// alongside Vitest for e2e vs unit) — check the more specific/e2e
// tools before the generic ones.

interface FrameworkDetector {
  name: TestFramework;
  /** Any of these appearing in dependencies/devDependencies is a match. */
  deps: string[];
}

const FRAMEWORK_DETECTORS: FrameworkDetector[] = [
  { name: "playwright", deps: ["@playwright/test", "playwright"] },
  { name: "vitest", deps: ["vitest"] },
  { name: "jest", deps: ["jest"] },
  { name: "mocha", deps: ["mocha"] },
];

/**
 * Best-effort framework detection from the repository's root
 * package.json. Returns undefined (rather than guessing) if nothing
 * recognizable is found or package.json can't be read — callers
 * should require an explicit `framework` option in that case instead
 * of silently picking one.
 */
export function detectFramework(
  repositoryRoot: string
): TestFramework | undefined {
  const packageJsonPath = path.join(repositoryRoot, "package.json");

  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  try {
    pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch {
    return undefined;
  }

  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  for (const detector of FRAMEWORK_DETECTORS) {
    if (detector.deps.some((dep) => dep in allDeps)) {
      return detector.name;
    }
  }

  return undefined;
}

// ======================================================
// COMMAND BUILDER
// ======================================================
//
// testFile -> framework -> correct command, per the design doc.
// Only the frameworks actually needed so far are implemented; add a
// case here (and a detector above) when a new target repo needs one.

export function buildTestCommand(
  framework: TestFramework,
  testFile: string
): FrameworkCommand {
  switch (framework) {
    case "vitest":
      return { command: "yarn", args: ["vitest", "run", testFile] };

    case "jest":
      return { command: "yarn", args: ["jest", testFile] };

    case "playwright":
      return { command: "yarn", args: ["playwright", "test", testFile] };

    case "mocha":
      return { command: "yarn", args: ["mocha", testFile] };
  }
}