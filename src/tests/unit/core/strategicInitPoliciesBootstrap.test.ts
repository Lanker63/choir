import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePoliciesDslForFirstTimeInit } from "../../../core/strategicInit.js";

const createdRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "choir-init-policies-"));
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("ensurePoliciesDslForFirstTimeInit", () => {
  it("creates .choir/policies.dsl with a commented sample policy for first-time init", () => {
    const root = makeTempRoot();

    const created = ensurePoliciesDslForFirstTimeInit(root, {
      hadChoirDirectoryAtStart: false,
    });

    const policiesPath = path.join(root, ".choir", "policies.dsl");
    expect(created).toBe(true);
    expect(fs.existsSync(policiesPath)).toBe(true);

    const contents = fs.readFileSync(policiesPath, "utf-8");
    expect(contents).toContain("# Sample policy");
    expect(contents).toContain("# policy repo-require-approval-for-plan-edits {");
    expect(contents).toContain("#   when diff.path = \"execution.plans\" and diff.operation = update then require-approval");
  });

  it("does not create policies.dsl when .choir existed before init", () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, ".choir"), { recursive: true });

    const created = ensurePoliciesDslForFirstTimeInit(root, {
      hadChoirDirectoryAtStart: true,
    });

    expect(created).toBe(false);
    expect(fs.existsSync(path.join(root, ".choir", "policies.dsl"))).toBe(false);
  });

  it("does not overwrite an existing policies.dsl file", () => {
    const root = makeTempRoot();
    const policiesPath = path.join(root, ".choir", "policies.dsl");
    fs.mkdirSync(path.dirname(policiesPath), { recursive: true });
    fs.writeFileSync(policiesPath, "# existing\n", "utf-8");

    const created = ensurePoliciesDslForFirstTimeInit(root, {
      hadChoirDirectoryAtStart: false,
    });

    expect(created).toBe(false);
    expect(fs.readFileSync(policiesPath, "utf-8")).toBe("# existing\n");
  });
});
