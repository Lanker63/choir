import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildExecutionPlan,
  createInMemoryTransactionFS,
  runExecutionPlanTransactionally,
} from "../../../core/scheduler.js";
import { recordAudit } from "../../../core/audit.js";
import { createEmptyStatePlane } from "../../../core/state.js";
import { CONTROL_PLANE_VERSION, type ControlPlane, type Plan, type Task } from "../../../schema.js";

function makeControlPlane(): ControlPlane {
  return {
    version: CONTROL_PLANE_VERSION,
    mission: "",
    vision: "",
    intent: {
      goals: [],
      constraints: [],
      nonGoals: [],
    },
    policy: {
      rules: [],
    },
    execution: {
      plans: [],
    },
  };
}

function makeTask(id: string, type: Task["type"], files: string[] = []): Task {
  return {
    id,
    title: id,
    type,
    dependsOn: [],
    successCriteria: ["ok"],
    ...(files.length > 0 ? { scope: { files } } : {}),
  };
}

function makePlan(id: string, tasks: Task[]): Plan {
  return {
    id,
    title: id,
    derivedFrom: "goal",
    goalRefs: [id],
    tasks,
    status: "approved",
  };
}

describe("scheduler transactional execution", () => {
  it("does not depend on cwd audit chain when a custom fs is provided without explicit root", async () => {
    const originalCwd = process.cwd();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "choir-scheduler-audit-"));

    try {
      process.chdir(root);

      recordAudit(root, {
        auditEvent: {
          id: "",
          timestamp: "",
          actor: { role: "conductor" },
          environment: "local",
          action: "seed-a",
          resource: "workspace",
          result: "success",
        },
        decisionTrace: {
          policiesEvaluated: [],
          finalDecision: "allow",
          reasoning: "seed",
        },
      });

      recordAudit(root, {
        auditEvent: {
          id: "",
          timestamp: "",
          actor: { role: "conductor" },
          environment: "local",
          action: "seed-b",
          resource: "workspace",
          result: "success",
        },
        decisionTrace: {
          policiesEvaluated: [],
          finalDecision: "allow",
          reasoning: "seed",
        },
      });

      const auditPath = path.join(root, ".choir", "audit.log.jsonl");
      const lines = fs.readFileSync(auditPath, "utf-8").trimEnd().split("\n");
      fs.appendFileSync(auditPath, `${lines[lines.length - 1]}\n`, "utf-8");

      const plans: Plan[] = [
        makePlan("plan-a", [makeTask("task-refactor", "refactor", ["src/example.ts"])]),
      ];
      const { executionPlan } = buildExecutionPlan(plans, { smallTaskMergeThreshold: 0 });

      const txFs = createInMemoryTransactionFS({
        files: {
          "src/example.ts": "const value = 1;\n",
        },
        state: createEmptyStatePlane(),
      });

      const result = await runExecutionPlanTransactionally(executionPlan, {
        fs: txFs,
        controlPlane: makeControlPlane(),
        enforcer: {
          proposeFixes: async () => ({
            fixes: [
              {
                id: "fix-1",
                ruleId: "rule-a",
                title: "fix",
                diagnosticIds: ["diag-1"],
                patches: [
                  {
                    type: "create-file",
                    file: "src/example.ts",
                    content: "const value = 2;\n",
                  },
                ],
                traceId: "trace-1",
              },
            ],
            diagnostics: [
              {
                id: "diag-1",
                ruleId: "rule-a",
                message: "update literal",
                severity: "warning",
                category: "AST",
                location: {
                  file: "src/example.ts",
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 1 },
                },
                traceId: "trace-1",
              },
            ],
          }),
        },
        pipeline: {
          run: async () => ({
            diagnostics: [],
            conflicts: [],
          }),
        },
        typeCheck: async () => ({ passed: true }),
      });

      expect(result.transactions[0]?.status).toBe("committed");
      expect(txFs.snapshot().files["src/example.ts"]).toBe("const value = 2;\n");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});