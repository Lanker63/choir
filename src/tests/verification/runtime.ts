import {
  formatRuntimeVerificationReport,
  runRuntimeVerification,
} from "./core/runtimeVerification.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

void runVerificationCliCommand({
  label: "Runtime verification",
  run: () => runRuntimeVerification(),
  format: formatRuntimeVerificationReport,
});
