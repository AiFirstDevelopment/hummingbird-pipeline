import Anthropic from "@anthropic-ai/sdk";

/**
 * The model every step of the pipeline uses.
 *
 * Pinned in one place so swapping models is a one-line diff rather than a
 * search-and-replace across the pipeline — and so every step is provably
 * running against the same model when we compare their behaviour.
 */
export const MODEL = "claude-opus-5";

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.error(
    [
      "ANTHROPIC_API_KEY is not set.",
      "",
      "Put your key in the .env file at the project root:",
      "",
      "    ANTHROPIC_API_KEY=sk-ant-...",
      "",
      "That file is gitignored, so the key never reaches the repo.",
    ].join("\n"),
  );
  process.exit(1);
}

/**
 * The SDK would read ANTHROPIC_API_KEY from the environment on its own. We pass
 * it explicitly so that a missing key fails here, at startup, with the message
 * above — rather than as a 401 in the middle of a multi-step pipeline run.
 */
export const client = new Anthropic({ apiKey });
