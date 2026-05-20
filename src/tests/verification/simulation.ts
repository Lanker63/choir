import {
  formatSimulationVerificationReport,
  runSimulationVerification,
} from "./core/simulationVerification.js";
import { runVerificationCliCommand } from "./verificationCliRunner.js";

void runVerificationCliCommand({
  label: "Simulation verification",
  run: () => runSimulationVerification(),
  format: formatSimulationVerificationReport,
});
