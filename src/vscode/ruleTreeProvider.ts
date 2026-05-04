import * as path from "path";
import fs from "fs";
import * as vscode from "vscode";
import { loadDSLRules } from "../dsl/loader.js";
import { DSLRule } from "../dsl/types.js";

class RuleTreeItem extends vscode.TreeItem {
  constructor(public readonly label: string, public readonly rule?: DSLRule) {
    super(label, vscode.TreeItemCollapsibleState.None);

    if (rule) {
      this.contextValue = "ruleItem";
      this.command = {
        command: "choir.openRuleEditorForRule",
        title: "Open Rule",
        arguments: [rule],
      };
    }
  }
}

export class RuleTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null> = new vscode.EventEmitter<vscode.TreeItem | undefined | null>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null> = this._onDidChangeTreeData.event;

  constructor(private context: vscode.ExtensionContext) {
    console.log("RuleTreeProvider: constructed");
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(null);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) return [];

    const folders = vscode.workspace.workspaceFolders ?? [];
    console.log("RuleTreeProvider: getChildren workspaceFolders=", folders.map(f => f.uri.fsPath));

    if (folders.length === 0) {
      return [new vscode.TreeItem("Open a folder/workspace to list rules")];
    }

    // Find a rules.yaml (or rules.yml) in any workspace folder
    let rulesPath: string | undefined;
    for (const folder of folders) {
      const p = path.join(folder.uri.fsPath, ".choir", "rules.yaml");
      if (fs.existsSync(p)) {
        rulesPath = p;
        break;
      }
    }
    if (!rulesPath) {
      for (const folder of folders) {
        const p = path.join(folder.uri.fsPath, ".choir", "rules.yml");
        if (fs.existsSync(p)) {
          rulesPath = p;
          break;
        }
      }
    }

    if (!rulesPath) {
      return [new vscode.TreeItem("No .choir/rules.yaml found in workspace folders")];
    }

    try {
      const raw = loadDSLRules(rulesPath) as unknown;
      const rules = Array.isArray(raw) ? (raw as DSLRule[]) : [];
      console.log("RuleTreeProvider: loaded rules count=", rules.length, "from", rulesPath);

      if (rules.length === 0) {
        return [new vscode.TreeItem("No rules found in .choir/rules.yaml")];
      }

      return rules.map(r => new RuleTreeItem(r.id ?? "<no-id>", r));
    } catch (err) {
      console.error("RuleTreeProvider: failed to load rules", err);
      return [new vscode.TreeItem("Failed to load rules (check console)")];
    }
  }
}
