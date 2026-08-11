import { resolveRunId, runsRoot } from "./runs.js";
import { join } from "node:path";

/** Opens the next pending case file in whatever the OS uses for .md files. */
const runId = await resolveRunId(process.argv[2]);
const path = join(runsRoot, runId, "case-file.md");

console.log(`Opening case ${runId}`);
console.log(path);

const { spawn } = await import("node:child_process");
const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
spawn(opener, [path], { stdio: "ignore", detached: true }).unref();
