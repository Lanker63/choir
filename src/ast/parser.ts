import ts from "typescript";
import { EnforcementContext } from "../core/context.js";
import { AST, Graph, SymbolGraph } from "../core/state.js";
import {
  ASTValidationFailure,
  NormalizedAST,
  formatValidationIssues,
  normalizeAST,
  validateNormalizedAST,
} from "./model.js";
import { visitDepthFirst } from "./visitor.js";

export interface ParseArtifacts {
  astIndex: Record<string, AST>;
  symbolGraph: SymbolGraph;
  dependencyGraph: Graph;
  normalizedAsts: Record<string, NormalizedAST>;
  validationFailures: ASTValidationFailure[];
}

function normalizeImportSpecifier(node: ts.ImportDeclaration): string {
  const text = node.moduleSpecifier.getText();
  return text.replace(/^['"]|['"]$/g, "");
}

function readCallExpressionName(node: ts.CallExpression, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }

  if (ts.isPropertyAccessExpression(node.expression)) {
    return node.expression.getText(sourceFile);
  }

  return node.expression.getText(sourceFile);
}

export function parseAST(context: EnforcementContext): ParseArtifacts {
  const astIndex: Record<string, AST> = {};
  const symbolGraph: SymbolGraph = {};
  const dependencyGraph: Graph = {};
  const normalizedAsts: Record<string, NormalizedAST> = {};
  const validationFailures: ASTValidationFailure[] = [];

  for (const file of context.files) {
    const sourceFile = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true
    );

    context.astMap.set(file.path, sourceFile);

    const normalized = normalizeAST(sourceFile, file.path);
    const validation = validateNormalizedAST(normalized);
    if (!validation.ok) {
      validationFailures.push({
        filePath: file.path,
        result: {
          ok: false,
          issues: validation.issues,
        },
      });

      // Invalid AST must fail fast while preserving diagnostics for the pipeline.
      break;
    }

    normalizedAsts[file.path] = normalized;

    const imports: string[] = [];
    const functions: string[] = [];
    const callExpressions: string[] = [];
    let nodeCount = 0;

    visitDepthFirst(sourceFile, (node) => {
      nodeCount += 1;

      if (ts.isImportDeclaration(node)) {
        imports.push(normalizeImportSpecifier(node));
      }

      if (ts.isFunctionDeclaration(node) && node.name?.text) {
        functions.push(node.name.text);
      }

      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        functions.push(node.name.text);
      }

      if (ts.isCallExpression(node)) {
        callExpressions.push(readCallExpressionName(node, sourceFile));
      }
    });

    const validationIssues = formatValidationIssues(validation);

    astIndex[file.path] = {
      rootNodeId: normalized.rootNodeId,
      nodeCount,
      parseDiagnostics: normalized.parseDiagnostics.length,
      validationIssues: validationIssues.length,
      imports,
      functions,
      callExpressions,
    };

    symbolGraph[file.path] = functions;
    dependencyGraph[file.path] = imports;
  }

  return {
    astIndex,
    symbolGraph,
    dependencyGraph,
    normalizedAsts,
    validationFailures,
  };
}