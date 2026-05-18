import {
  formatInitVerificationReport,
  runInitVerification,
} from "./core/initVerification.js";

async function main(): Promise<void> {
  try {
    const report = await runInitVerification();
    process.stdout.write(`${formatInitVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Init verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
