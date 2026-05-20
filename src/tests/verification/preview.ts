import {
  formatPreviewVerificationReport,
  runPreviewVerification,
} from "./core/previewVerification.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

void runVerificationCliCommand({
  label: "Preview verification",
  run: () => runPreviewVerification(),
  format: formatPreviewVerificationReport,
});
