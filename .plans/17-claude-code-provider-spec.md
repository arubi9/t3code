# Plan: Add Claude Code as a First-Class Provider

## Summary

Implement Claude Code through the existing provider adapter architecture so it can
start sessions, stream turns, surface approvals, and project orchestration events in
the same way Codex works today.

## Motivation

- The product already advertises "Claude Code support coming soon".
- The web app already contains a disabled Claude Code picker entry.
- The server/contracts are still effectively Codex-only, so the second provider
  should be added by extending shared provider seams instead of hard-coding another
  one-off path.

## Scope

- `packages/contracts` provider, model, and server-facing schemas
- `apps/server` provider adapter registration and Claude runtime integration
- `apps/web` provider picker, model settings, and provider-aware defaults
- provider documentation and operator prerequisites

## Non-Goals

- Shipping Cursor/OpenCode/Gemini in the same change
- Reworking orchestration event sourcing beyond what Claude support needs
- Replacing Codex behavior or making Codex and Claude share one protocol parser

## Current Architecture Constraints

1. The server is the source of truth for provider lifecycle.
2. The web app renders orchestration state, not raw provider protocol events.
3. `ProviderAdapterShape` is the main extensibility seam and should remain the only
   provider-specific boundary exposed to the rest of the server.
4. Current settings/model helpers assume Codex-only custom models and service-tier
   behavior.
5. The UI currently uses a placeholder `claudeCode` picker value even though
   `ProviderKind` only contains `"codex"`.

## Proposed Changes

1. **Choose one canonical provider key**
   - Promote Claude Code into `ProviderKind`.
   - Reuse the existing `claudeCode` key to minimize UI churn, or rename the current
     placeholder in the same PR if a different canonical slug is preferred.
   - Remove any remaining provider-picker-only union that diverges from
     `ProviderKind`.

2. **Extend shared contracts**
   - Update `packages/contracts/src/orchestration.ts` to include the new provider.
   - Update `packages/contracts/src/provider.ts` so `providerOptions` can carry
     Claude-specific startup configuration.
   - Update `packages/contracts/src/model.ts` with Claude model catalog, aliases,
     defaults, and any Claude-only model options.
   - Keep shared contracts provider-agnostic: anything emitted at runtime must still
     fit `ProviderRuntimeEvent`.

3. **Add a Claude adapter on the server**
   - Add `apps/server/src/provider/Services/ClaudeCodeAdapter.ts`.
   - Add `apps/server/src/provider/Layers/ClaudeCodeAdapter.ts`.
   - Register it through `ProviderAdapterRegistryLive` and `serverLayers.ts`.
   - Capabilities should be reported through the existing adapter capability surface
     so the UI/orchestration can branch only where necessary.

4. **Add a Claude session/runtime manager**
   - Mirror the role of `apps/server/src/codexAppServerManager.ts`:
     - spawn/stop the Claude process
     - track per-thread sessions
     - translate protocol messages into provider runtime events
     - handle interrupts, approvals, and structured user-input prompts
     - preserve resume/reconnect behavior where the Claude protocol supports it
   - If Claude Code does not expose a Codex-like app-server protocol, extract a small
     shared process-backed session abstraction before adding provider-specific logic.
     Do not clone the Codex manager wholesale if the only shared behavior is process
     lifecycle bookkeeping.

5. **Keep orchestration provider-agnostic**
   - `ProviderCommandReactor` should continue selecting a provider and calling
     `ProviderService`.
   - `ProviderRuntimeIngestion` should continue receiving normalized runtime events.
   - Any Claude-specific nuance should be absorbed in the adapter/manager layer unless
     orchestration truly needs a new domain concept.

6. **Finish the web path**
   - Replace hard-coded Codex-only custom model settings with provider-keyed storage.
   - Enable Claude Code in:
     - `apps/web/src/session-logic.ts`
     - `apps/web/src/components/ChatView.tsx`
     - `apps/web/src/appSettings.ts`
     - `apps/web/src/routes/_chat.settings.tsx`
   - Ensure default model resolution, slash model lookup, and locked-provider behavior
     all use the expanded `ProviderKind`.
   - Only show provider-specific controls (for example service tier or reasoning
     options) when the selected provider actually supports them.

7. **Document prerequisites and operational behavior**
   - Add a Claude-specific prerequisites doc beside `.docs/codex-prerequisites.md`.
   - Document expected install/auth requirements, binary discovery, and any config
     directory overrides.
   - Document which Claude features are required for parity with Codex:
     session resume, streaming deltas, tool events, approval prompts, and interrupts.

## Suggested Delivery Order

1. Contracts and model catalog
2. Server adapter + runtime manager behind a disabled feature flag or unexposed provider
3. Adapter/service tests
4. Web settings and provider picker enablement
5. Docs and manual verification

## Risks

- Claude Code may not offer a protocol that maps 1:1 to Codex app-server semantics.
- Approval prompts and structured user input may differ enough to require event
  normalization work.
- Resume/reconnect semantics may be weaker or absent.
- Copying Codex-only settings assumptions into Claude would create avoidable tech debt.

## Validation

- Contract tests cover the new provider kind, model catalog, and startup options.
- Shared model utility tests cover Claude defaults/aliases.
- `ProviderAdapterRegistry` tests prove Codex and Claude both register correctly.
- Claude adapter tests cover session start, turn streaming, approval handling,
  interrupts, and shutdown.
- Web tests cover provider availability, model option selection, and settings
  persistence for both providers.
- Manual verification:
  - start a Claude-backed session
  - send a turn
  - approve/deny a request
  - interrupt a running turn
  - reconnect and confirm thread state remains coherent

## Done Criteria

- Claude Code is selectable as a real provider, not a disabled placeholder.
- Starting a Claude session uses the same orchestration flow as Codex.
- Provider runtime events from Claude render correctly in existing thread/session UI.
- Codex remains unchanged except for shared abstractions needed to support multiple
  providers cleanly.
