export interface DependencyChange {
  package: string;
  changeType: "added" | "removed" | "upgraded" | "downgraded" | "changed" | "unchanged";
  from?: string | undefined;
  to?: string | undefined;
  source: "package.json" | "yarn.lock";
}

interface PackageJsonChanges {
  added: Map<string, string>;
  removed: Map<string, string>;
  changed: Map<string, { from: string; to: string }>;
}

/**
 * Analyze dependency changes from a git diff.
 *
 * Supports:
 * - package.json
 * - yarn.lock
 *
 * It does NOT perform symbol analysis.
 */
export function analyzeDependencyChanges(rawDiff: string): DependencyChange[] {
  const results: DependencyChange[] = [];

  const packageJsonChanges = analyzePackageJson(rawDiff);
  const yarnLockChanges = analyzeYarnLock(rawDiff);

  // package.json additions
  for (const [pkg, version] of packageJsonChanges.added) {
    results.push({
      package: pkg,
      changeType: "added",
      to: version,
      source: "package.json",
    });
  }

  // package.json removals
  for (const [pkg, version] of packageJsonChanges.removed) {
    results.push({
      package: pkg,
      changeType: "removed",
      from: version,
      source: "package.json",
    });
  }

  // package.json version changes
  for (const [pkg, versions] of packageJsonChanges.changed) {
    const changeType = compareVersions(versions.from, versions.to);

    results.push({
      package: pkg,
      changeType,
      from: versions.from,
      to: versions.to,
      source: "package.json",
    });
  }

  // yarn.lock changes
  results.push(...yarnLockChanges);

  return deduplicateDependencyChanges(results);
}

/**
 * Analyze package.json dependency changes.
 */
function analyzePackageJson(rawDiff: string): PackageJsonChanges {
  const added = new Map<string, string>();
  const removed = new Map<string, string>();
  const changed = new Map<string, { from: string; to: string }>();

  const lines = rawDiff.split("\n");

  let currentFile = "";

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/diff --git a\/(.+) b\/(.+)/);

      if (match?.[2]) {
        currentFile = match[2];
      }

      continue;
    }

    if (currentFile !== "package.json") {
      continue;
    }

    // Ignore diff metadata
    if (
      line.startsWith("+++ ") ||
      line.startsWith("--- ") ||
      line.startsWith("@@")
    ) {
      continue;
    }

    // Removed dependency
    if (line.startsWith("-")) {
      const dependency = extractDependency(line.substring(1));

      if (dependency) {
        removed.set(dependency.name, dependency.version);
      }

      continue;
    }

    // Added dependency
    if (line.startsWith("+")) {
      const dependency = extractDependency(line.substring(1));

      if (dependency) {
        added.set(dependency.name, dependency.version);
      }
    }
  }

  // Detect dependency version changes.
  for (const [pkg, oldVersion] of removed) {
    const newVersion = added.get(pkg);

    if (newVersion) {
      changed.set(pkg, {
        from: oldVersion,
        to: newVersion,
      });

      removed.delete(pkg);
      added.delete(pkg);
    }
  }

  return {
    added,
    removed,
    changed,
  };
}

/**
 * Extract a dependency name and version from a package.json line.
 *
 * Example:
 *
 *     "i18next-fs-backend": "^2.6.6"
 *
 * becomes:
 *
 *     name = i18next-fs-backend
 *     version = ^2.6.6
 */
function extractDependency(
  line: string
): { name: string; version: string } | null {
  const match = line.match(
    /^\s*"([^"]+)"\s*:\s*"([^"]+)"\s*,?\s*$/
  );

  if (!match?.[1] || !match?.[2]) {
    return null;
  }

  const name = match[1];
  const version = match[2];

  // Only treat package-like entries as dependencies.
  // This avoids interpreting unrelated package.json values as dependencies.
  if (
    version.startsWith("^") ||
    version.startsWith("~") ||
    version.startsWith(">") ||
    version.startsWith("<") ||
    version.startsWith("=") ||
    /^\d+\.\d+\.\d+/.test(version) ||
    version.startsWith("workspace:") ||
    version.startsWith("npm:")
  ) {
    return {
      name,
      version,
    };
  }

  return null;
}

/**
 * Analyze yarn.lock changes.
 */
function analyzeYarnLock(rawDiff: string): DependencyChange[] {
  const results: DependencyChange[] = [];

  const lines = rawDiff.split("\n");

  let currentFile = "";

  let removedPackage: string | null = null;
  let removedVersion: string | null = null;

  let addedPackage: string | null = null;
  let addedVersion: string | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      // Flush previous yarn.lock change.
      flushYarnChange(
        results,
        removedPackage,
        removedVersion,
        addedPackage,
        addedVersion
      );

      removedPackage = null;
      removedVersion = null;
      addedPackage = null;
      addedVersion = null;

      const match = line.match(/diff --git a\/(.+) b\/(.+)/);

      if (match?.[2]) {
        currentFile = match[2];
      }

      continue;
    }

    if (currentFile !== "yarn.lock") {
      continue;
    }

    // Example:
    //
    // -"i18next-fs-backend@npm:^2.6.0":
    //
    if (line.startsWith("-")) {
      const packageMatch = line.match(
        /^-\s*"([^"]+@npm:[^"]+)":/
      );

      if (packageMatch?.[1]) {
        removedPackage = packageMatch[1];
        continue;
      }

      const versionMatch = line.match(
        /^-\s+version:\s+(.+)$/
      );

      if (versionMatch?.[1] && removedPackage) {
        removedVersion = versionMatch[1].trim();
      }
    }

    // Example:
    //
    // +"i18next-fs-backend@npm:^2.6.6":
    //
    if (line.startsWith("+")) {
      const packageMatch = line.match(
        /^\+\s*"([^"]+@npm:[^"]+)":/
      );

      if (packageMatch?.[1]) {
        addedPackage = packageMatch[1];
        continue;
      }

      const versionMatch = line.match(
        /^\+\s+version:\s+(.+)$/
      );

      if (versionMatch?.[1] && addedPackage) {
        addedVersion = versionMatch[1].trim();
      }
    }
  }

  // Flush final change.
  flushYarnChange(
    results,
    removedPackage,
    removedVersion,
    addedPackage,
    addedVersion
  );

  return results;
}

/**
 * Convert a yarn.lock package entry into a dependency change.
 */
function flushYarnChange(
  results: DependencyChange[],
  removedPackage: string | null,
  removedVersion: string | null,
  addedPackage: string | null,
  addedVersion: string | null
) {
  if (removedPackage && addedPackage) {
    const removedName = extractPackageName(removedPackage);
    const addedName = extractPackageName(addedPackage);

    if (removedName === addedName) {
      const changeType = compareVersions(
        removedVersion ?? "",
        addedVersion ?? ""
      );

      results.push({
        package: addedName,
        changeType,
        from: removedVersion ?? undefined,
        to: addedVersion ?? undefined,
        source: "yarn.lock",
      });

      return;
    }
  }

  if (addedPackage) {
    results.push({
      package: extractPackageName(addedPackage),
      changeType: "added",
      to: addedVersion ?? undefined,
      source: "yarn.lock",
    });
  }

  if (removedPackage) {
    results.push({
      package: extractPackageName(removedPackage),
      changeType: "removed",
      from: removedVersion ?? undefined,
      source: "yarn.lock",
    });
  }
}

/**
 * Convert:
 *
 * i18next-fs-backend@npm:^2.6.6
 *
 * into:
 *
 * i18next-fs-backend
 */
function extractPackageName(value: string): string {
  const npmIndex = value.indexOf("@npm:");

  if (npmIndex !== -1) {
    return value.substring(0, npmIndex);
  }

  return value;
}

/**
 * Determine whether a dependency was upgraded or downgraded.
 */
function compareVersions(
  from: string,
  to: string
): "upgraded" | "downgraded" | "changed" {
  const fromNumbers = extractVersionNumbers(from);
  const toNumbers = extractVersionNumbers(to);

  if (!fromNumbers || !toNumbers) {
    return "changed";
  }

  for (let i = 0; i < 3; i++) {
    const toNum = toNumbers[i];
    const fromNum = fromNumbers[i];

    if (toNum === undefined || fromNum === undefined) {
      return "changed";
    }

    if (toNum > fromNum) {
      return "upgraded";
    }

    if (toNum < fromNum) {
      return "downgraded";
    }
  }

  return "changed";
}

/**
 * Extract semantic version numbers.
 *
 * Examples:
 *
 * ^2.6.6 -> [2, 6, 6]
 * 2.6.0  -> [2, 6, 0]
 */
function extractVersionNumbers(
  version: string
): [number, number, number] | null {
  const match = version.match(
    /(\d+)\.(\d+)\.(\d+)/
  );

  if (!match) {
    return null;
  }

  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
}

/**
 * Remove duplicate dependency results.
 */
function deduplicateDependencyChanges(
  changes: DependencyChange[]
): DependencyChange[] {
  const seen = new Set<string>();

  return changes.filter((change) => {
    const key = [
      change.package,
      change.changeType,
      change.from ?? "",
      change.to ?? "",
      change.source,
    ].join("|");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}