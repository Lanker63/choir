import {
  ChaosMode,
  ciIterationLimit,
  formatChaosTestReport,
  runChaosTest,
  runPropertyTest,
  setSeed,
} from "./core/propertyChaosHarness.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

function readSeed(): number {
  const envSeed = process.env.CHOIR_VERIFY_SEED;
  if (!envSeed) {
    return 1337;
  }

  const parsed = Number.parseInt(envSeed, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 1337;
}

function readMode(args: string[]): "property" | "chaos" {
  const arg = args[0] ?? "property";
  return arg === "chaos" ? "chaos" : "property";
}

function readChaosMode(args: string[]): ChaosMode {
  const value = (args[1] ?? process.env.CHOIR_CHAOS_MODE ?? "moderate").toLowerCase();
  if (value === "none" || value === "light" || value === "moderate" || value === "extreme") {
    return value;
  }

  return "moderate";
}

function readIterations(mode: "property" | "chaos"): number {
  if (mode === "property") {
    const raw = process.env.CHOIR_PROPERTY_ITERATIONS;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    const base = Number.isFinite(parsed) ? Math.max(1, parsed) : 40;
    return ciIterationLimit(base, 16);
  }

  const raw = process.env.CHOIR_CHAOS_ITERATIONS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const base = Number.isFinite(parsed) ? Math.max(1, parsed) : 24;
  return ciIterationLimit(base, 10);
}

void runVerificationCliCommand({
  label: "Property/chaos harness",
  run: async () => {
    const args = process.argv.slice(2);
    const mode = readMode(args);
    const chaosMode = readChaosMode(args);
    const iterations = readIterations(mode);
    const seed = readSeed();

    setSeed(seed);

    return mode === "property"
      ? runPropertyTest(iterations, {
        seed,
        chaosMode: "none",
        throwOnFailure: false,
      })
      : runChaosTest(chaosMode, iterations, {
        seed,
        throwOnFailure: false,
      });
  },
  format: formatChaosTestReport,
  exitCodeFromReport: (report) => (report.failures === 0 ? 0 : 1),
});
