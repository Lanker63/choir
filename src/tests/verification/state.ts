import { formatStateVerificationReport, runStateVerification } from "../../core/stateVerification.js";

async function main(): Promise<void> {
  try {
    const report = await runStateVerification();
    process.stdout.write(`${formatStateVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`State verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
