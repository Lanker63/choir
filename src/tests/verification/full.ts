import {
  formatFullSystemVerificationReport,
  runFullSystemVerification,
  type FullSystemVerificationMode,
} from "./core/fullSystemVerification.js";
import { installTmpDirTerminationCleanup } from "../utils/tmpCleanup.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

installTmpDirTerminationCleanup();

function readMode(): FullSystemVerificationMode {
  return process.env.CHOIR_FULL_SYSTEM_MODE === "quick" ? "quick" : "full";
}

void runVerificationCliCommand({
  label: "Full-system verification",
  run: () => runFullSystemVerification({
      mode: readMode(),
      workspaceRoot: process.cwd(),
      throwOnFailure: false,
    }),
  format: formatFullSystemVerificationReport,
});
