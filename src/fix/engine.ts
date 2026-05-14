import ts from "typescript";
import {
  AST,
  NormalizedAST,
  normalizeAST,
  validateNormalizedAST,
} from "../ast/model.js";
import { deepFreeze } from "../utils/deepFreeze.js";
import { Diagnostic } from "../core/types.js";
import {
  DeletePatch,
  Fix,
  FilePatch,
  InsertPatch,
  Patch,
  PatchApplyResult,
  PatchResult,
  PatchValidationResult,
  ReplacePatch,
  StructureDiff,
  isTextPatch,
} from "./types.js";
import { locationToOffsetRange } from "../core/diagnostics.js";

function patchIdForIndex(index: number): string {
  return `patch-${index + 1}`;
}

function validateFilePatch(patch: FilePatch): string[] {
  const errors: string[] = [];

  if (patch.type === "create-file" && patch.content.length === 0) {
    errors.push("create-file patch content cannot be empty");
  }

  if (patch.type === "rename-file" && patch.from === patch.to) {
    errors.push("rename-file patch requires distinct from/to paths");
  }

  return errors;
}

function validateTextPatchForFile(
  sourceText: string,
  normalizedAst: NormalizedAST,
  patch: ReplacePatch | InsertPatch | DeletePatch
): string[] {
  const errors: string[] = [];

  if (patch.location.file !== normalizedAst.filePath) {
    errors.push(`Patch targets ${patch.location.file} but expected ${normalizedAst.filePath}`);
    return errors;
  }

  let offsets: { start: number; end: number };
  try {
    offsets = locationToOffsetRange(sourceText, patch.location);
  } catch (error) {
    errors.push((error as Error).message);
    return errors;
  }

  if (offsets.start > offsets.end) {
    errors.push("Patch location start must be <= end");
  }

  if (patch.type === "replace" && patch.expectedText !== undefined) {
    const actualText = sourceText.slice(offsets.start, offsets.end);
    if (actualText !== patch.expectedText) {
      errors.push("replace expectedText did not match source text");
    }
  }

  if (patch.type === "delete" && patch.expectedText !== undefined) {
    const actualText = sourceText.slice(offsets.start, offsets.end);
    if (actualText !== patch.expectedText) {
      errors.push("delete expectedText did not match source text");
    }
  }

  return errors;
}

export function validatePatches(normalizedAst: NormalizedAST, patches: Patch[]): PatchValidationResult {
  const sourceText = normalizedAst.sourceFile.getFullText();
  const issues = patches.flatMap((patch, index) => {
    const errors = isTextPatch(patch)
      ? validateTextPatchForFile(sourceText, normalizedAst, patch)
      : validateFilePatch(patch);

    return errors.map((message) => ({ patchId: patchIdForIndex(index), message }));
  });

  return {
    ok: issues.length === 0,
    issues,
  };
}

function applyPatches(ast: AST, normalizedAst: NormalizedAST, patches: Patch[]): AST {
  const result = applyPatchesWithRoundTrip(ast, normalizedAst, patches);
  if (!result.roundTripSafe) {
    const reason = result.patchValidation.issues.map((issue) => issue.message).join(" | ");
    throw new Error(`Invalid patch set: ${reason}`);
  }

  return result.ast;
}

type TextPatchOperation = {
  patchId: string;
  patch: ReplacePatch | InsertPatch | DeletePatch;
  start: number;
  end: number;
  order: number;
};

function buildTextOperations(sourceText: string, patches: Patch[], filePath: string): TextPatchOperation[] {
  const operations: TextPatchOperation[] = [];

  for (let index = 0; index < patches.length; index += 1) {
    const patch = patches[index];
    if (!isTextPatch(patch) || patch.location.file !== filePath) {
      continue;
    }

    const range = locationToOffsetRange(sourceText, patch.location);
    const start = patch.type === "insert" && patch.position === "after" ? range.end : range.start;
    const end = patch.type === "insert" ? start : range.end;

    operations.push({
      patchId: patchIdForIndex(index),
      patch,
      start,
      end,
      order: index,
    });
  }

  return operations;
}

function detectOverlaps(operations: TextPatchOperation[]): Set<string> {
  const overlappingPatchIds = new Set<string>();
  const sorted = [...operations].sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }

    if (left.end !== right.end) {
      return left.end - right.end;
    }

    return left.order - right.order;
  });

  let previousEnd = -1;
  for (const operation of sorted) {
    const isInsert = operation.start === operation.end;
    const overlaps = operation.start < previousEnd && !isInsert;

    if (overlaps) {
      overlappingPatchIds.add(operation.patchId);
    }

    previousEnd = Math.max(previousEnd, operation.end);
  }

  return overlappingPatchIds;
}

function applyTextPatchesToFile(
  sourceText: string,
  patches: Patch[],
  filePath: string
): { code: string; results: PatchResult[] } {
  const operations = buildTextOperations(sourceText, patches, filePath);
  const overlapping = detectOverlaps(operations);

  let next = sourceText;
  const results = new Map<string, PatchResult>();

  const sortedForApply = [...operations].sort((left, right) => {
    if (left.start !== right.start) {
      return right.start - left.start;
    }

    if (left.end !== right.end) {
      return right.end - left.end;
    }

    return right.order - left.order;
  });

  for (const operation of sortedForApply) {
    if (overlapping.has(operation.patchId)) {
      results.set(operation.patchId, {
        patchId: operation.patchId,
        success: false,
        error: "overlapping-range",
      });
      continue;
    }

    try {
      if (operation.patch.type === "replace") {
        const actual = next.slice(operation.start, operation.end);
        if (operation.patch.expectedText !== undefined && actual !== operation.patch.expectedText) {
          throw new Error("replace expectedText did not match source text during apply");
        }

        next = `${next.slice(0, operation.start)}${operation.patch.text}${next.slice(operation.end)}`;
      }

      if (operation.patch.type === "delete") {
        const actual = next.slice(operation.start, operation.end);
        if (operation.patch.expectedText !== undefined && actual !== operation.patch.expectedText) {
          throw new Error("delete expectedText did not match source text during apply");
        }

        next = `${next.slice(0, operation.start)}${next.slice(operation.end)}`;
      }

      if (operation.patch.type === "insert") {
        next = `${next.slice(0, operation.start)}${operation.patch.text}${next.slice(operation.start)}`;
      }

      results.set(operation.patchId, {
        patchId: operation.patchId,
        success: true,
      });
    } catch (error) {
      results.set(operation.patchId, {
        patchId: operation.patchId,
        success: false,
        error: (error as Error).message,
      });
    }
  }

  for (let index = 0; index < patches.length; index += 1) {
    const patch = patches[index];
    const patchId = patchIdForIndex(index);

    if (results.has(patchId)) {
      continue;
    }

    if (!isTextPatch(patch)) {
      results.set(patchId, {
        patchId,
        success: false,
        error: `${patch.type} is not supported for in-memory AST round-trip`,
      });
      continue;
    }

    if (patch.location.file !== filePath) {
      results.set(patchId, {
        patchId,
        success: false,
        error: `Patch targets ${patch.location.file} but expected ${filePath}`,
      });
    }
  }

  return {
    code: next,
    results: [...results.values()].sort((left, right) => left.patchId.localeCompare(right.patchId)),
  };
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
  const frozenPatches = deepFreeze([...patches]);
  const patchValidation = validatePatches(normalizedAst, frozenPatches);
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

  const fileApply = applyTextPatchesToFile(ast.getFullText(), frozenPatches, normalizedAst.filePath);
  const emittedCode = fileApply.code;

  const reparsed = ts.createSourceFile(
    ast.fileName,
    emittedCode,
    ts.ScriptTarget.Latest,
    true
  );

  const normalizedReparsed = normalizeAST(reparsed, ast.fileName);
  const validation = validateNormalizedAST(normalizedReparsed);
  const roundTripSafe = validation.ok && fileApply.results.every((result) => result.success);

  return {
    ast: reparsed,
    code: emittedCode,
    validation,
    patchValidation,
    roundTripSafe,
    results: fileApply.results,
  };
}

function generateFixes(_diagnostics: Diagnostic[]): Fix[] {
  return [];
}