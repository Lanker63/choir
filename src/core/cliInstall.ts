export type CliInstallScope = "local" | "global";

export type CliPackageValidation = {
  ok: boolean;
  reason?: string;
};

export function normalizeCliPackageSpec(raw: string): string {
  return raw.trim();
}

export function validateCliPackageSpec(spec: string): CliPackageValidation {
  if (spec.length === 0) {
    return {
      ok: false,
      reason: "Package source is required.",
    };
  }

  // Guard against accidentally installing the unrelated legacy `choir` npm package.
  if (spec.toLowerCase() === "choir") {
    return {
      ok: false,
      reason: "Package `choir` is blocked. Provide an explicit private/pinned package source.",
    };
  }

  return {
    ok: true,
  };
}

export function buildCliInstallCommand(scope: CliInstallScope, packageSpec: string): string {
  return scope === "global"
    ? `npm install -g ${packageSpec}`
    : `npm install --save-dev ${packageSpec}`;
}
