import {
  DemoProvider,
  OpenAICompatibleProvider,
  type ModelProvider,
} from "@isla/core";

export { DemoProvider, OpenAICompatibleProvider };
export type { ModelProvider };

export type ProviderKind = "demo" | "openai" | "deepseek" | "ollama" | "lmstudio" | "openai-compatible";

interface Preset {
  baseUrl?: string;
  defaultModel?: string;
  requiresKey: boolean;
}

/**
 * Presets are conveniences, not endorsements. Anything that speaks the OpenAI chat-completions
 * protocol works through `openai-compatible`; the named ones just fill in a base URL.
 */
const PRESETS: Record<Exclude<ProviderKind, "demo">, Preset> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    requiresKey: true,
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    requiresKey: true,
  },
  ollama: {
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "qwen2.5:7b",
    requiresKey: false,
  },
  lmstudio: {
    baseUrl: "http://127.0.0.1:1234/v1",
    requiresKey: false,
  },
  "openai-compatible": {
    requiresKey: false,
  },
};

export interface ProviderOptions {
  kind?: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  embeddingModel?: string;
  timeoutMs?: number;
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/**
 * Builds a provider from explicit options. The offline demo provider is the default, so a
 * fresh checkout runs without a key; ask for a real one and you must supply what it needs.
 */
export function createProvider(options: ProviderOptions = {}): ModelProvider {
  const kind = options.kind ?? "demo";
  if (kind === "demo") {
    return new DemoProvider();
  }
  const preset = PRESETS[kind];
  const baseUrl = options.baseUrl ?? preset.baseUrl;
  const model = options.model ?? preset.defaultModel;
  if (!baseUrl) {
    throw new ProviderConfigError(`Provider "${kind}" needs a baseUrl`);
  }
  if (!model) {
    throw new ProviderConfigError(`Provider "${kind}" needs a model`);
  }
  if (preset.requiresKey && !options.apiKey) {
    throw new ProviderConfigError(`Provider "${kind}" needs an apiKey`);
  }
  return new OpenAICompatibleProvider({
    baseUrl,
    model,
    apiKey: options.apiKey ?? "local",
    ...(options.embeddingModel ? { embeddingModel: options.embeddingModel } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

/**
 * Reads `ISLA_PROVIDER`, `ISLA_BASE_URL`, `ISLA_API_KEY`, `ISLA_MODEL` and
 * `ISLA_EMBEDDING_MODEL`. Unknown provider names fall back to `openai-compatible` so a custom
 * endpoint only needs a base URL and a model.
 */
export function providerFromEnv(
  env: Record<string, string | undefined> = process.env,
): ModelProvider {
  const raw = env.ISLA_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === "demo") {
    return createProvider({ kind: "demo" });
  }
  const kind: ProviderKind =
    raw === "openai" || raw === "deepseek" || raw === "ollama" || raw === "lmstudio"
      ? raw
      : "openai-compatible";
  return createProvider({
    kind,
    ...(env.ISLA_BASE_URL ? { baseUrl: env.ISLA_BASE_URL } : {}),
    ...(env.ISLA_API_KEY ? { apiKey: env.ISLA_API_KEY } : {}),
    ...(env.ISLA_MODEL ? { model: env.ISLA_MODEL } : {}),
    ...(env.ISLA_EMBEDDING_MODEL ? { embeddingModel: env.ISLA_EMBEDDING_MODEL } : {}),
  });
}

/** Human-readable description for logs and the demo UI. */
export function describeProvider(provider: ModelProvider): string {
  return provider.name;
}
