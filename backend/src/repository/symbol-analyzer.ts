import { SyntaxKind, Node, Project } from "ts-morph";

import type { DiscoveredFile } from "./file-discovery.js";

// ======================================================
// TYPES
// ======================================================

export interface SymbolInfo {
  name: string;

  type:
    | "function"
    | "variable"
    | "method"
    | "class";

  file: string;

  line: number;

  role:
    | "definition"
    | "usage";

  containingFunction?:
    string | undefined;
}

export interface SymbolAnalysis {
  definitions: SymbolInfo[];
  usages: SymbolInfo[];
}

// ======================================================
// ANALYZE SYMBOL
// ======================================================

/**
 * Analyze a symbol by loading files on-demand.
 * Files are loaded one-at-a-time and discarded after analysis to minimize memory usage.
 */
export function analyzeSymbol(
  discoveredFiles: DiscoveredFile[],
  symbolName: string
): SymbolAnalysis {
  console.log(`📊 Analyzing symbol: ${symbolName}`);

  const definitions: SymbolInfo[] = [];
  const usages: SymbolInfo[] = [];
  const seenUsages = new Set<string>();

  // Load each file individually, analyze, then discard
  for (const discovered of discoveredFiles) {
    const { absolutePath, relativePath } = discovered;

    // Skip if path is a directory (EISDIR check)
    // This can happen if usage finder returns directory paths with file extensions
    let isDirectory = false;
    try {
      const fs = require("fs");
      const stat = fs.statSync(absolutePath);
      if (stat.isDirectory()) {
        console.warn(
          `Skipping directory path (expected file): ${absolutePath}`
        );
        continue;
      }
    } catch (statError) {
      console.warn(
        `Could not stat ${absolutePath}:`,
        statError instanceof Error ? statError.message : String(statError)
      );
      continue;
    }

    const project = new Project({
      skipAddingFilesFromTsConfig: true,
    });

    try {
      const sourceFile = project.addSourceFileAtPath(absolutePath);

      // ============================================
      // FUNCTION DEFINITIONS
      // ============================================
      for (const fn of sourceFile.getFunctions()) {
        if (fn.getName() === symbolName) {
          definitions.push({
            name: symbolName,
            type: "function",
            file: relativePath,
            line: fn.getStartLineNumber(),
            role: "definition",
          });
        }
      }

      // ============================================
      // VARIABLE DEFINITIONS
      // ============================================
      for (const variable of sourceFile.getVariableDeclarations()) {
        if (variable.getName() === symbolName) {
          definitions.push({
            name: symbolName,
            type: "variable",
            file: relativePath,
            line: variable.getStartLineNumber(),
            role: "definition",
          });
        }
      }

      // ============================================
      // CLASS DEFINITIONS
      // ============================================
      for (const cls of sourceFile.getClasses()) {
        if (cls.getName() === symbolName) {
          definitions.push({
            name: symbolName,
            type: "class",
            file: relativePath,
            line: cls.getStartLineNumber(),
            role: "definition",
          });
        }

        for (const method of cls.getMethods()) {
          if (method.getName() === symbolName) {
            definitions.push({
              name: symbolName,
              type: "method",
              file: relativePath,
              line: method.getStartLineNumber(),
              role: "definition",
            });
          }
        }
      }

      // ============================================
      // USAGES
      // ============================================
      const identifiers = sourceFile.getDescendantsOfKind(
        SyntaxKind.Identifier
      );

      for (const identifier of identifiers) {
        if (identifier.getText() !== symbolName) {
          continue;
        }

        // Skip definitions
        const variableDeclaration =
          identifier.getFirstAncestorByKind(
            SyntaxKind.VariableDeclaration
          );
        if (
          variableDeclaration &&
          variableDeclaration.getNameNode() === identifier
        ) {
          continue;
        }

        const functionDeclaration =
          identifier.getFirstAncestorByKind(
            SyntaxKind.FunctionDeclaration
          );
        if (
          functionDeclaration &&
          functionDeclaration.getNameNode() === identifier
        ) {
          continue;
        }

        const classDeclaration =
          identifier.getFirstAncestorByKind(
            SyntaxKind.ClassDeclaration
          );
        if (
          classDeclaration &&
          classDeclaration.getNameNode() === identifier
        ) {
          continue;
        }

        const methodDeclaration =
          identifier.getFirstAncestorByKind(
            SyntaxKind.MethodDeclaration
          );
        if (
          methodDeclaration &&
          methodDeclaration.getNameNode() === identifier
        ) {
          continue;
        }

        const containingFunction =
          findContainingFunction(identifier);

        const usageKey = `${relativePath}:${identifier.getStart()}`;
        if (seenUsages.has(usageKey)) {
          continue;
        }

        seenUsages.add(usageKey);

        usages.push({
          name: symbolName,
          type: containingFunction?.type ?? "function",
          file: relativePath,
          line: identifier.getStartLineNumber(),
          role: "usage",
          containingFunction: containingFunction?.name,
        });
      }
    } catch (error) {
      console.warn(
        `Failed to analyze file ${absolutePath}:`,
        error
      );
    }

    // Project goes out of scope and gets garbage collected
  }

  console.log(
    `✓ Found ${definitions.length} definition(s), ${usages.length} usage(s)`
  );

  return {
    definitions,
    usages,
  };
}

// ======================================================
// FIND CONTAINING FUNCTION
// ======================================================

function findContainingFunction(
  node: Node
):
  | {
      name: string;

      type:
        | "function"
        | "method";
    }
  | undefined {

  // ==================================================
  // Normal function
  // ==================================================

  const functionDeclaration =
    node.getFirstAncestorByKind(
      SyntaxKind.FunctionDeclaration
    );

  if (functionDeclaration) {

    return {
      name:
        functionDeclaration.getName() ??
        "<anonymous>",

      type: "function",
    };
  }

  // ==================================================
  // Class method
  // ==================================================

  const methodDeclaration =
    node.getFirstAncestorByKind(
      SyntaxKind.MethodDeclaration
    );

  if (methodDeclaration) {

    return {
      name:
        methodDeclaration.getName() ??
        "<anonymous>",

      type: "method",
    };
  }

  // ==================================================
  // Arrow function
  // ==================================================

  const arrowFunction =
    node.getFirstAncestorByKind(
      SyntaxKind.ArrowFunction
    );

  if (arrowFunction) {

    const parent =
      arrowFunction.getParent();

    if (
      Node.isVariableDeclaration(
        parent
      )
    ) {

      return {
        name:
          parent.getName(),

        type: "function",
      };
    }

    return {
      name:
        "<anonymous arrow function>",

      type: "function",
    };
  }

  // ==================================================
  // Function expression
  // ==================================================

  const functionExpression =
    node.getFirstAncestorByKind(
      SyntaxKind.FunctionExpression
    );

  if (functionExpression) {

    const parent =
      functionExpression.getParent();

    if (
      Node.isVariableDeclaration(
        parent
      )
    ) {

      return {
        name:
          parent.getName(),

        type: "function",
      };
    }

    return {
      name:
        "<anonymous function>",

      type: "function",
    };
  }

  // ==================================================
  // No containing function
  // ==================================================

  return undefined;
}

