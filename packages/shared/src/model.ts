import {
  CLAUDE_REASONING_EFFORT_OPTIONS,
  CODEX_REASONING_EFFORT_OPTIONS,
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ClaudeModelOptions,
  type ClaudeReasoningEffort,
  type CodexReasoningEffort,
  type ModelSlug,
  type ProviderKind,
} from "@t3tools/contracts";

type CatalogProvider = keyof typeof MODEL_OPTIONS_BY_PROVIDER;

const MODEL_SLUG_SET_BY_PROVIDER: Record<CatalogProvider, ReadonlySet<ModelSlug>> = {
  codex: new Set(MODEL_OPTIONS_BY_PROVIDER.codex.map((option) => option.slug)),
  claude: new Set(MODEL_OPTIONS_BY_PROVIDER.claude.map((option) => option.slug)),
};
const CLAUDE_MODELS_WITH_REASONING_EFFORT = new Set<ModelSlug>([
  "sonnet",
  "sonnet[1m]",
  "opus",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
]);

export function getModelOptions(provider: ProviderKind = "codex") {
  return MODEL_OPTIONS_BY_PROVIDER[provider];
}

export function getDefaultModel(provider: ProviderKind = "codex"): ModelSlug {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, ModelSlug>;
  const aliased = aliases[trimmed];
  return typeof aliased === "string" ? aliased : (trimmed as ModelSlug);
}

export function resolveModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug {
  if (typeof model === "string") {
    const trimmed = model.trim() as ModelSlug;
    if (trimmed && MODEL_SLUG_SET_BY_PROVIDER[provider].has(trimmed)) {
      return trimmed;
    }
  }
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return getDefaultModel(provider);
  }

  return MODEL_SLUG_SET_BY_PROVIDER[provider].has(normalized)
    ? normalized
    : getDefaultModel(provider);
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): ModelSlug {
  return resolveModelSlug(model, provider);
}

export function getReasoningEffortOptions(
  provider: ProviderKind = "codex",
): ReadonlyArray<CodexReasoningEffort> {
  return provider === "codex" ? CODEX_REASONING_EFFORT_OPTIONS : [];
}

export function supportsClaudeReasoningEffort(model: string | null | undefined): boolean {
  const normalizedModel = normalizeModelSlug(model, "claude");
  return normalizedModel !== null && CLAUDE_MODELS_WITH_REASONING_EFFORT.has(normalizedModel);
}

export function getClaudeReasoningEffortOptions(
  model: string | null | undefined,
): ReadonlyArray<ClaudeReasoningEffort> {
  return supportsClaudeReasoningEffort(model) ? CLAUDE_REASONING_EFFORT_OPTIONS : [];
}

export function getDefaultClaudeThinkingEnabled(): boolean {
  return true;
}

export function getDefaultClaudeReasoningEffort(): ClaudeReasoningEffort | null {
  return null;
}

export function resolveClaudeModelOptions(
  model: string | null | undefined,
  options?: ClaudeModelOptions | null,
): ClaudeModelOptions | undefined {
  const thinkingDisabled = options?.thinking === false;
  if (thinkingDisabled) {
    return { thinking: false };
  }
  if (supportsClaudeReasoningEffort(model) && options?.effort) {
    return { effort: options.effort };
  }
  return undefined;
}

export function getDefaultReasoningEffort(provider: "codex"): CodexReasoningEffort;
export function getDefaultReasoningEffort(provider: ProviderKind): CodexReasoningEffort | null;
export function getDefaultReasoningEffort(
  provider: ProviderKind = "codex",
): CodexReasoningEffort | null {
  return provider === "codex" ? "high" : null;
}

export { CODEX_REASONING_EFFORT_OPTIONS };
