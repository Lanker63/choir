import {
  formatOrchestrationVerificationReport,
  runOrchestrationVerification,
} from "./core/orchestrationVerification.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

void runVerificationCliCommand({
  label: "Orchestration verification",
  run: () => runOrchestrationVerification(),
  format: formatOrchestrationVerificationReport,
});
