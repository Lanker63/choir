import fs from "fs";
import os from "os";
import path from "path";
import {
  CompiledPolicy,
  GlobalPlan,
  Repo,
  executeGlobalPlan,
  simulatePlan,
} from "./globalOrchestration.js";
import { evaluatePolicies, type PolicySet, type YAMLDiff } from "./policyEngine.js";
import { approvePendingDiff, listPendingApprovals } from "./state.js";

export type PolicyVerificationCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type PolicyVerificationReport = {
  passed: boolean;
  checks: PolicyVerificationCheck[];
  failures: string[];
};

function fixtureRepos(): Repo[] {
  return [
    {
      id: "repo-a",
      dependencies: [],
      state: { meta: { value: "0" } },
    },
    {
      id: "repo-b",
      dependencies: ["repo-a"],
      state: { meta: { value: "0" } },
    },
  ];
}

function fixturePlan(id: string, actionA = "set:meta.value=1", actionB = "set:meta.value=2"): GlobalPlan {
  return {
    id,
    tasks: [
      {
        id: "repo-a:t1",
        repoId: "repo-a",
        action: actionA,
        dependsOn: [],
      },
      {
        id: "repo-b:t1",
        repoId: "repo-b",
        action: actionB,
        dependsOn: ["repo-a:t1"],
      },
    ],
  };
}

function requireApprovalPolicies(): CompiledPolicy[] {
  return [
    {
      id: "org-require-approval",
      source: "org",
      rules: [
        {
          id: "require-set-action-approval",
          kind: "deny-action-prefix",
          effect: "require-approval",
          actionPrefix: "set:",
          priority: 50,
        },
      ],
    },
  ];
}

function denyBeatsRequirePolicies(): CompiledPolicy[] {
  return [
    {
      id: "repo-require",
      source: "repo",
      rules: [
        {
          id: "require-danger-approval",
          kind: "deny-action-prefix",
          effect: "require-approval",
          actionPrefix: "danger:",
          priority: 100,
        },
      ],
    },
    {
      id: "org-deny",
      source: "org",
      rules: [
        {
          id: "deny-danger-actions",
          kind: "deny-action-prefix",
          effect: "deny",
          actionPrefix: "danger:",
          priority: 10,
        },
      ],
    },
  ];
}

export async function runPolicyVerification(): Promise<PolicyVerificationReport> {
  const checks: PolicyVerificationCheck[] = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "choir-policy-verify-"));

  try {
    const denyPlan = fixturePlan("policy-deny-precedence", "danger:mutate", "set:meta.value=2");
    const denySim = await simulatePlan(denyPlan, {
      repos: fixtureRepos(),
      policies: denyBeatsRequirePolicies(),
    });
    const denyDecision = denySim.policyDecisions[0];
    const denyPrecedencePassed = !denySim.success
      && !!denyDecision
      && denyDecision.allowed === false
      && denyDecision.requiresApproval === false
      && denyDecision.policyDecisions.some((entry) => entry.startsWith("deny:"));

    checks.push({
      name: "deny-precedence-over-require-approval",
      passed: denyPrecedencePassed,
      detail: denyPrecedencePassed
        ? "deny policy won deterministically when both deny and require-approval matched"
        : "deny precedence failed or policy simulation unexpectedly succeeded",
    });

    const policiesA = denyBeatsRequirePolicies();
    const policiesB = [...denyBeatsRequirePolicies()].reverse();
    const deterministicPlan = fixturePlan("policy-deterministic-order", "danger:mutate", "danger:mutate");
    const deterministicA = await simulatePlan(deterministicPlan, {
      repos: fixtureRepos(),
      policies: policiesA,
    });
    const deterministicB = await simulatePlan(deterministicPlan, {
      repos: fixtureRepos(),
      policies: policiesB,
    });

    const policyA = deterministicA.policyDecisions[0];
    const policyB = deterministicB.policyDecisions[0];
    const orderingPassed = JSON.stringify(policyA) === JSON.stringify(policyB);

    checks.push({
      name: "policy-evaluation-order-deterministic",
      passed: orderingPassed,
      detail: orderingPassed
        ? "policy result remained stable regardless of input ordering"
        : "policy result changed when policy input order changed",
    });

    let executionCalls = 0;
    const approvalPlan = fixturePlan("policy-approval-binding", "set:meta.value=1", "set:meta.value=2");
    const first = await executeGlobalPlan(approvalPlan, {
      repos: fixtureRepos(),
      policies: requireApprovalPolicies(),
      stateRoot: root,
      executeTask: async (task, state, _repoId, _allStates, mode) => {
        if (mode === "execution") {
          executionCalls += 1;
        }

        if (task.action.startsWith("set:")) {
          const payload = task.action.slice("set:".length);
          const [, valueRaw] = payload.split("=");
          return { ...state, meta: { value: valueRaw?.trim() ?? "1" } };
        }

        return state;
      },
    });

    const pendingAfterFirst = listPendingApprovals(root).filter((entry) => entry.id.startsWith("preview-"));
    const firstPending = pendingAfterFirst[0];
    if (firstPending) {
      approvePendingDiff(root, firstPending.id, "policy-verifier", new Date().toISOString());
    }

    const second = await executeGlobalPlan(approvalPlan, {
      repos: fixtureRepos(),
      policies: requireApprovalPolicies(),
      stateRoot: root,
      executeTask: async (task, state, _repoId, _allStates, mode) => {
        if (mode === "execution") {
          executionCalls += 1;
        }

        if (task.action.startsWith("set:")) {
          const payload = task.action.slice("set:".length);
          const [, valueRaw] = payload.split("=");
          return { ...state, meta: { value: valueRaw?.trim() ?? "1" } };
        }

        return state;
      },
    });

    const changedPlan = fixturePlan("policy-approval-binding", "set:meta.value=3", "set:meta.value=4");
    const third = await executeGlobalPlan(changedPlan, {
      repos: fixtureRepos(),
      policies: requireApprovalPolicies(),
      stateRoot: root,
      executeTask: async (task, state, _repoId, _allStates, mode) => {
        if (mode === "execution") {
          executionCalls += 1;
        }

        if (task.action.startsWith("set:")) {
          const payload = task.action.slice("set:".length);
          const [, valueRaw] = payload.split("=");
          return { ...state, meta: { value: valueRaw?.trim() ?? "1" } };
        }

        return state;
      },
    });

    const pendingAfterThird = listPendingApprovals(root).filter((entry) => entry.id.startsWith("preview-"));
    const pendingRotated = firstPending
      ? pendingAfterThird.some((entry) => entry.id !== firstPending.id)
      : false;

    const approvalBindingPassed = !first.success
      && executionCalls > 0
      && second.success
      && !third.success
      && pendingAfterFirst.length > 0
      && pendingRotated;

    checks.push({
      name: "preview-hash-approval-binding",
      passed: approvalBindingPassed,
      detail: approvalBindingPassed
        ? "approval unblocked matching preview hash only; changed preview required fresh approval"
        : [
          "preview-hash approval binding failed",
          `first.success=${first.success}`,
          `second.success=${second.success}`,
          `third.success=${third.success}`,
          `executionCalls=${executionCalls}`,
          `pendingAfterFirst=${pendingAfterFirst.map((entry) => entry.id).join(",") || "none"}`,
          `pendingAfterThird=${pendingAfterThird.map((entry) => entry.id).join(",") || "none"}`,
          `pendingRotated=${pendingRotated}`,
        ].join("; "),
    });

    const gatePassed = executionCalls > 0
      && pendingAfterFirst.length > 0
      && first.success === false;
    checks.push({
      name: "gate-blocks-before-execution-without-approval",
      passed: gatePassed,
      detail: gatePassed
        ? "execution was blocked until approval was granted"
        : "execution gate did not block missing approval",
    });

    const highRiskDiffs: YAMLDiff[] = [
      {
        path: "execution.plans[0]",
        operation: "add",
        after: {
          id: "high-risk-api-plan",
          title: "High-risk API sample refactor",
          tasks: [
            {
              id: "high-risk-api-task",
              description: "high-risk code execution path",
              successCriteria: ["high-risk change reviewed before execution"],
            },
          ],
        },
      },
    ];
    const highRiskPolicies: PolicySet = {
      rules: [
        {
          id: "repo-approval-high-risk:1",
          policyId: "repo-approval-high-risk",
          source: "repo",
          match: {
            path: "execution.plans",
            operation: "add",
          },
          condition: {
            contains: "high-risk",
          },
          effect: {
            type: "require-approval",
          },
        },
      ],
    };
    const highRiskEvaluation = evaluatePolicies(highRiskDiffs, highRiskPolicies, {
      role: "conductor",
      environment: "local",
    });
    const highRiskContainsPassed = highRiskEvaluation.trace.decision === "require-approval"
      && highRiskEvaluation.result.requiresApproval
      && highRiskEvaluation.trace.rulesMatched.includes("repo-approval-high-risk:1");

    checks.push({
      name: "policy-contains-matches-nested-plan-object",
      passed: highRiskContainsPassed,
      detail: highRiskContainsPassed
        ? "contains condition matched high-risk text inside added plan object"
        : `nested contains did not match (decision=${highRiskEvaluation.trace.decision})`,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const failures = checks
    .filter((entry) => !entry.passed)
    .map((entry) => `${entry.name}: ${entry.detail}`);

  return {
    passed: failures.length === 0,
    checks,
    failures,
  };
}

export function formatPolicyVerificationReport(report: PolicyVerificationReport): string {
  const lines = [
    `${report.passed ? "PASS" : "FAIL"} policy verification`,
    ...report.checks.map((entry) => `- ${entry.name}: ${entry.passed ? "PASS" : "FAIL"} (${entry.detail})`),
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:", ...report.failures.map((entry) => `- ${entry}`));
  }

  return lines.join("\n");
}
