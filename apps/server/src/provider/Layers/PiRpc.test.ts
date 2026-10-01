import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makePiRpcConnection } from "./PiRpc.ts";

it.live(
  "Pi RPC correlates reverse-order replies, releases cancelled waiters, and fails outstanding requests on exit",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-rpc-" });
      const command = writeFakeCli({
        directory: dir,
        name: "rpc-fixture",
        source: `
      import {createInterface} from 'node:readline';
      const output = r => process.stdout.write(JSON.stringify(r)+'\\r\\n');
      const reply = (r,data) => output({type:'response',id:r.id,command:r.type,success:true,data});
      let first, cancelled;
      for await (const line of createInterface({input:process.stdin})) {
        const r=JSON.parse(line);
        if(r.type==='first') {first=r; output({type:'received',id:r.id});}
        if(r.type==='second') {reply(r,'second'); reply(first,'first\\u2028kept');}
        if(r.type==='slow') {cancelled=r; output({type:'received',id:r.id});}
        if(r.type==='release') {reply(cancelled,'late'); reply(r,'release');}
        if(r.type==='exit') process.exit(0);
      }
    `,
      });
      const rpc = yield* makePiRpcConnection({
        command,
        args: [],
        cwd: dir,
        env: { PATH: process.env.PATH },
      });
      const first = yield* rpc
        .request({ type: "first" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const receipt = yield* Queue.take(rpc.events);
      assert.equal(receipt.type, "received");
      assert.equal(yield* rpc.request({ type: "second" }), "second");
      assert.equal(yield* Fiber.join(first), "first\u2028kept");
      const slow = yield* rpc
        .request({ type: "slow" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const sent = yield* Queue.take(rpc.events);
      yield* Fiber.interrupt(slow);
      assert.equal(yield* rpc.request({ type: "release" }), "release");
      // A late response is unowned, not delivered to the next request's waiter.
      assert.deepEqual(yield* Queue.take(rpc.events), {
        type: "response",
        id: sent.id,
        command: "slow",
        success: true,
        data: "late",
      });
      const result = yield* rpc.request({ type: "exit" }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure._tag, "PiRpcError");
      assert.equal(yield* rpc.exited, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
