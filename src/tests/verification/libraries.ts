import { formatLibraryVerificationReport, runLibraryVerification } from "./core/libraryVerification.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

void runVerificationCliCommand({
  label: "Library verification",
  run: () => runLibraryVerification(),
  format: formatLibraryVerificationReport,
});
