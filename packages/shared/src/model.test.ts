import { describe, expect, it } from "vitest";
import {
  CLAUDE_REASONING_EFFORT_OPTIONS,
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
} from "@t3tools/contracts";

import {
  getClaudeReasoningEffortOptions,
  getDefaultClaudeReasoningEffort,
  getDefaultClaudeThinkingEnabled,
  getDefaultModel,
  getDefaultReasoningEffort,
  getModelOptions,
  getReasoningEffortOptions,
  normalizeModelSlug,
  resolveClaudeModelOptions,
  resolveModelSlug,
  supportsClaudeReasoningEffort,
} from "./model";

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("claude-opus-4-6", "claude")).toBe("opus");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeModelSlug("")).toBeNull();
    expect(normalizeModelSlug("   ")).toBeNull();
    expect(normalizeModelSlug(null)).toBeNull();
    expect(normalizeModelSlug(undefined)).toBeNull();
  });

  it("preserves non-aliased model slugs", () => {
    expect(normalizeModelSlug("gpt-5.2")).toBe("gpt-5.2");
    expect(normalizeModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
    expect(normalizeModelSlug("sonnet", "claude")).toBe("sonnet");
  });

  it("does not leak prototype properties as aliases", () => {
    expect(normalizeModelSlug("toString")).toBe("toString");
    expect(normalizeModelSlug("constructor")).toBe("constructor");
  });
});

describe("resolveModelSlug", () => {
  it("returns default only when the model is missing", () => {
    expect(resolveModelSlug(undefined)).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(resolveModelSlug(null)).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("preserves unknown custom models", () => {
    expect(resolveModelSlug("gpt-4.1")).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(resolveModelSlug("custom/internal-model")).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("resolves only supported model options", () => {
    for (const model of MODEL_OPTIONS_BY_PROVIDER.codex) {
      expect(resolveModelSlug(model.slug)).toBe(model.slug);
    }
    for (const model of MODEL_OPTIONS_BY_PROVIDER.claude) {
      expect(resolveModelSlug(model.slug, "claude")).toBe(model.slug);
    }
  });
  it("keeps codex defaults for backward compatibility", () => {
    expect(getDefaultModel()).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(getModelOptions()).toEqual(MODEL_OPTIONS_BY_PROVIDER.codex);
  });

  it("returns provider-scoped defaults for claude", () => {
    expect(getDefaultModel("claude")).toBe(DEFAULT_MODEL_BY_PROVIDER.claude);
    expect(getModelOptions("claude")).toEqual(MODEL_OPTIONS_BY_PROVIDER.claude);
  });
});

describe("getReasoningEffortOptions", () => {
  it("returns codex reasoning options for codex", () => {
    expect(getReasoningEffortOptions("codex")).toEqual(["xhigh", "high", "medium", "low"]);
  });

  it("returns no reasoning options for claude", () => {
    expect(getReasoningEffortOptions("claude")).toEqual([]);
  });
});

describe("Claude model helpers", () => {
  it("reports which Claude models support reasoning effort", () => {
    expect(supportsClaudeReasoningEffort("sonnet")).toBe(true);
    expect(supportsClaudeReasoningEffort("claude-opus-4-6")).toBe(true);
    expect(supportsClaudeReasoningEffort("haiku")).toBe(false);
    expect(supportsClaudeReasoningEffort("default")).toBe(false);
  });

  it("returns Claude reasoning effort options only for supported models", () => {
    expect(getClaudeReasoningEffortOptions("sonnet")).toEqual(CLAUDE_REASONING_EFFORT_OPTIONS);
    expect(getClaudeReasoningEffortOptions("haiku")).toEqual([]);
  });

  it("returns Claude defaults", () => {
    expect(getDefaultClaudeThinkingEnabled()).toBe(true);
    expect(getDefaultClaudeReasoningEffort()).toBeNull();
  });

  it("normalizes Claude model options to supported combinations", () => {
    expect(
      resolveClaudeModelOptions("sonnet", {
        thinking: false,
        effort: "high",
      }),
    ).toEqual({ thinking: false });
    expect(
      resolveClaudeModelOptions("haiku", {
        effort: "medium",
      }),
    ).toBeUndefined();
    expect(
      resolveClaudeModelOptions("opus", {
        effort: "high",
      }),
    ).toEqual({ effort: "high" });
  });
});

describe("getDefaultReasoningEffort", () => {
  it("returns provider-scoped defaults", () => {
    expect(getDefaultReasoningEffort("codex")).toBe("high");
    expect(getDefaultReasoningEffort("claude")).toBeNull();
  });
});
