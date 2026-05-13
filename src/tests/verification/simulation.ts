import {
  formatSimulationVerificationReport,
  runSimulationVerification,
} from "./core/simulationVerification.js";

async function main(): Promise<void> {
  try {
    const report = await runSimulationVerification();
    process.stdout.write(`${formatSimulationVerificationReport(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Simulation verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
