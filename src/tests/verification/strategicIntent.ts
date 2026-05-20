import {
  formatStrategicIntentVerificationReport,
  runStrategicIntentVerification,
} from "./core/strategicIntentVerification.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

void runVerificationCliCommand({
  label: "Strategic intent verification",
  run: () => runStrategicIntentVerification(),
  format: formatStrategicIntentVerificationReport,
});
