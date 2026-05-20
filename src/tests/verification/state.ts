import { formatStateVerificationReport, runStateVerification } from "./core/stateVerification.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

void runVerificationCliCommand({
  label: "State verification",
  run: () => runStateVerification(),
  format: formatStateVerificationReport,
});
