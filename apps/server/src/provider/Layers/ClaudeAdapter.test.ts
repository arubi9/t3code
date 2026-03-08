import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
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
});
