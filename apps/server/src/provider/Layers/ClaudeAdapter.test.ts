import assert from "node:assert/strict";

import { type ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { vi } from "vitest";

const mockState = vi.hoisted(() => {
  class MockEmitter {
    private readonly listeners = new Map<string, Set<(...args: Array<any>) => void>>();

    on(event: string, listener: (...args: Array<any>) => void) {
      const listeners = this.listeners.get(event) ?? new Set<(...args: Array<any>) => void>();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, listener: (...args: Array<any>) => void) {
      const wrapped = (...args: Array<any>) => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: string, listener: (...args: Array<any>) => void) {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: Array<any>) {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }
  }

  class MockReadable extends MockEmitter {
    write(data: string) {
      this.emit("data", {
        toString: () => data,
      });
    }
  }

  class MockChild extends MockEmitter {
    readonly stdout = new MockReadable();
    readonly stderr = new MockReadable();
    readonly killCalls: Array<string | undefined> = [];

    kill(signal?: string) {
      this.killCalls.push(signal);
      return true;
    }

    emitExit(code: number | null, signal: string | null) {
      this.emit("exit", code, signal);
    }
  }

  const spawnCalls: Array<{
    binaryPath: string;
    args: string[];
    child: MockChild;
  }> = [];

  const spawnMock = vi.fn((binaryPath: string, args: string[]) => {
    const child = new MockChild();
    spawnCalls.push({
      binaryPath,
      args: [...args],
      child,
    });
    return child;
  });

  return {
    spawnCalls,
    spawnMock,
  };
});

vi.mock("node:child_process", () => ({
  spawn: mockState.spawnMock,
}));

import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import { makeClaudeAdapterLive } from "./ClaudeAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const waitForAsyncEffects = () => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));

const claudeAdapterLayer = it.layer(
  makeClaudeAdapterLive().pipe(Layer.provideMerge(NodeServices.layer)),
);

claudeAdapterLayer("ClaudeAdapterLive lifecycle", (it) => {
  it.effect("keeps the new turn interruptible after a stale exit from the previous session", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-stale-exit");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });
      const firstChild = mockState.spawnCalls[0]?.child;
      assert.ok(firstChild);

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });
      assert.deepEqual(firstChild.killCalls, ["SIGTERM"]);

      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "second turn",
        attachments: [],
      });
      const secondChild = mockState.spawnCalls[1]?.child;
      assert.ok(secondChild);

      firstChild.emitExit(null, "SIGTERM");
      yield* waitForAsyncEffects();

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions[0]?.threadId, threadId);
      assert.equal(sessions[0]?.status, "running");
      assert.equal(sessions[0]?.activeTurnId, secondTurn.turnId);

      yield* adapter.interruptTurn(threadId);
      assert.deepEqual(secondChild.killCalls, ["SIGTERM"]);
      assert.equal(firstTurn.turnId === secondTurn.turnId, false);
    }),
  );

  it.effect("does not mark a replaced session resumable from a stale completed-process exit", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-stale-complete");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });
      const firstChild = mockState.spawnCalls[0]?.child;
      assert.ok(firstChild);

      firstChild.stdout.write(`${JSON.stringify({ type: "result", subtype: "success" })}\n`);
      yield* waitForAsyncEffects();

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });

      firstChild.emitExit(0, null);

      yield* adapter.sendTurn({
        threadId,
        input: "second turn",
        attachments: [],
      });

      const secondSpawn = mockState.spawnCalls[1];
      assert.ok(secondSpawn);
      assert.equal(secondSpawn.binaryPath, "claude");
      assert.equal(secondSpawn.args.includes("--session-id"), true);
      assert.equal(secondSpawn.args.includes("--resume"), false);
    }),
  );

  it.effect("captures Claude turn history for readThread", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-read-history");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });
      const startedTurn = yield* adapter.sendTurn({
        threadId,
        input: "history turn",
        attachments: [],
      });
      const child = mockState.spawnCalls[0]?.child;
      assert.ok(child);

      child.stdout.write(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: {
              id: "msg-history",
            },
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "text_delta",
              text: "Hello",
            },
          },
        })}\n`,
      );
      child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success" })}\n`);
      yield* waitForAsyncEffects();

      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.threadId, threadId);
      assert.equal(snapshot.turns.length, 1);
      assert.equal(snapshot.turns[0]?.id, startedTurn.turnId);
      assert.equal(snapshot.turns[0]?.items.length, 3);
      assert.deepEqual(snapshot.turns[0]?.items[0], {
        kind: "turn.started",
        input: "history turn",
        interactionMode: null,
      });
      assert.deepEqual(snapshot.turns[0]?.items[1], {
        kind: "content.delta",
        itemId: "msg-history",
        streamKind: "assistant_text",
        delta: "Hello",
      });
      assert.deepEqual(snapshot.turns[0]?.items[2], {
        kind: "turn.completed",
        state: "completed",
        stopReason: "end_turn",
      });
    }),
  );

  it.effect("allows stopSession to be called repeatedly", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-stop-idempotent");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(threadId);
      yield* adapter.stopSession(threadId);

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.some((session) => session.threadId === threadId), false);
    }),
  );

  it.effect("resets Claude resume state after rollback", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-rollback-reset");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });
      const firstChild = mockState.spawnCalls[0]?.child;
      assert.ok(firstChild);
      firstChild.stdout.write(`${JSON.stringify({ type: "result", subtype: "success" })}\n`);
      yield* waitForAsyncEffects();
      firstChild.emitExit(0, null);

      yield* adapter.sendTurn({
        threadId,
        input: "second turn",
        attachments: [],
      });
      const secondSpawn = mockState.spawnCalls[1];
      const secondChild = secondSpawn?.child;
      assert.ok(secondSpawn);
      assert.ok(secondChild);
      assert.equal(secondSpawn.args.includes("--resume"), true);
      secondChild.stdout.write(`${JSON.stringify({ type: "result", subtype: "success" })}\n`);
      yield* waitForAsyncEffects();
      secondChild.emitExit(0, null);

      const rolledBack = yield* adapter.rollbackThread(threadId, 1);
      assert.equal(rolledBack.turns.length, 1);

      yield* adapter.sendTurn({
        threadId,
        input: "third turn",
        attachments: [],
      });
      const thirdSpawn = mockState.spawnCalls[2];
      assert.ok(thirdSpawn);
      assert.equal(thirdSpawn.args.includes("--session-id"), true);
      assert.equal(thirdSpawn.args.includes("--resume"), false);
    }),
  );

  it.effect("maps Claude permission denials into resolved approval history events", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-permission-denial");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "approval-required",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "blocked write",
        attachments: [],
      });
      const child = mockState.spawnCalls[0]?.child;
      assert.ok(child);

      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          permission_denials: [
            {
              tool_use_id: "tool-denied-1",
              tool_name: "Write",
              tool_input: {
                file_path: "/tmp/blocked.ts",
              },
            },
          ],
        })}\n`,
      );
      yield* waitForAsyncEffects();

      const events: Array<ProviderRuntimeEvent> = Array.from(
        yield* Stream.runCollect(
          adapter.streamEvents.pipe(
            Stream.filter((event) => event.threadId === threadId),
            Stream.take(8),
          ),
        ),
      );
      const opened = events.find((event) => event.type === "request.opened");
      const resolved = events.find((event) => event.type === "request.resolved");

      assert.ok(opened);
      assert.ok(resolved);
      assert.equal(opened?.requestId, "claude-denial:thread-permission-denial:tool-denied-1");
      if (opened?.type === "request.opened") {
        assert.equal(opened.payload.requestType, "file_change_approval");
        assert.equal(opened.payload.detail, "/tmp/blocked.ts");
      }
      if (resolved?.type === "request.resolved") {
        assert.equal(resolved.payload.requestType, "file_change_approval");
        assert.equal(resolved.payload.decision, "decline");
      }
    }),
  );
});
