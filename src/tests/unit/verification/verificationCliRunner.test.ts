import { describe, expect, it } from "vitest";
import { runVerificationCliCommand } from "../../verification/verificationCliRunner.js";

type ProcessLike = {
  exitCode?: number;
  stdout: { write: (text: string) => boolean };
  stderr: { write: (text: string) => boolean };
};

function createFakeProcess(): ProcessLike & { output: { stdout: string[]; stderr: string[] } } {
  const output = { stdout: [] as string[], stderr: [] as string[] };
  return {
    exitCode: undefined,
    stdout: {
      write: (text: string) => {
        output.stdout.push(text);
        return true;
      },
    },
    stderr: {
      write: (text: string) => {
        output.stderr.push(text);
        return true;
      },
    },
    output,
  };
}

describe("runVerificationCliCommand", () => {
  it("writes formatted output and exit code 0 when report passed", async () => {
    const fakeProcess = createFakeProcess();

    await runVerificationCliCommand({
      label: "Demo verification",
      run: async () => ({ passed: true }),
      format: () => "PASS demo",
      processLike: fakeProcess,
    });

    expect(fakeProcess.output.stdout).toEqual(["PASS demo\n"]);
    expect(fakeProcess.output.stderr).toEqual([]);
    expect(fakeProcess.exitCode).toBe(0);
  });

  it("writes formatted output and exit code 1 when report failed", async () => {
    const fakeProcess = createFakeProcess();

    await runVerificationCliCommand({
      label: "Demo verification",
      run: async () => ({ passed: false }),
      format: () => "FAIL demo",
      processLike: fakeProcess,
    });

    expect(fakeProcess.output.stdout).toEqual(["FAIL demo\n"]);
    expect(fakeProcess.output.stderr).toEqual([]);
    expect(fakeProcess.exitCode).toBe(1);
  });

  it("writes deterministic error output and exit code 1 when runner throws", async () => {
    const fakeProcess = createFakeProcess();

    await runVerificationCliCommand({
      label: "Demo verification",
      run: async () => {
        throw new Error("boom");
      },
      format: () => "unused",
      processLike: fakeProcess,
    });

    expect(fakeProcess.output.stdout).toEqual([]);
    expect(fakeProcess.output.stderr).toEqual(["Demo verification failed: boom\n"]);
    expect(fakeProcess.exitCode).toBe(1);
  });
});