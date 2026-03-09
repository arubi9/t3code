# Claude First-Class Integration Plan

Goal:
- Make Claude a first-class T3 provider without changing Codex behavior.
- Align the Claude UI and adapter surface with Claude Code's actual documented capabilities.
- Close the largest current gaps: Claude-specific model traits, plan mode semantics, approval/user-input bridging, and image input support.

Non-goals:
- Refactor Codex to fit Claude.
- Invent provider-native Claude APIs that are not exposed by Claude Code.
- Promise Codex-parity where the Claude surface is materially different.

## Source of Truth

Local code touchpoints:
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Services/ProviderAdapter.ts`
- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/server/src/provider/Reactors/ProviderCommandReactor.ts`
- `apps/server/src/checkpointing/Reactors/CheckpointReactor.ts`
- `apps/server/src/wsServer.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/session-logic.ts`
- `apps/web/src/appSettings.ts`
- `packages/contracts/src/model.ts`
- `packages/contracts/src/provider.ts`
- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/providerRuntime.ts`
- `packages/shared/src/model.ts`
- `packages/shared/src/provider.ts`

Claude Code docs to follow:
- Common Workflows: `https://code.claude.com/docs/en/common-workflows`
- CLI Usage: `https://code.claude.com/docs/en/cli-usage`
- Interactive Mode: `https://code.claude.com/docs/en/interactive-mode`
- SDK / permission prompt tool reference: `https://docs.claude.com/en/docs/claude-code/sdk/sdk-python#permission-prompt-tool`

## Current State

What works now:
- Claude can start a session, send a turn, stream output, resume, interrupt, and stop.
- Claude model switching is supported via the existing T3 provider session flow.
- Claude maps T3 `interactionMode === "plan"` to `claude --permission-mode plan`.
- Claude now exposes a local `readThread` snapshot and a best-effort local rollback fallback.

What is still wrong or incomplete:
- Claude has no T3-facing reasoning/thinking controls.
- The current traits picker is Codex-only and should remain Codex-only until Claude gets its own UI.
- Claude approvals are still reported as unsupported at the adapter contract boundary.
- Structured user input is still unsupported at the adapter contract boundary.
- Claude attachments are hard-rejected.
- Claude capability defaults still describe several missing features as unavailable.

## Product Decisions

### 1. Claude model picker and traits must be Claude-native

Requirements:
- Keep provider selection and model selection in the existing provider/model picker.
- Do not reuse Codex reasoning labels for Claude.
- Add a separate Claude traits control that is only rendered when `selectedProvider === "claude"`.
- Claude traits must follow Claude docs terminology:
  - `thinking`: `on` or `off`
  - `effort`: `low`, `medium`, `high`
- The UI must not show `Extra High`.
- The UI must not show `Fast Mode` for Claude.
- If a selected Claude model does not support a given trait, disable the control and explain why in UI copy.

Implementation targets:
- `packages/contracts/src/model.ts`
- `packages/shared/src/model.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/appSettings.ts`

Contract changes:
- Replace empty `ClaudeModelOptions` with a typed struct:
  - `thinking: boolean | undefined`
  - `effort: "low" | "medium" | "high" | undefined`
- Add Claude-specific option helpers in shared model utilities:
  - defaults
  - model support checks
  - label helpers

UI behavior:
- Codex keeps the current `CodexTraitsPicker`.
- Claude gets a new `ClaudeTraitsPicker`.
- The trigger label should use Claude wording, for example:
  - `Thinking`
  - `Thinking · High`
  - `No thinking`

Acceptance criteria:
- Selecting Claude never shows Codex `Extra High` or `Fast Mode`.
- Claude turns include Claude model options in the dispatch payload.
- Unsupported Claude trait combinations are impossible to submit from the UI.

### 2. Claude plan mode should be native where Claude is native

Requirements:
- Continue using Claude CLI headless mode through the adapter.
- Preserve `--permission-mode plan` for Claude turns started with T3 plan mode.
- Add Claude-specific plan UX language so users understand that plan mode is Claude's plan permission mode, not Codex app-server plan mode.
- Parse and project Claude planning output into T3 plan activities when present.

Implementation targets:
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Reactors/ProviderCommandReactor.ts`
- `apps/web/src/components/ChatView.tsx`
- `packages/contracts/src/providerRuntime.ts`

Design:
- Keep the current `interactionMode -> --permission-mode plan` mapping.
- Improve Claude stream normalization so plan-like output maps into canonical T3 plan events when detectable.
- Do not reuse Codex's injected plan instruction block from `codexAppServerManager.ts`.
- Add provider-aware labels in the UI:
  - Codex: existing semantics
  - Claude: `Claude plan mode`

Acceptance criteria:
- A Claude turn started in plan mode runs with `--permission-mode plan`.
- If Claude emits plan/proposed-plan style output, T3 renders it in the existing plan surfaces.
- The UI does not imply Claude is using the Codex plan protocol.

### 3. Claude approval handling should become a bridge, not a hard failure

Requirements:
- Stop treating Claude approval requests as permanently unsupported.
- Detect denied tool calls and permission denials from Claude stream JSON.
- Surface those denials as T3 approval requests with stable request IDs.
- On approval, continue the Claude run through a Claude-specific continuation path.

Implementation targets:
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Services/ProviderAdapter.ts`
- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/server/src/provider/Reactors/ProviderCommandReactor.ts`
- `packages/contracts/src/providerRuntime.ts`
- `packages/shared/src/provider.ts`

Design:
- Keep Codex approval behavior unchanged.
- Add additive Claude-only request metadata where needed:
  - original tool name
  - tool args
  - denial reason
  - continuation token or replay descriptor
- Prefer a real Claude permission bridge if the SDK permission prompt tool can be driven cleanly from T3 without replacing the current CLI wrapper.
- If that is not viable, implement a T3-owned retry flow:
  - detect denial
  - show approval in T3
  - on accept, restart or resume the turn with a less restrictive Claude permission mode
  - mark the original denial as resolved

Acceptance criteria:
- Claude file-write or command denials become pending approvals in T3.
- A user approval can continue the work without dropping to raw CLI.
- Denials and resolutions are durable in the orchestration transcript.

### 4. Structured user input should degrade predictably when Claude lacks a direct callback

Requirements:
- Do not leave `respondToUserInput` as a dead end.
- Preserve T3's existing user-input UX.
- Support two Claude paths:
  - native callback path if a documented Claude integration surface is viable
  - T3-owned continuation path if not

Implementation targets:
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Reactors/ProviderCommandReactor.ts`
- `packages/contracts/src/providerRuntime.ts`
- `packages/shared/src/provider.ts`

Design:
- Convert Claude `AskUserQuestion` style requests into canonical `user-input.requested` events.
- If Claude does not expose an in-run reply channel for the chosen integration shape, collect the answers in T3 and inject them into the next Claude turn in a structured continuation prompt.
- Mark this path clearly in code and runtime metadata as provider-emulated, not provider-native.

Acceptance criteria:
- Claude user-input requests appear in the existing T3 prompt flow.
- Answering the prompt can continue the Claude workflow without manual CLI interaction.
- The runtime transcript records both the request and the answer payload.

### 5. Claude image input should use the real Claude image surface

Requirements:
- Stop hard-rejecting images once a validated Claude-compatible path is implemented.
- Use Claude's documented image support model instead of inventing a Codex attachment payload.
- Preserve current T3 image draft behavior and uploaded attachment storage.

Implementation targets:
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/wsServer.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/composerDraftStore.ts`
- `packages/shared/src/provider.ts`
- `packages/contracts/src/provider.ts`

Design:
- Keep the current Claude attachment gate until end-to-end support is implemented.
- Preferred path:
  - resolve T3 image attachments to local filesystem paths accessible from the Claude process
  - inject them into the Claude prompt in the documented image-path format
- Alternative path:
  - if Claude CLI exposes a better headless image-input flag, use that instead
- The adapter owns the transformation from T3 attachment objects to Claude input shape.
- The UI should expose attachments for Claude only after this path is validated.

Acceptance criteria:
- A user can attach an image in T3 and Claude receives it through the wrapper.
- Claude responses referencing the image appear in the normal T3 transcript.
- Failed image resolution produces a clear Claude-specific error, not silent dropping.

### 6. Claude capabilities should distinguish native support from T3 support

Requirements:
- Current capability booleans are too coarse for the Claude roadmap.
- The system needs to distinguish:
  - provider-native support
  - T3-emulated support
  - unsupported

Implementation targets:
- `packages/contracts/src/provider.ts`
- `packages/shared/src/provider.ts`
- `apps/server/src/wsServer.ts`
- `apps/web/src/components/ChatView.tsx`

Contract changes:
- Replace or extend boolean capability fields with richer states for Claude-sensitive features:
  - `approvals`
  - `structuredUserInput`
  - `providerHistoryRead`
  - `providerRollback`
  - `attachments`
- Suggested shape:
  - `"native" | "emulated" | "unsupported"`

Design:
- Keep Codex values mapped to `native`.
- Use `emulated` where T3 can preserve UX without a provider-native API.
- Use `unsupported` only for genuinely unavailable features.

Acceptance criteria:
- The UI can describe Claude features accurately.
- The server no longer has to rely on provider-name checks for all Claude gating.

## Implementation Phases

### Phase 1: Claude model and traits contract
- Add typed `ClaudeModelOptions`.
- Add shared helpers for Claude defaults and trait labels.
- Add `ClaudeTraitsPicker`.
- Ensure turn dispatch carries Claude model options.

### Phase 2: Claude plan-mode UX and event normalization
- Keep `--permission-mode plan`.
- Parse Claude plan-like output into T3 plan events when possible.
- Update plan-mode UI copy for Claude.

### Phase 3: Claude approval bridge
- Detect permission denials.
- Open canonical approval requests.
- Implement Claude continuation after approval.

### Phase 4: Claude structured user-input bridge
- Detect Claude user-input requests.
- Implement native or emulated reply path.

### Phase 5: Claude image passthrough
- Map T3 image attachments to Claude-readable image input.
- Turn on Claude attachments only after live validation passes.

### Phase 6: Claude capability-state upgrade
- Replace coarse booleans with `native | emulated | unsupported`.
- Update server config payload and UI labels.

### Phase 7: Recovery and durability hardening
- Ensure approval/input continuation survives reconnects.
- Persist continuation metadata in the Claude shadow transcript where needed.
- Keep rollback and history behavior explicit about local-emulated semantics.

## File-by-File Backlog

### `packages/contracts/src/model.ts`
- Define `ClaudeThinkingMode` and `ClaudeReasoningEffort`.
- Expand `ClaudeModelOptions`.
- Add Claude reasoning option catalog and defaults.

### `packages/shared/src/model.ts`
- Add Claude model trait helpers.
- Add validation helpers for supported model/trait combinations.

### `packages/contracts/src/provider.ts`
- Upgrade feature capability fields from booleans to richer states.

### `packages/shared/src/provider.ts`
- Update default capability resolution for Claude and Codex.

### `apps/web/src/components/ChatView.tsx`
- Add `ClaudeTraitsPicker`.
- Render Claude traits only for Claude.
- Improve provider-aware labels for plan mode, approval mode, and attachments.

### `apps/web/src/appSettings.ts`
- Persist Claude trait defaults if they are user-configurable.

### `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- Accept Claude model options and translate them into Claude CLI/runtime behavior.
- Normalize plan, denial, and user-input events.
- Implement approval continuation.
- Implement user-input continuation.
- Implement image passthrough.

### `apps/server/src/provider/Reactors/ProviderCommandReactor.ts`
- Route Claude approval responses through the Claude continuation flow.
- Route Claude user-input responses through the Claude continuation flow.

### `apps/server/src/provider/Layers/ProviderService.ts`
- Support additive Claude request metadata without altering Codex behavior.

### `apps/server/src/wsServer.ts`
- Continue exposing provider capabilities and any richer capability states to the client.

## Validation Matrix

Automated:
- `bun lint`
- `bun typecheck`
- Targeted `bun run test` suites for:
  - `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`
  - provider/orchestration integration tests covering approval and user input
  - web tests for provider/model/traits rendering

Live smoke validation:
- Claude model switch inside an existing thread
- Claude thinking/effort traits appear in the UI and are honored at runtime
- Claude plan mode turn through the T3 wrapper
- Claude denial -> T3 approval -> Claude continuation
- Claude user-input question -> T3 answer -> Claude continuation
- Claude image attachment -> Claude response referencing the image

## Definition of Done

- Claude is selectable in the provider picker and shows Claude-native model traits.
- Claude plan mode is clearly represented and correctly wired to the Claude runtime.
- Claude approvals and user-input requests are actionable through T3, whether native or emulated.
- Claude image input works through the T3 wrapper.
- Capability metadata accurately describes native vs emulated vs unsupported Claude features.
- Codex behavior remains unchanged.
