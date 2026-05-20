import {
  formatTransactionVerificationReport,
  runTransactionVerification,
} from "./core/transactionVerification.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

void runVerificationCliCommand({
  label: "Transaction verification",
  run: () => runTransactionVerification(),
  format: formatTransactionVerificationReport,
});
