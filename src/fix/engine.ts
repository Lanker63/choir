import ts from "typescript";
import {
  AST,
  NodeId,
  NormalizedAST,
  normalizeAST,
  validateNormalizedAST,
} from "../ast/model.js";
import { deepFreeze } from "../utils/deepFreeze.js";
import { Violation } from "../core/types.js";
import {
  Patch,
  PatchApplyResult,
  PatchValidationResult,
  StructureDiff,
} from "./types.js";

function validatePatch(normalizedAst: NormalizedAST, patch: Patch): string[] {
  const errors: string[] = [];
  const targetNode = normalizedAst.nodeById.get(patch.targetNodeId);

  if (!targetNode) {
    errors.push(`Target node ${patch.targetNodeId} does not exist`);
    return errors;
  }

  if (patch.operation === "remove" && patch.targetNodeId === normalizedAst.rootNodeId) {
    errors.push("Cannot remove root SourceFile node");
  }

  if ((patch.operation === "replace" || patch.operation === "insert") && !patch.payload) {
    errors.push(`Patch ${patch.operation} requires payload`);
  }

  if (patch.operation === "insert" && patch.payload) {
    const insertable = ts.isSourceFile(targetNode) || ts.isBlock(targetNode);
    const statementPayload = ts.isStatement(patch.payload);
    if (!insertable || !statementPayload) {
      errors.push("Insert is only supported for SourceFile/Block targets with statement payload");
    }
  }

  return errors;
}

export function validatePatches(normalizedAst: NormalizedAST, patches: Patch[]): PatchValidationResult {
  const issues = patches.flatMap((patch) =>
    validatePatch(normalizedAst, patch).map((message) => ({
      targetNodeId: patch.targetNodeId,
      message,
    }))
  );

  return {
    ok: issues.length === 0,
    issues,
  };
}

export function applyPatches(ast: AST, normalizedAst: NormalizedAST, patches: Patch[]): AST {
  const frozenPatches = deepFreeze([...patches]);
  const patchValidation = validatePatches(normalizedAst, frozenPatches);
  if (!patchValidation.ok) {
    const message = patchValidation.issues
      .map((issue) => `${issue.targetNodeId}: ${issue.message}`)
      .join(" | ");
    throw new Error(`Invalid patch set: ${message}`);
  }

  const patchByTarget = new Map<NodeId, Patch>();
  for (const patch of frozenPatches) {
    patchByTarget.set(patch.targetNodeId, patch);
  }

  const transformer: ts.TransformerFactory<ts.SourceFile> = (transformContext) => {
    const visit: ts.Visitor = (node: ts.Node): ts.VisitResult<ts.Node> => {
      const nodeId = normalizedAst.nodeIdByNode.get(node);
      const patch = nodeId ? patchByTarget.get(nodeId) : undefined;

      if (patch) {
        if (patch.operation === "remove") {
          return undefined as unknown as ts.VisitResult<ts.Node>;
        }

        if (patch.operation === "replace" && patch.payload) {
          return patch.payload;
        }

        if (patch.operation === "insert" && patch.payload) {
          if (ts.isSourceFile(node) && ts.isStatement(patch.payload)) {
            return ts.factory.updateSourceFile(node, [patch.payload, ...node.statements]);
          }

          if (ts.isBlock(node) && ts.isStatement(patch.payload)) {
            return ts.factory.updateBlock(node, [patch.payload, ...node.statements]);
          }
        }
      }

      return ts.visitEachChild(node, visit, transformContext);
    };

    return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
  };

  const transformed = ts.transform(ast, [transformer]);
  const nextAst = transformed.transformed[0] as ts.SourceFile;
  transformed.dispose();
  return nextAst;
}

export function compareASTStructure(before: NormalizedAST, after: NormalizedAST): StructureDiff {
  const beforeIds = new Set(before.traversalOrder);
  const afterIds = new Set(after.traversalOrder);

  const removedNodeIds = [...beforeIds]
    .filter((nodeId) => !afterIds.has(nodeId))
    .sort((a, b) => a.localeCompare(b));

  const addedNodeIds = [...afterIds]
    .filter((nodeId) => !beforeIds.has(nodeId))
    .sort((a, b) => a.localeCompare(b));

  return {
    removedNodeIds,
    addedNodeIds,
  };
}

export function applyPatchesWithRoundTrip(
  ast: AST,
  normalizedAst: NormalizedAST,
  patches: Patch[]
): PatchApplyResult {
  const patchValidation = validatePatches(normalizedAst, patches);
  if (!patchValidation.ok) {
    return {
      ast,
      code: ast.getFullText(),
      validation: {
        ok: false,
        issues: patchValidation.issues.map((issue) => ({
          code: "invalid-parent-child-link",
          message: issue.message,
        })),
      },
      patchValidation,
      roundTripSafe: false,
    };
  }

  const transformedAst = applyPatches(ast, normalizedAst, patches);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const emittedCode = printer.printFile(transformedAst);

  const reparsed = ts.createSourceFile(
    ast.fileName,
    emittedCode,
    ts.ScriptTarget.Latest,
    true
  );

  const normalizedReparsed = normalizeAST(reparsed, ast.fileName);
  const validation = validateNormalizedAST(normalizedReparsed);

  return {
    ast: reparsed,
    code: emittedCode,
    validation,
    patchValidation,
    roundTripSafe: validation.ok,
  };
}

export function generateFixes(_violations: Violation[]): Patch[] {
  return [];
}