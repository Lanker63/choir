import {
  formatRuntimeVerificationReport,
  runRuntimeVerification,
} from "../../core/runtimeVerification.js";

async function main(): Promise<void> {
  try {
    const report = await runRuntimeVerification();
    process.stdout.write(`${formatRuntimeVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Runtime verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
