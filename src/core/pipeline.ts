import { buildContext } from "./context";
import { runAST } from "../ast/engine";
import { RuleRegistry } from "../rules/registry";
import { loadDSLRules } from "../dsl/loader";
import { compileAndRegister } from "../dsl/compiler";

export async function runEnforcer(root: string) {
  const context = buildContext(root);

  const registry = new RuleRegistry();

  // 🔥 Load DSL
  const dslRules = loadDSLRules("./rules.yaml");

  // 🔥 Compile → AST rules
  compileAndRegister(dslRules, registry);

  const ast = runAST(context, registry);
}