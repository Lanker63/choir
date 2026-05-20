import { describe, expect, it } from "vitest";
import {
  resolveRollbackStageSelection,
  resolveRollbackUnitSelection,
} from "../../../core/rollbackSelectors.js";

describe("rollbackSelectors", () => {
  it("resolves exact and alias stage selectors deterministically", () => {
    const stages = [
      { id: "batch-L1-1", order: 1, units: ["packages:api"] },
      { id: "batch-L2-1", order: 2, units: ["packages:web"] },
    ];

    expect(resolveRollbackStageSelection("batch-L1-1", stages)).toMatchObject({
      stage: stages[0],
      matchedBy: "exact-id",
    });

    expect(resolveRollbackStageSelection("stage-2", stages)).toMatchObject({
      stage: stages[1],
      matchedBy: "order-alias",
    });
  });

  it("fails closed for ambiguous canonical stage matches", () => {
    const stages = [
      { id: "batch:l1:1", order: 1, units: ["packages:api"] },
      { id: "batch-l1-1", order: 2, units: ["packages:web"] },
    ];

    const resolved = resolveRollbackStageSelection("batch l1 1", stages);
    expect(resolved.stage).toBeUndefined();
    expect(resolved.error).toMatch(/ambiguous/i);
  });

  it("resolves work-unit selector with deterministic bindings", () => {
    const resolved = resolveRollbackUnitSelection("wu-abc123", ["packages:api", "packages:web"], {
      workUnitBindings: {
        "wu-abc123": ["packages:api"],
      },
    });

    expect(resolved).toMatchObject({
      unit: "packages:api",
      matchedBy: "work-unit-id",
    });
  });

  it("fails closed for ambiguous bound work-unit selectors", () => {
    const resolved = resolveRollbackUnitSelection("wu-shared", ["packages:api", "packages:web"], {
      workUnitBindings: {
        "wu-shared": ["packages:web", "packages:api"],
      },
    });

    expect(resolved.unit).toBeUndefined();
    expect(resolved.error).toMatch(/ambiguous/i);
  });
});
