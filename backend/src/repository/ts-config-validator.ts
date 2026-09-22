/**
 * TypeScript Configuration Validator
 * 
 * Validates that the repository's TypeScript configuration is sound
 * before attempting to run tests. Prevents wasted effort on test execution
 * when the build itself will fail due to config issues.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// ======================================================
// TYPES
// ======================================================

export interface TsConfigValidation {
  valid: boolean;
  issues: string[];
  warnings: string[];
  canProceed: boolean;
}

// ======================================================
// CONFIG VALIDATION
// ======================================================

/**
 * Validate TypeScript configuration without running tests.
 * This performs a quick compile check to catch config issues early.
 */
export function validateTsConfig(repositoryRoot: string): TsConfigValidation {
  const result: TsConfigValidation = {
    valid: true,
    issues: [],
    warnings: [],
    canProceed: true,
  };

  try {
    // Try to run tsc with noEmit flag on a minimal file
    const tscPath = path.join(repositoryRoot, "node_modules", ".bin", "tsc");
    if (!fs.existsSync(tscPath)) {
      result.warnings.push("TypeScript compiler not found");
      return result;
    }

    // Create a minimal test file to check compilation
    const tempDir = path.join(repositoryRoot, ".ts-config-check-temp");
    const tempFile = path.join(tempDir, "check.ts");

    try {
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      fs.writeFileSync(tempFile, "const x: string = 'test';", "utf8");

      // Try to compile it
      try {
        execSync(`${tscPath} --noEmit "${tempFile}"`, {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (error: any) {
        const stderr = error.stderr || error.message || String(error);

        // Check for specific configuration errors
        if (stderr.includes("TS5110")) {
          result.issues.push(
            "TS5110: Option 'module' must be set to match 'moduleResolution'"
          );
          result.valid = false;
          result.canProceed = false;
        }
        if (stderr.includes("TS5")) {
          // Other TypeScript 5.x config errors
          result.issues.push(
            `TypeScript configuration error: ${stderr.split("\n")[0]}`
          );
          result.valid = false;
          result.canProceed = false;
        }
      }
    } finally {
      // Clean up temp files
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
        if (fs.existsSync(tempDir)) {
          const files = fs.readdirSync(tempDir);
          if (files.length === 0) {
            fs.rmdirSync(tempDir);
          }
        }
      } catch {
        // Ignore cleanup errors
      }
    }

    return result;
  } catch (err) {
    result.warnings.push(
      `Failed to validate TypeScript config: ${err instanceof Error ? err.message : String(err)}`
    );
    return result;
  }
}

// ======================================================
// ERROR FORMATTING
// ======================================================

/**
 * Format validation result for logging.
 */
export function formatValidationResult(
  validation: TsConfigValidation
): string[] {
  const lines: string[] = [];

  if (validation.valid) {
    lines.push("[TS-Config] ✓ TypeScript configuration is valid");
  } else {
    lines.push("[TS-Config] ❌ TypeScript configuration has errors:");
    for (const issue of validation.issues) {
      lines.push(`  - ${issue}`);
    }
  }

  if (validation.warnings.length > 0) {
    for (const warning of validation.warnings) {
      lines.push(`[TS-Config] ⚠️ ${warning}`);
    }
  }

  if (!validation.canProceed) {
    lines.push(
      "[TS-Config] ℹ️ Test execution will be skipped until config is fixed"
    );
  }

  return lines;
}

// ======================================================
// SUGGESTED FIXES
// ======================================================

/**
 * Provide suggestions for fixing identified issues.
 */
export function suggestFixes(validation: TsConfigValidation): string[] {
  const suggestions: string[] = [];

  for (const issue of validation.issues) {
    if (
      issue.includes("TS5110") ||
      issue.includes("module") ||
      issue.includes("moduleResolution")
    ) {
      suggestions.push(`
Fix: Update tsconfig.json to ensure 'module' and 'moduleResolution' match:

Option 1 (Recommended for Node.js):
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    ...
  }
}

Option 2 (ES Modules):
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    ...
  }
}

Reference: https://www.typescriptlang.org/tsconfig
      `);
    }
  }

  return suggestions;
}
