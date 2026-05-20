export type SymbolHint = {
  file: string;
  name: string;
};

export type SemanticMutation =
  | {
      kind: "RenameSymbol";
      symbolHint: SymbolHint;
      newName: string;
    }
  | {
      kind: "MoveSymbol";
      symbolHint: SymbolHint;
      targetFile: string;
      updateExports?: boolean;
    }
  | {
      kind: "InlineSymbol";
      symbolHint: SymbolHint;
    }
  | {
      kind: "AddImport";
      file: string;
      moduleSpecifier: string;
      namedImports: string[];
      isTypeOnly?: boolean;
    }
  | {
      kind: "MergeImport";
      file: string;
      moduleSpecifier: string;
      namedImports: string[];
      isTypeOnly?: boolean;
    }
  | {
      kind: "UpdateExports";
      file: string;
      namedExports: string[];
    }
  | {
      kind: "RenameFile";
      from: string;
      to: string;
      rewriteImports: boolean;
    }
  | {
      kind: "UpsertFile";
      file: string;
      content: string;
    };

export type SemanticMutationManifestFileDelta = {
  file: string;
  operation: "create" | "update" | "delete";
  beforeHash: string;
  afterHash: string;
};

export type SemanticMutationManifest = {
  id: string;
  replayHash: string;
  mutationHash: string;
  beforeWorkspaceHash: string;
  afterWorkspaceHash: string;
  mutationCount: number;
  compilerEvidence: {
    before: {
      total: number;
      semantic: number;
      syntactic: number;
    };
    after: {
      total: number;
      semantic: number;
      syntactic: number;
    };
  };
  graphDelta: {
    importsAdded: number;
    importsRemoved: number;
    exportsAdded: number;
    exportsRemoved: number;
  };
  fileDeltas: SemanticMutationManifestFileDelta[];
};
