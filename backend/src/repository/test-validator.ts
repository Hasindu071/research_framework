/**
 * Test Validator: Validates generated test code for TypeScript compilation errors
 * and attempts repairs before merging into the test file.
 * 
 * This module ensures that generated tests won't fail at compile-time due to:
 * - Type mismatches
 * - Missing imports
 * - Incorrect API usage
 * - Invalid property access
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// ======================================================
// TYPES
// ======================================================

export interface TypeScriptError {
  line: number;
  column: number;
  message: string;
  code: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: TypeScriptError[];
  warnings: string[];
  repairedCode?: string;
  repairAttempted: boolean;
  repairSuccessful: boolean;
}

// ======================================================
// TYPESCRIPT VALIDATION
// ======================================================

/**
 * Validate generated test code by creating a temporary test file
 * and running TypeScript compiler on it.
 */
export function validateGeneratedTestCode(
  testCode: string,
  testFilePath: string,
  repositoryRoot: string
): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    repairAttempted: false,
    repairSuccessful: false,
  };

  // Create temporary file for validation
  const tempDir = path.join(repositoryRoot, ".test-validation-temp");
  const tempTestFile = path.join(tempDir, path.basename(testFilePath));

  try {
    // Ensure temp directory exists
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Write test code to temp file
    fs.writeFileSync(tempTestFile, testCode, "utf8");

    // Try to compile with TypeScript
    try {
      const tscPath = path.join(repositoryRoot, "node_modules", ".bin", "tsc");
      if (!fs.existsSync(tscPath)) {
        result.warnings.push("TypeScript compiler not found, skipping validation");
        return result;
      }

      // Run tsc on the temp file with noEmit flag
      try {
        execSync(`${tscPath} --noEmit "${tempTestFile}"`, {
          cwd: repositoryRoot,
          encoding: "utf8",
        });
      } catch (error: any) {
        // Parse errors from stderr
        const stderr = error.stderr || error.message || String(error);
        const errors = parseTypeScriptErrors(stderr);
        
        if (errors.length > 0) {
          result.valid = false;
          result.errors = errors;

          // Attempt repairs
          const repaired = attemptRepairs(testCode, errors);
          if (repaired && repaired !== testCode) {
            result.repairAttempted = true;
            result.repairedCode = repaired;

            // Validate repaired code
            fs.writeFileSync(tempTestFile, repaired, "utf8");
            try {
              execSync(`${tscPath} --noEmit "${tempTestFile}"`, {
                cwd: repositoryRoot,
                encoding: "utf8",
              });
              result.repairSuccessful = true;
              result.valid = true;
              result.errors = []; // Clear errors if repair worked
            } catch {
              // Repair didn't work, keep original errors
              result.repairSuccessful = false;
            }
          }
        }
      }
    } catch (err) {
      result.warnings.push(`Failed to run TypeScript validation: ${err instanceof Error ? err.message : String(err)}`);
    }

    return result;
  } finally {
    // Clean up temp file
    try {
      if (fs.existsSync(tempTestFile)) {
        fs.unlinkSync(tempTestFile);
      }
      // Remove temp dir if empty
      if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir);
        if (files.length === 0) {
          fs.rmdirSync(tempDir);
        }
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  }
}

// ======================================================
// ERROR PARSING
// ======================================================

/**
 * Parse TypeScript compiler errors from stderr output.
 */
function parseTypeScriptErrors(stderr: string): TypeScriptError[] {
  const errors: TypeScriptError[] = [];
  
  // TypeScript error format examples:
  // error TS2339: Property 'v' does not exist on type 'AtomState<unknown>'.
  // (line,col): error TSXXXX: message

  const lines = stderr.split("\n");
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    
    // Try to extract line:col info
    let currentLine = 1;
    let currentCol = 1;
    const posMatch = line.match(/\((\d+),(\d+)\)/);
    if (posMatch) {
      currentLine = parseInt(posMatch[1] || "1", 10);
      currentCol = parseInt(posMatch[2] || "1", 10);
    }

    // Extract error code and message
    const errMatch = line.match(/(?:error|warning)\s+TS(\d+):\s+(.+?)$/);
    if (errMatch) {
      errors.push({
        line: currentLine,
        column: currentCol,
        message: errMatch[2] || "",
        code: `TS${errMatch[1] || "0"}`,
      });
    }
  }

  return errors;
}

// ======================================================
// REPAIR ATTEMPTS
// ======================================================

/**
 * Attempt to repair generated test code based on TypeScript errors.
 */
function attemptRepairs(testCode: string, errors: TypeScriptError[]): string | null {
  let repaired = testCode;
  let madeChanges = false;

  for (const error of errors) {
    const message = error.message || "";
    
    // ========================================
    // Error: Property 'X' does not exist on type 'Y'
    // ========================================
    if (error.code === "TS2339") {
      // Pattern: accessing .v on AtomState or similar
      if (message.includes("Property 'v' does not exist")) {
        if (repaired.includes(".v")) {
          repaired = repaired.replace(/\.v\b/g, "");
          console.log(`[Test-Validator] Repaired: Removed .v property access`);
          madeChanges = true;
        }
      }
      // Pattern: accessing .d on state
      else if (message.includes("Property 'd' does not exist")) {
        if (repaired.includes(".d")) {
          repaired = repaired.replace(/\.d\b/g, "");
          console.log(`[Test-Validator] Repaired: Removed .d property access`);
          madeChanges = true;
        }
      }
      // Pattern: accessing .e on state
      else if (message.includes("Property 'e' does not exist")) {
        if (repaired.includes(".e")) {
          repaired = repaired.replace(/\.e\b/g, "");
          console.log(`[Test-Validator] Repaired: Removed .e property access`);
          madeChanges = true;
        }
      }
    }

    // ========================================
    // Error: Cannot find name 'X'
    // ========================================
    if (error.code === "TS2304") {
      if (message.includes("Cannot find name 'jest'")) {
        if (!repaired.includes("jest") && !repaired.includes("vi")) {
          console.log(`[Test-Validator] Note: Test uses jest but should use vitest`);
        }
      }
      if (message.includes("Cannot find name 'expect'")) {
        console.log(`[Test-Validator] Note: Missing expect - should be globally available`);
      }
    }

    // ========================================
    // Error: Cannot find module 'X'
    // ========================================
    if (error.code === "TS2307") {
      console.log(`[Test-Validator] Note: Missing module: ${message}`);
    }

    // ========================================
    // Error: Parameter 'X' implicitly has an 'any' type
    // ========================================
    if (error.code === "TS7006") {
      const paramMatch = message.match(/Parameter '(\w+)' implicitly/);
      if (paramMatch && paramMatch[1]) {
        const paramName = paramMatch[1];
        const pattern = new RegExp(`\\(([^)]*)\\b${paramName}\\b([^)]*)\\)`, "g");
        if (pattern.test(repaired)) {
          repaired = repaired.replace(
            pattern,
            `($1${paramName}: any$2)`
          );
          console.log(`[Test-Validator] Repaired: Added type annotation for parameter '${paramName}'`);
          madeChanges = true;
        }
      }
    }

    // ========================================
    // Error: Type 'unknown' is not assignable to type 'X'
    // ========================================
    if (error.code === "TS2322") {
      if (message.includes("Type 'unknown' is not assignable to type 'ReactNode'")) {
        console.log(`[Test-Validator] Note: Type mismatch with React - check test assertions`);
      }
    }
  }

  return madeChanges ? repaired : null;
}

// ======================================================
// PUBLIC INTERFACE
// ======================================================

/**
 * Validate and optionally repair generated test code.
 * Returns the original code if no errors, repaired code if repairs were successful,
 * or null if validation failed and no repairs could be made.
 */
export function validateAndRepairTestCode(
  testCode: string,
  testFilePath: string,
  repositoryRoot: string
): { code: string; valid: boolean; errors: TypeScriptError[] } {
  const validation = validateGeneratedTestCode(testCode, testFilePath, repositoryRoot);

  return {
    code: validation.repairedCode || testCode,
    valid: validation.valid,
    errors: validation.errors,
  };
}
