import { describe, expect, it } from "vitest";
import { architecturePassByName } from "../../verification/core/contractVerification.js";

describe("contractVerification", () => {
  it("matches architecture PASS lines by test name regardless of test id prefix", () => {
    const name = "priority overrides and dependency safety rejections are honored";
    const pattern = architecturePassByName(name);

    expect(pattern.test(`PASS 7.5 ${name}`)).toBe(true);
    expect(pattern.test(`PASS x.5 ${name}`)).toBe(true);
    expect(pattern.test("FAIL 7.5 priority overrides and dependency safety rejections are honored")).toBe(false);
  });
});
