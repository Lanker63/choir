import { formatVerificationReport, runFullVerification } from "./core/verificationHarness.js";
import { installTmpDirTerminationCleanup } from "../utils/tmpCleanup.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

installTmpDirTerminationCleanup();

void runVerificationCliCommand({
  label: "Verification harness",
  run: () => {
    const mode = process.env.CHOIR_VERIFY_MODE === "quick" ? "quick" : "full";
    return runFullVerification({
      mode,
      throwOnFailure: false,
      detectFlakiness: true,
      parallelCaseExecution: false,
      flakeRuns: mode === "quick" ? 2 : 3,
    });
  },
  format: formatVerificationReport,
});
