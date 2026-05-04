import * as vscode from "vscode";
import path from "path";
import { Diagnostic } from "../core/types.js";
import { Fix, Patch, isTextPatch } from "../fix/types.js";

const collection = vscode.languages.createDiagnosticCollection("choir");
const fixesByDiagnosticId = new Map<string, Fix[]>();

function toUri(file: string): vscode.Uri {
  if (path.isAbsolute(file)) {
    return vscode.Uri.file(file);
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return vscode.Uri.file(root ? path.join(root, file) : file);
}

function mapSeverity(severity: Diagnostic["severity"]): vscode.DiagnosticSeverity {
  if (severity === "warning") {
    return vscode.DiagnosticSeverity.Warning;
  }

  if (severity === "info") {
    return vscode.DiagnosticSeverity.Information;
  }

  if (severity === "hint") {
    return vscode.DiagnosticSeverity.Hint;
  }

  return vscode.DiagnosticSeverity.Error;
}

export function toVSCodeDiagnostic(diagnostic: Diagnostic): vscode.Diagnostic {
  const result = new vscode.Diagnostic(
    new vscode.Range(
      diagnostic.location.start.line,
      diagnostic.location.start.character,
      diagnostic.location.end.line,
      diagnostic.location.end.character
    ),
    diagnostic.message,
    mapSeverity(diagnostic.severity)
  );

  result.code = diagnostic.id;
  result.source = diagnostic.ruleId;

  if (diagnostic.related && diagnostic.related.length > 0) {
    result.relatedInformation = diagnostic.related.map((related) =>
      new vscode.DiagnosticRelatedInformation(
        new vscode.Location(
          toUri(related.location.file),
          new vscode.Range(
            related.location.start.line,
            related.location.start.character,
            related.location.end.line,
            related.location.end.character
          )
        ),
        related.message
      )
    );
  }

  return result;
}

function convertPatchToWorkspaceEdit(edit: vscode.WorkspaceEdit, patch: Patch): void {
  if (isTextPatch(patch)) {
    const uri = toUri(patch.location.file);
    const range = new vscode.Range(
      patch.location.start.line,
      patch.location.start.character,
      patch.location.end.line,
      patch.location.end.character
    );

    if (patch.type === "replace") {
      edit.replace(uri, range, patch.text);
      return;
    }

    if (patch.type === "delete") {
      edit.delete(uri, range);
      return;
    }

    const insertPosition = patch.position === "before" ? range.start : range.end;
    edit.insert(uri, insertPosition, patch.text);
    return;
  }

  if (patch.type === "create-file") {
    const uri = toUri(patch.file);
    edit.createFile(uri, { ignoreIfExists: true });
    edit.insert(uri, new vscode.Position(0, 0), patch.content);
    return;
  }

  if (patch.type === "delete-file") {
    edit.deleteFile(toUri(patch.file), { ignoreIfNotExists: true });
    return;
  }

  edit.renameFile(toUri(patch.from), toUri(patch.to), { ignoreIfExists: false, overwrite: false });
}

function convertPatchesToWorkspaceEdit(patches: Patch[]): vscode.WorkspaceEdit {
  const edit = new vscode.WorkspaceEdit();

  for (const patch of patches) {
    convertPatchToWorkspaceEdit(edit, patch);
  }

  return edit;
}

export function toCodeAction(fix: Fix): vscode.CodeAction {
  const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
  action.edit = convertPatchesToWorkspaceEdit(fix.patches);
  action.isPreferred = fix.isPreferred;
  return action;
}

export function publishFixes(fixes: Fix[]) {
  fixesByDiagnosticId.clear();

  for (const fix of fixes) {
    for (const diagnosticId of fix.diagnosticIds) {
      const bucket = fixesByDiagnosticId.get(diagnosticId) ?? [];
      bucket.push(fix);
      fixesByDiagnosticId.set(diagnosticId, bucket);
    }
  }
}

export function registerFixCodeActions(context: vscode.ExtensionContext) {
  const provider = vscode.languages.registerCodeActionsProvider({ scheme: "file" }, {
    provideCodeActions(_document, _range, context) {
      const diagnosticIds = new Set<string>();

      for (const diagnostic of context.diagnostics) {
        if (typeof diagnostic.code === "string") {
          diagnosticIds.add(diagnostic.code);
        }
      }

      const fixes = [...diagnosticIds]
        .flatMap((diagnosticId) => fixesByDiagnosticId.get(diagnosticId) ?? [])
        .sort((left, right) => left.id.localeCompare(right.id));

      return fixes.map((fix) => toCodeAction(fix));
    },
  }, {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  });

  context.subscriptions.push(provider, collection);
}

export function publishDiagnostics(diagnostics: Diagnostic[]) {
  const map = new Map<string, vscode.Diagnostic[]>();

  collection.clear();

  for (const diagnostic of diagnostics) {
    const uri = toUri(diagnostic.location.file);
    const vscodeDiagnostic = toVSCodeDiagnostic(diagnostic);

    if (!map.has(uri.fsPath)) {
      map.set(uri.fsPath, []);
    }

    map.get(uri.fsPath)!.push(vscodeDiagnostic);
  }

  map.forEach((diags, file) => {
    collection.set(vscode.Uri.file(file), diags);
  });
}