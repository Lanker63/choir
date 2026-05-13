import { formatContractVerificationReport, runContractVerification } from "./core/contractVerification.js";

function readMode(): "quick" | "full" {
  return process.env.CHOIR_CONTRACT_MODE === "full" ? "full" : "quick";
}

async function main(): Promise<void> {
  try {
    const report = await runContractVerification({
      workspaceRoot: process.cwd(),
      mode: readMode(),
      throwOnFailure: false,
    });

    process.stdout.write(`${formatContractVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Contract verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
