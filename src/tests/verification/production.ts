import {
  formatProductionVerificationReport,
  runProductionVerification,
} from "../../core/productionVerification.js";

async function main(): Promise<void> {
  try {
    const report = await runProductionVerification();
    process.stdout.write(`${formatProductionVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Production verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
