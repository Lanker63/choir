import { formatPolicyVerificationReport, runPolicyVerification } from "./core/policyVerification.js";

async function main(): Promise<void> {
  try {
    const report = await runPolicyVerification();
    process.stdout.write(`${formatPolicyVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Policy verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
