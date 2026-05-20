import {
  formatPlanningVerificationReport,
  runPlanningVerification,
} from "./core/planningVerification.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

void runVerificationCliCommand({
  label: "Planning verification",
  run: () => runPlanningVerification(),
  format: formatPlanningVerificationReport,
});
