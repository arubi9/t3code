/** Pi CLI RPC adapter for the legacy provider runtime. */
import {
  EventId,
  RuntimeRequestId,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type PiSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ModelSelection,
  RuntimeItemId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { readMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import {
  buildPiRpcLaunch,
  discoverPiUserExtensions,
  materializePiT3McpExtension,
} from "./piT3McpInjection.ts";
import {
  piDialogMethod,
  piDialogQuestion,
  piDialogResponse,
  type PiDialogMethod,
} from "./piExtensionUi.ts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { makePiSubagents, type PiTaskEvent } from "./piSubagents.ts";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  makePiRpcConnection,
  withPiRegistrationDialogs,
  parsePiModelSlug,
  piRecordString,
  type PiRpcConnection,
  type PiRpcRecord,
} from "./PiRpc.ts";
import { PI_THINKING_LEVELS } from "./piThinkingCapabilities.ts";

const PROVIDER = ProviderDriverKind.make("pi");
/** Session registration can block on Pi extensions (trust/login); do not use normal RPC timeout. */
export const PI_THREAD_REGISTRATION_TIMEOUT_MS = 30 * 60_000;

interface PiSessionContext {
  readonly threadId: ThreadId;
  readonly pendingDialogs: Map<RuntimeRequestId, PiPendingDialog>;
  readonly connection: PiRpcConnection;
  session: ProviderSession;
  readonly eventPermit: Semaphore.Semaphore;
  readonly baselineModel: { provider: string; modelId: string } | undefined;
  readonly baselineThinking: string | undefined;
  appliedModel: string | undefined;
  appliedThinking: string | undefined;
  skillNames: ReadonlySet<string> | undefined;
  activeTurn: PiActiveTurn | undefined;
  stopped: boolean;
  eventFiber: Fiber.Fiber<void, never> | undefined;
  /** Projects pi-subagents tool calls into T3 task events for the subagent roster. */
  readonly subagents: ReturnType<typeof makePiSubagents>;
}

interface PiPendingDialog {
  readonly requestId: RuntimeRequestId;
  readonly nativeId: string;
  readonly method: PiDialogMethod;
  readonly turnId: TurnId | undefined;
  timeoutFiber?: Fiber.Fiber<void, never>;
}

interface PiActiveTurn {
  readonly id: TurnId;
  interrupted: boolean;
  sawAgentActivity: boolean;
  errorMessage: string | undefined;
  messageOrdinal: number;
  readonly streams: Map<string, string>;
  readonly tools: Map<string, { name: string; args: unknown }>;
}

export interface PiAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /** Test seam; production creates a fresh RPC child for each T3 thread. */
  readonly connectionFactory?: () => Effect.Effect<PiRpcConnection>;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const resumeSessionPath = (resumeCursor: unknown): string | undefined => {
  const value = record(resumeCursor);
  for (const key of ["sessionPath", "sessionFile", "sessionId"]) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
};

// T3 skill chips are $name; Pi only expands a leading /skill:name command.
// Only session-discovered skills qualify, not shell variables or arbitrary $words.
const expandSkillReference = (text: string, skillNames: ReadonlySet<string>): string => {
  for (const match of text.matchAll(/(^|\s)\$([^\s]+)(?=\s|$)/g)) {
    const name = match[2];
    if (!name || !skillNames.has(name)) continue;
    const start = match.index + (match[1]?.length ?? 0);
    const prompt = [text.slice(0, start).trimEnd(), text.slice(start + name.length + 1).trimStart()]
      .filter(Boolean)
      .join(" ");
    return `/skill:${name}${prompt ? ` ${prompt}` : ""}`;
  }
  return text;
};

const discoverSkillNames = (connection: PiRpcConnection) =>
  connection.request({ type: "get_commands" }).pipe(
    Effect.map((data) => {
      const commands = record(data)?.commands;
      const names = new Set<string>();
      if (!Array.isArray(commands)) return names;
      for (const command of commands) {
        if (piRecordString(command, "source") !== "skill") continue;
        const name = piRecordString(command, "name")?.replace(/^skill:/, "");
        const path =
          piRecordString(record(command)?.sourceInfo, "path") ?? piRecordString(command, "path");
        if (name && path) names.add(name);
      }
      return names;
    }),
  );

const toolOutputText = (result: unknown): string => {
  const content = record(result)?.content;
  return Array.isArray(content)
    ? content
        .filter((block) => piRecordString(block, "type") === "text")
        .map((block) => piRecordString(block, "text") ?? "")
        .join("\n")
    : "";
};

/**
 * Creates the v1 Pi adapter. Pi's `agent_settled` is deliberately the sole
 * normal turn terminal: `agent_end` only marks one low-level model run.
 */
export function makePiAdapter(
  piSettings: PiSettings,
  options?: PiAdapterOptions,
): Effect.Effect<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
>;
export function makePiAdapter(
  piSettings: PiSettings,
  options: PiAdapterOptions = {},
): Effect.Effect<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = options.connectionFactory
      ? undefined
      : yield* ChildProcessSpawner.ChildProcessSpawner;
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, PiSessionContext>();
    let eventSequence = 0;

    const stamp = () =>
      Effect.gen(function* () {
        const createdAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
        return { eventId: EventId.make(`pi-${eventSequence++}`), createdAt };
      });
    const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);
    const emitTasks = (context: PiSessionContext, updates: ReadonlyArray<PiTaskEvent>) =>
      Effect.forEach(
        updates,
        (update) =>
          Effect.flatMap(stamp(), (stamped) =>
            emit({ ...stamped, provider: PROVIDER, threadId: context.threadId, ...update }),
          ),
        { discard: true },
      );
    const requestError = (threadId: ThreadId, method: string, cause: unknown) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
    const requireSession = (threadId: ThreadId) => {
      const context = sessions.get(threadId);
      return context && !context.stopped
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const resolveDialog = (
      context: PiSessionContext,
      pending: PiPendingDialog,
      response: PiRpcRecord,
      decision?: ProviderApprovalDecision,
      answers?: ProviderUserInputAnswers,
    ) =>
      Effect.gen(function* () {
        context.pendingDialogs.delete(pending.requestId);
        if (pending.timeoutFiber) yield* Fiber.interrupt(pending.timeoutFiber);
        const base = {
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: context.threadId,
          requestId: pending.requestId,
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
        };
        yield* emit(
          pending.method === "confirm"
            ? {
                ...base,
                type: "request.resolved",
                payload: {
                  requestType: "command_execution_approval",
                  decision: decision ?? "cancel",
                  resolution: response,
                },
              }
            : { ...base, type: "user-input.resolved", payload: { answers: answers ?? {} } },
        );
      });

    const cancelDialogs = (context: PiSessionContext) =>
      Effect.gen(function* () {
        for (const pending of context.pendingDialogs.values()) {
          yield* Effect.ignore(
            context.connection.send({
              type: "extension_ui_response",
              id: pending.nativeId,
              cancelled: true,
            }),
          );
          yield* resolveDialog(context, pending, { cancelled: true });
        }
      });

    const openDialog = (context: PiSessionContext, event: PiRpcRecord) =>
      Effect.gen(function* () {
        const method = piDialogMethod(event);
        const nativeId = piRecordString(event, "id");
        if (!method || !nativeId?.trim()) return;
        // Native UUIDs are scoped to a Pi process, never to a T3 thread/restart.
        if (Array.from(context.pendingDialogs.values()).some((p) => p.nativeId === nativeId))
          return;
        const requestId = RuntimeRequestId.make(
          `pi-dialog-${yield* Random.next}-${eventSequence++}`,
        );
        const pending: PiPendingDialog = {
          requestId,
          nativeId,
          method,
          turnId: context.activeTurn?.id,
        };
        context.pendingDialogs.set(requestId, pending);
        const base = {
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: context.threadId,
          requestId,
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
        };
        yield* emit(
          method === "confirm"
            ? {
                ...base,
                type: "request.opened",
                payload: {
                  requestType: "command_execution_approval",
                  detail:
                    [piRecordString(event, "title"), piRecordString(event, "message")]
                      .filter(Boolean)
                      .join("\n")
                      .trim() || "Pi confirmation",
                  options: [
                    { decision: "accept", label: "Confirm" },
                    { decision: "decline", label: "Decline" },
                    { decision: "cancel", label: "Cancel" },
                  ],
                },
              }
            : {
                ...base,
                type: "user-input.requested",
                payload: { questions: [piDialogQuestion(nativeId, method, event)] },
              },
        );
        // Pi does not emit a dialog-close record when its timer expires.
        if (
          typeof event.timeout === "number" &&
          Number.isFinite(event.timeout) &&
          event.timeout > 0
        ) {
          pending.timeoutFiber = yield* Effect.sleep(event.timeout).pipe(
            Effect.andThen(
              Queue.offer(context.connection.events, { type: "t3.dialog_timeout", requestId }),
            ),
            Effect.ignore,
            Effect.forkIn(scope),
          );
        }
      });

    const completeTurn = (context: PiSessionContext) =>
      Effect.gen(function* () {
        const turn = context.activeTurn;
        yield* cancelDialogs(context);
        if (!turn) return;
        context.activeTurn = undefined;
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: yield* Effect.map(DateTime.now, DateTime.formatIso),
        };
        yield* emit({
          type: "turn.completed",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId: turn.id,
          payload: {
            state: turn.interrupted ? "interrupted" : turn.errorMessage ? "failed" : "completed",
            stopReason: turn.interrupted ? "aborted" : turn.errorMessage ? "error" : null,
            ...(!turn.interrupted && turn.errorMessage ? { errorMessage: turn.errorMessage } : {}),
          },
        });
      });

    const emitContent = (
      context: PiSessionContext,
      turn: PiActiveTurn,
      kind: "assistant_text" | "reasoning_text",
      contentIndex: number | undefined,
      text: string,
      snapshot: boolean,
      event: PiRpcRecord,
    ) =>
      Effect.gen(function* () {
        const itemId = `${turn.id}:m${turn.messageOrdinal}:${kind}:${contentIndex ?? 0}`;
        const previous = turn.streams.get(itemId) ?? "";
        // End snapshots are cumulative, not new deltas. A conflicting snapshot
        // cannot replace already-streamed v1 text; never append it as a duplicate.
        const delta = snapshot
          ? text.startsWith(previous)
            ? text.slice(previous.length)
            : ""
          : text;
        if (!delta) return;
        turn.streams.set(itemId, previous + delta);
        yield* emit({
          type: "content.delta",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId: turn.id,
          itemId: RuntimeItemId.make(itemId),
          payload: {
            streamKind: kind,
            delta,
            ...(contentIndex === undefined ? {} : { contentIndex }),
          },
          raw: { source: "acp.jsonrpc", method: String(event.type), payload: event },
        });
      });

    const handleEvent = (context: PiSessionContext, event: PiRpcRecord) =>
      Effect.gen(function* () {
        const turn = context.activeTurn;
        switch (event.type) {
          case "extension_ui_request":
            yield* openDialog(context, event);
            return;
          case "t3.dialog_timeout": {
            const pending = context.pendingDialogs.get(event.requestId as RuntimeRequestId);
            if (pending) {
              yield* Effect.ignore(
                context.connection.send({
                  type: "extension_ui_response",
                  id: pending.nativeId,
                  cancelled: true,
                }),
              );
              yield* resolveDialog(context, pending, { cancelled: true });
            }
            return;
          }
          case "agent_start":
            if (turn) turn.sawAgentActivity = true;
            return;
          case "message_start":
            // Background completions arrive as custom messages, often after the spawning turn.
            if (piRecordString(event.message, "customType") === "subagent-notification")
              yield* emitTasks(context, context.subagents.notification(event.message));
            if (turn && piRecordString(event.message, "role") === "assistant") {
              turn.sawAgentActivity = true;
              turn.messageOrdinal += 1;
            }
            return;
          case "message_update": {
            if (!turn) return;
            turn.sawAgentActivity = true;
            const delta = record(event.assistantMessageEvent);
            const type = delta?.type;
            if (
              type !== "text_delta" &&
              type !== "thinking_delta" &&
              type !== "text_end" &&
              type !== "thinking_end"
            )
              return;
            const snapshot = type === "text_end" || type === "thinking_end";
            yield* emitContent(
              context,
              turn,
              type === "thinking_delta" || type === "thinking_end"
                ? "reasoning_text"
                : "assistant_text",
              typeof delta?.contentIndex === "number" && Number.isInteger(delta.contentIndex)
                ? delta.contentIndex
                : undefined,
              (snapshot
                ? (piRecordString(delta, "content") ?? piRecordString(delta, "thinking"))
                : piRecordString(delta, "delta")) ?? "",
              snapshot,
              event,
            );
            return;
          }
          case "message_end": {
            if (!turn || piRecordString(event.message, "role") !== "assistant") return;
            turn.sawAgentActivity = true;
            const message = record(event.message);
            if (Array.isArray(message?.content)) {
              for (const [index, block] of message.content.entries()) {
                const type = piRecordString(block, "type");
                if (type !== "text" && type !== "thinking") continue;
                yield* emitContent(
                  context,
                  turn,
                  type === "thinking" ? "reasoning_text" : "assistant_text",
                  index,
                  piRecordString(block, type) ?? "",
                  true,
                  event,
                );
              }
            }
            if (message?.stopReason === "error") {
              turn.errorMessage =
                piRecordString(message, "errorMessage")?.trim() || "Pi reported a model error.";
            } else if (message?.stopReason === "aborted") {
              turn.interrupted = true;
            }
            return;
          }
          case "tool_execution_start":
          case "tool_execution_update":
          case "tool_execution_end": {
            if (!turn) return;
            turn.sawAgentActivity = true;
            const toolCallId = piRecordString(event, "toolCallId")?.trim();
            if (!toolCallId) return;
            const previous = turn.tools.get(toolCallId);
            const name = piRecordString(event, "toolName")?.trim() || previous?.name || "tool";
            const args = event.args ?? previous?.args;
            turn.tools.set(toolCallId, { name, args });
            const completed = event.type === "tool_execution_end";
            const result = completed ? event.result : event.partialResult;
            const output = toolOutputText(result);
            const command = piRecordString(args, "command");
            const exitCode = record(record(result)?.details)?.exitCode;
            yield* emit({
              type: completed
                ? "item.completed"
                : event.type === "tool_execution_start"
                  ? "item.started"
                  : "item.updated",
              ...(yield* stamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId: turn.id,
              itemId: RuntimeItemId.make(toolCallId),
              payload: {
                itemType:
                  name === "bash"
                    ? "command_execution"
                    : name === "edit" || name === "write"
                      ? "file_change"
                      : "dynamic_tool_call",
                status: completed
                  ? event.isError === true
                    ? "failed"
                    : "completed"
                  : "inProgress",
                title: name,
                ...(output.trim() ? { detail: output.trim() } : {}),
                data: {
                  tool: name,
                  ...(args === undefined ? {} : { input: args }),
                  ...(command === undefined ? {} : { command }),
                  ...(result === undefined ? {} : { result, output }),
                  ...(typeof exitCode === "number" && Number.isFinite(exitCode)
                    ? { exitCode }
                    : {}),
                },
              },
              raw: { source: "acp.jsonrpc", method: String(event.type), payload: event },
            });
            yield* emitTasks(
              context,
              context.subagents.tool({
                turnId: turn.id,
                toolCallId,
                toolName: name,
                args,
                result,
                completed,
                failed: event.isError === true,
                interrupted: turn.interrupted,
              }),
            );
            return;
          }
          case "auto_retry_end":
            if (turn) {
              turn.sawAgentActivity = true;
              turn.errorMessage =
                event.success === true
                  ? undefined
                  : piRecordString(event, "finalError")?.trim() || "Pi auto-retry failed.";
            }
            return;
          case "compaction_end":
            // A successful overflow recovery supersedes the model error that
            // triggered it. A cancelled/failed compaction must not clear it.
            if (turn && event.result != null && event.aborted !== true)
              turn.errorMessage = undefined;
            return;
          case "agent_settled":
            yield* completeTurn(context);
            return;
          case "response":
            // Only uncorrelated prompt/parse rejections belong to this turn.
            // A rejected steer does not stop the model run it was aimed at.
            if (!turn || event.id !== undefined) return;
            if (
              event.success === false &&
              (event.command === "prompt" || event.command === "parse")
            ) {
              turn.errorMessage =
                piRecordString(event, "error")?.trim() || "Pi rejected the prompt.";
              yield* completeTurn(context);
            } else if (
              event.success === true &&
              event.command === "prompt" &&
              !turn.sawAgentActivity
            ) {
              // Queue the idle probe behind events received before get_state's
              // response, so an early ack cannot terminalize a starting agent.
              yield* context.connection.request({ type: "get_state" }).pipe(
                Effect.matchEffect({
                  onSuccess: (data) =>
                    Queue.offer(context.connection.events, {
                      type: "t3.settle_probe",
                      turnId: turn.id,
                      data,
                    }),
                  onFailure: () =>
                    Queue.offer(context.connection.events, {
                      type: "t3.settle_probe",
                      turnId: turn.id,
                      probeFailed: true,
                    }),
                }),
                Effect.ignore,
                Effect.forkIn(scope),
              );
            }
            return;
          case "t3.settle_probe": {
            const data = record(event.data);
            if (
              turn &&
              event.turnId === turn.id &&
              !turn.sawAgentActivity &&
              (event.probeFailed === true ||
                (data?.isStreaming !== true && (data?.pendingMessageCount ?? 0) === 0))
            ) {
              yield* completeTurn(context);
            }
            return;
          }
          // agent_end is intentionally non-terminal. Pi may compact/retry or
          // continue queued work before it emits agent_settled.
          default:
            return;
        }
      });

    const stopContext = (context: PiSessionContext) =>
      Effect.gen(function* () {
        if (context.stopped) return;
        context.stopped = true;
        if (context.eventFiber) yield* Fiber.interrupt(context.eventFiber);
        yield* cancelDialogs(context);
        yield* emitTasks(context, context.subagents.stop());
        yield* Effect.ignore(context.connection.terminate);
        sessions.delete(context.threadId);
        yield* emit({
          type: "session.exited",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: context.threadId,
          payload: { exitKind: "graceful" },
        });
      }).pipe(context.eventPermit.withPermits(1));

    const failContext = (context: PiSessionContext, error: unknown) =>
      Effect.gen(function* () {
        if (context.stopped) return;
        context.stopped = true;
        yield* cancelDialogs(context);
        if (context.activeTurn) {
          context.activeTurn.errorMessage =
            error instanceof Error ? error.message : "Pi RPC process exited.";
          yield* completeTurn(context);
        }
        yield* emitTasks(context, context.subagents.stop());
        yield* Effect.ignore(context.connection.terminate);
        sessions.delete(context.threadId);
        yield* emit({
          type: "session.exited",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: context.threadId,
          payload: {
            exitKind: "error",
            reason: error instanceof Error ? error.message : "Pi RPC process exited.",
          },
        });
      });

    const applySelection = (
      context: PiSessionContext,
      selection: ModelSelection | undefined,
      operation: "startSession" | "sendTurn",
    ) =>
      Effect.gen(function* () {
        if (!selection) return;
        const selected = selection.model;
        if (
          (selected === "default" && context.appliedModel !== undefined) ||
          (selected !== "default" && selected !== context.appliedModel)
        ) {
          const model = selected === "default" ? context.baselineModel : parsePiModelSlug(selected);
          if (!model) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation,
              issue:
                selected === "default"
                  ? "Pi did not provide a default model to restore."
                  : "Pi models must use provider/model format.",
            });
          }
          yield* context.connection
            .request({ type: "set_model", ...model })
            .pipe(Effect.mapError((cause) => requestError(context.threadId, "set_model", cause)));
          context.appliedModel = selected === "default" ? undefined : selected;
          context.session = { ...context.session, model: selected };
          // Pi may clamp thinking when models change. Invalidate even if the
          // following thinking request fails, so the next turn retries it.
          context.appliedThinking = undefined;
        }
        const thinking = getModelSelectionStringOptionValue(selection, "thinking");
        const level = thinking === "inherit" ? context.baselineThinking : thinking;
        // set_model can clamp Pi's thinking level. Reapply even an unchanged
        // choice after a model change; otherwise switching back keeps the clamp.
        if (
          level !== undefined &&
          PI_THINKING_LEVELS.some((value) => value === level) &&
          level !== context.appliedThinking
        ) {
          yield* context.connection
            .request({ type: "set_thinking_level", level })
            .pipe(
              Effect.mapError((cause) =>
                requestError(context.threadId, "set_thinking_level", cause),
              ),
            );
          context.appliedThinking = level;
        }
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required.",
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing) yield* stopContext(existing);
        const connection = options.connectionFactory
          ? yield* options.connectionFactory()
          : yield* Effect.gen(function* () {
              const environment = options.environment ?? process.env;
              const mcpSession = readMcpProviderSession(input.threadId);
              const extensionPath =
                mcpSession === undefined
                  ? undefined
                  : yield* Effect.gen(function* () {
                      // Private per-process source directory: never execute a shared,
                      // replaceable cache file with this thread's MCP credential.
                      const dir = yield* fileSystem.makeTempDirectoryScoped({
                        prefix: "t3-pi-mcp-",
                      });
                      return yield* materializePiT3McpExtension(dir);
                    });
              const discoveredExtensionPaths = yield* discoverPiUserExtensions({
                environment,
                cwd: input.cwd,
              });
              const launch = buildPiRpcLaunch({
                launchArgs: piSettings.launchArgs,
                environment,
                mcpSession,
                extensionPath,
                discoveredExtensionPaths,
              });
              return yield* makePiRpcConnection({
                command: piSettings.binaryPath || "pi",
                args: launch.args,
                cwd: input.cwd,
                env: launch.env,
                hasT3Mcp: launch.hasT3Mcp,
              });
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner!),
              Effect.provideService(Scope.Scope, scope),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
        const { context, state, nativeSession } = yield* withPiRegistrationDialogs(
          connection,
          Effect.gen(function* () {
            const resumePath = resumeSessionPath(input.resumeCursor);
            if (resumePath) {
              const switched = yield* connection
                .request(
                  { type: "switch_session", sessionPath: resumePath },
                  PI_THREAD_REGISTRATION_TIMEOUT_MS,
                )
                .pipe(
                  Effect.mapError((cause) => requestError(input.threadId, "switch_session", cause)),
                  Effect.onError(() => Effect.ignore(connection.terminate)),
                );
              if (record(switched)?.cancelled === true) {
                yield* Effect.ignore(connection.terminate);
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "switch_session",
                  detail: "Pi cancelled the session switch.",
                });
              }
            }
            const state = yield* connection
              .request({ type: "get_state" }, PI_THREAD_REGISTRATION_TIMEOUT_MS)
              .pipe(
                Effect.mapError((cause) => requestError(input.threadId, "get_state", cause)),
                Effect.onError(() => Effect.ignore(connection.terminate)),
              );
            const nativeSession =
              piRecordString(state, "sessionFile") ?? piRecordString(state, "sessionId");
            if (!nativeSession) {
              yield* Effect.ignore(connection.terminate);
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "get_state",
                detail: "Pi returned neither sessionFile nor sessionId.",
              });
            }
            const nativeModel = record(record(state)?.model);
            const provider = piRecordString(nativeModel, "provider");
            const modelId = piRecordString(nativeModel, "id");
            const skillNames = yield* discoverSkillNames(connection).pipe(
              Effect.orElseSucceed(() => undefined),
            );
            const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
            const context: PiSessionContext = {
              threadId: input.threadId,
              connection,
              pendingDialogs: new Map(),
              eventPermit: yield* Semaphore.make(1),
              // No T3 child-session projection here; the set only tracks live transcript paths.
              subagents: makePiSubagents(new Set()),
              baselineModel: provider && modelId ? { provider, modelId } : undefined,
              baselineThinking: piRecordString(state, "thinkingLevel"),
              appliedModel: undefined,
              appliedThinking: piRecordString(state, "thinkingLevel"),
              skillNames,
              session: {
                provider: PROVIDER,
                status: "ready",
                runtimeMode: input.runtimeMode,
                cwd: input.cwd,
                model: input.modelSelection?.model,
                threadId: input.threadId,
                resumeCursor: { sessionPath: nativeSession },
                createdAt: now,
                updatedAt: now,
              },
              activeTurn: undefined,
              stopped: false,
              eventFiber: undefined,
            };
            yield* applySelection(context, input.modelSelection, "startSession").pipe(
              Effect.onError(() => Effect.ignore(connection.terminate)),
            );
            return { context, state, nativeSession };
          }),
        ).pipe(
          Effect.onExit((exit) =>
            exit._tag === "Success" ? Effect.void : Effect.ignore(connection.terminate),
          ),
        );
        sessions.set(input.threadId, context);
        context.eventFiber = yield* Effect.forever(
          Queue.take(connection.events).pipe(
            Effect.flatMap((event) =>
              handleEvent(context, event).pipe(context.eventPermit.withPermits(1)),
            ),
          ),
        ).pipe(
          Effect.catch((error) =>
            failContext(context, error).pipe(context.eventPermit.withPermits(1)),
          ),
          Effect.forkIn(scope),
        );
        yield* connection.exited.pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              failContext(context, error).pipe(context.eventPermit.withPermits(1)),
            onSuccess: () =>
              failContext(context, new Error("Pi RPC process exited.")).pipe(
                context.eventPermit.withPermits(1),
              ),
          }),
          Effect.forkIn(scope),
        );
        yield* emit({
          type: "session.started",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { resume: state },
        });
        yield* emit({
          type: "thread.started",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: nativeSession },
        });
        return context.session;
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.flatMap(requireSession(input.threadId), (context) =>
        Effect.gen(function* () {
          let text = input.input?.trim();
          if (!text)
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Pi requires non-empty text input.",
            });
          if (context.skillNames === undefined && text.includes("$")) {
            // Retry a failed startup lookup once at first skill use.
            context.skillNames = yield* discoverSkillNames(context.connection).pipe(
              Effect.orElseSucceed(() => new Set<string>()),
            );
          }
          if (context.skillNames) text = expandSkillReference(text, context.skillNames);
          if (context.activeTurn) {
            yield* context.connection
              .send({ type: "steer", message: text })
              .pipe(Effect.mapError((cause) => requestError(input.threadId, "steer", cause)));
            return {
              threadId: input.threadId,
              turnId: context.activeTurn.id,
              resumeCursor: context.session.resumeCursor,
            };
          }
          yield* applySelection(context, input.modelSelection, "sendTurn");
          const turnId = TurnId.make(`pi-${eventSequence++}`);
          context.activeTurn = {
            id: turnId,
            interrupted: false,
            sawAgentActivity: false,
            errorMessage: undefined,
            messageOrdinal: 0,
            streams: new Map(),
            tools: new Map(),
          };
          yield* context.connection.send({ type: "prompt", message: text }).pipe(
            Effect.mapError((cause) => requestError(input.threadId, "prompt", cause)),
            Effect.tapError(() =>
              Effect.sync(() => {
                context.activeTurn = undefined;
              }),
            ),
          );
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* Effect.map(DateTime.now, DateTime.formatIso),
          };
          yield* emit({
            type: "turn.started",
            ...(yield* stamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: {},
          });
          return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
        }).pipe(context.eventPermit.withPermits(1)),
      );

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
      turnId,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const shouldAbort = yield* Effect.gen(function* () {
          if (turnId !== undefined && context.activeTurn?.id !== turnId) return false;
          yield* cancelDialogs(context);
          if (!context.activeTurn) return false;
          context.activeTurn.interrupted = true;
          return true;
        }).pipe(context.eventPermit.withPermits(1));
        if (!shouldAbort) return;
        yield* context.connection
          .request({ type: "abort" })
          .pipe(Effect.mapError((cause) => requestError(threadId, "abort", cause)));
      });

    const respondToDialog = (
      threadId: ThreadId,
      requestId: string,
      kind: "confirm" | "input",
      decision?: ProviderApprovalDecision,
      answers?: ProviderUserInputAnswers,
    ) =>
      Effect.flatMap(requireSession(threadId), (context) =>
        Effect.gen(function* () {
          const pending = context.pendingDialogs.get(RuntimeRequestId.make(requestId));
          if (
            context.stopped ||
            !pending ||
            (pending.method === "confirm") !== (kind === "confirm")
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: kind === "confirm" ? "respondToRequest" : "respondToUserInput",
              issue: "No matching pending Pi dialog in this session.",
            });
          }
          const response = piDialogResponse(pending.method, pending.nativeId, decision, answers);
          yield* context.connection
            .send({ type: "extension_ui_response", id: pending.nativeId, ...response })
            .pipe(
              Effect.mapError((cause) => requestError(threadId, "extension_ui_response", cause)),
            );
          // Keep failed sends retryable; serialize the receipt before Pi settles.
          yield* resolveDialog(context, pending, response, decision, answers);
        }).pipe(context.eventPermit.withPermits(1)),
      );

    yield* Scope.addFinalizer(
      scope,
      Effect.forEach(sessions.values(), stopContext, { discard: true }),
    );
    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: (threadId, requestId, decision) =>
        respondToDialog(threadId, requestId, "confirm", decision),
      respondToUserInput: (threadId, requestId, answers) =>
        respondToDialog(threadId, requestId, "input", undefined, answers),
      readThread: (threadId) =>
        Effect.flatMap(requireSession(threadId), () =>
          Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "readThread",
              issue: "Pi does not expose native turn history through the v1 adapter.",
            }),
          ),
        ),
      rollbackThread: (threadId) =>
        Effect.flatMap(requireSession(threadId), () =>
          Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "Pi rollback is not supported by the v1 adapter.",
            }),
          ),
        ),
      stopSession: (threadId) => Effect.flatMap(requireSession(threadId), stopContext),
      listSessions: () =>
        Effect.sync(() => Array.from(sessions.values(), (context) => context.session)),
      hasSession: (threadId) =>
        Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped),
      stopAll: () => Effect.forEach(sessions.values(), stopContext, { discard: true }),
      streamEvents: Stream.fromPubSub(events),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
