import { client, MODEL } from "./client.js";

/**
 * Step 1 smoke test: prove the plumbing works end to end.
 *
 * Nothing here is part of the compliance pipeline. It exists so that when a
 * later step misbehaves, we already know the key, the network, the SDK, and
 * the model string are not the problem.
 */

const response = await client.messages.create({
  model: MODEL,
  max_tokens: 4096,
  messages: [
    {
      role: "user",
      content: "Reply with exactly one short sentence confirming you received this.",
    },
  ],
});

for (const block of response.content) {
  if (block.type === "text") {
    console.log(block.text);
  }
}

// Printing the envelope, not just the text. `stop_reason` in particular tells us
// whether the model finished ("end_turn") or ran out of room ("max_tokens") —
// a distinction that matters as soon as we ask for structured output.
console.log();
console.log(`model:       ${response.model}`);
console.log(`stop_reason: ${response.stop_reason}`);
console.log(`tokens:      ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`);
