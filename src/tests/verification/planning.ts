import {
  formatPlanningVerificationReport,
  runPlanningVerification,
} from "./core/planningVerification.js";

async function main(): Promise<void> {
  try {
    const report = await runPlanningVerification();
    process.stdout.write(`${formatPlanningVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Planning verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
