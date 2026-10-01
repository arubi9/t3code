import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  RuntimeItemId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { PiRpcError, type PiRpcConnection, type PiRpcRecord } from "./PiRpc.ts";
import { makePiAdapter, PI_THREAD_REGISTRATION_TIMEOUT_MS } from "./PiAdapter.ts";

const PI = ProviderDriverKind.make("pi");
const threadId = ThreadId.make("pi-test-thread");
const decodeRuntimeEvent = Schema.decodeUnknownEffect(ProviderRuntimeEvent);

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
          if (record.type === "get_state")
            return {
              sessionFile: "/tmp/pi-session.jsonl",
              model: { provider: "openai", id: "baseline" },
              thinkingLevel: "medium",
            };
          if (record.type === "get_commands")
            return {
              commands: [{ name: "skill:fixture", source: "skill", path: "/tmp/fixture/SKILL.md" }],
            };
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

it.effect("Pi fails an active turn and removes the session on transport failure", () =>
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
    const collector = yield* adapter.streamEvents.pipe(
      Stream.takeUntil((event) => event.type === "session.exited"),
      Stream.runCollect,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.fail(fake.exited, new PiRpcError({ operation: "stdout", detail: "closed" }));
    const events = yield* Fiber.join(collector);
    assert.strictEqual(
      events.find((event) => event.type === "turn.completed")?.payload.state,
      "failed",
    );
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

const setup = () =>
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
    return { fake, adapter };
  });

// Completion is an event-pump receipt, not a sleep or a count of unrelated events.
const collectThroughSettlement = (adapter: Effect.Success<ReturnType<typeof makePiAdapter>>) =>
  adapter.streamEvents.pipe(
    Stream.takeUntil((event) => event.type === "turn.completed"),
    Stream.runCollect,
    Effect.forkChild({ startImmediately: true }),
  );

const runEvents = (nativeEvents: PiRpcRecord[]) =>
  Effect.gen(function* () {
    const { fake, adapter } = yield* setup();
    yield* adapter.sendTurn({ threadId, input: "fixture" });
    const collector = yield* collectThroughSettlement(adapter);
    for (const event of nativeEvents) yield* Queue.offer(fake.events, event);
    yield* Queue.offer(fake.events, { type: "agent_settled" });
    const events = Array.from(yield* Fiber.join(collector));
    for (const event of events) yield* decodeRuntimeEvent(event);
    return events;
  });

it.effect("Pi retains reasoning deltas separately from assistant text", () =>
  Effect.gen(function* () {
    const events = yield* runEvents([
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "Reasoning fixture",
        },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Answer" },
      },
    ]);
    assert.deepStrictEqual(
      events.filter((event) => event.type === "content.delta").map((event) => event.payload),
      [
        { streamKind: "reasoning_text", delta: "Reasoning fixture", contentIndex: 0 },
        { streamKind: "assistant_text", delta: "Answer", contentIndex: 1 },
      ],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi retains tool identity, arguments, partial output and final error status", () =>
  Effect.gen(function* () {
    const args = { command: "echo fixture" };
    const partialResult = { content: [{ type: "text", text: "fix" }] };
    const result = { content: [{ type: "text", text: "fixture" }], details: { exitCode: 1 } };
    const events = yield* runEvents([
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args },
      { type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", partialResult },
      { type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result, isError: true },
    ]);
    const tools = events.filter((event) => event.type.startsWith("item."));
    assert.deepStrictEqual(
      tools.map((event) => [event.type, event.itemId]),
      [
        ["item.started", RuntimeItemId.make("call-1")],
        ["item.updated", RuntimeItemId.make("call-1")],
        ["item.completed", RuntimeItemId.make("call-1")],
      ],
    );
    const completed = events.find((event) => event.type === "item.completed");
    assert.strictEqual(completed?.payload.itemType, "command_execution");
    assert.strictEqual(completed?.payload.status, "failed");
    assert.strictEqual(completed?.payload.detail, "fixture");
    assert.containsSubset(completed?.payload.data, {
      input: args,
      command: args.command,
      result,
      exitCode: 1,
    });
    assert.strictEqual(
      events.find((event) => event.type === "item.updated")?.payload.detail,
      "fix",
    );
    // Tool errors alone are model-visible results, not terminal provider errors.
    assert.strictEqual(
      events.find((event) => event.type === "turn.completed")?.payload.state,
      "completed",
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi projects pi-subagents Agent calls and notifications into roster task events", () =>
  Effect.gen(function* () {
    const events = yield* runEvents([
      {
        type: "tool_execution_end",
        toolCallId: "spawn-1",
        toolName: "Agent",
        args: { prompt: "audit", description: "Audit repo" },
        result: { content: [], details: { agentId: "a", status: "background" } },
        isError: false,
      },
      {
        type: "message_start",
        message: {
          role: "custom",
          customType: "subagent-notification",
          details: { id: "a", status: "completed", resultPreview: "done" },
        },
      },
    ]);
    const tasks = events.filter(
      (event) =>
        event.type === "task.started" ||
        event.type === "task.progress" ||
        event.type === "task.completed",
    );
    assert.deepStrictEqual(
      tasks.map((event) => [event.type, event.payload.taskId]),
      [
        ["task.started", "pi-subagents:a"],
        ["task.progress", "pi-subagents:a"],
        ["task.completed", "pi-subagents:a"],
      ],
    );
    assert.containsSubset(tasks.at(-1)?.payload, { status: "completed", summary: "done" });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi reports exhausted model retries as failed with the final error", () =>
  Effect.gen(function* () {
    const events = yield* runEvents([
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "Fixture failure" },
      },
      { type: "auto_retry_end", success: false, finalError: "Fixture retry exhausted" },
    ]);
    const completed = events.find((event) => event.type === "turn.completed");
    assert.strictEqual(completed?.payload.state, "failed");
    assert.strictEqual(completed?.payload.errorMessage, "Fixture retry exhausted");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi restores the captured default model after an explicit selection", () =>
  Effect.gen(function* () {
    const { fake, adapter } = yield* setup();
    yield* adapter.sendTurn({
      threadId,
      input: "first",
      modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "anthropic/explicit" },
    });
    const collector = yield* collectThroughSettlement(adapter);
    yield* Queue.offer(fake.events, { type: "agent_settled" });
    yield* Fiber.join(collector);
    yield* adapter.sendTurn({
      threadId,
      input: "second",
      modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "default" },
    });
    assert.deepStrictEqual(
      fake.requests.findLast((request) => request.type === "set_model"),
      {
        type: "set_model",
        provider: "openai",
        modelId: "baseline",
      },
    );
    assert.strictEqual((yield* adapter.listSessions())[0]?.model, "default");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi applies per-turn thinking then restores inherited thinking", () =>
  Effect.gen(function* () {
    const { fake, adapter } = yield* setup();
    for (const thinking of ["low", "inherit"]) {
      yield* adapter.sendTurn({
        threadId,
        input: "fixture",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/explicit",
          options: [{ id: "thinking", value: thinking }],
        },
      });
      const collector = yield* collectThroughSettlement(adapter);
      yield* Queue.offer(fake.events, { type: "agent_settled" });
      yield* Fiber.join(collector);
    }
    assert.deepStrictEqual(
      fake.requests.filter((request) => request.type === "set_thinking_level"),
      [
        { type: "set_thinking_level", level: "low" },
        { type: "set_thinking_level", level: "medium" },
      ],
    );
    assert.strictEqual(fake.requests.filter((request) => request.type === "set_model").length, 1);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi expands known skill chips into a leading native skill command", () =>
  Effect.gen(function* () {
    const { fake, adapter } = yield* setup();
    for (const input of [
      "$fixture help",
      "please $fixture help",
      "$unknown help",
      "cost $5",
      "x$fixture help",
    ]) {
      yield* adapter.sendTurn({ threadId, input });
      const collector = yield* collectThroughSettlement(adapter);
      yield* Queue.offer(fake.events, { type: "agent_settled" });
      yield* Fiber.join(collector);
    }
    assert.deepStrictEqual(
      fake.requests
        .filter((request) => request.type === "prompt")
        .map((request) => request.message),
      [
        "/skill:fixture help",
        "/skill:fixture please help",
        "$unknown help",
        "cost $5",
        "x$fixture help",
      ],
    );
    assert.strictEqual(
      fake.requests.filter((request) => request.type === "get_commands").length,
      1,
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

// Next tranche: implement trust, extension dialogs and MCP together before enabling extensions.
it.effect(
  "parity: projects extension confirmations instead of dropping trust/dialog requests",
  () =>
    Effect.gen(function* () {
      const events = yield* runEvents([
        {
          type: "extension_ui_request",
          id: "confirm-1",
          method: "confirm",
          title: "Trust this fixture?",
          message: "Fixture only",
        },
      ]);
      assert.isTrue(events.some((event) => event.type === "request.opened"));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
it.effect("parity: projects extension select/input dialogs", () =>
  Effect.gen(function* () {
    const events = yield* runEvents([
      {
        type: "extension_ui_request",
        id: "select-1",
        method: "select",
        title: "Pick",
        options: ["A", "B"],
      },
    ]);
    assert.isTrue(events.some((event) => event.type === "user-input.requested"));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

for (const recovery of [
  undefined,
  { type: "auto_retry_end", success: true },
  { type: "compaction_end", result: { summary: "Recovered" } },
] as const) {
  it.effect(
    `Pi ${recovery ? `clears a recovered error on ${recovery.type}` : "retains a final assistant error without retries"}`,
    () =>
      Effect.gen(function* () {
        const events = yield* runEvents([
          {
            type: "message_end",
            message: { role: "assistant", stopReason: "error", errorMessage: "Model failed" },
          },
          ...(recovery ? [recovery] : []),
        ]);
        const completed = events.find((event) => event.type === "turn.completed");
        assert.strictEqual(completed?.payload.state, recovery ? "completed" : "failed");
        assert.strictEqual(completed?.payload.errorMessage, recovery ? undefined : "Model failed");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
}

it.effect("Pi settles a rejected id-less prompt without waiting for agent_settled", () =>
  Effect.gen(function* () {
    const { fake, adapter } = yield* setup();
    yield* adapter.sendTurn({ threadId, input: "fixture" });
    const collector = yield* collectThroughSettlement(adapter);
    yield* Queue.offer(fake.events, {
      type: "response",
      command: "prompt",
      success: false,
      error: "Prompt refused",
    });
    const events = yield* Fiber.join(collector);
    const completed = events.find((event) => event.type === "turn.completed");
    assert.strictEqual(completed?.payload.state, "failed");
    assert.strictEqual(completed?.payload.errorMessage, "Prompt refused");
    const [session] = yield* adapter.listSessions();
    assert.strictEqual(session?.status, "ready");
    assert.isUndefined(session?.activeTurnId);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi does not fail an active turn when a steer is rejected", () =>
  Effect.gen(function* () {
    const events = yield* runEvents([
      { type: "agent_start" },
      { type: "response", command: "steer", success: false, error: "Steer refused" },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Still running" },
      },
    ]);
    assert.strictEqual(
      events.find((event) => event.type === "turn.completed")?.payload.state,
      "completed",
    );
    assert.isTrue(
      events.some(
        (event) => event.type === "content.delta" && event.payload.delta === "Still running",
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi probes command acknowledgement in stream order before settling", () =>
  Effect.gen(function* () {
    const { fake, adapter } = yield* setup();
    yield* adapter.sendTurn({ threadId, input: "/fixture" });
    const collector = yield* collectThroughSettlement(adapter);
    yield* Queue.offerAll(fake.events, [
      { type: "response", command: "prompt", success: true },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Started after ack" },
      },
      { type: "agent_settled" },
    ]);
    const events = yield* Fiber.join(collector);
    assert.isTrue(
      events.some(
        (event) => event.type === "content.delta" && event.payload.delta === "Started after ack",
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi reconciles text and thinking end snapshots without replaying streamed prefixes", () =>
  Effect.gen(function* () {
    const events = yield* runEvents([
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Think" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Thinking" },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Thinking" },
            { type: "text", text: "Answer" },
          ],
        },
      },
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Next answer" }] },
      },
    ]);
    const deltas = events.filter((event) => event.type === "content.delta");
    assert.deepStrictEqual(
      deltas.map((event) => event.payload.delta),
      ["Think", "ing", "Answer", "Next answer"],
    );
    assert.strictEqual(deltas[0]?.itemId, deltas[1]?.itemId);
    assert.notStrictEqual(deltas[2]?.itemId, deltas[3]?.itemId);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi maps file tools and unknown tools without losing their native results", () =>
  Effect.gen(function* () {
    const editResult = {
      content: [{ type: "text", text: "Edited file" }],
      details: { diff: "-old\n+new" },
    };
    const imageResult = { content: [{ type: "image", data: "abc", mimeType: "image/png" }] };
    const events = yield* runEvents([
      {
        type: "tool_execution_start",
        toolCallId: "edit-1",
        toolName: "edit",
        args: { path: "/tmp/file" },
      },
      { type: "tool_execution_end", toolCallId: "edit-1", result: editResult, isError: false },
      {
        type: "tool_execution_end",
        toolCallId: "custom-1",
        toolName: "custom",
        result: imageResult,
        isError: false,
      },
    ]);
    const completed = events.filter((event) => event.type === "item.completed");
    assert.deepStrictEqual(
      completed.map((event) => [event.payload.itemType, event.payload.status]),
      [
        ["file_change", "completed"],
        ["dynamic_tool_call", "completed"],
      ],
    );
    assert.containsSubset(completed[0]?.payload.data, {
      input: { path: "/tmp/file" },
      result: editResult,
    });
    assert.containsSubset(completed[1]?.payload.data, { result: imageResult });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi restores registration baselines, not the initially selected overrides", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeRpc();
    const adapter = yield* makePiAdapter(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      { connectionFactory: () => Effect.succeed(fake.connection) },
    );
    yield* adapter.startSession({
      threadId,
      cwd: "/tmp",
      runtimeMode: "full-access",
      modelSelection: {
        instanceId: ProviderInstanceId.make("pi"),
        model: "anthropic/explicit",
        options: [{ id: "thinking", value: "high" }],
      },
    });
    yield* adapter.sendTurn({
      threadId,
      input: "fixture",
      modelSelection: {
        instanceId: ProviderInstanceId.make("pi"),
        model: "default",
        options: [{ id: "thinking", value: "inherit" }],
      },
    });
    assert.deepStrictEqual(fake.requests.slice(-3), [
      { type: "set_model", provider: "openai", modelId: "baseline" },
      { type: "set_thinking_level", level: "medium" },
      { type: "prompt", message: "fixture" },
    ]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi retries thinking after a model change even when the first apply failed", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeRpc();
    let failThinking = false;
    const adapter = yield* makePiAdapter(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      {
        connectionFactory: () =>
          Effect.succeed({
            ...fake.connection,
            request: (record, timeoutMs) =>
              record.type === "set_thinking_level" && failThinking
                ? Effect.fail(
                    new PiRpcError({ operation: "set_thinking_level", detail: "Temporary error" }),
                  )
                : fake.connection.request(record, timeoutMs),
          }),
      },
    );
    yield* adapter.startSession({
      threadId,
      cwd: "/tmp",
      runtimeMode: "full-access",
      modelSelection: {
        instanceId: ProviderInstanceId.make("pi"),
        model: "anthropic/first",
        options: [{ id: "thinking", value: "high" }],
      },
    });
    const input = {
      threadId,
      input: "fixture",
      modelSelection: {
        instanceId: ProviderInstanceId.make("pi"),
        model: "anthropic/second",
        options: [{ id: "thinking", value: "high" }],
      },
    };
    failThinking = true;
    const error = yield* Effect.flip(adapter.sendTurn(input));
    assert.strictEqual(error._tag, "ProviderAdapterRequestError");
    assert.isFalse(fake.requests.some((request) => request.type === "prompt"));
    failThinking = false;
    yield* adapter.sendTurn(input);
    assert.deepStrictEqual(fake.requests.slice(-2), [
      { type: "set_thinking_level", level: "high" },
      { type: "prompt", message: "fixture" },
    ]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi retries failed startup skill discovery once at first use, including steer", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeRpc();
    let lookups = 0;
    const adapter = yield* makePiAdapter(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      {
        connectionFactory: () =>
          Effect.succeed({
            ...fake.connection,
            request: (record, timeoutMs) =>
              record.type === "get_commands" && lookups++ === 0
                ? Effect.fail(new PiRpcError({ operation: "get_commands" }))
                : fake.connection.request(record, timeoutMs),
          }),
      },
    );
    yield* adapter.startSession({ threadId, cwd: "/tmp", runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "hello" });
    yield* adapter.sendTurn({ threadId, input: "$fixture help" });
    assert.deepStrictEqual(fake.requests.at(-1), { type: "steer", message: "/skill:fixture help" });
    assert.strictEqual(lookups, 2);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi emits turn.started before immediate prompt rejection and can start again", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeRpc();
    const adapter = yield* makePiAdapter(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      {
        connectionFactory: () =>
          Effect.succeed({
            ...fake.connection,
            send: (record) =>
              fake.connection.send(record).pipe(
                Effect.andThen(
                  Queue.offer(fake.events, {
                    type: "response",
                    command: "prompt",
                    success: false,
                    error: "Rejected immediately",
                  }),
                ),
                Effect.asVoid,
              ),
          }),
      },
    );
    yield* adapter.startSession({ threadId, cwd: "/tmp", runtimeMode: "full-access" });
    for (let index = 0; index < 2; index++) {
      const collector = yield* collectThroughSettlement(adapter);
      const turn = yield* adapter.sendTurn({ threadId, input: "fixture" });
      const events = yield* Fiber.join(collector);
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["turn.started", "turn.completed"],
      );
      assert.isTrue(events.every((event) => event.turnId === turn.turnId));
      assert.strictEqual((yield* adapter.listSessions())[0]?.status, "ready");
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi preserves interruption at settle even if the abort reports a model error", () =>
  Effect.gen(function* () {
    const { fake, adapter } = yield* setup();
    const turn = yield* adapter.sendTurn({ threadId, input: "fixture" });
    yield* adapter.interruptTurn(threadId, turn.turnId);
    const collector = yield* collectThroughSettlement(adapter);
    yield* Queue.offerAll(fake.events, [
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "Abort" },
      },
      { type: "agent_end" },
      { type: "agent_settled" },
    ]);
    const events = yield* Fiber.join(collector);
    assert.strictEqual(
      events.find((event) => event.type === "turn.completed")?.payload.state,
      "interrupted",
    );
    assert.isUndefined((yield* adapter.listSessions())[0]?.activeTurnId);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

const openDialog = (
  adapter: Effect.Success<ReturnType<typeof makePiAdapter>>,
  fake: Effect.Success<ReturnType<typeof makeFakeRpc>>,
  event: PiRpcRecord,
) =>
  Effect.gen(function* () {
    const receipt = yield* adapter.streamEvents.pipe(
      Stream.filter((e) => e.type === "request.opened" || e.type === "user-input.requested"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Queue.offer(fake.events, event);
    const [opened] = yield* Fiber.join(receipt);
    assert.isDefined(opened?.requestId);
    yield* decodeRuntimeEvent(opened);
    return opened!;
  });

for (const method of ["confirm", "select", "input", "editor"] as const) {
  it.effect(`Pi routes ${method} replies by opaque request identity exactly once`, () =>
    Effect.gen(function* () {
      const { fake, adapter } = yield* setup();
      yield* adapter.sendTurn({ threadId, input: "fixture" });
      const opened = yield* openDialog(adapter, fake, {
        type: "extension_ui_request",
        id: "native-1",
        method,
        title: "Choose",
        options: ["A", "B"],
        prefill: "original\ntext",
      });
      if (opened.type === "user-input.requested") {
        assert.equal(opened.payload.questions[0]?.allowCustomAnswer, method !== "select");
        if (method === "editor")
          assert.include(opened.payload.questions[0]!.question, "original\ntext");
      }
      const requestId = ApprovalRequestId.make(opened.requestId!);
      const resolve = () =>
        method === "confirm"
          ? adapter.respondToRequest(threadId, requestId, "accept")
          : adapter.respondToUserInput(threadId, requestId, {
              "native-1": method === "select" ? "B" : "",
            });
      // Wrong endpoint and wrong native id cannot consume the dialog.
      const wrong = yield* Effect.flip(
        method === "confirm"
          ? adapter.respondToUserInput(threadId, requestId, {})
          : adapter.respondToRequest(threadId, requestId, "accept"),
      );
      assert.equal(wrong._tag, "ProviderAdapterValidationError");
      yield* Effect.flip(
        adapter.respondToRequest(threadId, ApprovalRequestId.make("native-1"), "accept"),
      );
      const receipt = yield* adapter.streamEvents.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* resolve();
      const [resolved] = yield* Fiber.join(receipt);
      yield* decodeRuntimeEvent(resolved);
      assert.equal(resolved?.requestId, opened.requestId);
      assert.equal(resolved?.turnId, opened.turnId);
      assert.equal(
        resolved?.type,
        method === "confirm" ? "request.resolved" : "user-input.resolved",
      );
      assert.deepEqual(fake.requests.at(-1), {
        type: "extension_ui_response",
        id: "native-1",
        ...(method === "confirm" ? { confirmed: true } : { value: method === "select" ? "B" : "" }),
      });
      yield* Effect.flip(resolve());
      assert.equal(fake.requests.filter((r) => r.type === "extension_ui_response").length, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
}

for (const terminal of ["settle", "interrupt", "stop", "exit", "timeout"] as const) {
  it.effect(`Pi cancels dialogs on ${terminal} and rejects stale answers`, () =>
    Effect.gen(function* () {
      const { fake, adapter } = yield* setup();
      yield* adapter.sendTurn({ threadId, input: "fixture" });
      const opened = yield* openDialog(adapter, fake, {
        type: "extension_ui_request",
        id: "pending",
        method: "input",
        title: "Input",
        timeout: 500,
      });
      const receipt = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((e) =>
          terminal === "exit" || terminal === "stop"
            ? e.type === "session.exited"
            : e.type === "user-input.resolved",
        ),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      if (terminal === "settle") yield* Queue.offer(fake.events, { type: "agent_settled" });
      if (terminal === "interrupt") yield* adapter.interruptTurn(threadId);
      if (terminal === "stop") yield* adapter.stopSession(threadId);
      if (terminal === "exit")
        yield* Deferred.fail(fake.exited, new PiRpcError({ operation: "exit" }));
      if (terminal === "timeout") yield* TestClock.adjust(500);
      const events = yield* Fiber.join(receipt);
      assert.equal(events.filter((e) => e.type === "user-input.resolved").length, 1);
      assert.deepEqual(
        fake.requests.find((r) => r.type === "extension_ui_response"),
        { type: "extension_ui_response", id: "pending", cancelled: true },
      );
      yield* Effect.flip(
        adapter.respondToUserInput(threadId, ApprovalRequestId.make(opened.requestId!), {
          pending: "late",
        }),
      );
      yield* TestClock.adjust(1000);
      assert.equal(fake.requests.filter((r) => r.type === "extension_ui_response").length, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
}

it.effect("Pi keeps a failed dialog write retryable and resolves before immediate settlement", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeRpc();
    let fail = true;
    const adapter = yield* makePiAdapter(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      {
        connectionFactory: () =>
          Effect.succeed({
            ...fake.connection,
            send: (r) =>
              r.type !== "extension_ui_response"
                ? fake.connection.send(r)
                : Effect.suspend(() =>
                    fail
                      ? Effect.fail(new PiRpcError({ operation: "write" }))
                      : Queue.offer(fake.events, { type: "agent_settled" }).pipe(
                          Effect.andThen(fake.connection.send(r)),
                        ),
                  ),
          }),
      },
    );
    yield* adapter.startSession({ threadId, cwd: "/tmp", runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "fixture" });
    const opened = yield* openDialog(adapter, fake, {
      type: "extension_ui_request",
      id: "retry",
      method: "confirm",
    });
    const respond = adapter.respondToRequest(
      threadId,
      ApprovalRequestId.make(opened.requestId!),
      "decline",
    );
    yield* Effect.flip(respond);
    fail = false;
    const collector = yield* collectThroughSettlement(adapter);
    yield* respond;
    const events = yield* Fiber.join(collector);
    assert.deepEqual(
      events.map((e) => e.type),
      ["request.resolved", "turn.completed"],
    );
    assert.deepEqual(fake.requests.at(-1), {
      type: "extension_ui_response",
      id: "retry",
      confirmed: false,
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("Pi separates identical native dialog IDs across threads and session restarts", () =>
  Effect.gen(function* () {
    const first = yield* makeFakeRpc();
    const second = yield* makeFakeRpc();
    const third = yield* makeFakeRpc();
    const fakes = [first, second, third];
    const adapter = yield* makePiAdapter(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      { connectionFactory: () => Effect.succeed(fakes.shift()!.connection) },
    );
    const other = ThreadId.make("other");
    yield* adapter.startSession({ threadId, cwd: "/tmp", runtimeMode: "full-access" });
    yield* adapter.startSession({ threadId: other, cwd: "/tmp", runtimeMode: "full-access" });
    const native = { type: "extension_ui_request", id: "same", method: "confirm" };
    const a = yield* openDialog(adapter, first, native);
    const b = yield* openDialog(adapter, second, native);
    assert.notEqual(a.requestId, b.requestId);
    yield* Effect.flip(
      adapter.respondToRequest(other, ApprovalRequestId.make(a.requestId!), "accept"),
    );
    yield* adapter.respondToRequest(other, ApprovalRequestId.make(b.requestId!), "cancel");
    yield* adapter.startSession({ threadId, cwd: "/tmp", runtimeMode: "full-access" });
    const c = yield* openDialog(adapter, third, native);
    assert.notEqual(a.requestId, c.requestId);
    yield* Effect.flip(
      adapter.respondToRequest(threadId, ApprovalRequestId.make(a.requestId!), "accept"),
    );
    yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(c.requestId!), "accept");
    assert.deepEqual(second.requests.at(-1), {
      type: "extension_ui_response",
      id: "same",
      cancelled: true,
    });
    assert.deepEqual(third.requests.at(-1), {
      type: "extension_ui_response",
      id: "same",
      confirmed: true,
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "Pi cancels non-routable registration dialogs rather than hanging or granting trust",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeRpc();
      const answered = yield* Deferred.make<void>();
      const adapter = yield* makePiAdapter(
        { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
        {
          connectionFactory: () =>
            Effect.succeed({
              ...fake.connection,
              send: (r) =>
                fake.connection.send(r).pipe(Effect.andThen(Deferred.succeed(answered, undefined))),
              request: (r) =>
                r.type !== "get_state"
                  ? fake.connection.request(r)
                  : Queue.offer(fake.events, {
                      type: "extension_ui_request",
                      id: "startup",
                      method: "confirm",
                      title: "Trust?",
                    }).pipe(
                      Effect.andThen(Deferred.await(answered)),
                      Effect.andThen(fake.connection.request(r)),
                    ),
            }),
        },
      );
      yield* adapter.startSession({ threadId, cwd: "/tmp", runtimeMode: "full-access" });
      assert.deepEqual(
        fake.requests.find((r) => r.type === "extension_ui_response"),
        { type: "extension_ui_response", id: "startup", cancelled: true },
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
