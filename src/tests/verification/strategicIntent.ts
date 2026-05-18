import {
  formatStrategicIntentVerificationReport,
  runStrategicIntentVerification,
} from "./core/strategicIntentVerification.js";

async function main(): Promise<void> {
  try {
    const report = await runStrategicIntentVerification();
    process.stdout.write(`${formatStrategicIntentVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Strategic intent verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
