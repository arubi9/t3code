/** Pi CLI RPC adapter for the legacy provider runtime. */
import {
  EventId,
  type PiSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

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
  readonly connection: PiRpcConnection;
  session: ProviderSession;
  activeTurn: { readonly id: TurnId; interrupted: boolean; sawAgentActivity: boolean } | undefined;
  stopped: boolean;
  eventFiber: Fiber.Fiber<void, never> | undefined;
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
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
>;
export function makePiAdapter(
  piSettings: PiSettings,
  options: PiAdapterOptions = {},
): Effect.Effect<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
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

    const completeTurn = (context: PiSessionContext) =>
      Effect.gen(function* () {
        const turn = context.activeTurn;
        if (!turn) return;
        context.activeTurn = undefined;
        context.session = {
          ...context.session,
          status: "ready",
          updatedAt: yield* Effect.map(DateTime.now, DateTime.formatIso),
        };
        yield* emit({
          type: "turn.completed",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId: turn.id,
          payload: { state: turn.interrupted ? "interrupted" : "completed", stopReason: null },
        });
      });

    const handleEvent = (context: PiSessionContext, event: PiRpcRecord) =>
      Effect.gen(function* () {
        const turn = context.activeTurn;
        switch (event.type) {
          case "agent_start":
          case "message_start":
            if (turn) turn.sawAgentActivity = true;
            return;
          case "message_update": {
            if (!turn) return;
            turn.sawAgentActivity = true;
            const delta = record(event.assistantMessageEvent);
            if (delta?.type !== "text_delta") return;
            const text = piRecordString(delta, "delta") ?? "";
            if (!text) return;
            yield* emit({
              type: "content.delta",
              ...(yield* stamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId: turn.id,
              payload: {
                streamKind: "assistant_text",
                delta: text,
                ...(typeof delta.contentIndex === "number"
                  ? { contentIndex: delta.contentIndex }
                  : {}),
              },
              raw: { source: "acp.jsonrpc", method: "message_update", payload: event },
            });
            return;
          }
          case "agent_settled":
            yield* completeTurn(context);
            return;
          case "response":
            // Pi sends an id-less ack for fire-and-forget prompts. A command
            // that did not start an agent has no `agent_settled` event.
            if (
              event.success === true &&
              event.command === "prompt" &&
              turn &&
              !turn.sawAgentActivity
            ) {
              yield* completeTurn(context);
            }
            return;
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
        yield* Effect.ignore(context.connection.terminate);
        sessions.delete(context.threadId);
        yield* emit({
          type: "session.exited",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: context.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const failContext = (context: PiSessionContext, error: unknown) =>
      Effect.gen(function* () {
        if (context.stopped) return;
        context.stopped = true;
        if (context.activeTurn) {
          context.activeTurn.interrupted = true;
          yield* completeTurn(context);
        }
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
          : yield* makePiRpcConnection({
              command: piSettings.binaryPath || "pi",
              args: ["--mode", "rpc", "--no-extensions", ...tokenizeCliArgs(piSettings.launchArgs)],
              cwd: input.cwd,
              env: options.environment ?? process.env,
            }).pipe(
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
        const selectedModel = input.modelSelection?.model;
        if (selectedModel && selectedModel !== "default") {
          const parsedModel = parsePiModelSlug(selectedModel);
          if (!parsedModel) {
            yield* Effect.ignore(connection.terminate);
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Pi models must use provider/model format.",
            });
          }
          yield* connection
            .request({
              type: "set_model",
              provider: parsedModel.provider,
              modelId: parsedModel.modelId,
            })
            .pipe(
              Effect.mapError((cause) => requestError(input.threadId, "set_model", cause)),
              Effect.onError(() => Effect.ignore(connection.terminate)),
            );
        }
        const thinking = getModelSelectionStringOptionValue(input.modelSelection, "thinking");
        if (thinking !== "inherit" && PI_THINKING_LEVELS.some((level) => level === thinking)) {
          yield* connection.request({ type: "set_thinking_level", level: thinking }).pipe(
            Effect.mapError((cause) => requestError(input.threadId, "set_thinking_level", cause)),
            Effect.onError(() => Effect.ignore(connection.terminate)),
          );
        }
        const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
        const context: PiSessionContext = {
          threadId: input.threadId,
          connection,
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
        sessions.set(input.threadId, context);
        context.eventFiber = yield* Effect.forever(
          Queue.take(connection.events).pipe(
            Effect.flatMap((event) => handleEvent(context, event)),
          ),
        ).pipe(
          Effect.catch(() => Effect.void),
          Effect.forkIn(scope),
        );
        yield* connection.exited.pipe(
          Effect.matchEffect({
            onFailure: (error) => failContext(context, error),
            onSuccess: () => failContext(context, new Error("Pi RPC process exited.")),
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
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const text = input.input?.trim();
        if (!text)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi requires non-empty text input.",
          });
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
        const selectedModel = input.modelSelection?.model;
        if (
          selectedModel &&
          selectedModel !== "default" &&
          selectedModel !== context.session.model
        ) {
          const parsedModel = parsePiModelSlug(selectedModel);
          if (!parsedModel) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Pi models must use provider/model format.",
            });
          }
          yield* context.connection
            .request({
              type: "set_model",
              provider: parsedModel.provider,
              modelId: parsedModel.modelId,
            })
            .pipe(Effect.mapError((cause) => requestError(input.threadId, "set_model", cause)));
          context.session = { ...context.session, model: selectedModel };
        }
        const turnId = TurnId.make(`pi-${eventSequence++}`);
        context.activeTurn = { id: turnId, interrupted: false, sawAgentActivity: false };
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
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
      turnId,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (!context.activeTurn || (turnId !== undefined && context.activeTurn.id !== turnId))
          return;
        context.activeTurn.interrupted = true;
        yield* context.connection
          .request({ type: "abort" })
          .pipe(Effect.mapError((cause) => requestError(threadId, "abort", cause)));
      });

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
      respondToRequest: () =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToRequest",
            issue: "Pi has no v1 approval requests.",
          }),
        ),
      respondToUserInput: () =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: "Pi has no v1 user-input requests.",
          }),
        ),
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
