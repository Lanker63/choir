import {
  formatOrchestrationVerificationReport,
  runOrchestrationVerification,
} from "./core/orchestrationVerification.js";

async function main(): Promise<void> {
  try {
    const report = await runOrchestrationVerification();
    process.stdout.write(`${formatOrchestrationVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Orchestration verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
