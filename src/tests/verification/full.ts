import {
  formatPhase8HardeningReport,
  runPhase8Hardening,
  type Phase8Mode,
} from "../../core/phase8Hardening.js";

function readMode(): Phase8Mode {
  return process.env.CHOIR_HARDENING_MODE === "quick" ? "quick" : "full";
}

async function main(): Promise<void> {
  try {
    const report = await runPhase8Hardening({
      mode: readMode(),
      workspaceRoot: process.cwd(),
      throwOnFailure: false,
    });

    process.stdout.write(`${formatPhase8HardeningReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Phase8 hardening failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
