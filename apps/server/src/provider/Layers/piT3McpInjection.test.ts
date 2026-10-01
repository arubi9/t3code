import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import {
  buildPiRpcLaunch,
  discoverPiUserExtensions,
  materializePiT3McpExtension,
} from "./piT3McpInjection.ts";
import { PI_T3_MCP_EXTENSION_SOURCE } from "./piT3McpExtensionSource.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const mcpSession = {
  environmentId: EnvironmentId.make("fixture-env"),
  threadId: ThreadId.make("fixture-thread"),
  providerSessionId: "fixture-session",
  providerInstanceId: ProviderInstanceId.make("pi"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer fixture-thread-secret",
  capabilities: new Set<string>(),
};

it.effect(
  "discovers user and npm package extensions without injecting the deferred T3 subagent override",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-home-" });
      const extensionsDir = `${home}/.pi/agent/extensions`;
      const lensDir = `${home}/.pi/agent/npm/node_modules/pi-lens`;
      const authDir = `${home}/.pi/agent/npm/node_modules/@gotgenes/pi-anthropic-auth`;
      const filteredDir = `${home}/.pi/agent/npm/node_modules/filtered-extension`;
      const packageSubagentDir = `${home}/.pi/agent/npm/node_modules/pi-subagents`;
      const ponytailDir = `${home}/.pi/agent/git/github.com/DietrichGebert/ponytail`;
      const escapedDir = `${home}/.pi/escape`;
      yield* fs.makeDirectory(`${extensionsDir}/todos`, { recursive: true });
      yield* fs.makeDirectory(`${extensionsDir}/subagent`, { recursive: true });
      yield* fs.makeDirectory(`${lensDir}/src`, { recursive: true });
      yield* fs.makeDirectory(`${authDir}/src`, { recursive: true });
      yield* fs.makeDirectory(`${filteredDir}/src`, { recursive: true });
      yield* fs.makeDirectory(packageSubagentDir, { recursive: true });
      yield* fs.makeDirectory(`${ponytailDir}/pi-extension`, { recursive: true });
      yield* fs.makeDirectory(escapedDir, { recursive: true });
      yield* fs.writeFileString(`${extensionsDir}/demo.ts`, "export default () => {}");
      yield* fs.writeFileString(`${extensionsDir}/subagent.ts`, "export default () => {}");
      yield* fs.writeFileString(`${extensionsDir}/subagent.js`, "export default () => {}");
      yield* fs.writeFileString(`${extensionsDir}/todos/index.ts`, "export default () => {}");
      yield* fs.writeFileString(`${extensionsDir}/subagent/index.ts`, "export default () => {}");
      yield* fs.writeFileString(`${lensDir}/src/index.ts`, "export default () => {}");
      yield* fs.writeFileString(`${authDir}/src/index.ts`, "export default () => {}");
      yield* fs.writeFileString(`${filteredDir}/src/index.ts`, "export default () => {}");
      yield* fs.writeFileString(`${filteredDir}/src/legacy.ts`, "export default () => {}");
      yield* fs.writeFileString(`${packageSubagentDir}/index.ts`, "export default () => {}");
      yield* fs.writeFileString(`${ponytailDir}/pi-extension/index.js`, "export default () => {}");
      yield* fs.writeFileString(
        `${lensDir}/package.json`,
        '{ "pi": { "extensions": ["./src/index.ts"] } }',
      );
      yield* fs.writeFileString(
        `${authDir}/package.json`,
        '{ "pi": { "extensions": ["./src/index.ts"] } }',
      );
      yield* fs.writeFileString(
        `${filteredDir}/package.json`,
        '{ "pi": { "extensions": ["./src/index.ts", "./src/legacy.ts"] } }',
      );
      yield* fs.writeFileString(
        `${packageSubagentDir}/package.json`,
        '{ "pi": { "extensions": ["./index.ts"] } }',
      );
      yield* fs.writeFileString(
        `${ponytailDir}/package.json`,
        '{ "pi": { "extensions": ["./pi-extension/index.js"] } }',
      );
      yield* fs.writeFileString(`${escapedDir}/index.js`, "export default () => {}");
      yield* fs.writeFileString(
        `${escapedDir}/package.json`,
        '{ "pi": { "extensions": ["./index.js"] } }',
      );
      yield* fs.writeFileString(
        `${home}/.pi/agent/settings.json`,
        `{ "packages": [
          "npm:pi-lens",
          "npm:@gotgenes/pi-anthropic-auth@1.2.3",
          { "source": "npm:filtered-extension", "extensions": ["./src/index.ts"] },
          "npm:pi-subagents",
          "git:github.com/DietrichGebert/ponytail",
          "git:../../escape",
          { "source": "npm:disabled-extension", "extensions": [] }
        ] }`,
      );
      const found = yield* discoverPiUserExtensions({
        environment: { HOME: home },
        cwd: undefined,
      });
      assert.deepEqual(found, [
        `${extensionsDir}/demo.ts`,
        `${extensionsDir}/subagent/index.ts`,
        `${extensionsDir}/subagent.js`,
        `${extensionsDir}/subagent.ts`,
        `${extensionsDir}/todos/index.ts`,
        `${lensDir}/src/index.ts`,
        `${authDir}/src/index.ts`,
        `${filteredDir}/src/index.ts`,
        `${packageSubagentDir}/index.ts`,
        `${ponytailDir}/pi-extension/index.js`,
      ]);
      yield* fs.writeFileString(
        `${home}/.pi/agent/settings.json`,
        `{ "packages": [
          { "source": "npm:filtered-extension", "autoload": false, "extensions": ["./src/index.ts"] }
        ] }`,
      );
      const autoloadDisabled = yield* discoverPiUserExtensions({
        environment: { HOME: home },
        cwd: undefined,
      });
      assert.deepEqual(autoloadDisabled, [
        `${extensionsDir}/demo.ts`,
        `${extensionsDir}/subagent/index.ts`,
        `${extensionsDir}/subagent.js`,
        `${extensionsDir}/subagent.ts`,
        `${extensionsDir}/todos/index.ts`,
        `${filteredDir}/src/index.ts`,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("includes project extensions only under standing project trust", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-home-" });
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-parent-" });
    const project = `${parent}/project`;
    yield* fs.makeDirectory(`${home}/.pi/agent`, { recursive: true });
    yield* fs.makeDirectory(`${project}/.pi/extensions`, { recursive: true });
    yield* fs.writeFileString(`${project}/.pi/extensions/local.ts`, "export default () => {}");
    const untrusted = yield* discoverPiUserExtensions({
      environment: { HOME: home },
      cwd: project,
    });
    assert.deepEqual(untrusted, []);
    yield* fs.writeFileString(`${home}/.pi/agent/trust.json`, `{ "${parent}": true }`);
    const trustedViaAncestor = yield* discoverPiUserExtensions({
      environment: { HOME: home },
      cwd: project,
    });
    assert.deepEqual(trustedViaAncestor, [`${project}/.pi/extensions/local.ts`]);
    yield* fs.writeFileString(
      `${home}/.pi/agent/settings.json`,
      '{ "defaultProjectTrust": "always" }',
    );
    yield* fs.writeFileString(
      `${home}/.pi/agent/trust.json`,
      `{ "${parent}": true, "${project}": false }`,
    );
    const explicitlyUntrusted = yield* discoverPiUserExtensions({
      environment: { HOME: home },
      cwd: project,
    });
    assert.deepEqual(explicitlyUntrusted, []);
    yield* fs.writeFileString(`${home}/.pi/agent/trust.json`, "{}");
    const trustedByDefault = yield* discoverPiUserExtensions({
      environment: { HOME: home },
      cwd: project,
    });
    assert.deepEqual(trustedByDefault, [`${project}/.pi/extensions/local.ts`]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("scopes MCP credentials to this launch and strips stale identity from probes", () => {
  const environment = {
    PATH: "/fixture/bin",
    T3_MCP_URL: "http://stale",
    T3_MCP_BEARER_TOKEN: "stale-secret",
    T3_PI_MCP_EXTENSION_PATH: "/stale",
    T3_PI_CHILD_SESSION_ROOT: "/old/children",
  };
  const extensionPath = "/private/pi-t3-mcp-extension.ts";
  const launch = buildPiRpcLaunch({ launchArgs: "", environment, mcpSession, extensionPath });
  assert.equal(launch.env.T3_MCP_URL, mcpSession.endpoint);
  assert.equal(launch.env.T3_MCP_BEARER_TOKEN, "fixture-thread-secret");
  assert.equal(launch.env.T3_PI_MCP_EXTENSION_PATH, extensionPath);
  assert.isUndefined(launch.env.T3_PI_CHILD_SESSION_ROOT);
  assert.isFalse(encodeJson(launch.args).includes("secret"));
  assert.equal(environment.T3_MCP_BEARER_TOKEN, "stale-secret");
  for (const config of [{}, { extensionPath }, { mcpSession }]) {
    const probe = buildPiRpcLaunch({
      launchArgs: "--extension /stale/pi-t3-mcp-extension.ts",
      environment,
      ...config,
    });
    assert.deepEqual(probe.env, { PATH: "/fixture/bin" });
    assert.isFalse(probe.hasT3Mcp);
    assert.deepEqual(probe.args, ["--mode", "rpc", "--no-extensions"]);
  }
});

it("keeps ordinary subagent extensions but blocks the unported override in every launch form", () => {
  const launch = buildPiRpcLaunch({
    launchArgs:
      "-e /ordinary/subagent.ts --extension=/cache/pi-t3-subagent-extension.ts --extension /ordinary/subagent.ts -e /other/pi-t3-subagent-extension.ts",
    environment: {},
    discoveredExtensionPaths: ["/cache/pi-t3-subagent-extension.ts", "/ordinary/subagent.ts"],
  });
  assert.deepEqual(launch.args, [
    "--mode",
    "rpc",
    "--no-extensions",
    "--extension",
    "/ordinary/subagent.ts",
  ]);
  const optOut = buildPiRpcLaunch({
    launchArgs: "-ne -e /explicit.ts",
    environment: {},
    discoveredExtensionPaths: ["/autoload.ts"],
  });
  assert.deepEqual(optOut.args, [
    "--mode",
    "rpc",
    "--no-extensions",
    "--extension",
    "/explicit.ts",
  ]);
});

it.effect(
  "uses canonical nearest trust decisions and fails closed for unreadable or corrupt trust",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-trust-" });
      const agent = `${root}/agent`;
      const project = `${root}/real/project`;
      yield* fs.makeDirectory(`${project}/.pi/extensions`, { recursive: true });
      yield* fs.makeDirectory(agent);
      yield* fs.writeFileString(
        `${project}/.pi/extensions/evil.js`,
        "throw new Error('must not execute')",
      );
      yield* fs.symlink(project, `${root}/alias`);
      const discover = discoverPiUserExtensions({
        environment: { PI_CODING_AGENT_DIR: agent },
        cwd: `${root}/alias`,
      });
      yield* fs.writeFileString(
        `${agent}/settings.json`,
        encodeJson({ defaultProjectTrust: "always" }),
      );
      for (const trust of [
        "not-json",
        encodeJson({ [root]: true, [project]: false }),
        encodeJson({ [`${root}/alias`]: true, [project]: false }),
      ]) {
        yield* fs.writeFileString(`${agent}/trust.json`, trust);
        assert.deepEqual(yield* discover, []);
      }
      yield* fs.writeFileString(
        `${agent}/trust.json`,
        encodeJson({ [root]: false, [project]: true }),
      );
      assert.deepEqual(yield* discover, [`${root}/alias/.pi/extensions/evil.js`]);
      yield* fs.remove(`${agent}/trust.json`);
      yield* fs.makeDirectory(`${agent}/trust.json`);
      assert.deepEqual(yield* discover, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "restores git manifests and ordered autoload include/exclude/exact filters without traversal",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-git-" });
      const pkg = `${agent}/git/github.com/owner/repo`;
      yield* fs.makeDirectory(`${pkg}/src`, { recursive: true });
      for (const name of ["a.ts", "b.ts", "c.ts"])
        yield* fs.writeFileString(`${pkg}/src/${name}`, "export default () => {}");
      yield* fs.writeFileString(
        `${pkg}/package.json`,
        encodeJson({
          pi: { extensions: ["./src/a.ts", "./src/b.ts", "./src/c.ts", "../../escape.ts"] },
        }),
      );
      for (const [config, expected] of [
        [
          {
            source: "git:github.com/owner/repo.git@v1",
            extensions: ["src/*.ts", "!**/b.ts", "+src/b.ts", "-src/c.ts"],
          },
          ["a.ts", "b.ts"],
        ],
        [{ source: "git:github.com/owner/repo", autoload: false }, []],
        [
          {
            source: "git:github.com/owner/repo",
            autoload: false,
            extensions: ["+src/b.ts", "-src/b.ts", "src/a.ts"],
          },
          ["a.ts"],
        ],
        [{ source: "git:github.com/owner/repo", extensions: [] }, []],
      ] as const) {
        yield* fs.writeFileString(`${agent}/settings.json`, encodeJson({ packages: [config] }));
        const found = yield* discoverPiUserExtensions({
          environment: { PI_CODING_AGENT_DIR: agent },
          cwd: undefined,
        });
        assert.deepEqual(
          found,
          expected.map((name) => `${pkg}/src/${name}`),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "materializes the v1 MCP bridge without credentials or unavailable v2 tool instructions",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-bridge-" });
      const dest = yield* materializePiT3McpExtension(dir);
      const source = yield* fs.readFileString(dest);
      assert.equal(source, PI_T3_MCP_EXTENSION_SOURCE);
      assert.isFalse(source.includes("fixture-thread-secret"));
      assert.isFalse(source.includes("delegate_task"));
      assert.include(source, "before_agent_start");
      assert.include(source, 'redirect: "error"');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
