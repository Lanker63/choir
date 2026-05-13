import {
  formatPreviewVerificationReport,
  runPreviewVerification,
} from "./core/previewVerification.js";

async function main(): Promise<void> {
  try {
    const report = await runPreviewVerification();
    process.stdout.write(`${formatPreviewVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Preview verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
