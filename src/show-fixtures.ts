import { loadAlert, loadSources } from "./fixtures.js";

/** Prints exactly what the pipeline will reason over. No model call. */

const alert = await loadAlert();
const sources = await loadSources();

console.log("=".repeat(72));
console.log("ALERT");
console.log("=".repeat(72));
console.log(alert);

for (const source of sources) {
  console.log("=".repeat(72));
  console.log(`SOURCE ${source.id}`);
  console.log("=".repeat(72));
  console.log(source.text);
}

console.log(`Loaded 1 alert and ${sources.length} sources: ${sources.map((s) => s.id).join(", ")}`);
