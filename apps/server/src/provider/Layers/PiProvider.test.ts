import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { checkPiProviderStatus } from "./PiProvider.ts";

it.live(
  "discovery permits initial RPC readiness after Pi's 30-second stale-lock recovery",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-discovery-" });
      const agent = `${root}/agent`;
      yield* fs.makeDirectory(agent);
      const binaryPath = writeFakeCli({
        directory: root,
        name: "pi-delayed-ready",
        source: `
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';
if (process.argv.includes('--version')) { console.log('0.85.0'); process.exit(0); }
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.type === 'get_state') await setTimeout(31_000);
  const data = request.type === 'get_available_models'
    ? { models: [{ provider: 'fixture', id: 'local-model' }] } : {};
  console.log(JSON.stringify({ type: 'response', id: request.id, command: request.type, success: true, data }));
}
`,
      });
      const snapshot = yield* checkPiProviderStatus(
        { enabled: true, binaryPath, launchArgs: "", customModels: [] },
        { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agent },
        root,
      );
      assert.equal(snapshot.status, "ready", snapshot.message);
      assert.isTrue(snapshot.models.some((model) => model.slug === "fixture/local-model"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  60_000,
);
