import {
  Project,
  SyntaxKind,
  Node,
} from "ts-morph";

import path from "path";

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

export function analyzeSymbol(
  repositoryPath: string,
  symbolName: string
): SymbolAnalysis {

  console.log(
    `Analyzing symbol: ${symbolName}`
  );

  // ==================================================
  // Create TypeScript project
  // ==================================================

  const project =
    new Project({
      skipAddingFilesFromTsConfig: true,
    });

  // ==================================================
  // Load source files
  // ==================================================

  project.addSourceFilesAtPaths([

    path.join(
      repositoryPath,
      "**/*.ts"
    ),

    path.join(
      repositoryPath,
      "**/*.tsx"
    ),

    path.join(
      repositoryPath,
      "**/*.js"
    ),

    path.join(
      repositoryPath,
      "**/*.jsx"
    ),

    // Exclude dependencies

    `!${path.join(
      repositoryPath,
      "node_modules/**"
    )}`,

    // Exclude Git

    `!${path.join(
      repositoryPath,
      ".git/**"
    )}`,

    // Exclude build output

    `!${path.join(
      repositoryPath,
      "dist/**"
    )}`,

    `!${path.join(
      repositoryPath,
      "build/**"
    )}`,

    `!${path.join(
      repositoryPath,
      ".next/**"
    )}`,

    `!${path.join(
      repositoryPath,
      "coverage/**"
    )}`,
  ]);

  // ==================================================
  // Result arrays
  // ==================================================

  const definitions:
    SymbolInfo[] = [];

  const usages:
    SymbolInfo[] = [];

  // ==================================================
  // Prevent duplicate usages
  // ==================================================

  const seenUsages =
    new Set<string>();

  // ==================================================
  // Analyze every source file
  // ==================================================

  for (
    const sourceFile
    of project.getSourceFiles()
  ) {

    const filePath =
      sourceFile.getFilePath();

    const relativeFile =
      path.relative(
        repositoryPath,
        filePath
      );

    // ==================================================
    // 1. Function definitions
    // ==================================================

    for (
      const fn
      of sourceFile.getFunctions()
    ) {

      if (
        fn.getName() !== symbolName
      ) {
        continue;
      }

      definitions.push({
        name: symbolName,

        type: "function",

        file: relativeFile,

        line:
          fn.getStartLineNumber(),

        role: "definition",
      });
    }

    // ==================================================
    // 2. Variable definitions
    // ==================================================

    for (
      const variable
      of sourceFile.getVariableDeclarations()
    ) {

      if (
        variable.getName() !== symbolName
      ) {
        continue;
      }

      definitions.push({
        name: symbolName,

        type: "variable",

        file: relativeFile,

        line:
          variable.getStartLineNumber(),

        role: "definition",
      });
    }

    // ==================================================
    // 3. Class definitions
    // ==================================================

    for (
      const cls
      of sourceFile.getClasses()
    ) {

      // ------------------------------------------------
      // Class itself
      // ------------------------------------------------

      if (
        cls.getName() === symbolName
      ) {

        definitions.push({
          name: symbolName,

          type: "class",

          file: relativeFile,

          line:
            cls.getStartLineNumber(),

          role: "definition",
        });
      }

      // ------------------------------------------------
      // Methods inside class
      // ------------------------------------------------

      for (
        const method
        of cls.getMethods()
      ) {

        if (
          method.getName() !== symbolName
        ) {
          continue;
        }

        definitions.push({
          name: symbolName,

          type: "method",

          file: relativeFile,

          line:
            method.getStartLineNumber(),

          role: "definition",
        });
      }
    }

    // ==================================================
    // 4. Find all identifier occurrences
    // ==================================================

    const identifiers =
      sourceFile.getDescendantsOfKind(
        SyntaxKind.Identifier
      );

    for (
      const identifier
      of identifiers
    ) {

      // Not our symbol

      if (
        identifier.getText() !==
        symbolName
      ) {
        continue;
      }

      // ==================================================
      // Ignore variable definition
      // ==================================================

      const variableDeclaration =
        identifier.getFirstAncestorByKind(
          SyntaxKind.VariableDeclaration
        );

      if (
        variableDeclaration &&
        variableDeclaration.getNameNode() ===
          identifier
      ) {
        continue;
      }

      // ==================================================
      // Ignore function definition
      // ==================================================

      const functionDeclaration =
        identifier.getFirstAncestorByKind(
          SyntaxKind.FunctionDeclaration
        );

      if (
        functionDeclaration &&
        functionDeclaration.getNameNode() ===
          identifier
      ) {
        continue;
      }

      // ==================================================
      // Ignore class definition
      // ==================================================

      const classDeclaration =
        identifier.getFirstAncestorByKind(
          SyntaxKind.ClassDeclaration
        );

      if (
        classDeclaration &&
        classDeclaration.getNameNode() ===
          identifier
      ) {
        continue;
      }

      // ==================================================
      // Ignore method definition
      // ==================================================

      const methodDeclaration =
        identifier.getFirstAncestorByKind(
          SyntaxKind.MethodDeclaration
        );

      if (
        methodDeclaration &&
        methodDeclaration.getNameNode() ===
          identifier
      ) {
        continue;
      }

      // ==================================================
      // Find containing function
      // ==================================================

      const containingFunction =
        findContainingFunction(
          identifier
        );

      // ==================================================
      // Create unique usage ID
      // ==================================================

      const usageKey =
        [
          relativeFile,

          identifier.getStartLineNumber(),

          identifier.getStart(),

          symbolName,
        ].join(":");

      // ==================================================
      // Skip duplicate occurrence
      // ==================================================

      if (
        seenUsages.has(usageKey)
      ) {
        continue;
      }

      seenUsages.add(
        usageKey
      );

      // ==================================================
      // Save usage
      // ==================================================

      usages.push({
        name: symbolName,

        type:
          containingFunction?.type ??
          "function",

        file: relativeFile,

        line:
          identifier.getStartLineNumber(),

        role: "usage",

        containingFunction:
          containingFunction?.name,
      });
    }
  }

  // ==================================================
  // Return result
  // ==================================================

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

