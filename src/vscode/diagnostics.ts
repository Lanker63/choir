import * as vscode from "vscode";
import { Violation } from "../core/types.js";

const collection = vscode.languages.createDiagnosticCollection("choir");

export function publishDiagnostics(violations: Violation[]) {
  const map = new Map<string, vscode.Diagnostic[]>();

  for (const v of violations) {
    const uri = vscode.Uri.file(v.file);

    const range = new vscode.Range(
      new vscode.Position(0, 0),
      new vscode.Position(0, 1)
    );

    const diagnostic = new vscode.Diagnostic(
      range,
      v.message,
      vscode.DiagnosticSeverity.Error
    );

    if (!map.has(uri.fsPath)) {
      map.set(uri.fsPath, []);
    }

    map.get(uri.fsPath)!.push(diagnostic);
  }

  map.forEach((diags, file) => {
    collection.set(vscode.Uri.file(file), diags);
  });
}