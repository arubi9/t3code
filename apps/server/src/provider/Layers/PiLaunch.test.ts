import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { clearMcpProviderSession, setMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import { makePiAdapter } from "./PiAdapter.ts";
import { checkPiProviderStatus } from "./PiProvider.ts";

// This child executes selected fixture extensions, including the real generated
// MCP bridge. Only HTTP is stubbed: there is no listener, DB, login or model turn.
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

const source = `
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  fs.writeFileSync(process.env.HOME + '/version-env.json', JSON.stringify(process.env));
  console.log('0.85.0'); process.exit(0);
}
const tools = [], calls = [], commands = [], hooks = new Map();
const pi = {
  registerTool: (tool) => tools.push(tool),
  registerCommand: (name) => commands.push({name, source:'extension'}),
  on: (name, handler) => hooks.set(name, handler),
};
globalThis.fetch = async (endpoint, init) => {
  const request = JSON.parse(init.body);
  calls.push({endpoint, headers:init.headers, redirect:init.redirect, request});
  return new Response(JSON.stringify({id:request.id, result: request.method === 'tools/list'
    ? {tools:[{name:'preview_status', description:'Fixture browser', inputSchema:{type:'object'}}]}
    : request.method === 'tools/call' ? {content:[{type:'text',text:'fixture result'}]} : {}}), { headers: {'mcp-session-id':'fixture-mcp'} });
};
const paths = args.flatMap((arg,i) => arg === '--extension' || arg === '-e' ? [args[i+1]] : []);
if (!args.includes('--no-extensions')) paths.push(process.cwd() + '/.pi/extensions/unauthorized.js');
for (const path of paths) {
  if (path.endsWith('pi-t3-mcp-extension.ts')) {
    const text = stripTypeScriptTypes(fs.readFileSync(path,'utf8')).replace('import { Type } from "typebox";', 'const Type = { Unsafe: x => x, Object: () => ({}) };');
    await (await import('data:text/javascript,' + encodeURIComponent(text))).default(pi);
  } else await (await import(pathToFileURL(path).href)).default(pi);
}
if (tools[0]) await tools[0].execute('fixture-call', {}, undefined);
const systemPrompt = hooks.get('before_agent_start')?.({systemPrompt:'base'}).systemPrompt;
fs.writeFileSync(process.env.HOME + '/launch.json', JSON.stringify({args, env:process.env, commands, calls, tools:tools.map(t => t.name), systemPrompt, pid:process.pid}));
for await (const line of createInterface({input:process.stdin})) {
  const request = JSON.parse(line);
  const data = request.type === 'get_state' ? {sessionFile:'/fixture/session.jsonl'}
    : request.type === 'get_available_models' ? {models:[{provider:'fixture',id:'extension-model'}]}
    : request.type === 'get_commands' ? {commands} : {};
  console.log(JSON.stringify({type:'response',id:request.id,command:request.type,success:true,data}));
}
`;

it.live(
  "session/probe launches never execute unauthorized project extensions and scope MCP to the owning thread",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-launch-" });
      const home = `${root}/home`;
      const cwd = `${root}/project`;
      const agent = `${home}/.pi/agent`;
      const git = `${agent}/git/github.com/fixture/package`;
      yield* fs.makeDirectory(`${agent}/extensions`, { recursive: true });
      yield* fs.makeDirectory(`${cwd}/.pi/extensions`, { recursive: true });
      yield* fs.makeDirectory(git, { recursive: true });
      yield* fs.writeFileString(
        `${agent}/extensions/user.js`,
        'export default pi => pi.registerCommand("user-command")',
      );
      yield* fs.writeFileString(
        `${git}/index.js`,
        'export default pi => pi.registerCommand("git-command")',
      );
      yield* fs.writeFileString(
        `${git}/package.json`,
        encodeJson({ pi: { extensions: ["./index.js"] } }),
      );
      yield* fs.writeFileString(
        `${agent}/settings.json`,
        encodeJson({ packages: ["git:github.com/fixture/package"] }),
      );
      yield* fs.writeFileString(
        `${cwd}/.pi/extensions/unauthorized.js`,
        `import { writeFileSync } from 'node:fs'; writeFileSync(${encodeJson(`${root}/EXECUTED`)}, 'unauthorized'); export default () => {}`,
      );
      const binaryPath = writeFakeCli({ directory: root, name: "pi-fixture", source });
      const settings = { enabled: true, binaryPath, launchArgs: "", customModels: [] };
      const environment = {
        PATH: process.env.PATH,
        HOME: home,
        PI_CODING_AGENT_DIR: agent,
        T3_MCP_URL: "http://stale",
        T3_MCP_BEARER_TOKEN: "stale-secret",
        T3_PI_MCP_EXTENSION_PATH: "/stale",
      };
      const owner = ThreadId.make("pi-launch-owner");
      const other = ThreadId.make("pi-launch-other");
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          setMcpProviderSession({
            environmentId: EnvironmentId.make("fixture-env"),
            threadId: owner,
            providerSessionId: "fixture-session",
            providerInstanceId: ProviderInstanceId.make("pi"),
            endpoint: "http://fixture.invalid/mcp",
            authorizationHeader: "Bearer owner-secret",
            capabilities: new Set(),
          }),
        ),
        () => Effect.sync(() => clearMcpProviderSession(owner)),
      );
      const adapter = yield* makePiAdapter(settings, { environment });
      yield* adapter.startSession({ threadId: owner, cwd, runtimeMode: "full-access" });
      const readLaunch = fs.readFileString(`${home}/launch.json`).pipe(
        Effect.map(
          (text) =>
            decodeJson(text) as {
              args: string[];
              env: Record<string, string>;
              commands: { name: string }[];
              calls: {
                endpoint: string;
                redirect: string;
                headers: Record<string, string>;
                request: { method: string };
              }[];
              tools: string[];
              systemPrompt?: string;
            },
        ),
      );
      const owned = yield* readLaunch;
      assert.deepEqual(
        owned.commands.map((c) => c.name),
        ["user-command", "git-command"],
      );
      assert.deepEqual(owned.tools, ["preview_status"]);
      assert.deepEqual(
        owned.calls.map((call) => call.request.method),
        ["initialize", "notifications/initialized", "tools/list", "tools/call"],
      );
      for (const call of owned.calls) {
        assert.equal(call.endpoint, "http://fixture.invalid/mcp");
        assert.equal(call.headers.authorization, "Bearer owner-secret");
        assert.equal(call.headers["mcp-protocol-version"], "2025-06-18");
        assert.equal(call.redirect, "error");
      }
      assert.equal(owned.calls.at(-1)?.headers["mcp-session-id"], "fixture-mcp");
      assert.include(owned.systemPrompt!, "Pi harness");
      assert.include(owned.systemPrompt!, "preview_status");
      assert.isFalse(encodeJson(owned.args).includes("owner-secret"));
      yield* adapter.stopSession(owner);
      yield* adapter.startSession({ threadId: other, cwd, runtimeMode: "full-access" });
      const unowned = yield* readLaunch;
      assert.isUndefined(unowned.env.T3_MCP_BEARER_TOKEN);
      assert.deepEqual(unowned.tools, []);
      yield* adapter.stopSession(other);
      const snapshot = yield* checkPiProviderStatus(settings, environment, cwd);
      const probe = yield* readLaunch;
      const versionEnv = decodeJson(yield* fs.readFileString(`${home}/version-env.json`)) as Record<
        string,
        unknown
      >;
      assert.isUndefined(versionEnv.T3_MCP_BEARER_TOKEN);
      assert.isUndefined(probe.env.T3_MCP_BEARER_TOKEN);
      assert.isUndefined(probe.env.T3_MCP_URL);
      assert.isUndefined(probe.env.T3_PI_MCP_EXTENSION_PATH);
      assert.deepEqual(probe.tools, []);
      assert.deepEqual(
        snapshot.slashCommands?.map((command) => command.name),
        ["user-command", "git-command"],
      );
      assert.isFalse(yield* fs.exists(`${root}/EXECUTED`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
