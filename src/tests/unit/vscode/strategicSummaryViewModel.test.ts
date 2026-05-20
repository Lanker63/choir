import { describe, expect, it } from "vitest";
import { deriveStrategicSummary } from "../../../vscode/strategicSummaryViewModel.js";

describe("strategicSummaryViewModel", () => {
  it("reads strategic fields from nested strategicIntent blocks", () => {
    const summary = deriveStrategicSummary({
      strategicIntent: {
        mission: "Ship safe changes",
        priorities: ["correctness"],
        optimizationGoals: ["deterministic-replay"],
        governanceIntensity: "strict",
        rolloutPreferences: ["canary-required"],
      },
      domains: {
        payments: {
          mission: "Protect payment core",
          strategicIntent: {
            governanceIntensity: "strict",
            priorities: ["rollback-safety"],
            rolloutPreferences: ["phased-required"],
          },
        },
      },
      packages: {
        "apps/api": {
          domain: "payments",
          strategicIntent: {
            governanceIntensity: "moderate",
            rolloutPreferences: ["phased-optional"],
          },
        },
      },
    });

    expect(summary).toEqual({
      global: {
        mission: "Ship safe changes",
        priorities: ["correctness"],
        optimizationGoals: ["deterministic-replay"],
        riskTolerance: "moderate",
        governanceIntensity: "strict",
        rolloutPreferences: ["canary-required"],
      },
      domains: [
        {
          id: "payments",
          mission: "Protect payment core",
          governanceIntensity: "strict",
          priorities: ["rollback-safety"],
          rolloutPreferences: ["phased-required"],
        },
      ],
      packages: [
        {
          id: "apps/api",
          domain: "payments",
          governanceIntensity: "moderate",
          rolloutPreferences: ["phased-optional"],
        },
      ],
    });
  });

  it("derives package domains from contexts when package domain is omitted", () => {
    const summary = deriveStrategicSummary({
      packages: {
        "apps/api": {
          strategicIntent: {
            governanceIntensity: "strict",
          },
        },
      },
      contexts: {
        payments: {
          domain: "payments",
          packages: ["apps/api"],
        },
      },
    });

    expect(summary?.packages).toEqual([
      {
        id: "apps/api",
        domain: "payments",
        governanceIntensity: "strict",
        rolloutPreferences: [],
      },
    ]);
  });
});
