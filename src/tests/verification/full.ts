import {
  formatFullSystemVerificationReport,
  runFullSystemVerification,
  type FullSystemVerificationMode,
} from "./core/fullSystemVerification.js";

function readMode(): FullSystemVerificationMode {
  return process.env.CHOIR_FULL_SYSTEM_MODE === "quick" ? "quick" : "full";
}

async function main(): Promise<void> {
  try {
    const report = await runFullSystemVerification({
      mode: readMode(),
      workspaceRoot: process.cwd(),
      throwOnFailure: false,
    });

    process.stdout.write(`${formatFullSystemVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Full-system verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
