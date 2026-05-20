import {
  formatProductionVerificationReport,
  runProductionVerification,
} from "./core/productionVerification.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

void runVerificationCliCommand({
  label: "Production verification",
  run: () => runProductionVerification(),
  format: formatProductionVerificationReport,
});
