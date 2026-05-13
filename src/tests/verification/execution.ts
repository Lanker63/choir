import {
  formatExecutionVerificationReport,
  runExecutionVerification,
} from "./core/executionVerification.js";

async function main(): Promise<void> {
  try {
    const report = await runExecutionVerification();
    process.stdout.write(`${formatExecutionVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Execution verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
