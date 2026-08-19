import { readFile } from "node:fs/promises";
import { join } from "node:path";

const runtimeBundles = [join("out", "main", "index.js"), join("out", "preload", "index.mjs")];
const forbiddenRuntimeImports = ["@zapture/recorder-core", "/src/index.ts", "\\src\\index.ts"];

for (const bundle of runtimeBundles) {
  const source = await readFile(bundle, "utf8");
  for (const forbiddenImport of forbiddenRuntimeImports) {
    if (source.includes(forbiddenImport)) {
      throw new Error(`${bundle} contains an unsafe runtime import: ${forbiddenImport}`);
    }
  }
}

console.log("Zapture runtime bundles contain no raw TypeScript workspace imports");
