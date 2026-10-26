import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProvider, ProviderConfigError, providerFromEnv } from "./index.js";

describe("provider factory", () => {
  it("defaults to the offline demo provider", () => {
    assert.equal(createProvider().name, "demo");
    assert.equal(providerFromEnv({}).name, "demo");
  });

  it("requires a key for hosted presets but builds a local one without", () => {
    assert.throws(() => createProvider({ kind: "openai", model: "gpt-4o-mini" }), ProviderConfigError);
    const ollama = createProvider({ kind: "ollama" });
    assert.match(ollama.name, /^openai-compatible:/u);
  });

  it("reads the documented environment variables", () => {
    const provider = providerFromEnv({
      ISLA_PROVIDER: "deepseek",
      ISLA_API_KEY: "test-key",
      ISLA_MODEL: "deepseek-chat",
    });
    assert.match(provider.name, /deepseek-chat/u);
  });
});
