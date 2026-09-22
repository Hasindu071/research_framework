import fs from "fs";
import path from "path";
import type { TestFramework } from "./frameworks.js";

// ======================================================
// TYPES
// ======================================================

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun" | "unknown";

/**
 * Complete context for a package/workspace, resolved from the test file's
 * location. This is the foundation — everything else derives from this.
 */
export interface PackageContext {
  /** Absolute path to the package directory (where package.json lives). */
  packageDir: string;

  /** Absolute path to package.json. */
  packageJsonPath: string;

  /** Package name from package.json (may be undefined for root). */
  packageName?: string;

  /** Package manager detected for this repository. */
  packageManager: PackageManager;

  /** All scripts from this package.json. */
  scripts: Record<string, string>;

  /** Dependencies + devDependencies combined. */
  allDeps: Record<string, string>;
}

export interface FrameworkResolution {
  framework: TestFramework | null;
  packageManager: PackageManager;

  workspaceDir: string;
  workspaceRelative: string;

  configFile: string | null;

  testPathRelativeToWorkspace: string;

  confidence: number;

  evidence: string[];

  configVerified: boolean;

  configIsWorkspace: boolean;

  testScripts?: string[];
}

// ======================================================
// CONSTANTS
// ======================================================

const CONFIG_FILES: Record<TestFramework, string[]> = {
  vitest: [
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mts",
    "vitest.config.mjs",
    "vite.config.ts",
    "vite.config.js",
  ],

  jest: [
    "jest.config.js",
    "jest.config.ts",
    "jest.config.cjs",
    "jest.config.mjs",
  ],

  playwright: [
    "playwright.config.ts",
    "playwright.config.js",
  ],

  mocha: [
    ".mocharc.json",
    ".mocharc.js",
    ".mocharc.cjs",
    ".mocharc.yml",
  ],
};

const DEP_NAMES: Record<TestFramework, string[]> = {
  vitest: ["vitest"],
  jest: ["jest"],
  playwright: ["@playwright/test", "playwright"],
  mocha: ["mocha"],
};

const DEFAULT_INCLUDE: Record<TestFramework, string[]> = {
  vitest: [
    "**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
  ],

  jest: [
    "**/__tests__/**/*.{js,jsx,ts,tsx}",
    "**/*.{test,spec}.{js,jsx,ts,tsx}",
  ],

  playwright: [
    "**/*.{test,spec}.{js,ts,jsx,tsx,mjs}",
  ],

  mocha: [
    "test/**/*.{js,cjs,mjs}",
  ],
};

const DEFAULT_EXCLUDE: string[] = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
];

// ======================================================
// PACKAGE MANAGER DETECTION
// ======================================================

export function detectPackageManager(
  repoRoot: string
): PackageManager {

  console.log(
    `[package-manager] repoRoot: ${repoRoot}`
  );

  const packageJsonPath = path.join(
    repoRoot,
    "package.json"
  );

  console.log(
    `[package-manager] package.json exists: ${
      fs.existsSync(packageJsonPath)
    }`
  );

  const rootPkg = readPkgJson(repoRoot);

  console.log(
    `[package-manager] packageManager field: ${
      rootPkg?.packageManager
    }`
  );

  // ----------------------------------------------------
  // 1. package.json packageManager field
  // ----------------------------------------------------

  if (rootPkg?.packageManager) {

    const packageManagerValue =
      String(rootPkg.packageManager).trim();

    /*
     * Examples:
     *
     * pnpm@11.3.0
     * yarn@1.22.22
     * npm@10.0.0
     * bun@1.1.0
     */

    const match = packageManagerValue.match(
      /^(pnpm|yarn|npm|bun)(?:@|$)/
    );

    if (match) {

      const pm = match[1] as PackageManager;

      console.log(
        `[package-manager] detected from package.json: ${pm}`
      );

      return pm;
    }

    console.log(
      `[package-manager] packageManager field could not be parsed: ${packageManagerValue}`
    );
  }

  // ----------------------------------------------------
  // 2. pnpm lockfile
  // ----------------------------------------------------

  const pnpmLock = path.join(
    repoRoot,
    "pnpm-lock.yaml"
  );

  if (fs.existsSync(pnpmLock)) {

    console.log(
      "[package-manager] detected from lockfile: pnpm"
    );

    return "pnpm";
  }

  // ----------------------------------------------------
  // 3. yarn lockfile
  // ----------------------------------------------------

  const yarnLock = path.join(
    repoRoot,
    "yarn.lock"
  );

  if (fs.existsSync(yarnLock)) {

    console.log(
      "[package-manager] detected from lockfile: yarn"
    );

    return "yarn";
  }

  // ----------------------------------------------------
  // 4. npm lockfile
  // ----------------------------------------------------

  const npmLock = path.join(
    repoRoot,
    "package-lock.json"
  );

  if (fs.existsSync(npmLock)) {

    console.log(
      "[package-manager] detected from lockfile: npm"
    );

    return "npm";
  }

  // ----------------------------------------------------
  // 5. bun lockfile
  // ----------------------------------------------------

  const bunLockBinary = path.join(
    repoRoot,
    "bun.lockb"
  );

  const bunLock = path.join(
    repoRoot,
    "bun.lock"
  );

  if (
    fs.existsSync(bunLockBinary) ||
    fs.existsSync(bunLock)
  ) {

    console.log(
      "[package-manager] detected from lockfile: bun"
    );

    return "bun";
  }

  // ----------------------------------------------------
  // 6. Unknown
  // ----------------------------------------------------

  console.log(
    "[package-manager] UNKNOWN"
  );

  return "unknown";
}

// ======================================================
// WORKSPACE/PACKAGE DETECTION
// ======================================================

export function resolvePackageContext(
  testFile: string,
  repoRoot: string
): PackageContext {

  const ancestorDirs =
    collectAncestorDirs(
      testFile,
      repoRoot
    );

  const packageDir =
    findNearestWorkspace(
      ancestorDirs
    );

  const packageJsonPath =
    path.join(
      packageDir,
      "package.json"
    );

  // Read package.json
  const pkg =
    readPkgJson(packageDir) || {};

  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  const packageManager =
    detectPackageManager(repoRoot);

  console.log(
    `[package-context] packageDir: ${packageDir}`
  );

  console.log(
    `[package-context] packageManager: ${packageManager}`
  );

  return {
    packageDir,

    packageJsonPath,

    packageName: pkg.name,

    packageManager,

    scripts: pkg.scripts || {},

    allDeps,
  };
}

/**
 * Build list of ancestor directories from test file to repo root.
 */
function collectAncestorDirs(
  testFile: string,
  repoRoot: string
): string[] {

  const dirs: string[] = [];

  const rootResolved =
    path.resolve(repoRoot);

  let cur =
    path.dirname(
      path.resolve(
        repoRoot,
        testFile
      )
    );

  while (true) {

    dirs.push(cur);

    if (cur === rootResolved) {
      break;
    }

    const parent =
      path.dirname(cur);

    if (parent === cur) {
      break;
    }

    cur = parent;
  }

  return dirs;
}

/**
 * Find the nearest package.json.
 */
function findNearestWorkspace(
  dirs: string[]
): string {

  for (const dir of dirs) {

    if (
      fs.existsSync(
        path.join(
          dir,
          "package.json"
        )
      )
    ) {
      return dir;
    }
  }

  return dirs[
    dirs.length - 1
  ]!;
}

// ======================================================
// PACKAGE.JSON HELPERS
// ======================================================

function readPkgJson(
  dir: string
): any | null {

  const packageJsonPath =
    path.join(
      dir,
      "package.json"
    );

  try {

    const content =
      fs.readFileSync(
        packageJsonPath,
        "utf8"
      );

    const pkg =
      JSON.parse(content);

    console.log(
      `[package-json] Reading: ${packageJsonPath}`
    );

    console.log(
      `[package-json] packageManager: ${
        pkg.packageManager
      }`
    );

    return pkg;

  } catch (error) {

    console.log(
      `[package-json] Failed to read: ${packageJsonPath}`
    );

    console.log(error);

    return null;
  }
}

// ======================================================
// MINI GLOB ENGINE
// ======================================================

function escapeRegexChar(
  c: string
): string {

  return c.replace(
    /[.+^$()|[\]\\]/g,
    "\\$&"
  );
}

function globToRegExp(
  glob: string
): RegExp {

  let re = "";
  let i = 0;

  while (i < glob.length) {

    const c = glob[i];

    if (c === "*") {

      if (glob[i + 1] === "*") {

        if (glob[i + 2] === "/") {

          re += "(?:.*/)?";

          i += 3;

        } else {

          re += ".*";

          i += 2;
        }

      } else {

        re += "[^/]*";

        i += 1;
      }

      continue;
    }

    if (c === "?") {

      re += "[^/]";

      i += 1;

      continue;
    }

    if (c === "{") {

      const end =
        glob.indexOf(
          "}",
          i
        );

      if (end === -1) {

        re += "\\{";

        i += 1;

        continue;
      }

      const options =
        glob
          .slice(
            i + 1,
            end
          )
          .split(",")
          .map(
            (opt) =>
              opt
                .split("")
                .map(
                  (ch) =>
                    escapeRegexChar(ch)
                )
                .join("")
          );

      re += `(?:${options.join("|")})`;

      i = end + 1;

      continue;
    }

    if (c) {

      re +=
        escapeRegexChar(c);
    }

    i += 1;
  }

  return new RegExp(
    `^${re}$`
  );
}

function globMatch(
  glob: string,
  testPath: string
): boolean {

  try {

    return globToRegExp(
      glob
    ).test(testPath);

  } catch {

    return false;
  }
}

function matchesAny(
  patterns: string[],
  testPath: string
): boolean {

  return patterns.some(
    (p) =>
      globMatch(
        p,
        testPath
      )
  );
}

// ======================================================
// CONFIG FILE DISCOVERY
// ======================================================

interface ConfigCandidate {
  dir: string;
  file: string;
  framework: TestFramework;
}

function findConfigCandidates(
  dirs: string[],
  framework: TestFramework
): ConfigCandidate[] {

  const found: ConfigCandidate[] = [];

  for (const dir of dirs) {

    for (
      const candidate of
      CONFIG_FILES[framework]
    ) {

      if (
        fs.existsSync(
          path.join(
            dir,
            candidate
          )
        )
      ) {

        found.push({
          dir,
          file: candidate,
          framework,
        });
      }
    }
  }

  return found;
}

function extractAllStringArraysAfterKey(
  content: string,
  key: string
): string[] {

  const keyRegex =
    new RegExp(
      `\\b${key}\\s*:\\s*`,
      "g"
    );

  let match:
    RegExpExecArray | null;

  const allStrings:
    Set<string> = new Set();

  while (
    (match =
      keyRegex.exec(content))
  ) {

    const start =
      match.index +
      match[0].length;

    const next =
      content[start];

    if (next === "[") {

      let depth = 0;

      let end = start;

      for (
        ;
        end < content.length;
        end++
      ) {

        if (
          content[end] === "["
        ) {
          depth++;
        } else if (
          content[end] === "]"
        ) {

          depth--;

          if (
            depth === 0
          ) {

            end++;

            break;
          }
        }
      }

      const arrayText =
        content.slice(
          start,
          end
        );

      const strings =
        [
          ...arrayText.matchAll(
            /['"`]([^'"`]+)['"`]/g
          ),
        ]
          .map(
            (m) => m[1]
          )
          .filter(
            (
              s
            ): s is string =>
              s !== undefined
          );

      strings.forEach(
        (s) =>
          allStrings.add(s)
      );

    } else if (
      next === "'" ||
      next === '"' ||
      next === "`"
    ) {

      const quote = next;

      const end =
        content.indexOf(
          quote,
          start + 1
        );

      if (end !== -1) {

        allStrings.add(
          content.slice(
            start + 1,
            end
          )
        );
      }
    }
  }

  return Array.from(
    allStrings
  );
}

function extractPlaywrightTestDir(
  content: string
): string[] {

  const testDirRegex =
    /\btestDir\s*:\s*['"`]([^'"`]+)['"`]/g;

  let match:
    RegExpExecArray | null;

  const dirs:
    Set<string> = new Set();

  while (
    (match =
      testDirRegex.exec(content))
  ) {

    const dir = match[1];

    dirs.add(
      `${dir}/**/*.{test,spec}.{js,ts,jsx,tsx,mjs}`
    );
  }

  return Array.from(
    dirs
  );
}

function extractTestMatchPatterns(
  content: string
): string[] {

  return extractAllStringArraysAfterKey(
    content,
    "testMatch"
  );
}

function configHasWorkspaceProjects(
  content: string,
  framework?: TestFramework
): boolean {

  if (
    framework === "playwright"
  ) {

    return /\bworkspace\s*:\s*/
      .test(content);
  }

  return /\b(projects|workspace)\s*:\s*/
    .test(content);
}

export function isWorkspaceConfigFile(
  configPathAbs: string,
  framework?: TestFramework
): boolean {

  try {

    const content =
      fs.readFileSync(
        configPathAbs,
        "utf8"
      );

    return configHasWorkspaceProjects(
      content,
      framework
    );

  } catch {

    return false;
  }
}

function readConfigPatterns(
  configPath: string,
  framework: TestFramework
): {
  include: string[];
  exclude: string[];
} | null {

  let content = "";

  try {

    content =
      fs.readFileSync(
        configPath,
        "utf8"
      );

  } catch {

    return {
      include:
        DEFAULT_INCLUDE[
          framework
        ],

      exclude:
        DEFAULT_EXCLUDE,
    };
  }

  if (
    configHasWorkspaceProjects(
      content
    )
  ) {

    const include =
      extractAllStringArraysAfterKey(
        content,
        "include"
      );

    const exclude =
      extractAllStringArraysAfterKey(
        content,
        "exclude"
      );

    if (
      include.length === 0
    ) {

      return null;
    }

    return {
      include,

      exclude:
        exclude.length > 0
          ? [
              ...exclude,
              ...DEFAULT_EXCLUDE,
            ]
          : DEFAULT_EXCLUDE,
    };
  }

  let include =
    extractAllStringArraysAfterKey(
      content,
      "include"
    );

  let exclude =
    extractAllStringArraysAfterKey(
      content,
      "exclude"
    );

  if (
    framework === "playwright"
  ) {

    const testDirPatterns =
      extractPlaywrightTestDir(
        content
      );

    const testMatchPatterns =
      extractTestMatchPatterns(
        content
      );

    if (
      testDirPatterns.length > 0
    ) {

      include = [
        ...include,
        ...testDirPatterns,
      ];

    } else if (
      testMatchPatterns.length > 0
    ) {

      include = [
        ...include,
        ...testMatchPatterns,
      ];
    }

  } else if (
    framework === "jest" ||
    framework === "mocha"
  ) {

    const testMatchPatterns =
      extractTestMatchPatterns(
        content
      );

    if (
      testMatchPatterns.length > 0
    ) {

      include = [
        ...include,
        ...testMatchPatterns,
      ];
    }
  }

  return {
    include:
      include.length > 0
        ? include
        : DEFAULT_INCLUDE[
            framework
          ],

    exclude:
      exclude.length > 0
        ? [
            ...exclude,
            ...DEFAULT_EXCLUDE,
          ]
        : DEFAULT_EXCLUDE,
  };
}

function configMatchesTest(
  candidate: ConfigCandidate,
  testFileAbs: string
): boolean {

  const patterns =
    readConfigPatterns(
      path.join(
        candidate.dir,
        candidate.file
      ),
      candidate.framework
    );

  if (!patterns) {
    return false;
  }

  const {
    include,
    exclude,
  } = patterns;

  const relToConfig =
    path
      .relative(
        candidate.dir,
        testFileAbs
      )
      .split(
        path.sep
      )
      .join("/");
  
  if (
    relToConfig.startsWith("..")
  ) {
    return false;
  }

  if (
    matchesAny(
      exclude,
      relToConfig
    )
  ) {
    return false;
  }

  return matchesAny(
    include,
    relToConfig
  );
}

// ======================================================
// FRAMEWORK DETECTION FROM DEPENDENCIES
// ======================================================

function frameworkFromDeps(
  allDeps: Record<string, string>
): TestFramework | null {

  if (!allDeps) {
    return null;
  }

  for (
    const [
      name,
      deps,
    ] of Object.entries(
      DEP_NAMES
    ) as [
      TestFramework,
      string[]
    ][]
  ) {

    if (
      deps.some(
        (d) =>
          d in allDeps
      )
    ) {

      return name;
    }
  }

  return null;
}

// ======================================================
// TEST SCRIPT HELPERS
// ======================================================

function isPassthroughTestScript(
  scriptCmd: string
): boolean {

  if (!scriptCmd) {
    return false;
  }

  const trimmed =
    scriptCmd.trim();

  const passthroughFrameworks = [
    "vitest",
    "jest",
    "mocha",
    "playwright",
  ];

  for (
    const fw of
    passthroughFrameworks
  ) {

    if (
      new RegExp(
        `^${fw}(\\s|$)`
      ).test(trimmed)
    ) {

      return true;
    }
  }

  const wrapperPatterns = [
    /^yarn\s+/,
    /^npm\s+/,
    /^pnpm\s+/,
    /^bun\s+/,
    /^npx\s+/,
    /^nx\s+/,
    /^turbo\s+/,
    /^node\s+/,
    /^ts-node\s+/,
    /^tsx\s+/,
    /^node --/,
  ];

  for (
    const pattern of
    wrapperPatterns
  ) {

    if (
      pattern.test(trimmed)
    ) {

      return false;
    }
  }

  return false;
}

function getTestScripts(
  pkg: any
): string[] {

  if (!pkg?.scripts) {
    return [];
  }

  const scriptNames = [
    "test:unit",
    "test:e2e",
    "test:component",
    "test:integration",
    "test",
  ];

  return scriptNames.filter(
    (name) =>
      name in pkg.scripts
  );
}

export function getTestScriptsForDir(
  dir: string
): string[] {

  const pkg =
    readPkgJson(dir);

  return getTestScripts(pkg);
}

// ======================================================
// FRAMEWORK DETECTION FROM SCRIPTS
// ======================================================

function frameworkFromScripts(
  scripts: Record<string, string>
): {
  framework: TestFramework;
  script: string;
} | null {

  if (
    !scripts ||
    Object.keys(scripts).length === 0
  ) {

    return null;
  }

  for (
    const [
      scriptName,
      scriptCmd,
    ] of Object.entries(
      scripts
    )
  ) {

    if (
      !/test/i.test(
        scriptName
      )
    ) {
      continue;
    }

    for (
      const fw of
      Object.keys(
        DEP_NAMES
      ) as TestFramework[]
    ) {

      if (
        new RegExp(
          `\\b${fw}\\b`,
          "i"
        ).test(scriptCmd)
      ) {

        return {
          framework: fw,
          script: scriptName,
        };
      }
    }
  }

  return null;
}

// ======================================================
// FRAMEWORK DETECTION FROM IMPORTS
// ======================================================

function frameworkFromImports(
  testFileContent: string
): TestFramework | null {

  const frameworks:
    Array<
      [
        TestFramework,
        string[]
      ]
    > = [

    [
      "vitest",
      [
        'from "vitest"',
        "from 'vitest'",
      ],
    ],

    [
      "playwright",
      [
        'from "@playwright/test"',
        "from '@playwright/test'",
      ],
    ],

    [
      "jest",
      [
        'from "jest"',
        "from \'jest\'",
      ],
    ],

    [
      "mocha",
      [
        'from "mocha"',
        "from 'mocha'",
      ],
    ],
  ];

  for (
    const [
      fw,
      imports,
    ] of frameworks
  ) {

    if (
      imports.some(
        (imp) =>
          testFileContent.includes(
            imp
          )
      )
    ) {

      return fw;
    }
  }

  return null;
}

// ======================================================
// MAIN RESOLUTION
// ======================================================

export function resolveFramework(
  testFile: string,
  repoRoot: string
): FrameworkResolution {

  const ancestorDirs =
    collectAncestorDirs(
      testFile,
      repoRoot
    );

  const testFileAbs =
    path.resolve(
      repoRoot,
      testFile
    );

  const pkgContext =
    resolvePackageContext(
      testFile,
      repoRoot
    );

  const evidence: string[] = [];

  evidence.push(
    `resolved owning package: ${
      pkgContext.packageName ||
      "(root)"
    } at ${
      path.relative(
        repoRoot,
        pkgContext.packageDir
      ) || "."
    }`
  );

  let framework:
    TestFramework | null = null;

  let confidence = 0;

  let configFile:
    string | null = null;

  let workspaceDir =
    pkgContext.packageDir;

  let configVerified = false;

  let configIsWorkspace = false;

  // ====================================================
  // STRATEGY 1: CONFIG
  // ====================================================

  const allCandidates:
    ConfigCandidate[] = [];

  for (
    const fw of
    Object.keys(
      CONFIG_FILES
    ) as TestFramework[]
  ) {

    allCandidates.push(
      ...findConfigCandidates(
        ancestorDirs,
        fw
      )
    );
  }

  allCandidates.sort(
    (a, b) =>
      ancestorDirs.indexOf(a.dir) -
      ancestorDirs.indexOf(b.dir)
  );

  let firstUnverifiedCandidate:
    ConfigCandidate | null = null;

  for (
    const candidate of
    allCandidates
  ) {

    if (
      !firstUnverifiedCandidate
    ) {

      firstUnverifiedCandidate =
        candidate;
    }

    if (
      configMatchesTest(
        candidate,
        testFileAbs
      )
    ) {

      framework =
        candidate.framework;

      workspaceDir =
        candidate.dir;

      configFile =
        path.relative(
          repoRoot,
          path.join(
            candidate.dir,
            candidate.file
          )
        );

      configVerified = true;

      confidence = 0.95;

      try {

        const content =
          fs.readFileSync(
            path.join(
              candidate.dir,
              candidate.file
            ),
            "utf8"
          );

        configIsWorkspace =
          configHasWorkspaceProjects(
            content,
            candidate.framework
          );

      } catch {

        configIsWorkspace =
          false;
      }

      evidence.push(
        `config "${candidate.file}" in ${
          path.relative(
            repoRoot,
            candidate.dir
          ) || "."
        } declares include/exclude patterns that match this test file`
      );

      if (
        configIsWorkspace
      ) {

        evidence.push(
          `config is workspace/projects-based — will auto-discover from ${
            path.relative(
              repoRoot,
              candidate.dir
            ) || "."
          }`
        );
      }

      break;
    }
  }

  if (
    !framework &&
    firstUnverifiedCandidate
  ) {

    evidence.push(
      `config "${firstUnverifiedCandidate.file}" found in ${
        path.relative(
          repoRoot,
          firstUnverifiedCandidate.dir
        ) || "."
      } but its include/exclude patterns do not match this test file — not used`
    );
  }

  // ====================================================
  // STRATEGY 2: IMPORTS
  // ====================================================

  if (!framework) {

    try {

      const content =
        fs.readFileSync(
          testFileAbs,
          "utf8"
        );

      const fromImports =
        frameworkFromImports(
          content
        );

      if (fromImports) {

        framework =
          fromImports;

        evidence.push(
          `test file imports from "${fromImports}"`
        );

        confidence = 0.7;
      }

    } catch {
      // Continue
    }
  }

  // ====================================================
  // STRATEGY 3: TEST SCRIPT
  // ====================================================

  if (!framework) {

    const fromScripts =
      frameworkFromScripts(
        pkgContext.scripts
      );

    if (fromScripts) {

      framework =
        fromScripts.framework;

      if (
        firstUnverifiedCandidate
      ) {

        evidence.push(
          `config "${firstUnverifiedCandidate.file}" found but didn't match; falling back to package script "${fromScripts.script}"`
        );

      } else {

        evidence.push(
          `owning package script "${fromScripts.script}" invokes ${fromScripts.framework}`
        );
      }

      confidence = 0.65;
    }
  }

  // ====================================================
  // STRATEGY 4: DEPENDENCIES
  // ====================================================

  if (!framework) {

    const fromDeps =
      frameworkFromDeps(
        pkgContext.allDeps
      );

    if (fromDeps) {

      framework =
        fromDeps;

      if (
        firstUnverifiedCandidate
      ) {

        evidence.push(
          `config "${firstUnverifiedCandidate.file}" found but didn't match; falling back to dependency: ${fromDeps} in owning package`
        );

      } else {

        evidence.push(
          `${fromDeps} listed in owning package dependencies`
        );
      }

      confidence = 0.55;
    }
  }

  // ====================================================
  // STRATEGY 5: ROOT DEPENDENCIES
  // ====================================================

  if (!framework) {

    const rootPkg =
      readPkgJson(
        repoRoot
      );

    const rootAllDeps = {
      ...rootPkg?.dependencies,
      ...rootPkg?.devDependencies,
    };

    const fromRootDeps =
      frameworkFromDeps(
        rootAllDeps
      );

    if (fromRootDeps) {

      framework =
        fromRootDeps;

      evidence.push(
        `${fromRootDeps} listed in root package dependencies (owning package had no test framework)`
      );

      confidence = 0.35;
    }
  }

  if (!framework) {

    evidence.push(
      "no verified config, import, script, or dependency evidence found"
    );
  }

  const workspaceRelative =
    path.relative(
      repoRoot,
      workspaceDir
    ) || ".";

  const testPathRelativeToWorkspace =
    path.relative(
      workspaceDir,
      testFileAbs
    );

  const testScripts =
    getTestScripts(
      pkgContext.scripts
    );

  return {
    framework,

    packageManager:
      pkgContext.packageManager,

    workspaceDir,

    workspaceRelative,

    configFile,

    testPathRelativeToWorkspace,

    confidence,

    evidence,

    configVerified,

    configIsWorkspace,

    testScripts,
  };
}

// ======================================================
// COMMAND BUILDING
// ======================================================

function execPrefix(
  packageManager: PackageManager,
  bin: string
): {
  command: string;
  args: string[];
} {

  switch (packageManager) {

    case "pnpm":

      return {
        command: "pnpm",
        args: [
          "exec",
          bin,
        ],
      };

    case "yarn":
      // On Windows, yarn exec has issues with backslashes in file paths
      // Use npm run to call the test script from package.json instead
      if (process.platform === "win32" && (bin === "vitest" || bin === "jest")) {
        // Check if there's a test script in package.json
        // If not, fall back to yarn exec
        return {
          command: "npm",
          args: [
            "run",
            "test",
            "--",
          ],
        };
      }

      return {
        command: "yarn",
        args: [
          "exec",
          bin,
        ],
      };

    case "bun":

      return {
        command: "bunx",
        args: [
          bin,
        ],
      };

    default:

      return {
        command: "npx",
        args: [
          bin,
        ],
      };
  }
}

// ======================================================
// TEST COMMAND BUILDING
// ======================================================

export function buildTestCommand(
  resolution: FrameworkResolution,
  targetFileRelativeToWorkspace?: string
): {
  command: string;
  args: string[];
} {

  const {
    framework,
    packageManager,
    configFile,
    configIsWorkspace,
    testPathRelativeToWorkspace,
  } = resolution;

  const testPath =
    targetFileRelativeToWorkspace ||
    testPathRelativeToWorkspace;

  // ----------------------------------------------------
  // No framework
  // ----------------------------------------------------

  if (!framework) {

    if (
      resolution.testScripts &&
      resolution.testScripts.length > 0
    ) {

      const pkg =
        readPkgJson(
          resolution.workspaceDir
        );

      const scripts =
        pkg?.scripts || {};

      const firstScript =
        resolution.testScripts[0]!;

      const firstScriptCmd =
        scripts[firstScript];

      if (
        firstScriptCmd &&
        isPassthroughTestScript(
          firstScriptCmd
        )
      ) {

        return buildPackageManagerCommand(
          packageManager,
          firstScript,
          [testPath]
        );
      }
    }

    return buildPackageManagerCommand(
      packageManager,
      "test",
      [testPath]
    );
  }

  // ----------------------------------------------------
  // Passthrough test script
  // ----------------------------------------------------

  if (
    resolution.testScripts &&
    resolution.testScripts.length > 0
  ) {

    const pkg =
      readPkgJson(
        resolution.workspaceDir
      );

    const scripts =
      pkg?.scripts || {};

    for (
      const scriptName of
      resolution.testScripts
    ) {

      const scriptCmd =
        scripts[scriptName];

      if (
        scriptCmd &&
        isPassthroughTestScript(
          scriptCmd
        )
      ) {

        return buildPackageManagerCommand(
          packageManager,
          scriptName,
          [testPath]
        );
      }
    }
  }

  // ----------------------------------------------------
  // Workspace config
  // ----------------------------------------------------

  if (configIsWorkspace) {

    switch (framework) {

      case "vitest": {

        const base =
          execPrefix(
            packageManager,
            "vitest"
          );

        return {
          command: base.command,

          args: [
            ...base.args,
            "run",
            testPath,
          ],
        };
      }

      case "jest": {

        const base =
          execPrefix(
            packageManager,
            "jest"
          );

        return {
          command: base.command,

          args: [
            ...base.args,
            testPath,
          ],
        };
      }

      case "playwright": {

        const base =
          execPrefix(
            packageManager,
            "playwright"
          );

        return {
          command: base.command,

          args: [
            ...base.args,
            "test",
            testPath,
          ],
        };
      }

      case "mocha": {

        const base =
          execPrefix(
            packageManager,
            "mocha"
          );

        return {
          command: base.command,

          args: [
            ...base.args,
            testPath,
          ],
        };
      }
    }
  }

  // ----------------------------------------------------
  // Leaf config
  // ----------------------------------------------------

  let configArgs: string[] = [];

  if (configFile) {

    const workspaceRel =
      resolution.workspaceRelative &&
      resolution.workspaceRelative !== "."
        ? resolution.workspaceRelative
        : "";

    const configRelativeToWorkspace =
      path.relative(
        workspaceRel,
        configFile
      );

    if (
      !configRelativeToWorkspace.startsWith(
        ".."
      )
    ) {

      configArgs = [
        "--config",
        configRelativeToWorkspace ||
          path.basename(
            configFile
          ),
      ];
    }
  }

  // ----------------------------------------------------
  // Framework CLI
  // ----------------------------------------------------

  switch (framework) {

    case "vitest": {

      const base =
        execPrefix(
          packageManager,
          "vitest"
        );

      return {
        command: base.command,

        args: [
          ...base.args,
          "run",
          ...configArgs,
          testPath,
        ],
      };
    }

    case "jest": {

      const base =
        execPrefix(
          packageManager,
          "jest"
        );

      return {
        command: base.command,

        args: [
          ...base.args,
          ...configArgs,
          testPath,
        ],
      };
    }

    case "playwright": {

      const base =
        execPrefix(
          packageManager,
          "playwright"
        );

      return {
        command: base.command,

        args: [
          ...base.args,
          "test",
          ...configArgs,
          testPath,
        ],
      };
    }

    case "mocha": {

      const base =
        execPrefix(
          packageManager,
          "mocha"
        );

      return {
        command: base.command,

        args: [
          ...base.args,
          testPath,
        ],
      };
    }
  }
}

// ======================================================
// PACKAGE MANAGER COMMAND
// ======================================================

function buildPackageManagerCommand(
  packageManager: PackageManager,
  scriptName: string,
  extraArgs: string[]
): {
  command: string;
  args: string[];
} {

  switch (packageManager) {

    case "yarn":

      return {
        command: "yarn",

        args: [
          "run",
          scriptName,
          ...extraArgs,
        ],
      };

    case "pnpm":

      return {
        command: "pnpm",

        args: [
          "run",
          scriptName,
          ...extraArgs,
        ],
      };

    case "npm":

      return {
        command: "npm",

        args: [
          "run",
          scriptName,
          "--",
          ...extraArgs,
        ],
      };

    case "bun":

      return {
        command: "bun",

        args: [
          "run",
          scriptName,
          ...extraArgs,
        ],
      };

    default:

      return {
        command: "npm",

        args: [
          "run",
          scriptName,
          "--",
          ...extraArgs,
        ],
      };
  }
}