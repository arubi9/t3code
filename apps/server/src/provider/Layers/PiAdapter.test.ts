import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { PiRpcError, type PiRpcConnection, type PiRpcRecord } from "./PiRpc.ts";
import { makePiAdapter, PI_THREAD_REGISTRATION_TIMEOUT_MS } from "./PiAdapter.ts";

const PI = ProviderDriverKind.make("pi");
const threadId = ThreadId.make("pi-test-thread");

const makeFakeRpc = () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<PiRpcRecord, PiRpcError>();
    const exited = yield* Deferred.make<number, PiRpcError>();
    const requests: Array<Record<string, unknown>> = [];
    const requestTimeouts: Array<number | undefined> = [];
    const connection: PiRpcConnection = {
      events,
      send: (record) => Effect.sync(() => void requests.push(record)),
      request: (record, timeoutMs) =>
        Effect.sync(() => {
          requests.push(record);
          requestTimeouts.push(timeoutMs);
          if (record.type === "get_state") return { sessionFile: "/tmp/pi-session.jsonl" };
          return {};
        }),
      terminate: Effect.void,
      exited: Deferred.await(exited),
    };
    return { connection, events, exited, requests, requestTimeouts };
  });

it.effect("Pi streams assistant text and only settles a turn at agent_settled", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeRpc();
    const adapter = yield* makePiAdapter(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      { connectionFactory: () => Effect.succeed(fake.connection) },
    );
    yield* adapter.startSession({
      threadId,
      provider: PI,
      cwd: "/tmp",
      runtimeMode: "full-access",
    });

    const turn = yield* adapter.sendTurn({ threadId, input: "hello" });
    const received = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Queue.offer(fake.events, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
    });
    yield* Queue.offer(fake.events, { type: "agent_end" });
    yield* Queue.offer(fake.events, { type: "agent_settled" });

    const events = yield* Fiber.join(received);
    assert.deepStrictEqual(
      Array.from(events, (event) => event.type),
      ["content.delta", "turn.completed"],
    );
    const completed = events.find((event) => event.type === "turn.completed");
    assert.strictEqual(completed?.turnId, turn.turnId);
    assert.strictEqual(completed?.payload.state, "completed");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi settles a command-only prompt after its idle acknowledgement", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeRpc();
    const adapter = yield* makePiAdapter(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      { connectionFactory: () => Effect.succeed(fake.connection) },
    );
    yield* adapter.startSession({
      threadId,
      provider: PI,
      cwd: "/tmp",
      runtimeMode: "full-access",
    });
    const turn = yield* adapter.sendTurn({ threadId, input: "/command" });
    const completed = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 1)).pipe(
      Effect.forkChild({ startImmediately: true }),
    );

    yield* Queue.offer(fake.events, { type: "response", command: "prompt", success: true });

    const [event] = yield* Fiber.join(completed);
    assert.strictEqual(event?.type, "turn.completed");
    assert.strictEqual(event?.turnId, turn.turnId);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi interrupts an active turn and removes the session on transport failure", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeRpc();
    const adapter = yield* makePiAdapter(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      { connectionFactory: () => Effect.succeed(fake.connection) },
    );
    yield* adapter.startSession({
      threadId,
      provider: PI,
      cwd: "/tmp",
      runtimeMode: "full-access",
    });
    yield* adapter.sendTurn({ threadId, input: "hello" });
    yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
    yield* Deferred.fail(fake.exited, new PiRpcError({ operation: "stdout", detail: "closed" }));
    yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

    assert.isFalse(yield* adapter.hasSession(threadId));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi applies a selected supported thinking level", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeRpc();
    const adapter = yield* makePiAdapter(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      { connectionFactory: () => Effect.succeed(fake.connection) },
    );

    yield* adapter.startSession({
      threadId,
      provider: PI,
      cwd: "/tmp",
      runtimeMode: "full-access",
      modelSelection: {
        instanceId: ProviderInstanceId.make("pi"),
        model: "anthropic/claude-sonnet-5",
        options: [{ id: "thinking", value: "high" }],
      },
    });

    assert.deepStrictEqual(fake.requests.slice(-2), [
      { type: "set_model", provider: "anthropic", modelId: "claude-sonnet-5" },
      { type: "set_thinking_level", level: "high" },
    ]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi keeps session registration open past the ordinary RPC timeout", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeRpc();
    const request = fake.connection.request;
    const adapter = yield* makePiAdapter(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      {
        connectionFactory: () =>
          Effect.succeed({
            ...fake.connection,
            request: (record, timeoutMs) =>
              record.type === "switch_session"
                ? Effect.sleep("16 minutes").pipe(Effect.as({}))
                : request(record, timeoutMs),
          }),
      },
    );
    const registration = yield* adapter
      .startSession({
        threadId,
        provider: PI,
        cwd: "/tmp",
        runtimeMode: "full-access",
        resumeCursor: { sessionPath: "/tmp/existing.jsonl" },
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("16 minutes");
    yield* Fiber.join(registration);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi refuses a cancelled session switch", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeRpc();
    const adapter = yield* makePiAdapter(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      {
        connectionFactory: () =>
          Effect.succeed({
            ...fake.connection,
            request: (record, timeoutMs) =>
              record.type === "switch_session"
                ? Effect.succeed({ cancelled: true })
                : fake.connection.request(record, timeoutMs),
          }),
      },
    );

    const error = yield* Effect.flip(
      adapter.startSession({
        threadId,
        provider: PI,
        cwd: "/tmp",
        runtimeMode: "full-access",
        resumeCursor: { sessionPath: "/tmp/existing.jsonl" },
      }),
    );
    assert.strictEqual(error._tag, "ProviderAdapterRequestError");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi rejects unsupported native history and rollback", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeRpc();
    const adapter = yield* makePiAdapter(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      { connectionFactory: () => Effect.succeed(fake.connection) },
    );
    yield* adapter.startSession({
      threadId,
      provider: PI,
      cwd: "/tmp",
      runtimeMode: "full-access",
    });

    const readError = yield* Effect.flip(adapter.readThread(threadId));
    const rollbackError = yield* Effect.flip(adapter.rollbackThread(threadId, 1));

    assert.strictEqual(readError._tag, "ProviderAdapterValidationError");
    assert.strictEqual(rollbackError._tag, "ProviderAdapterValidationError");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi resumes through switch_session and aborts without terminalizing before settle", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeRpc();
    const adapter = yield* makePiAdapter(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      { connectionFactory: () => Effect.succeed(fake.connection) },
    );
    yield* adapter.startSession({
      threadId,
      provider: PI,
      cwd: "/tmp",
      runtimeMode: "full-access",
      resumeCursor: { sessionPath: "/tmp/existing.jsonl" },
    });
    const turn = yield* adapter.sendTurn({ threadId, input: "stop" });
    yield* adapter.interruptTurn(threadId, turn.turnId);
    yield* Queue.offer(fake.events, { type: "agent_end" });
    yield* Queue.offer(fake.events, { type: "agent_settled" });

    assert.deepStrictEqual(fake.requests[0], {
      type: "switch_session",
      sessionPath: "/tmp/existing.jsonl",
    });
    assert.deepStrictEqual(fake.requestTimeouts.slice(0, 2), [
      PI_THREAD_REGISTRATION_TIMEOUT_MS,
      PI_THREAD_REGISTRATION_TIMEOUT_MS,
    ]);
    assert.isTrue(fake.requests.some((request) => request.type === "abort"));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
