import { formatContractVerificationReport, runContractVerification } from "./core/contractVerification.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

function readMode(): "quick" | "full" {
  return process.env.CHOIR_CONTRACT_MODE === "full" ? "full" : "quick";
}

void runVerificationCliCommand({
  label: "Contract verification",
  run: () => runContractVerification({
      workspaceRoot: process.cwd(),
      mode: readMode(),
      throwOnFailure: false,
    }),
  format: formatContractVerificationReport,
});
