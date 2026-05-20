import { describe, expect, it } from "vitest";
import {
  SeededRandom,
  deterministicHash,
  deterministicId,
  stableStringify,
} from "../../../core/deterministicCore.js";

describe("deterministicCore", () => {
  it("stably stringifies object keys", () => {
    const left = { b: 2, a: { d: 4, c: 3 } };
    const right = { a: { c: 3, d: 4 }, b: 2 };

    expect(stableStringify(left)).toBe(stableStringify(right));
    expect(deterministicHash(left)).toBe(deterministicHash(right));
  });

  it("builds deterministic bounded ids", () => {
    const id = deterministicId("preview", { path: "src/a.ts", op: "update" }, 10);
    expect(id).toMatch(/^preview-[a-f0-9]{10}$/);
    expect(deterministicId("preview", { path: "src/a.ts", op: "update" }, 10)).toBe(id);
  });

  it("produces deterministic random sequences for the same seed", () => {
    const a = new SeededRandom(42);
    const b = new SeededRandom(42);

    const left = [a.next(), a.next(), a.nextInt(10), a.nextInt(10)];
    const right = [b.next(), b.next(), b.nextInt(10), b.nextInt(10)];

    expect(left).toEqual(right);
  });
});
