import { formatVerificationReport, runFullVerification } from "../../core/verificationHarness.js";

async function main(): Promise<void> {
  const mode = process.env.CHOIR_VERIFY_MODE === "quick" ? "quick" : "full";

  try {
    const report = await runFullVerification({
      mode,
      throwOnFailure: false,
      detectFlakiness: true,
      parallelCaseExecution: false,
      flakeRuns: mode === "quick" ? 2 : 3,
    });

    process.stdout.write(`${formatVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Verification harness failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
