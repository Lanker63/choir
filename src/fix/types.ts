import ts from "typescript";
import { NodeId, ValidationResult } from "../ast/model.js";

export type ASTNode = ts.Node;

export type Patch = {
  targetNodeId: NodeId;
  operation: "replace" | "remove" | "insert";
  payload?: ASTNode;
};

export interface PatchValidationIssue {
  targetNodeId: NodeId;
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
}

export interface StructureDiff {
  removedNodeIds: NodeId[];
  addedNodeIds: NodeId[];
}
