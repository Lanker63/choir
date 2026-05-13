import {
  formatCompilerVerificationReport,
  runCompilerVerification,
} from "./core/compilerVerification.js";

async function main(): Promise<void> {
  try {
    const report = await runCompilerVerification();
    process.stdout.write(`${formatCompilerVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Compiler verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
