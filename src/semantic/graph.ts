import ts from "typescript";
import { EnforcementContext } from "../core/context.js";
import { deterministicHash, stableSortBy } from "../core/deterministicCore.js";
import { NodeId, NormalizedAST, normalizeAST } from "../ast/model.js";
import { CompilerWorkspace } from "../core/compilerWorkspace.js";

export type SemanticGraph = {
  symbols: Map<string, ts.Symbol>;
  types: Map<NodeId, ts.Type>;
  references: Map<NodeId, NodeId[]>;
};

export interface ReadonlySemanticGraph {
  getType(nodeId: NodeId): ts.Type | undefined;
  getReferences(nodeId: NodeId): readonly NodeId[];
  getSymbol(symbolKey: string): ts.Symbol | undefined;
  symbolKeys(): readonly string[];
}

export interface SemanticBuildResult {
  graph: SemanticGraph;
  diagnostics: readonly ts.Diagnostic[];
}

export type SemanticBuildOptions = {
  includeGraph?: boolean;
};

type SemanticCacheEntry = {
  key: string;
  result: SemanticBuildResult;
};

let semanticCache: SemanticCacheEntry | null = null;

function makeCacheKey(context: EnforcementContext, options: Required<SemanticBuildOptions>): string {
  const fingerprints = stableSortBy(context.files, (file) => file.path)
    .map((file) => ({
      path: file.path,
      contentHash: deterministicHash(file.content),
    }));

  return deterministicHash({
    fingerprints,
    includeGraph: options.includeGraph,
  });
}

export function createEmptySemanticGraph(): SemanticGraph {
  return {
    symbols: new Map<string, ts.Symbol>(),
    types: new Map<NodeId, ts.Type>(),
    references: new Map<NodeId, NodeId[]>(),
  };
}

function addReferenceReference(
  map: Map<NodeId, NodeId[]>,
  declarationNodeId: NodeId,
  referenceNodeId: NodeId
): void {
  const existing = map.get(declarationNodeId) ?? [];
  if (!existing.includes(referenceNodeId)) {
    existing.push(referenceNodeId);
    existing.sort((a, b) => a.localeCompare(b));
    map.set(declarationNodeId, existing);
  }
}

function getSymbolLookupNode(node: ts.Node): ts.Node {
  const named = node as ts.Node & { name?: ts.Node };
  return named.name ?? node;
}

function normalizePath(value: string): string {
  return value.split("\\").join("/");
}

function toStableFilePath(root: string, filePath: string): string {
  const relative = normalizePath(filePath).startsWith(normalizePath(root))
    ? normalizePath(filePath).slice(normalizePath(root).length).replace(/^\//, "")
    : normalizePath(filePath);

  return relative.length > 0 ? relative : ".";
}

function stableSymbolKey(
  context: EnforcementContext,
  projectId: string,
  symbol: ts.Symbol,
  checker: ts.TypeChecker
): string {
  const declarations = [...(symbol.declarations ?? [])].sort((left, right) => {
    const leftFile = normalizePath(left.getSourceFile().fileName);
    const rightFile = normalizePath(right.getSourceFile().fileName);
    if (leftFile !== rightFile) {
      return leftFile.localeCompare(rightFile);
    }

    return left.getStart() - right.getStart();
  });
  const declaration = declarations[0];
  if (!declaration) {
    return `${projectId}:unknown:${checker.getFullyQualifiedName(symbol)}`;
  }

  return [
    projectId,
    toStableFilePath(context.root, declaration.getSourceFile().fileName),
    declaration.getStart(),
    symbol.getEscapedName().toString(),
  ].join(":");
}

export function createReadonlySemanticGraph(graph: SemanticGraph): ReadonlySemanticGraph {
  return {
    getType(nodeId: NodeId): ts.Type | undefined {
      return graph.types.get(nodeId);
    },
    getReferences(nodeId: NodeId): readonly NodeId[] {
      return graph.references.get(nodeId) ?? [];
    },
    getSymbol(symbolKey: string): ts.Symbol | undefined {
      return graph.symbols.get(symbolKey);
    },
    symbolKeys(): readonly string[] {
      return [...graph.symbols.keys()].sort((a, b) => a.localeCompare(b));
    },
  };
}

export function buildSemanticGraph(
  context: EnforcementContext,
  normalizedAsts: Record<string, NormalizedAST>,
  options: SemanticBuildOptions = {}
): SemanticBuildResult {
  const resolvedOptions: Required<SemanticBuildOptions> = {
    includeGraph: options.includeGraph ?? true,
  };
  const cacheKey = makeCacheKey(context, resolvedOptions);
  if (semanticCache && semanticCache.key === cacheKey) {
    return semanticCache.result;
  }

  const graph = createEmptySemanticGraph();
  const normalizedByPath = new Map(
    Object.entries(normalizedAsts).map(([filePath, normalized]) => [normalizePath(filePath), normalized] as const)
  );
  const workspace = new CompilerWorkspace({
    root: context.root,
    files: context.files,
  });
  const diagnostics: ts.Diagnostic[] = [];

  for (const project of workspace.projects) {
    if (resolvedOptions.includeGraph) {
      const checker = project.program.getTypeChecker();

      for (const filePath of Object.keys(normalizedAsts).sort((a, b) => a.localeCompare(b))) {
        const sourceFile = project.program.getSourceFile(filePath);
        if (!sourceFile) {
          continue;
        }

        const normalized = normalizeAST(sourceFile, filePath);

        for (const nodeId of normalized.traversalOrder) {
          const node = normalized.nodeById.get(nodeId);
          if (!node) {
            continue;
          }

          try {
            const type = checker.getTypeAtLocation(node);
            graph.types.set(nodeId, type);
          } catch {
            // Ignore type resolution errors for individual nodes.
          }

          const symbolNode = getSymbolLookupNode(node);
          const symbol = checker.getSymbolAtLocation(symbolNode);
          if (!symbol) {
            continue;
          }

          const symbolName = checker.getFullyQualifiedName(symbol);
          const declarationPos = symbol.declarations?.[0]?.pos ?? -1;
          const symbolKey = `${symbolName}@${declarationPos}`;
          graph.symbols.set(symbolKey, symbol);
          graph.symbols.set(stableSymbolKey(context, project.id, symbol, checker), symbol);

          const declarations = symbol.declarations ?? [];
          for (const declaration of declarations) {
            const declarationNodeId = normalized.nodeIdByNode.get(declaration);
            if (!declarationNodeId) {
              continue;
            }

            addReferenceReference(graph.references, declarationNodeId, nodeId);
          }
        }
      }
    }

    diagnostics.push(
      ...ts.getPreEmitDiagnostics(project.program)
        .filter((diagnostic) => {
          const filePath = diagnostic.file?.fileName;
          return filePath ? normalizedByPath.has(normalizePath(filePath)) : false;
        })
    );
  }

  const result: SemanticBuildResult = {
    graph,
    diagnostics: diagnostics.sort((left, right) => {
      const leftFile = left.file?.fileName ?? "";
      const rightFile = right.file?.fileName ?? "";
      if (leftFile !== rightFile) {
        return leftFile.localeCompare(rightFile);
      }

      return (left.start ?? 0) - (right.start ?? 0) || left.code - right.code;
    }),
  };

  semanticCache = {
    key: cacheKey,
    result,
  };

  return result;
}
