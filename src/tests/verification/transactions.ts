import {
  formatTransactionVerificationReport,
  runTransactionVerification,
} from "./core/transactionVerification.js";

async function main(): Promise<void> {
  try {
    const report = await runTransactionVerification();
    process.stdout.write(`${formatTransactionVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Transaction verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
