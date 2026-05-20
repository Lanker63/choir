import { describe, expect, it } from "vitest";
import type { ControlPlane } from "../../../schema.js";
import {
  deriveDomainHeatmapRows,
  derivePackageMappingRows,
} from "../../../vscode/strategicInitViewModel.js";

describe("strategicInitViewModel", () => {
  it("falls back to strategic init replay models when control-plane domains are omitted", () => {
    const control: ControlPlane = {
      version: "1",
      mission: "",
      vision: "",
      intent: { goals: [], constraints: [], "nonGoals": [] },
      policy: { rules: [] },
      execution: { plans: [] },
      packages: {
        "apps/api": {
          strategicIntent: {
            governanceIntensity: "strict",
          },
        },
      },
      contexts: {
        workspaceRoot: {
          packages: ["apps/api"],
        },
      },
      runtime: {
        mode: "execution-enabled",
      },
      capabilities: {
        preview: true,
        simulate: true,
        execute: true,
        optimize: true,
        import: true,
        install: true,
        update: true,
      },
    };

    const strategicState = {
      discovery: {
        domains: [
          {
            id: "payments",
            packages: ["apps/api"],
          },
        ],
      },
      models: [
        {
          id: "payments",
          governanceIntensity: "strict",
          riskTolerance: "low",
          rolloutPreferences: ["canary-required"],
        },
      ],
    };

    expect(deriveDomainHeatmapRows(control, strategicState)).toEqual([
      {
        id: "payments",
        governanceIntensity: "strict",
        riskTolerance: "low",
        rolloutPreferences: ["canary-required"],
      },
    ]);
  });

  it("derives package domain mapping from strategic replay discovery when package domain is absent", () => {
    const control: ControlPlane = {
      version: "1",
      mission: "",
      vision: "",
      intent: { goals: [], constraints: [], "nonGoals": [] },
      policy: { rules: [] },
      execution: { plans: [] },
      packages: {
        "apps/api": {
          strategicIntent: {
            governanceIntensity: "strict",
          },
        },
      },
      contexts: {
        workspaceRoot: {
          packages: ["apps/api"],
        },
      },
      runtime: {
        mode: "execution-enabled",
      },
      capabilities: {
        preview: true,
        simulate: true,
        execute: true,
        optimize: true,
        import: true,
        install: true,
        update: true,
      },
    };

    const strategicState = {
      discovery: {
        domains: [
          {
            id: "payments",
            packages: ["apps/api"],
          },
        ],
      },
      models: [
        {
          id: "payments",
          governanceIntensity: "moderate",
          riskTolerance: "moderate",
          rolloutPreferences: ["phased-optional"],
        },
      ],
    };

    expect(derivePackageMappingRows(control, strategicState)).toEqual([
      {
        id: "apps/api",
        domain: "payments",
        governanceIntensity: "strict",
      },
    ]);
  });
});
