import {
  formatInitVerificationReport,
  runInitVerification,
} from "./core/initVerification.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

void runVerificationCliCommand({
  label: "Init verification",
  run: () => runInitVerification(),
  format: formatInitVerificationReport,
});
