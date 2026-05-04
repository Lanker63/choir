import ts from "typescript";

export interface DepthFirstVisitState {
  parent: ts.Node | null;
  childIndex: number;
  depth: number;
}

export type DepthFirstVisitor = (node: ts.Node, state: DepthFirstVisitState) => void;

export function visitDepthFirst(root: ts.Node, visitor: DepthFirstVisitor): void {
  function walk(node: ts.Node, parent: ts.Node | null, childIndex: number, depth: number): void {
    visitor(node, { parent, childIndex, depth });

    let index = 0;
    ts.forEachChild(node, (child) => {
      walk(child, node, index, depth + 1);
      index += 1;
    });
  }

  walk(root, null, 0, 0);
}
