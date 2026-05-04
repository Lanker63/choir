import ts from "typescript";
import { EnforcementContext } from "../core/context.js";

export function parseAST(context: EnforcementContext) {
  for (const file of context.files) {
    const ast = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true
    );

    context.astMap.set(file.path, ast);
  }
}