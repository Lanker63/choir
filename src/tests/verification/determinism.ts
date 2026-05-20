import {
  formatDeterminismVerificationReport,
  runDeterminismVerification,
} from "./core/determinismVerification.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

void runVerificationCliCommand({
  label: "Determinism verification",
  run: () => runDeterminismVerification(),
  format: formatDeterminismVerificationReport,
});
