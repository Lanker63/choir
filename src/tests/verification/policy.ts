import { formatPolicyVerificationReport, runPolicyVerification } from "./core/policyVerification.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

void runVerificationCliCommand({
  label: "Policy verification",
  run: () => runPolicyVerification(),
  format: formatPolicyVerificationReport,
});
