import fs from "fs";
import path from "path";
import type { TestMatch, TestRelationship } from "./test-analyzer.js";
import { buildMissingMockStubs } from "./auto-mock-generator.js";

// ======================================================
// CLEAN GENERATED TEST CODE
// ======================================================

/**
 * If the LLM ignored the "no describe()" instruction and wrapped its own
 * test(s) in a describe(), strip that one outer layer so we don't end up
 * double-nested inside the scaffold's own describe().
 */
function stripOuterDescribeWrapper(code: string): string {
  const trimmed = code.trim();
  
  // Check for describe block at the start
  if (!trimmed.startsWith("describe")) return code;
  
  // Simple approach: find the outermost { and matching }
  let braceDepth = 0;
  let braceStart = -1;
  let braceEnd = -1;
  
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    
    if (char === "{") {
      if (braceDepth === 0) braceStart = i + 1;
      braceDepth++;
    } else if (char === "}") {
      braceDepth--;
      if (braceDepth === 0) {
        braceEnd = i;
        break;
      }
    }
  }
  
  // If we found matching braces and they wrap actual code, extract it
  if (braceStart > 0 && braceEnd > braceStart) {
    const content = trimmed.slice(braceStart, braceEnd).trim();
    if (content.length > 0) {
      return content;
    }
  }
  
  return code;
}

/**
 * Fix common syntax errors in LLM-generated test code.
 * - Double commas: `</>,, ` → `</>, `
 * - Trailing commas in function calls
 * - Malformed JSX fragments
 */
/**
 * Fix common LLM pattern mistakes that cause test failures:
 * 1. vi.advanceTimersByTimeAsync without vi.useFakeTimers setup
 * 2. Component definitions inside tests that reference undefined symbols
 * 3. screen usage without import
 */
function fixLLMPatternMistakes(code: string): string {
  let fixed = code;

  // Fix 0: Detect stub tests that don't actually test anything
  // These are tests that just do expect(true).toBe(true) or similar no-ops
  const stubTestRegex = /it\s*\(\s*['"`][^'"`]+['"`]\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*{\s*expect\s*\(\s*(?:true|false|1|0|null|undefined|'[^']*'|"[^"]*")\s*\)\s*\.toBe(?:Null|Undefined|NaN|Truthy|Falsy|InstanceOf|Defined|Called|CalledTimes|CalledWith|CalledOnce)?\s*\(\s*(?:true|false|1|0|null|undefined|'[^']*'|"[^"]*")\s*\)\s*;\s*}\s*\);/gm;
  const stubMatches = Array.from(fixed.matchAll(stubTestRegex));
  
  if (stubMatches.length > 0) {
    console.log(`[Test-File-Writer] ⚠️ CRITICAL: Detected ${stubMatches.length} stub test(s) that don't test actual function behavior!`);
    for (const match of stubMatches) {
      console.log(`[Test-File-Writer]    Stub test: ${match[0].substring(0, 100)}...`);
    }
    console.log(`[Test-File-Writer]    These tests always pass but don't verify function behavior. They should be replaced with real tests.`);
  }

  // Fix 0b: Simpler check for common stub patterns
  if (fixed.includes("expect(true).toBe(true)") || 
      fixed.includes("expect(false).toBe(false)") ||
      fixed.includes("expect(null).toBeNull()") ||
      fixed.includes("expect(undefined).toBeUndefined()")) {
    console.log(`[Test-File-Writer] ⚠️ CRITICAL: Generated test contains stub assertions (always pass, don't test real behavior)!`);
    console.log(`[Test-File-Writer]    The LLM likely couldn't understand the function and generated a placeholder.`);
    console.log(`[Test-File-Writer]    This test should be skipped or rewritten with actual function behavior verification.`);
  }

  // Fix 1: Add vi.useFakeTimers() before vi.advanceTimersByTimeAsync()
  if (fixed.includes("vi.advanceTimersByTimeAsync")) {
    const hasBeforeEachWithFakeTimers = /beforeEach\s*\(\s*\(\)\s*=>\s*{\s*vi\.useFakeTimers\(\)/.test(fixed);
    
    if (!hasBeforeEachWithFakeTimers) {
      if (!fixed.includes("vi.useFakeTimers()")) {
        const firstItIndex = fixed.indexOf("it(");
        if (firstItIndex > -1) {
          const lineStart = fixed.lastIndexOf("\n", firstItIndex) + 1;
          const indent = fixed.substring(lineStart, firstItIndex).match(/^\s*/)?.[0] || "";
          
          const beforeEachCode = `beforeEach(() => {\n${indent}  vi.useFakeTimers();\n${indent}});\n\n${indent}`;
          fixed = fixed.substring(0, lineStart) + beforeEachCode + fixed.substring(lineStart);
          
          console.log("[Test-File-Writer] ✓ Added beforeEach with vi.useFakeTimers() for timer-based tests");
        }
      }
    }
  }

  // Fix 2: Detect and fix screen.getByText/findByText pattern
  // This is a strong indicator that the LLM is using the wrong pattern
  // If we see screen.getByText but render is called, we need to destructure instead
  if (fixed.includes("screen.getByText") || fixed.includes("screen.findByText")) {
    // Check if render is being called (meaning we should destructure)
    if (fixed.includes("render(")) {
      // Find what query methods are used via screen
      const screenMethods = new Set<string>();
      const screenRegex = /screen\.(get|find|query)(By\w+)/g;
      let match;
      while ((match = screenRegex.exec(fixed)) !== null) {
        screenMethods.add((match[1] || '') + (match[2] || ''));
      }
      
      if (screenMethods.size > 0) {
        // Replace screen.getByX with getByX
        fixed = fixed.replace(/screen\.(get|find|query)(By\w+)/g, "$1$2");
        
        // Add destructuring to render calls if not already there
        const methodsList = Array.from(screenMethods).join(", ");
        
        // Find the first render() call and add destructuring if needed
        const hasExistingDestructure = /const\s+{\s*\w+.*}\s*=\s*render\s*\(/;
        if (!hasExistingDestructure.test(fixed)) {
          // Replace first render( with const { methods } = render(
          fixed = fixed.replace(
            /(\n\s*)render\s*\(/,
            `$1const { ${methodsList} } = render(`
          );
        }
        
        console.log("[Test-File-Writer] ✓ Fixed screen.getByX pattern: replaced with destructured methods");
      }
    }
  }

  // Fix 3: Detect component definitions that reference undefined variables
  const componentDefRegex = /function\s+(\w+)\s*\(\s*\)\s*{[\s\S]*?}/g;
  let componentMatch;
  while ((componentMatch = componentDefRegex.exec(fixed)) !== null) {
    const componentCode = componentMatch[0];
    const hookCallRegex = /\b(use\w+)\s*\(/g;
    let hookMatch;
    while ((hookMatch = hookCallRegex.exec(componentCode)) !== null) {
      const hookName = hookMatch[1];
      if (!fixed.includes(`const ${hookName}`) && 
          !fixed.includes(`import.*${hookName}`) &&
          !fixed.includes(`function ${hookName}`) &&
          !fixed.match(new RegExp(`\\b${hookName}\\s*=`))) {
        console.log(`[Test-File-Writer] ⚠️ WARNING: Component uses undefined hook '${hookName}'. LLM test may fail.`);
      }
    }
  }
  
  return fixed;
}


function fixCommonSyntaxErrors(code: string): string {
  // Fix double commas in JSX/function calls (e.g., "</>,," or "arg,,")
  code = code.replace(/,{2,}/g, ",");
  
  // Fix trailing commas before closing parens (e.g., "render(...,)")
  code = code.replace(/,(\s*\))/g, "$1");
  
  // Fix malformed JSX fragments like "<>......</>,,"
  code = code.replace(/<\/>\s*,+\s*,/g, "</>");
  
  return code;
}

/**
 * Clean generated test code before writing it to disk.
 * - Removes outer describe() wrapper if the LLM added one (defensive strip)
 * - Removes Markdown code fences if Gemini added them
 * - Removes excess indentation from all lines
 * - Moves vi.mock() calls to the top (in case LLM put them elsewhere)
 * - Handles multi-line vi.mock() statements properly
 * - Fixes common syntax errors
 */
function cleanGeneratedTestCode(code: string): string {
  console.log("[Test-File-Writer] USING FIXED cleanGeneratedTestCode");
  console.log("[Test-File-Writer] Raw testCode from LLM (first 200 chars):");
  console.log(code.substring(0, 200));
  
  let cleaned = code.replace(/\r\n/g, "\n").trim();
  
  // Fix LLM pattern mistakes early (screen.getByText, timer setup, etc.)
  cleaned = fixLLMPatternMistakes(cleaned);
  
  // Fix common syntax errors
  cleaned = fixCommonSyntaxErrors(cleaned);

  // Strip outer describe() wrapper if present (defensive against LLM ignoring the instruction)
  cleaned = stripOuterDescribeWrapper(cleaned);

  // Remove Markdown code fences if Gemini added them
  cleaned = cleaned.replace(/^```(?:typescript|ts|javascript|js)?\s*/i, "");
  cleaned = cleaned.replace(/\s*```$/i, "");

  // Extract vi.mock and import lines to move to top, handling multi-line mocks
  const lines = cleaned.split("\n");
  const mocks: string[] = [];
  const imports: string[] = [];
  const other: string[] = [];
  
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line?.trim() ?? "";
    
    if (trimmed.startsWith("vi.mock(")) {
      // Extract the full mock statement (may span multiple lines)
      let mockCode = line || "";
      let depth = 0;
      let bracketDepth = 0;
      let foundEnd = false;
      
      for (const ch of mockCode) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (ch === "{") bracketDepth++;
        else if (ch === "}") bracketDepth--;
        if (depth === 0 && bracketDepth === 0 && ch === ")") {
          foundEnd = true;
          break;
        }
      }
      
      // Continue reading lines until complete
      while (!foundEnd && i + 1 < lines.length) {
        i++;
        const nextLine = lines[i];
        if (nextLine) {
          mockCode += "\n" + nextLine;
          for (const ch of nextLine) {
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
            if (ch === "{") bracketDepth++;
            else if (ch === "}") bracketDepth--;
            if (depth === 0 && bracketDepth === 0 && ch === ")") {
              foundEnd = true;
              break;
            }
          }
        }
      }
      
      mocks.push(mockCode);
      i++;
    } else if (trimmed.startsWith("import ")) {
      imports.push(line || "");
      i++;
    } else if (trimmed.length > 0) {
      other.push(line || "");
      i++;
    } else {
      i++;
    }
  }
  
  // Reassemble with imports FIRST, then mocks, then other code
  // This ensures imports are available before vi.mock() references them
  const reassembled = [...imports, ...mocks, ...other].join("\n");

  // Remove unwanted indentation
  const reassembledLines = reassembled.split("\n");
  const nonEmptyLines = reassembledLines.filter((line) => line.trim().length > 0);
  
  const minIndent =
    nonEmptyLines.length > 0
      ? Math.min(...nonEmptyLines.map((line) => line.match(/^\s*/)?.[0].length ?? 0))
      : 0;

  const result = reassembledLines.map((line) => line.slice(minIndent)).join("\n").trim();
  console.log("[Test-File-Writer] Cleaned testCode (first 200 chars):");
  console.log(result.substring(0, 200));
  return result;
}

// ======================================================
// PICKING THE SINGLE BEST RELATED TEST FILE
// ======================================================

/**
 * Strength of evidence, weakest to strongest — mirrors the ordering
 * documented on TestRelationship in test-analyzer.ts. Higher wins.
 */
const RELATIONSHIP_RANK: Record<TestRelationship, number> = {
  dependency: 0,
  "locale-import": 1,
  "same-directory": 2,
  "same-name": 3,
  import: 4,
  "symbol-usage": 5,
};

export interface TargetTestFileResolution {
  /** Repo-relative path of the test file generated tests should land in. */
  testFile: string;
  /** True if this file doesn't exist yet and needs to be created from scratch. */
  isNewFile: boolean;
  /** The match that justified this choice, if any test file was found at all. */
  match?: TestMatch;
}

/**
 * Given every TestMatch found for one changed source file, pick the single
 * most relevant test file to extend — ranked by relationship strength,
 * ties broken by confidence. If nothing matched at all, fall back to a
 * co-located `<basename>.test.ts`, which the caller will need to create.
 *
 * This replaces "arbitrarily pick whichever candidate test the prioritizer
 * happened to rank first" with a deliberate, evidence-based choice, and it's
 * the single place that decision gets made — callers should not re-derive it.
 */
export function resolveTargetTestFile(
  sourceFile: string,
  matchesForFile: TestMatch[]
): TargetTestFileResolution {
  if (matchesForFile.length > 0) {
    const best = [...matchesForFile].sort((a, b) => {
      const rankDiff =
        RELATIONSHIP_RANK[b.relationship] - RELATIONSHIP_RANK[a.relationship];

      if (rankDiff !== 0) {
        return rankDiff;
      }

      return b.confidence - a.confidence;
    })[0]!;

    return { testFile: best.testFile, isNewFile: false, match: best };
  }

  return { testFile: inferNewTestFileName(sourceFile), isNewFile: true };
}

/**
 * Co-located `<basename>.test.ts` or `<basename>.test.tsx` next to the source file — 
 * matching the source file's extension to preserve JSX support.
 * 
 * Rule:
 * - Source .tsx → Test .test.tsx
 * - Source .ts  → Test .test.ts
 * - Source .jsx → Test .test.jsx
 * - Source .js  → Test .test.js
 */
export function inferNewTestFileName(sourceFile: string): string {
  // Extract the base name without extension
  const match = sourceFile.match(/^(.+)\.(ts|tsx|js|jsx)$/);
  if (!match) {
    // Fallback if format doesn't match expected pattern
    return `${sourceFile}.test.ts`;
  }

  const basePath = match[1]!;
  const sourceExtension = match[2]!;

  // BUGFIX: If the source file is already a test file, don't double-add .test
  // This handles cases where sourceFile is something like "onboarding.test.ts"
  if (basePath.endsWith('.test')) {
    // Already a test file, return as-is
    return sourceFile;
  }

  // Preserve the JSX-capable extension
  if (sourceExtension === "tsx" || sourceExtension === "jsx") {
    return `${basePath}.test.${sourceExtension}`;
  }

  // Regular TS/JS gets .ts/.js test file
  return `${basePath}.test.${sourceExtension}`;
}

// ======================================================
// MERGING GENERATED TESTS INTO THE REAL FILE
// ======================================================

export interface GeneratedTestLike {
  name: string;
  testCode: string;
}

export interface MergeResult {
  testFileAbsolute: string;
  finalContent: string;
  /**
   * Content of the file before this merge. `null` means the file didn't
   * exist before — i.e. we created it — so "reverting" means deleting it,
   * not restoring old text.
   */
  originalContent: string | null;
}

/**
 * Merge freshly generated `it()`/`test()` blocks into a real test file.
 *
 * - If the file already exists: insert the new blocks just before the
 *   closing brace of the outermost `describe(...)`, so they land alongside
 *   the existing tests rather than in a side file.
 * - If it doesn't exist: scaffold a new file with an import of the source
 *   module and a `describe()` wrapper around the generated tests.
 *
 * `testFileAbsolute` in the result IS the file the project actually uses —
 * this function never writes to a `__generated__/` or `generated_*` copy.
 */
export function mergeGeneratedTests(
  repositoryRoot: string,
  testFile: string,
  isNewFile: boolean,
  sourceFile: string,
  generatedTests: GeneratedTestLike[]
): MergeResult {
  console.log("[Test-File-Writer] MERGE CALLED - isNewFile:", isNewFile, "testFile:", testFile);
  const testFileAbsolute = path.resolve(repositoryRoot, testFile);

  // Clean all generated test code first
  const cleanedTests = generatedTests.map((t) => ({
    ...t,
    testCode: cleanGeneratedTestCode(t.testCode),
  }));

  // Extract all imports and vi.mock() calls from all tests
  const allImports = new Set<string>();
  const allMocks: string[] = [];

  for (const t of cleanedTests) {
    let code = t.testCode;
    
    // Extract complete vi.mock() statements by parsing carefully
    // Look for vi.mock calls anywhere in the code (even if wrongly placed inside it())
    const lines = code.split("\n");
    const mockLines: string[] = [];
    let i = 0;
    
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line?.trim() ?? "";
      
      // Check if this line starts a vi.mock() call
      if (trimmed.startsWith("vi.mock(")) {
        // Extract the full mock statement by tracking parens/braces
        let mockCode = line || "";
        let depth = 0;
        let bracketDepth = 0;
        let foundEnd = false;
        
        for (const ch of mockCode) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          if (ch === "{") bracketDepth++;
          else if (ch === "}") bracketDepth--;
          if (depth === 0 && bracketDepth === 0 && ch === ")") {
            foundEnd = true;
            break;
          }
        }
        
        // If not complete on first line, keep reading
        while (!foundEnd && i + 1 < lines.length) {
          i++;
          const nextLine = lines[i];
          if (nextLine) {
            mockCode += "\n" + nextLine;
            for (const ch of nextLine) {
              if (ch === "(") depth++;
              else if (ch === ")") depth--;
              if (ch === "{") bracketDepth++;
              else if (ch === "}") bracketDepth--;
              if (depth === 0 && bracketDepth === 0 && ch === ")") {
                foundEnd = true;
                break;
              }
            }
          }
        }
        
        mockLines.push(mockCode);
        i++;
      } else if (trimmed.startsWith("import ")) {
        // Extract imports separately - store the full line normalized
        // Normalize to handle potential variations
        const normalizedImport = trimmed.endsWith(';') ? trimmed : trimmed + ';';
        allImports.add(normalizedImport);
        i++;
      } else if (trimmed.length > 0 && !trimmed.startsWith("vi.")) {
        // Regular test code — skip here, process later
        i++;
      } else {
        i++;
      }
    }
    
    // Add all extracted mocks
    for (const mock of mockLines) {
      allMocks.push(mock);
    }
  }

  // Safety net: if the test code uses symbols that require imports,
  // make sure those imports are in the file
  try {
    for (const t of cleanedTests) {
      const code = t.testCode;
      
      // Map of common symbols to their imports
      const symbolImportMap = new Map<string, string>([
        // React
        ['React', "import React from 'react';"],
        ['StrictMode', "import { StrictMode } from 'react';"],
        ['useState', "import { useState } from 'react';"],
        ['useEffect', "import { useEffect } from 'react';"],
        ['useContext', "import { useContext } from 'react';"],
        ['useCallback', "import { useCallback } from 'react';"],
        ['useMemo', "import { useMemo } from 'react';"],
        // Zustand
        ['create', "import { create } from 'zustand';"],
        ['createWithEqualityFn', "import { createWithEqualityFn } from 'zustand/traditional';"],
        ['persist', "import { persist } from 'zustand/middleware';"],
        ['createJSONStorage', "import { createJSONStorage } from 'zustand/middleware';"],
        ['devtools', "import { devtools } from 'zustand/middleware';"],
        ['subscribeWithSelector', "import { subscribeWithSelector } from 'zustand/middleware';"],
        ['combine', "import { combine } from 'zustand/middleware';"],
        // Testing libraries
        ['render', "import { render } from '@testing-library/react';"],
        ['screen', "import { screen } from '@testing-library/react';"],
        ['act', "import { act } from '@testing-library/react';"],
        ['cleanup', "import { cleanup } from '@testing-library/react';"],
        ['waitFor', "import { waitFor } from '@testing-library/react';"],
        ['fireEvent', "import { fireEvent } from '@testing-library/react';"],
        ['within', "import { within } from '@testing-library/react';"],
        ['userEvent', "import userEvent from '@testing-library/user-event';"],
        // Vitest
        ['vi', "import { vi } from 'vitest';"],
        ['it', "import { it } from 'vitest';"],
        ['describe', "import { describe } from 'vitest';"],
        ['expect', "import { expect } from 'vitest';"],
        ['beforeEach', "import { beforeEach } from 'vitest';"],
        ['afterEach', "import { afterEach } from 'vitest';"],
        ['beforeAll', "import { beforeAll } from 'vitest';"],
        ['afterAll', "import { afterAll } from 'vitest';"],
        ['test', "import { test } from 'vitest';"],
        // Common test utilities
        ['sleep', "import { sleep } from './test-utils';"],
        // Commonly used in mocks and complex applications
        ['vi.fn', "import { vi } from 'vitest';"],
        ['vi.spyOn', "import { vi } from 'vitest';"],
        ['vi.mock', "import { vi } from 'vitest';"],
        ['vi.mocked', "import { vi } from 'vitest';"],
      ]);
      
      // Check for used symbols and add missing imports
      for (const [symbol, importStatement] of symbolImportMap) {
        // Check if symbol is used in the code
        // Look for the symbol as a standalone identifier (not part of another word)
        // Be VERY generous: look for ANY context where the symbol appears as a word boundary
        const symbolPatterns = [
          new RegExp(`\\b${symbol}\\s*\\(`),  // symbol(...)
          new RegExp(`\\b${symbol}\\s*\\)`),  // )symbol...
          new RegExp(`\\b${symbol}\\s*,`),    // symbol,
          new RegExp(`\\b${symbol}\\s*;`),    // symbol;
          new RegExp(`\\s${symbol}\\b`),      // leading whitespace + symbol
          new RegExp(`\\b${symbol}$`, 'm'),   // symbol at line end
          new RegExp(`\\b${symbol}\\.`),      // symbol. (property access)
          new RegExp(`\\(${symbol}`),         // (symbol
          new RegExp(`\\[${symbol}`),         // [symbol
          new RegExp(`${symbol}\\]`),         // symbol]
          new RegExp(`${symbol}\\}`),         // symbol}
          new RegExp(`\\{\\s*${symbol}`),     // { symbol
        ];
        
        const isUsed = symbolPatterns.some(pattern => pattern.test(code));
        
        if (isUsed && !allImports.has(importStatement)) {
          allImports.add(importStatement);
          console.log(`[Test-File-Writer] Auto-added missing import for ${symbol}`);
        }
      }
      
      // Additionally, scan for common function calls that might not match above patterns
      const functionCallRegex = /\b(\w+)\s*\(/g;
      let funcMatch;
      const localFunctionsAndImports = new Set<string>();
      
      // Collect all defined variables and imported names
      for (const importStmt of allImports) {
        const importMatch = importStmt.match(/(?:import|from)\s+(?:\{([^}]+)\}|(\w+))/);
        if (importMatch) {
          const imported = importMatch[1] || importMatch[2];
          if (imported) {
            imported.split(',').forEach(name => {
              localFunctionsAndImports.add(name.trim().split(' as ')[0]?.trim() || '');
            });
          }
        }
      }
      
      // Check for function calls that might need imports
      while ((funcMatch = functionCallRegex.exec(code)) !== null) {
        const funcName = funcMatch[1];
        if (funcName && !localFunctionsAndImports.has(funcName)) {
          // Check if this is in our symbol map
          if (symbolImportMap.has(funcName)) {
            const importStatement = symbolImportMap.get(funcName);
            if (importStatement && !allImports.has(importStatement)) {
              allImports.add(importStatement);
              console.log(`[Test-File-Writer] Auto-added missing import for function ${funcName}`);
            }
          }
        }
      }
    }
  } catch (err) {
    console.log(`[Test-File-Writer] Auto-import safety net skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Build import and mock block at file top
  // Order: imports first, then mocks (vitest requirement)
  let topLevelBlock = "";
  if (allImports.size > 0) {
    topLevelBlock += Array.from(allImports).join("\n") + "\n\n";
  }
  if (allMocks.length > 0) {
    topLevelBlock += allMocks.join("\n\n") + "\n\n";
  }

  // Build indented test block for describe
  // CRITICAL FIX: Deduplicate test blocks by their content (not just name)
  // to prevent duplicate declarations when multiple tests have similar code
  const seenTestContent = new Set<string>();
  const uniqueTests = cleanedTests.filter((t) => {
    // Create a normalized signature of the test (skip whitespace variation)
    const normalized = t.testCode
      .replace(/\s+/g, " ")
      .trim();
    
    if (seenTestContent.has(normalized)) {
      console.log(
        `[Test-File-Writer] ⚠️ DEDUP: Skipping duplicate test "${t.name}" — ` +
        `identical code already processed in this merge batch`
      );
      return false;
    }
    
    seenTestContent.add(normalized);
    return true;
  });
  
  const generatedBlock = uniqueTests
    .map((t) => {
      const lines = t.testCode.split("\n");
      const testOnlyLines: string[] = [];
      let i = 0;
      
      while (i < lines.length) {
        const line = lines[i];
        const trimmed = line?.trim() ?? "";
        
        // Skip vi.mock() calls and imports — they go at file top
        if (trimmed.startsWith("vi.mock(")) {
          // Skip the entire mock statement
          let depth = 0;
          let bracketDepth = 0;
          let foundEnd = false;
          
          for (const ch of (line || "")) {
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
            if (ch === "{") bracketDepth++;
            else if (ch === "}") bracketDepth--;
            if (depth === 0 && bracketDepth === 0 && ch === ")") {
              foundEnd = true;
              break;
            }
          }
          
          while (!foundEnd && i + 1 < lines.length) {
            i++;
            const nextLine = lines[i];
            for (const ch of (nextLine || "")) {
              if (ch === "(") depth++;
              else if (ch === ")") depth--;
              if (ch === "{") bracketDepth++;
              else if (ch === "}") bracketDepth--;
              if (depth === 0 && bracketDepth === 0 && ch === ")") {
                foundEnd = true;
                break;
              }
            }
          }
          i++;
        } else if (trimmed.startsWith("import ")) {
          // Skip imports
          i++;
        } else if (trimmed.length > 0) {
          // Keep test code
          testOnlyLines.push(line || "");
          i++;
        } else {
          i++;
        }
      }
      
      return (
        `\n  // Auto-generated — addresses a coverage gap identified from this commit's diff (${t.name})\n` +
        testOnlyLines.map((line) => `  ${line}`).join("\n")
      );
    })
    .join("\n");

  if (isNewFile || !fs.existsSync(testFileAbsolute)) {
    // Ensure sourceFile is absolute for proper import calculation
    const sourceFileAbsolute = path.isAbsolute(sourceFile) 
      ? sourceFile 
      : path.resolve(repositoryRoot, sourceFile);
    
    const relativeImport = toRelativeImportSpecifier(
      testFileAbsolute,
      sourceFileAbsolute
    );
    const symbolBase = path
      .basename(sourceFile)
      .replace(/\.(ts|tsx|js|jsx)$/, "");

    console.log(
      `[Test-File-Writer] Creating new test file with import: ${relativeImport} (from ${testFileAbsolute} to ${sourceFileAbsolute})`
    );

    const scaffold =
      topLevelBlock +
      `import * as ${toIdentifier(symbolBase)} from "${relativeImport}";\n\n` +
      `describe("${symbolBase}", () => {${generatedBlock}\n});\n`;

    fs.mkdirSync(path.dirname(testFileAbsolute), { recursive: true });
    fs.writeFileSync(testFileAbsolute, scaffold, "utf8");

    console.log(
      `[Test-File-Writer] Created new test file: ${testFileAbsolute}`
    );

    return { testFileAbsolute, finalContent: scaffold, originalContent: null };
  }

  const originalContent = fs.readFileSync(testFileAbsolute, "utf8");
  const insertionIndex = findOuterBlockInsertionPoint(originalContent);

  // Add imports and mocks at the top of the file if not already present
  let finalContent: string;
  if (topLevelBlock.trim().length > 0 || allImports.size > 0 || allMocks.length > 0) {
    // Extract existing imports from the file, normalized for comparison
    const existingImportsRaw = originalContent.match(/^import .+$/gm) || [];
    const existingImports = new Set(
      existingImportsRaw.map((imp) => (imp.trim().endsWith(';') ? imp.trim() : imp.trim() + ';'))
    );
    const existingMockStarts = originalContent.match(/^vi\.mock\(/gm) || [];
    
    // Find imports that are not already in the file
    const newImports = Array.from(allImports).filter(
      (imp) => !existingImports.has(imp)
    );
    
    // Only add mocks if we don't have roughly the same number
    const shouldAddMocks = allMocks.length > 0 && existingMockStarts.length < allMocks.length;
    
    if (newImports.length > 0 || shouldAddMocks) {
      const firstImportIdx = originalContent.search(/^import /m);
      if (firstImportIdx !== -1) {
        // Insert after first import line
        const insertAfterIdx = originalContent.indexOf("\n", firstImportIdx);
        let insertedContent = "";
        if (newImports.length > 0) {
          insertedContent += newImports.join("\n") + "\n";
        }
        if (shouldAddMocks) {
          insertedContent += allMocks.join("\n\n") + "\n\n";
        }
        finalContent =
          originalContent.slice(0, insertAfterIdx + 1) +
          insertedContent +
          originalContent.slice(insertAfterIdx + 1);
      } else {
        // No imports exist, add at the top
        finalContent =
          newImports.join("\n") +
          (newImports.length > 0 ? "\n\n" : "") +
          allMocks.join("\n\n") +
          (allMocks.length > 0 ? "\n\n" : "") +
          originalContent;
      }
    } else {
      finalContent = originalContent;
    }
  } else {
    finalContent = originalContent;
  }

  // Now insert test blocks
  const insertionIdxForTests = findOuterBlockInsertionPoint(finalContent);
  if (insertionIdxForTests === -1) {
    finalContent = `${finalContent}\n${generatedBlock}\n`;
  } else {
    finalContent =
      finalContent.slice(0, insertionIdxForTests) +
      "\n" +
      generatedBlock +
      "\n" +
      finalContent.slice(insertionIdxForTests);
  }

  fs.writeFileSync(testFileAbsolute, finalContent, "utf8");

  console.log(
    `[Test-File-Writer] Extended existing test file with ${generatedTests.length} test(s): ${testFileAbsolute}`
  );

  return { testFileAbsolute, finalContent, originalContent };
}

/**
 * Undo a merge — restores the file to its pre-merge state (or deletes it,
 * if the merge created it). Used when generated tests don't pass and the
 * caller doesn't want to keep them in the real file.
 */
export function revertMerge(result: MergeResult): void {
  if (result.originalContent === null) {
    try {
      fs.unlinkSync(result.testFileAbsolute);
      console.log(
        `[Test-File-Writer] Reverted: deleted newly created ${result.testFileAbsolute}`
      );
    } catch {
      // Already gone — nothing to do.
    }
    return;
  }

  fs.writeFileSync(result.testFileAbsolute, result.originalContent, "utf8");
  console.log(
    `[Test-File-Writer] Reverted: restored original content of ${result.testFileAbsolute}`
  );
}

/**
 * Find the index just before the final closing `});` of the outermost
 * describe block, via brace counting (not a single regex) so nested
 * describes/callbacks don't throw off the match. Returns -1 if no
 * top-level describe wrapper is found.
 */
function findOuterBlockInsertionPoint(content: string): number {
  const describeMatch =
    /\bdescribe\s*\(\s*(['"`]).*?\1\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*{/.exec(
      content
    );

  if (!describeMatch) {
    return -1;
  }

  const openBraceIdx = describeMatch.index + describeMatch[0].length - 1;
  let depth = 0;

  for (let i = openBraceIdx; i < content.length; i++) {
    if (content[i] === "{") {
      depth++;
    } else if (content[i] === "}") {
      depth--;

      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function indent(code: string, prefix: string): string {
  return code
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join("\n");
}

function toRelativeImportSpecifier(
  fromFileAbsolute: string,
  toFileAbsolute: string
): string {
  const fromDir = path.dirname(fromFileAbsolute);
  
  // Normalize both paths to ensure they're absolute
  const normalizedFrom = path.resolve(fromDir);
  const normalizedTo = path.resolve(toFileAbsolute);
  
  let rel = path
    .relative(normalizedFrom, normalizedTo)
    .replace(/\.(ts|tsx|js|jsx)$/, "");

  // Normalize path separators to forward slashes
  rel = rel.replace(/\\/g, "/");

  // Ensure relative path starts with ./ or ../
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }

  return rel;
}

function toIdentifier(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_$]/g, "_");
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}