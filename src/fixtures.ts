import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturesDir = join(projectRoot, "fixtures");

export interface SourceDocument {
  /** Derived from the filename, e.g. "SRC-002" from "SRC-002.md". */
  id: string;
  text: string;
}

export async function loadAlert(): Promise<string> {
  return readFile(join(fixturesDir, "alert.md"), "utf8");
}

/**
 * Loads every source document, sorted by ID.
 *
 * The ID comes from the filename rather than from anything inside the document,
 * which makes the filesystem the single authority on what source IDs exist. That
 * lets us verify afterwards that a citation refers to a real document instead of
 * one the model invented.
 */
export async function loadSources(): Promise<SourceDocument[]> {
  const dir = join(fixturesDir, "sources");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();

  return Promise.all(
    files.map(async (file) => ({
      id: file.replace(/\.md$/, ""),
      text: await readFile(join(dir, file), "utf8"),
    })),
  );
}
