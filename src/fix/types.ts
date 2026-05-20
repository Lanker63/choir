import ts from "typescript";
import { ValidationResult } from "../ast/model.js";
import { SourceLocation } from "../core/types.js";
import { SemanticMutation } from "../core/semanticMutation.js";

type ASTNode = ts.Node;

export type Patch =
  | ReplacePatch
  | InsertPatch
  | DeletePatch
  | FilePatch;

export type ReplacePatch = {
  type: "replace";
  location: SourceLocation;
  text: string;
  expectedText?: string;
};

export type InsertPatch = {
  type: "insert";
  location: SourceLocation;
  text: string;
  position: "before" | "after";
};

export type DeletePatch = {
  type: "delete";
  location: SourceLocation;
  expectedText?: string;
};

export type FilePatch =
  | CreateFilePatch
  | DeleteFilePatch
  | RenameFilePatch;

export type CreateFilePatch = {
  type: "create-file";
  file: string;
  content: string;
};

export type DeleteFilePatch = {
  type: "delete-file";
  file: string;
};

export type RenameFilePatch = {
  type: "rename-file";
  from: string;
  to: string;
};

export type Fix = {
  id: string;
  ruleId: string;
  title: string;
  description?: string;
  diagnosticIds: string[];
  patches: Patch[];
  isPreferred?: boolean;
  isSafe?: boolean;
  requiresConfirmation?: boolean;
  dependsOn?: string[];
  conflictsWith?: string[];
  traceId: string;
  semanticMutations?: SemanticMutation[];
};

export type PatchResult = {
  patchId: string;
  success: boolean;
  error?: string;
};

export type FixConflict = {
  fixA: string;
  fixB: string;
  reason: "overlapping-range" | "semantic-conflict" | "rule-priority" | "file-conflict";
};

export interface PatchValidationIssue {
  patchId: string;
  message: string;
}

export interface PatchValidationResult {
  ok: boolean;
  issues: PatchValidationIssue[];
}

export interface PatchApplyResult {
  ast: ts.SourceFile;
  code: string;
  validation: ValidationResult;
  patchValidation: PatchValidationResult;
  roundTripSafe: boolean;
  results?: PatchResult[];
}

export interface StructureDiff {
  removedNodeIds: string[];
  addedNodeIds: string[];
}

export function isTextPatch(patch: Patch): patch is ReplacePatch | InsertPatch | DeletePatch {
  return patch.type === "replace" || patch.type === "insert" || patch.type === "delete";
}
