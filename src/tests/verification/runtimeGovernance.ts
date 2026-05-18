import {
  formatRuntimeGovernanceVerificationReport,
  runRuntimeGovernanceVerification,
} from "./core/runtimeGovernanceVerification.js";

async function main(): Promise<void> {
  try {
    const report = await runRuntimeGovernanceVerification();
    process.stdout.write(`${formatRuntimeGovernanceVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Runtime governance verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
