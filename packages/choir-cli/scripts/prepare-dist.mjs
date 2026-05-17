import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

const rootPackagePath = path.join(repoRoot, "package.json");
const cliPackagePath = path.join(packageRoot, "package.json");
const outRoot = path.join(repoRoot, "out");
const distOutRoot = path.join(packageRoot, "dist", "out");

if (!fs.existsSync(outRoot)) {
  throw new Error("Missing compiled out/ directory. Run `npm run build:extension` from repo root first.");
}

const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, "utf-8"));
const cliPackage = JSON.parse(fs.readFileSync(cliPackagePath, "utf-8"));

let packageChanged = false;
if (cliPackage.version !== rootPackage.version) {
  cliPackage.version = rootPackage.version;
  packageChanged = true;
}

const rootDependencies = rootPackage.dependencies ?? {};
const cliDependencies = cliPackage.dependencies ?? {};
if (JSON.stringify(cliDependencies) !== JSON.stringify(rootDependencies)) {
  cliPackage.dependencies = rootDependencies;
  packageChanged = true;
}

if (packageChanged) {
  fs.writeFileSync(cliPackagePath, `${JSON.stringify(cliPackage, null, 2)}\n`, "utf-8");
}

fs.rmSync(path.join(packageRoot, "dist"), { recursive: true, force: true });
fs.mkdirSync(path.dirname(distOutRoot), { recursive: true });
fs.cpSync(outRoot, distOutRoot, { recursive: true });

const cliEntrypoint = path.join(distOutRoot, "cli.js");
if (!fs.existsSync(cliEntrypoint)) {
  throw new Error("CLI entrypoint not found at dist/out/cli.js after copy.");
}

fs.chmodSync(cliEntrypoint, 0o755);
console.log("Prepared choir-cli dist from out/ runtime artifacts.");
