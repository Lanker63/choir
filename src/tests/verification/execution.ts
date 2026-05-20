import {
  formatExecutionVerificationReport,
  runExecutionVerification,
} from "./core/executionVerification.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

void runVerificationCliCommand({
  label: "Execution verification",
  run: () => runExecutionVerification(),
  format: formatExecutionVerificationReport,
});
