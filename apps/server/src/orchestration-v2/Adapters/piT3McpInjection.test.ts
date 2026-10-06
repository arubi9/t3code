import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  PI_T3_MCP_EXTENSION_FILENAME,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
  T3_PI_RUNTIME_MODE_ENV,
} from "./piT3McpExtensionSource.ts";
import {
  PI_T3_SUBAGENT_EXTENSION_FILENAME,
  T3_PI_CHILD_SESSION_ROOT_ENV,
} from "./piT3SubagentExtensionSource.ts";
import {
  buildPiRpcLaunch,
  discoverPiUserExtensions,
  materializePiT3McpExtension,
  materializePiT3SubagentExtension,
  resolvePiLaunchArgs,
  T3_PI_MCP_EXTENSION_PATH_ENV,
} from "./piT3McpInjection.ts";

const threadId = ThreadId.make("thread-pi-t3-mcp");

const mcpSession = {
  environmentId: EnvironmentId.make("environment-pi-t3-mcp"),
  threadId,
  providerSessionId: "mcp-session-pi",
  providerInstanceId: ProviderInstanceId.make("pi"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer secret-pi-token",
  browserToolsAvailable: true,
};

describe("pi T3 MCP injection", () => {
  it("always adds the permission bridge and configures MCP when available", () => {
    const resolvedArgs = resolvePiLaunchArgs(
      "--extension=/home/user/.pi/agent/extensions/demo.ts --session-dir=/tmp/pi-sessions --provider=anthropic --model=claude-sonnet --tools='' --name=-review --extension-flag=kept",
    );
    assert.isTrue(resolvedArgs.ok);
    if (!resolvedArgs.ok) return;
    const launch = buildPiRpcLaunch({
      launchArgs: resolvedArgs.args,
      environment: { PATH: "/usr/bin" },
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      runtimeMode: "approval-required",
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--extension",
      "/home/user/.pi/agent/extensions/demo.ts",
      "--session-dir",
      "/tmp/pi-sessions",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet",
      "--tools",
      "",
      "--name",
      "-review",
      "--extension-flag=kept",
      "--extension",
      "/tmp/cache/pi-t3-mcp-extension.ts",
    ]);
    assert.notInclude(launch.args, "--no-extensions");
    assert.equal(launch.env[T3_MCP_URL_ENV], "http://127.0.0.1:43123/mcp");
    assert.equal(launch.env[T3_MCP_BEARER_ENV], "secret-pi-token");
    assert.equal(launch.env[T3_PI_RUNTIME_MODE_ENV], "approval-required");

    const permissionOnly = buildPiRpcLaunch({
      launchArgs: [],
      environment: {
        [T3_MCP_URL_ENV]: "http://127.0.0.1:9999/stale",
        [T3_MCP_BEARER_ENV]: "stale-token",
      },
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      runtimeMode: "auto-accept-edits",
    });
    assert.deepEqual(permissionOnly.args, [
      "--mode",
      "rpc",
      "--extension",
      "/tmp/cache/pi-t3-mcp-extension.ts",
    ]);
    assert.isFalse(permissionOnly.hasT3Mcp);
    assert.isUndefined(permissionOnly.env[T3_MCP_URL_ENV]);
    assert.isUndefined(permissionOnly.env[T3_MCP_BEARER_ENV]);
    assert.equal(permissionOnly.env[T3_PI_RUNTIME_MODE_ENV], "auto-accept-edits");
  });

  it("falls back to Pi's first supported mode for legacy auto threads", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [],
      environment: {},
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      runtimeMode: "auto",
    });

    assert.equal(launch.env[T3_PI_RUNTIME_MODE_ENV], "approval-required");
  });

  it("forces tools and user extensions off for unattended text generation", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [
        "--tools",
        "read,write",
        "--extension",
        "/home/user/.pi/agent/extensions/demo.ts",
        "--extension=./second.ts",
        "--provider",
        "anthropic",
      ],
      environment: {},
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      ephemeral: true,
      disableExtensions: true,
      disableTools: true,
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--no-session",
      "--provider",
      "anthropic",
      "--no-extensions",
      "--no-tools",
    ]);
    assert.isFalse(launch.hasT3Mcp);
    assert.deepInclude(resolvePiLaunchArgs("--mode text"), {
      ok: false,
      message: "Pi launch argument '--mode' is controlled by T3 Code and cannot be overridden.",
    });
    assert.deepInclude(resolvePiLaunchArgs("--session old.jsonl"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("prompt pi immediately"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("--plan @instructions.md"), { ok: false });
  });

  it("rejects --provider without --model, which Pi 1.0 refuses at startup", () => {
    const rejection = {
      ok: false,
      message: "Pi launch argument '--provider' requires '--model'.",
    };
    assert.deepInclude(resolvePiLaunchArgs("--provider openrouter"), rejection);
    assert.deepInclude(resolvePiLaunchArgs("--provider=openrouter --models gpt-6"), rejection);
    assert.isTrue(resolvePiLaunchArgs("--provider openrouter --model=deepseek/v4").ok);
    assert.isTrue(resolvePiLaunchArgs("--model deepseek/v4").ok);
  });

  it.effect("materializes the MCP bridge with namespaced tool registration", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-extensions-" });
      const mcpDest = yield* materializePiT3McpExtension(cacheDir);
      assert.isTrue(mcpDest.endsWith(PI_T3_MCP_EXTENSION_FILENAME));
      const mcpSource = yield* fs.readFileString(mcpDest);
      assert.include(mcpSource, "export default async function t3McpExtension");
      assert.include(mcpSource, "before_agent_start");
      assert.include(mcpSource, 'pi.on("tool_call"');
      assert.include(mcpSource, "Allow ${event.toolName}?");
      assert.include(mcpSource, '"mcp-protocol-version"');
      assert.include(mcpSource, '"tools/call"');
      assert.include(mcpSource, "mcp__t3-code__");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("materializes both runtime extensions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-extensions-" });
      const mcpDest = yield* materializePiT3McpExtension(cacheDir);
      const subagentDest = yield* materializePiT3SubagentExtension(cacheDir);
      assert.isTrue(mcpDest.endsWith(PI_T3_MCP_EXTENSION_FILENAME));
      assert.isTrue(subagentDest.endsWith(PI_T3_SUBAGENT_EXTENSION_FILENAME));
      const mcpSource = yield* fs.readFileString(mcpDest);
      const subagentSource = yield* fs.readFileString(subagentDest);
      assert.include(mcpSource, "export default async function t3McpExtension");
      // Orchestration guidance rides the system-prompt hook, not the user
      // message, so first-turn slash commands still expand.
      assert.include(mcpSource, "before_agent_start");
      assert.include(mcpSource, '"mcp-protocol-version"');
      assert.include(mcpSource, '"tools/call"');
      assert.include(subagentSource, "export default function t3SubagentExtension");
      assert.include(subagentSource, "--session");
      assert.include(subagentSource, T3_PI_CHILD_SESSION_ROOT_ENV);
      // Children re-attach the T3 MCP extension so t3_thread_* tools survive
      // the nested spawn (T3_MCP_* env is inherited from the parent).
      assert.include(subagentSource, T3_PI_MCP_EXTENSION_PATH_ENV);
      assert.isFalse(subagentSource.includes("--no-session"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("discovers user and npm package extensions while skipping subagent overrides", () =>
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
        `${extensionsDir}/todos/index.ts`,
        `${lensDir}/src/index.ts`,
        `${authDir}/src/index.ts`,
        `${filteredDir}/src/index.ts`,
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
});
