import { ASTRule } from "../dsl/types";

export class RuleRegistry {
  private astRules: ASTRule[] = [];

  registerAST(rule: ASTRule) {
    this.astRules.push(rule);
  }

  getASTRules() {
    return this.astRules;
  }
}