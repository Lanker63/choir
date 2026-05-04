import * as vscode from "vscode";
import { DSLRule } from "../dsl/types.js";
import { readControlPlane, getControlPlanePath } from "../choirManager.js";
import { resolveControlPlanePath } from "./rulesPath.js";

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

  constructor() {
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

    const controlPath = resolveControlPlanePath();

    if (!controlPath) {
      return [new vscode.TreeItem("No .choir/choir.config.yaml found in workspace folders")];
    }

    try {
      const control = readControlPlane();
      const rules = control?.policy.rules ?? [];
      console.log("RuleTreeProvider: loaded rules count=", rules.length, "from", getControlPlanePath());

      if (rules.length === 0) {
        return [new vscode.TreeItem("No rules found in .choir/choir.config.yaml")];
      }

      return rules.map(r => new RuleTreeItem(r.id ?? "<no-id>", r));
    } catch (err) {
      console.error("RuleTreeProvider: failed to load rules", err);
      return [new vscode.TreeItem("Failed to load rules (check console)")];
    }
  }
}
