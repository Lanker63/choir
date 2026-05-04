import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { buildContext } from "./context.js";
import { runAST } from "../ast/engine.js";
import { RuleRegistry } from "../rules/registry.js";
import { loadDSLRules } from "../dsl/loader.js";
import { compileAndRegister } from "../dsl/compiler.js";

function resolveRulesPath(): string | null {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) return null;

  const root = workspace.uri.fsPath;

  const candidates = [
    path.join(root, ".choir", "rules.yaml"),
    path.join(root, "rules.yaml"),
  ];

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      return file;
    }
  }

  return null;
}

export async function runEnforcer(root: string) {
  const context = buildContext(root);

  const registry = new RuleRegistry();

  const rulesPath = resolveRulesPath();

  if (!rulesPath) {
    console.warn("No rules.yaml found in workspace");
    return;
  }

  // 🔥 Load DSL
  const dslRules = loadDSLRules(rulesPath);

  // 🔥 Compile → AST rules
  compileAndRegister(dslRules, registry);

  const ast = runAST(context, registry);
}