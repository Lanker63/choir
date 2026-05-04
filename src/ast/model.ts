import ts from "typescript";
import { visitDepthFirst } from "./visitor.js";

export type AST = ts.SourceFile;
export type NodeId = string;

export interface NormalizedNode {
  id: NodeId;
  kind: ts.SyntaxKind;
  kindName: string;
  pos: number;
  end: number;
  parentId: NodeId | null;
  childIds: NodeId[];
  stablePath: string;
}

export interface NormalizedAST {
  filePath: string;
  sourceFile: AST;
  rootNodeId: NodeId;
  traversalOrder: NodeId[];
  nodes: Map<NodeId, NormalizedNode>;
  nodeById: Map<NodeId, ts.Node>;
  nodeIdByNode: WeakMap<ts.Node, NodeId>;
  parseDiagnostics: readonly ts.Diagnostic[];
}

export interface ReadonlyNormalizedAST {
  filePath: string;
  rootNodeId: NodeId;
  traversalOrder: readonly NodeId[];
  getNode(nodeId: NodeId): NormalizedNode | undefined;
  hasNode(nodeId: NodeId): boolean;
}

export interface ValidationIssue {
  code:
    | "parse-error"
    | "invalid-root"
    | "invalid-kind"
    | "invalid-range"
    | "missing-parent"
    | "missing-child"
    | "invalid-parent-child-link"
    | "child-range-outside-parent"
    | "orphan-node";
  message: string;
  nodeId?: NodeId;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export interface ASTValidationFailure {
  filePath: string;
  result: ValidationResult;
}

export function normalizeAST(ast: AST, filePath = ast.fileName): NormalizedAST {
  const parseDiagnostics = (
    ast as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics ?? [];

  const nodes = new Map<NodeId, NormalizedNode>();
  const nodeById = new Map<NodeId, ts.Node>();
  const nodeIdByNode = new WeakMap<ts.Node, NodeId>();
  const traversalOrder: NodeId[] = [];

  visitDepthFirst(ast, (node, state) => {
    const parentId = state.parent ? nodeIdByNode.get(state.parent) ?? null : null;
    const stablePath = parentId
      ? `${nodes.get(parentId)?.stablePath ?? "0"}.${state.childIndex}`
      : "0";

    const id = `${stablePath}:${node.kind}:${node.pos}:${node.end}`;

    const normalizedNode: NormalizedNode = {
      id,
      kind: node.kind,
      kindName: ts.SyntaxKind[node.kind] ?? "Unknown",
      pos: node.pos,
      end: node.end,
      parentId,
      childIds: [],
      stablePath,
    };

    nodes.set(id, normalizedNode);
    nodeById.set(id, node);
    nodeIdByNode.set(node, id);
    traversalOrder.push(id);

    if (parentId) {
      const parent = nodes.get(parentId);
      if (parent) {
        parent.childIds.push(id);
      }
    }
  });

  const rootNodeId = traversalOrder[0] ?? "";

  return {
    filePath,
    sourceFile: ast,
    rootNodeId,
    traversalOrder,
    nodes,
    nodeById,
    nodeIdByNode,
    parseDiagnostics,
  };
}

export function validateNormalizedAST(normalized: NormalizedAST): ValidationResult {
  const issues: ValidationIssue[] = [];
  const nodes = normalized.nodes;

  if (!normalized.rootNodeId || !nodes.has(normalized.rootNodeId)) {
    issues.push({
      code: "invalid-root",
      message: `Missing root node for ${normalized.filePath}`,
    });
  } else {
    const root = nodes.get(normalized.rootNodeId);
    if (root && root.parentId !== null) {
      issues.push({
        code: "invalid-root",
        message: `Root node must not have a parent in ${normalized.filePath}`,
        nodeId: root.id,
      });
    }
  }

  for (const diagnostic of normalized.parseDiagnostics) {
    issues.push({
      code: "parse-error",
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    });
  }

  for (const node of nodes.values()) {
    if (node.kind < 0 || node.kind >= ts.SyntaxKind.Count) {
      issues.push({
        code: "invalid-kind",
        message: `Invalid node kind ${node.kind} for ${node.id}`,
        nodeId: node.id,
      });
    }

    if (node.pos > node.end || node.pos < 0) {
      issues.push({
        code: "invalid-range",
        message: `Invalid range [${node.pos}, ${node.end}] for ${node.id}`,
        nodeId: node.id,
      });
    }

    if (node.id !== normalized.rootNodeId && node.parentId === null) {
      issues.push({
        code: "missing-parent",
        message: `Non-root node ${node.id} is missing parent`,
        nodeId: node.id,
      });
    }

    if (node.parentId) {
      const parent = nodes.get(node.parentId);
      if (!parent) {
        issues.push({
          code: "missing-parent",
          message: `Parent ${node.parentId} for node ${node.id} is missing`,
          nodeId: node.id,
        });
      } else {
        const linked = parent.childIds.includes(node.id);
        if (!linked) {
          issues.push({
            code: "invalid-parent-child-link",
            message: `Parent ${parent.id} does not link child ${node.id}`,
            nodeId: node.id,
          });
        }

        if (node.pos < parent.pos || node.end > parent.end) {
          issues.push({
            code: "child-range-outside-parent",
            message: `Node ${node.id} range is outside parent ${parent.id}`,
            nodeId: node.id,
          });
        }
      }
    }

    for (const childId of node.childIds) {
      const child = nodes.get(childId);
      if (!child) {
        issues.push({
          code: "missing-child",
          message: `Node ${node.id} references missing child ${childId}`,
          nodeId: node.id,
        });
        continue;
      }

      if (child.parentId !== node.id) {
        issues.push({
          code: "invalid-parent-child-link",
          message: `Child ${child.id} parent mismatch (expected ${node.id}, got ${child.parentId})`,
          nodeId: child.id,
        });
      }
    }
  }

  if (normalized.rootNodeId && nodes.has(normalized.rootNodeId)) {
    const visited = new Set<NodeId>();
    const stack: NodeId[] = [normalized.rootNodeId];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);

      const node = nodes.get(current);
      if (!node) {
        continue;
      }

      for (const childId of node.childIds) {
        stack.push(childId);
      }
    }

    for (const nodeId of nodes.keys()) {
      if (!visited.has(nodeId)) {
        issues.push({
          code: "orphan-node",
          message: `Node ${nodeId} is unreachable from root`,
          nodeId,
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

export function validateAST(ast: AST): ValidationResult {
  return validateNormalizedAST(normalizeAST(ast));
}

export function createReadonlyNormalizedAST(normalized: NormalizedAST): ReadonlyNormalizedAST {
  const traversalOrder = Object.freeze([...normalized.traversalOrder]);

  return Object.freeze({
    filePath: normalized.filePath,
    rootNodeId: normalized.rootNodeId,
    traversalOrder,
    getNode(nodeId: NodeId): NormalizedNode | undefined {
      const node = normalized.nodes.get(nodeId);
      if (!node) {
        return undefined;
      }

      return {
        ...node,
        childIds: [...node.childIds],
      };
    },
    hasNode(nodeId: NodeId): boolean {
      return normalized.nodes.has(nodeId);
    },
  });
}

export function formatValidationIssues(result: ValidationResult): string[] {
  return result.issues.map((issue) => {
    if (issue.nodeId) {
      return `[${issue.code}] ${issue.message} (${issue.nodeId})`;
    }

    return `[${issue.code}] ${issue.message}`;
  });
}
