import { formatLibraryVerificationReport, runLibraryVerification } from "./core/libraryVerification.js";

async function main(): Promise<void> {
  try {
    const report = await runLibraryVerification();
    process.stdout.write(`${formatLibraryVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Library verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
