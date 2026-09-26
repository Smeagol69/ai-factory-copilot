import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// Native inputs and loose runtime files declared in AIFactoryCopilot.Build.cs.
// Dependencies are lock-pinned and checked separately by package-local.ps1.
const SCOPES = [
  "AIFactoryCopilot.uplugin", "Source", "Config", "Resources", "Content",
  "companion/server.mjs", "companion/package.json", "companion/package-lock.json",
  "companion/lib", "companion/data",
];

function inventory(root) {
  const files = new Map();
  const visit = (relative) => {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`Cannot verify linked packaging input: ${absolute}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute)) visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      files.set(relative, createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"));
    } else {
      throw new Error(`Unsupported packaging input: ${absolute}`);
    }
  };
  for (const scope of SCOPES) visit(scope);
  return files;
}

export function verifyStarterSync(sourceRoot, pluginRoot) {
  const source = inventory(sourceRoot);
  const plugin = inventory(pluginRoot);
  for (const required of ["AIFactoryCopilot.uplugin", "Source/AIFactoryCopilot/AIFactoryCopilot.Build.cs", "companion/server.mjs", "companion/package.json", "companion/package-lock.json"]) {
    if (!source.has(required)) throw new Error(`Repository packaging input is missing: ${required}`);
  }
  const mismatches = [];
  for (const [name, hash] of source) {
    if (!plugin.has(name)) mismatches.push(`missing: ${name}`);
    else if (plugin.get(name) !== hash) mismatches.push(`changed: ${name}`);
  }
  for (const name of plugin.keys()) {
    if (!source.has(name)) mismatches.push(`extra: ${name}`);
  }
  if (mismatches.length) {
    throw new Error(`Starter Project source is not synchronized (${mismatches.length} differences):\n` +
      mismatches.sort().slice(0, 25).join("\n") +
      "\nSync the reviewed repository into the Starter Project before packaging; no build or deployment was started.");
  }
  return { files: source.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { "source-root": { type: "string" }, "plugin-root": { type: "string" } } });
    if (!values["source-root"] || !values["plugin-root"]) throw new Error("Both --source-root and --plugin-root are required.");
    const result = verifyStarterSync(values["source-root"], values["plugin-root"]);
    console.log(`Starter Project source verified: ${result.files} matching files (SHA-256).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
