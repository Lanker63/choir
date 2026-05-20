import {
  formatCompilerVerificationReport,
  runCompilerVerification,
} from "./core/compilerVerification.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

void runVerificationCliCommand({
  label: "Compiler verification",
  run: () => runCompilerVerification(),
  format: formatCompilerVerificationReport,
});
