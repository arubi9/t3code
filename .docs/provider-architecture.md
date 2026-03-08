# Provider architecture

T3 Code is already structured for multi-provider support, even though Codex is the
only fully implemented provider today.

## Current runtime flow

The browser does not talk to providers directly. It talks to the server over
WebSocket, and the server turns orchestration commands into provider lifecycle calls:

- **Request/Response**: `{ id, method, params }` → `{ id, result }` or `{ id, error }`
- **Push events**: `{ type: "push", channel, data }` for orchestration read-model updates

The current provider path is:

1. `apps/web` dispatches orchestration commands over WebSocket.
2. `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` decides when a
   provider session should start, continue, or stop.
3. `apps/server/src/provider/Services/ProviderService.ts` acts as the cross-provider
   facade.
4. `apps/server/src/provider/Services/ProviderAdapterRegistry.ts` resolves the
   concrete adapter for the selected provider.
5. `apps/server/src/provider/Services/CodexAdapter.ts` and
   `apps/server/src/provider/Layers/CodexAdapter.ts` implement the provider contract
   for Codex.
6. `apps/server/src/codexAppServerManager.ts` owns the Codex-specific child-process,
   JSON-RPC, session, approval, and streaming behavior.
7. `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` projects
   provider runtime events back into orchestration domain events that the web app
   renders.

## Contracts that make a second provider possible

The key seams for adding another provider such as Claude Code already exist:

- `packages/contracts/src/orchestration.ts`
  - canonical `ProviderKind`
- `packages/contracts/src/provider.ts`
  - provider session/start/turn/request schemas
- `packages/contracts/src/model.ts`
  - provider model catalogs and model-specific options
- `apps/server/src/provider/Services/ProviderAdapter.ts`
  - shared adapter interface every provider must implement
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
  - runtime binding from `ProviderKind` to concrete adapter

## Current Claude Code placeholders

The web app already reserves a Claude Code option as "coming soon":

- `apps/web/src/session-logic.ts`
- `apps/web/src/components/ChatView.tsx`

That means the remaining work is mostly to make the contracts, server runtime, and
settings model truly multi-provider instead of Codex-only.

## Recommended Claude Code approach

Implement Claude Code through the same adapter boundary as Codex:

1. Extend `ProviderKind`, provider start options, and provider model catalogs.
2. Add a Claude-specific adapter service/layer in `apps/server/src/provider`.
3. Add a Claude-specific session manager that owns process/protocol details, just as
   `codexAppServerManager.ts` does for Codex.
4. Normalize Claude runtime output into the existing `ProviderRuntimeEvent` contract
   so orchestration and the web UI can stay provider-agnostic.
5. Enable the existing Claude option in the web app only after the server path and
   settings are ready.

If Claude Code exposes a structured local protocol comparable to `codex app-server`,
the cleanest implementation is a sibling manager with the same responsibilities. If
its protocol differs, the right first step is extracting any process/session logic
that should be shared instead of cloning Codex-specific code.

## Claude Code implementation spec

See `.plans/17-claude-code-provider-spec.md` for a concrete implementation plan,
scope, risks, and validation checklist based on the current codebase.
