import {
  formatDeterminismVerificationReport,
  runDeterminismVerification,
} from "../../core/determinismVerification.js";

async function main(): Promise<void> {
  try {
    const report = await runDeterminismVerification();
    process.stdout.write(`${formatDeterminismVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Determinism verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
