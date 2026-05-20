type VerificationLikeReport = {
  passed?: boolean;
};

type VerificationCliWriter = {
  write: (text: string) => unknown;
};

type VerificationCliProcess = {
  exitCode?: number;
  stdout: VerificationCliWriter;
  stderr: VerificationCliWriter;
};

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultExitCodeFromReport(report: unknown): number {
  if (typeof report === "object" && report !== null && "passed" in report) {
    const value = (report as VerificationLikeReport).passed;
    if (typeof value === "boolean") {
      return value ? 0 : 1;
    }
  }

  return 0;
}

export async function runVerificationCliCommand<TReport>(options: {
  label: string;
  run: () => Promise<TReport>;
  format: (report: TReport) => string;
  exitCodeFromReport?: (report: TReport) => number;
  processLike?: VerificationCliProcess;
}): Promise<void> {
  const processLike = options.processLike ?? process;

  try {
    const report = await options.run();
    processLike.stdout.write(`${options.format(report)}\n`);
    processLike.exitCode = (options.exitCodeFromReport ?? defaultExitCodeFromReport)(report);
  } catch (error) {
    processLike.stderr.write(`${options.label} failed: ${normalizeErrorMessage(error)}\n`);
    processLike.exitCode = 1;
  }
}
