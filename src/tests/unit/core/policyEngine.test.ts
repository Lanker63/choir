import { describe, expect, it } from "vitest";
import {
  evaluatePolicies,
  hashDiff,
  toPolicySet,
  type PolicySet,
  type YAMLDiff,
} from "../../../core/policyEngine.js";

function makeDiff(path: string, operation: YAMLDiff["operation"], before: unknown, after: unknown): YAMLDiff {
  return {
    path,
    operation,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  };
}

describe("policyEngine", () => {
  it("enforces deny precedence over require-approval", () => {
    const policies: PolicySet = {
      rules: [
        {
          id: "rule-require",
          policyId: "repo-approval",
          source: "repo",
          match: {
            path: "intent.goals",
            operation: "add",
          },
          effect: {
            type: "require-approval",
            message: "requires approval",
          },
        },
        {
          id: "rule-deny",
          policyId: "org-deny",
          source: "org",
          match: {
            path: "intent.goals",
            operation: "add",
          },
          effect: {
            type: "deny",
            message: "denied",
          },
        },
      ],
    };

    const { result, trace } = evaluatePolicies(
      [makeDiff("intent.goals[0]", "add", undefined, "sensitive goal")],
      policies,
      {
        role: "architect",
        environment: "local",
      }
    );

    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(false);
    expect(result.violations).toEqual([{ ruleId: "rule-deny", message: "denied" }]);
    expect(trace.decision).toBe("deny");
    expect(trace.rulesMatched).toEqual(["rule-deny", "rule-require"]);
  });

  it("produces stable diff hash regardless of diff order", () => {
    const first = [
      makeDiff("intent.goals[1]", "add", undefined, "b"),
      makeDiff("intent.goals[0]", "add", undefined, "a"),
    ];

    const second = [...first].reverse();

    expect(hashDiff(first)).toBe(hashDiff(second));
  });

  it("normalizes policy set ordering deterministically", () => {
    const policySet = toPolicySet([
      {
        id: "rule-b",
        match: {
          path: "intent.constraints",
          operation: "add",
        },
        effect: {
          type: "allow",
        },
      },
      {
        id: "rule-a",
        match: {
          path: "intent.goals",
          operation: "add",
        },
        scope: {
          environments: ["staging", "local"],
          roles: ["conductor", "architect"],
        },
        effect: {
          type: "require-approval",
        },
      },
    ]);

    expect(policySet.rules.map((rule) => rule.id)).toEqual(["rule-a", "rule-b"]);
    expect(policySet.rules[0]?.scope?.environments).toEqual(["local", "staging"]);
    expect(policySet.rules[0]?.scope?.roles).toEqual(["architect", "conductor"]);
  });
});
