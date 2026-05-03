import * as vscode from "vscode";
import { Strategy } from "./schema";
import * as glob from "glob";
import * as fs from "fs";
import * as ts from "typescript";

export interface EnforcerResult {
    ok: boolean;
    violations: string[];
}

const BANNED_IDENTIFIERS = new Set([
    "eval",
    "Function",
    "execScript"
]);

const BANNED_CALLS = new Set([
    "child_process.exec",
    "child_process.spawn",
    "fs.writeFileSync",
    "fs.unlinkSync"
]);

export function enforceCode(code: string): EnforcerResult {
    const sourceFile = ts.createSourceFile(
        "input.ts",
        code,
        ts.ScriptTarget.Latest,
        true
    );

    const violations: string[] = [];

    function checkNode(node: ts.Node) {
        // 1. Detect direct identifier usage (eval, Function, etc.)
        if (ts.isIdentifier(node)) {
            if (BANNED_IDENTIFIERS.has(node.text)) {
                violations.push(`Blocked identifier usage: ${node.text}`);
            }
        }

        // 2. Detect function calls
        if (ts.isCallExpression(node)) {
            const expr = node.expression;

            // Simple function calls: eval()
            if (ts.isIdentifier(expr)) {
                if (BANNED_IDENTIFIERS.has(expr.text)) {
                    violations.push(`Blocked function call: ${expr.text}()`);
                }
            }

            // Member calls: fs.writeFileSync, child_process.exec
            if (ts.isPropertyAccessExpression(expr)) {
                const fullName = getFullPropertyName(expr);
                if (BANNED_CALLS.has(fullName)) {
                    violations.push(`Blocked dangerous API call: ${fullName}()`);
                }
            }
        }

        // 3. Detect dynamic function construction (Function constructor)
        if (
            ts.isNewExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "Function"
        ) {
            violations.push("Blocked Function constructor usage");
        }

        ts.forEachChild(node, checkNode);
    }

    checkNode(sourceFile);

    return {
        ok: violations.length === 0,
        violations
    };
}

// Helper: reconstruct dotted member expression
function getFullPropertyName(expr: ts.PropertyAccessExpression): string {
    const parts: string[] = [];

    let current: ts.Expression = expr;

    while (ts.isPropertyAccessExpression(current)) {
        parts.unshift(current.name.text);
        current = current.expression;
    }

    if (ts.isIdentifier(current)) {
        parts.unshift(current.text);
    }

    return parts.join(".");
}

export async function enforceStrategy(strategy: Strategy) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return [];

    const results: string[] = [];

    const files = glob.sync("**/*.ts", { cwd: root, ignore: ["node_modules/**"] });

    for (const file of files) {
        const fullPath = root + "/" + file;
        const content = fs.readFileSync(fullPath, "utf-8");

        // Example rule: enforce service layer usage
        if (strategy.constraints.includes("no direct db access")) {
            if (content.includes("SELECT") || content.includes("db.query")) {
                results.push(`❌ ${file}: Direct DB access detected`);
            }
        }

        // Example rule: enforce layers
        if (strategy.architecture.layers.length > 0) {
            if (file.includes("controller") && content.includes("repository")) {
                results.push(`⚠️ ${file}: Controller accessing repository directly`);
            }
        }
    }

    return results;
}