import {
  formatRuntimeGovernanceVerificationReport,
  runRuntimeGovernanceVerification,
} from "./core/runtimeGovernanceVerification.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

void runVerificationCliCommand({
  label: "Runtime governance verification",
  run: () => runRuntimeGovernanceVerification(),
  format: formatRuntimeGovernanceVerificationReport,
});
