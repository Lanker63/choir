import * as vscode from "vscode";
import { DSLRule } from "../dsl/types.js";
import { describeControlPlaneLoadError, readControlPlane, getControlPlanePath } from "../choirManager.js";
import { resolveControlPlanePath } from "./rulesPath.js";

function normalizeErrorMessage(message: string): string {
  return message.replace(/^Unable to parse\s+[^:]+:\s*/i, "").trim();
}

function wrapText(text: string, width: number): string[] {
  if (text.length <= width) {
    return [text];
  }

  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = "";

  const pushLongWord = (word: string) => {
    for (let index = 0; index < word.length; index += width) {
      lines.push(word.slice(index, index + width));
    }
  };

  for (const word of words) {
    if (word.length > width) {
      if (current.length > 0) {
        lines.push(current);
        current = "";
      }

      pushLongWord(word);
      continue;
    }

    const next = current.length === 0 ? word : `${current} ${word}`;
    if (next.length > width) {
      lines.push(current);
      current = word;
      continue;
    }

    current = next;
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [text];
}

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
      const resolvedPath = getControlPlanePath() ?? controlPath ?? ".choir/choir.config.yaml";
      const fullMessage = err instanceof Error
        ? err.message
        : describeControlPlaneLoadError(err, resolvedPath);
      const details = normalizeErrorMessage(fullMessage);
      const wrapped = wrapText(details, 72);

      const title = new vscode.TreeItem("Failed to load rules");
      title.tooltip = fullMessage;

      const fileHint = new vscode.TreeItem("File: .choir/choir.config.yaml");
      fileHint.tooltip = resolvedPath;

      const issueHeader = new vscode.TreeItem("Issue:");
      issueHeader.tooltip = fullMessage;

      const detailItems = wrapped.map((line) => {
        const item = new vscode.TreeItem(`  ${line}`);
        item.tooltip = fullMessage;
        return item;
      });

      const fixHint = new vscode.TreeItem("Action: open the file and fix the schema/YAML error.");
      fixHint.tooltip = fullMessage;

      return [title, fileHint, issueHeader, ...detailItems, fixHint];
    }
  }
}
