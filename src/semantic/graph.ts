import ts from "typescript";
import { EnforcementContext } from "../core/context.js";
import { deterministicHash, stableSortBy } from "../core/deterministicCore.js";
import { NodeId, NormalizedAST, normalizeAST } from "../ast/model.js";

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

type SemanticCacheEntry = {
  key: string;
  result: SemanticBuildResult;
};

let semanticCache: SemanticCacheEntry | null = null;

function makeCacheKey(context: EnforcementContext): string {
  const fingerprints = stableSortBy(context.files, (file) => file.path)
    .map((file) => ({
      path: file.path,
      contentHash: deterministicHash(file.content),
    }));

  return deterministicHash(fingerprints);
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
  normalizedAsts: Record<string, NormalizedAST>
): SemanticBuildResult {
  const cacheKey = makeCacheKey(context);
  if (semanticCache && semanticCache.key === cacheKey) {
    return semanticCache.result;
  }

  const graph = createEmptySemanticGraph();

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    allowJs: false,
    noEmit: true,
  };

  const rootNames = context.files.map((file) => file.path);
  const program = ts.createProgram(rootNames, compilerOptions);
  const checker = program.getTypeChecker();

  for (const filePath of Object.keys(normalizedAsts).sort((a, b) => a.localeCompare(b))) {
    const sourceFile = program.getSourceFile(filePath);
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

  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => {
      const filePath = diagnostic.file?.fileName;
      return filePath ? !!normalizedAsts[filePath] : false;
    });

  const result: SemanticBuildResult = {
    graph,
    diagnostics,
  };

  semanticCache = {
    key: cacheKey,
    result,
  };

  return result;
}
