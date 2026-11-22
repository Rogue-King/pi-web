import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";

const directory = await mkdtemp(join(tmpdir(), "pi-web-profiles-"));
const agentDir = join(directory, "agent");
const workspace = join(directory, "profile-switch");
const cwd = join(directory, "project");
for (const path of [agentDir, cwd, join(workspace, "profiles")]) await mkdir(path, { recursive: true });
Object.assign(process.env, {
  HOME: directory,
  PI_CODING_AGENT_DIR: agentDir,
  PI_PROFILE_SWITCH_DIR: workspace,
  PI_WEB_PROFILE: "pair",
  PI_OFFLINE: "1",
  PI_WEB_DISABLE_MCP: "1",
});
const packageRoot = dirname(createRequire(import.meta.url).resolve("pi-profile-switch/package.json"));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false, packages: [packageRoot] }));
const sharedSelection = JSON.stringify({ activeProfile: "pair" });
await writeFile(join(agentDir, "pi-profile-state.json"), sharedSelection);
await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
  one: { url: "http://127.0.0.1:1/one" }, two: { url: "http://127.0.0.1:1/two" },
} }));
await writeFile(join(workspace, "profiles/pair.json"), JSON.stringify({
  skills: [], tools: ["read"], mcps: ["one"], instructions: "PAIR_SENTINEL",
}));
await writeFile(join(workspace, "profiles/autonomous.json"), JSON.stringify({
  extensions: [], skills: [], tools: ["read", "write"], mcps: ["two"], instructions: "AUTO_SENTINEL",
}));
const jiti = createJiti(import.meta.url, { interopDefault: true, tsconfigPaths: true });
const { startRpcSession, setRpcSessionProfile } = await jiti.import("./rpc-manager.ts");
const { readSessionProfile, listSessionProfiles } = await jiti.import("./session-profile.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { GET: getProfiles } = await jiti.import("../app/api/profiles/route.ts");
const { POST: sendCommand } = await jiti.import("../app/api/agent/[id]/route.ts");
const { POST: createSession } = await jiti.import("../app/api/agent/new/route.ts");
const wrappers = [];
test.after(async () => {
  for (const wrapper of wrappers) await wrapper.shutdown();
  await rm(directory, { recursive: true, force: true });
});

async function start(file = "") {
  const { session: wrapper } = await startRpcSession(randomUUID(), file, file ? undefined : cwd);
  wrappers.push(wrapper);
  await wrapper.waitUntilReady();
  return wrapper;
}
async function command(wrapper, message) {
  const result = await wrapper.send({ type: "prompt", message });
  assert.notEqual(result?.success, false, JSON.stringify(result));
  const deadline = Date.now() + 10000;
  while (wrapper.isRunning()) {
    if (Date.now() > deadline) throw new Error("Profile command did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function selected(wrapper) {
  return readSessionProfile(wrapper.inner.sessionManager.getEntries());
}

test("concurrent chats isolate profile switches, reloads, overlays and global configuration", async () => {
  const settingsBefore = await readFile(join(agentDir, "settings.json"), "utf8");
  const [pair, autonomous] = await Promise.all([start(), start()]);
  assert.equal(selected(pair), "pair");
  assert.equal(selected(autonomous), "pair");
  const commands = (await pair.send({ type: "get_commands" })).commands;
  assert.equal(commands.filter((command) => command.name.startsWith("profile")).length, 1);
  const choices = await pair.send({ type: "get_profiles" });
  assert.equal(choices.active, "pair");
  assert.ok(choices.profiles.some((profile) => profile.name === "autonomous" && profile.available));
  assert.deepEqual(choices.diagnostics, []);
  await autonomous.send({ type: "set_profile", profile: "autonomous" });
  assert.equal((await autonomous.send({ type: "get_profiles" })).active, "autonomous");
  assert.equal((await pair.send({ type: "get_profiles" })).active, "pair");
  assert.equal(selected(autonomous), "autonomous");
  assert.equal(selected(pair), "pair");
  assert.match(autonomous.inner.systemPrompt, /AUTO_SENTINEL/);
  assert.doesNotMatch(autonomous.inner.systemPrompt, /PAIR_SENTINEL/);
  assert.match(pair.inner.systemPrompt, /PAIR_SENTINEL/);
  const toolsWithoutMcpGateways = (wrapper) => wrapper.inner.getActiveToolNames().filter((name) => !["codemode", "tool_search"].includes(name));
  assert.deepEqual(toolsWithoutMcpGateways(pair), ["read"]);
  assert.ok(autonomous.inner.getActiveToolNames().includes("write"));

  await Promise.all([
    command(pair, "/profile reload"),
    command(autonomous, "/profile overlay disable tool write"),
  ]);
  assert.deepEqual(toolsWithoutMcpGateways(autonomous), ["read"]);
  assert.deepEqual(toolsWithoutMcpGateways(pair), ["read"]);
  await command(autonomous, "/profile reload");
  assert.deepEqual(toolsWithoutMcpGateways(autonomous), ["read"]);
  await command(autonomous, "/profile overlay clear");
  assert.ok(autonomous.inner.getActiveToolNames().includes("write"));
  await assert.rejects(pair.send({ type: "set_profile", profile: "missing" }), /Unable to activate profile/);
  await command(pair, "/profile use missing");
  assert.equal(selected(pair), "pair");
  assert.match(pair.inner.systemPrompt, /PAIR_SENTINEL/);
  assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
  assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), settingsBefore);
  assert.equal(await readFile(join(agentDir, "pi-profile-state.json"), "utf8"), sharedSelection);
  assert.equal((await readdir(cwd)).includes(".pi"), false);
  const dirs = await readdir(join(workspace, "instances"));
  assert.equal(dirs.length, 2);
  const plans = await Promise.all(dirs.map(async (dir) => JSON.parse(await readFile(join(workspace, "instances", dir, "pi-profile.json"), "utf8"))));
  assert.deepEqual(plans.map((plan) => plan.profile).sort(), ["autonomous", "pair"]);
  for (let index = 0; index < dirs.length; index++) {
    const mcp = JSON.parse(await readFile(join(workspace, "instances", dirs[index], "mcp.json"), "utf8"));
    const enabled = Object.entries(mcp.mcpServers).filter(([, server]) => server.enabled !== false).map(([name]) => name);
    assert.deepEqual(enabled, plans[index].profile === "pair" ? ["one"] : ["two"]);
  }
  const autonomousDir = join(workspace, "instances", dirs[plans.findIndex((plan) => plan.profile === "autonomous")]);
  assert.equal((await lstat(join(autonomousDir, "pi-profile-state.json"))).isSymbolicLink(), false);
  await autonomous.shutdown();
  await writeFile(join(autonomousDir, "pid"), "999999999");
  const { sweepStaleInstances } = await jiti.import("pi-profile-switch/src/launcher/runtime-cleanup.ts");
  await sweepStaleInstances(agentDir);
  await assert.rejects(lstat(autonomousDir), { code: "ENOENT" });
  assert.equal(await readFile(join(agentDir, "pi-profile-state.json"), "utf8"), sharedSelection);
});

test("saved profile survives disposal and reopen without a network/model request", async () => {
  const wrapper = await start();
  await command(wrapper, "/profile use autonomous");
  const faux = fauxProvider({ models: [{ id: "profiles-test" }] });
  wrapper.inner.modelRuntime.registerNativeProvider(faux.provider);
  await wrapper.inner.setModel(faux.getModel("profiles-test"));
  faux.setResponses([fauxAssistantMessage([fauxText("saved")])]);
  await command(wrapper, "Persist this session");
  const file = wrapper.inner.sessionManager.getSessionFile();
  assert.ok(file);
  await wrapper.shutdown();
  const reopened = await start(file);
  assert.equal(selected(reopened), "autonomous");
  assert.equal((await reopened.send({ type: "get_profiles" })).active, "autonomous");
  assert.match(reopened.inner.systemPrompt, /AUTO_SENTINEL/);
  assert.doesNotMatch(reopened.inner.systemPrompt, /PAIR_SENTINEL/);
});

test("a deleted saved profile can be listed and replaced after startup fails without losing history", async () => {
  const manager = SessionManager.create(cwd);
  manager.appendCustomEntry("pi-profile-switch:profile", { version: 1, profile: "dev" });
  manager.appendMessage({ role: "user", content: "Keep this conversation", timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage([fauxText("History stays")]));
  const file = manager.getSessionFile();
  const id = manager.getSessionId();
  const before = await readFile(file, "utf8");
  const starting = startRpcSession(id, file, undefined);
  const replace = (profile) => sendCommand(new Request("http://localhost/api/agent/" + id, {
    method: "POST", body: JSON.stringify({ type: "set_profile", profile }),
  }), { params: Promise.resolve({ id }) });

  await assert.rejects(starting, /unknown profile: dev/);
  const catalog = await getProfiles(new Request("http://localhost/api/profiles?sessionId=" + id));
  assert.equal(catalog.status, 200);
  const choices = await catalog.json();
  assert.equal(choices.active, "dev");
  assert.ok(choices.profiles.some((profile) => profile.name === "pair" && profile.available));
  assert.equal(await readFile(file, "utf8"), before);

  assert.equal((await replace("../settings")).status, 500);
  assert.equal((await replace("missing")).status, 500);
  assert.equal(await readFile(file, "utf8"), before);
  const response = await replace("pair");
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal((await response.json()).data.active, "pair");
  const { session } = await startRpcSession(id, file, undefined);
  wrappers.push(session);
  assert.equal(selected(session), "pair");
  assert.equal(session.inner.sessionId, id);
  assert.equal(session.sessionFile, file);
  assert.deepEqual(session.inner.messages.filter((message) => message.role === "user").map((message) => message.content), ["Keep this conversation"]);
  await session.shutdown();
  assert.equal(selected(await start(file)), "pair");
  assert.equal(await readFile(join(agentDir, "pi-profile-state.json"), "utf8"), sharedSelection);
});

test("recovery waits out an already-starting stale profile", async () => {
  const manager = SessionManager.create(cwd);
  manager.appendCustomEntry("pi-profile-switch:profile", { version: 1, profile: "dev" });
  manager.appendMessage({ role: "user", content: "A racing start", timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage([fauxText("Keep me")]));
  const id = manager.getSessionId();
  const file = manager.getSessionFile();
  const failed = assert.rejects(startRpcSession(id, file, undefined), /unknown profile: dev/);
  const recovering = setRpcSessionProfile(id, file, "pair");
  await failed;
  assert.equal((await recovering).active, "pair");
  const { session } = await startRpcSession(id, file, undefined);
  wrappers.push(session);
  assert.equal(session.inner.sessionId, id);
});

test("a profile stuck in session_start can be replaced without waiting for its initializer", async (t) => {
  const extensionsDir = join(agentDir, "extensions");
  await mkdir(extensionsDir, { recursive: true });
  const extensionFile = join(extensionsDir, "stuck-profile.ts");
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  globalThis.__profileStartupEntered = () => entered.resolve();
  globalThis.__profileStartupRelease = release.promise;
  await writeFile(extensionFile, `export default function(pi) {
    pi.on("session_start", async (_, ctx) => {
      globalThis.__profileStartupEntered();
      await globalThis.__profileStartupRelease;
      ctx.ui.notify("startup released");
    });
  }`);
  t.after(async () => {
    release.resolve();
    delete globalThis.__profileStartupEntered;
    delete globalThis.__profileStartupRelease;
    await rm(extensionFile);
  });
  const manager = SessionManager.create(cwd);
  manager.appendCustomEntry("pi-profile-switch:profile", { version: 1, profile: "pair" });
  manager.appendMessage({ role: "user", content: "Startup must not trap this conversation", timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage([fauxText("Keep the transcript")]));
  const id = manager.getSessionId();
  const file = manager.getSessionFile();
  const { session: stuck } = await startRpcSession(id, file, undefined);
  wrappers.push(stuck);
  await entered.promise;
  const readiness = assert.rejects(stuck.waitUntilReady(), /Session closed during startup/);
  assert.equal((await setRpcSessionProfile(id, file, "autonomous")).active, "autonomous");
  await readiness;
  const { session: recovered } = await startRpcSession(id, file, undefined);
  wrappers.push(recovered);
  assert.notEqual(recovered, stuck);
  assert.equal(recovered.inner.sessionId, id);
  assert.equal(recovered.sessionFile, file);
  assert.equal(selected(recovered), "autonomous");
  assert.equal(recovered.inner.messages.filter((message) => message.role === "user").length, 1);
});

test("a new chat can choose a profile before an invalid launch default starts", async () => {
  const previous = process.env.PI_WEB_PROFILE;
  process.env.PI_WEB_PROFILE = "dev";
  try {
    const catalog = await getProfiles(new Request("http://localhost/api/profiles?cwd=" + encodeURIComponent(cwd)));
    assert.equal(catalog.status, 200);
    assert.ok((await catalog.json()).profiles.some((profile) => profile.name === "autonomous" && profile.available));
    const response = await createSession(new Request("http://localhost/api/agent/new", {
      method: "POST", body: JSON.stringify({ cwd, type: "ensure_session", profile: "autonomous" }),
    }));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const { sessionId } = await response.json();
    const { session } = await startRpcSession(sessionId, "", cwd);
    wrappers.push(session);
    assert.equal(selected(session), "autonomous");
    assert.equal(session.inner.messages.filter((message) => message.role === "user").length, 0);
  } finally {
    process.env.PI_WEB_PROFILE = previous;
  }
});

test("profile selection waits for an active response without aborting it or sending a prompt", async () => {
  const wrapper = await start();
  const faux = fauxProvider({ models: [{ id: "profiles-wait" }] });
  wrapper.inner.modelRuntime.registerNativeProvider(faux.provider);
  await wrapper.inner.setModel(faux.getModel("profiles-wait"));
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  faux.setResponses([async () => {
    entered.resolve();
    await release.promise;
    return fauxAssistantMessage([fauxText("Finished normally")]);
  }]);
  await wrapper.send({ type: "prompt", message: "Finish first" });
  await entered.promise;
  const switching = wrapper.send({ type: "set_profile", profile: "autonomous" });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(selected(wrapper), "pair");
    assert.equal(wrapper.inner.isStreaming, true);
  } finally {
    release.resolve();
  }
  assert.equal((await switching).active, "autonomous");
  const prompts = wrapper.inner.messages.filter((message) => message.role === "user");
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0].content, [{ type: "text", text: "Finish first" }]);
  assert.match(wrapper.inner.systemPrompt, /AUTO_SENTINEL/);
});

for (const intercepted of [false, true]) {
  test(`profile selection waits for a composer shell command (${intercepted ? "user_bash handler" : "executeBash"})`, async () => {
    const wrapper = await start();
    const target = intercepted ? wrapper.inner.extensionRunner : wrapper.inner;
    const method = intercepted ? "emitUserBash" : "executeBash";
    const original = target[method];
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    target[method] = async () => {
      entered.resolve();
      await release.promise;
      const result = { output: "", exitCode: 0, cancelled: false, truncated: false };
      return intercepted ? { result } : result;
    };
    const shell = wrapper.send({ type: "bash", command: "controlled fixture" });
    await entered.promise;
    const switching = wrapper.send({ type: "set_profile", profile: "autonomous" });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(selected(wrapper), "pair");
    } finally {
      release.resolve();
      target[method] = original;
    }
    await shell;
    assert.equal((await switching).active, "autonomous");
  });
}

test("a chat-only session cannot acquire profiles through the recovery API", async () => {
  const manager = SessionManager.create(cwd);
  manager.appendCustomEntry("pi-web:tool-selection", { version: 1, tools: [] });
  manager.appendMessage({ role: "user", content: "Chat only", timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage([fauxText("No tools")]));
  const id = manager.getSessionId();
  const file = manager.getSessionFile();
  const before = await readFile(file, "utf8");
  const response = await getProfiles(new Request("http://localhost/api/profiles?sessionId=" + id));
  assert.deepEqual(await response.json(), { profiles: [], diagnostics: [] });
  await assert.rejects(setRpcSessionProfile(id, file, "autonomous"), /Profiles are unavailable/);
  assert.equal(await readFile(file, "utf8"), before);
});

test("untrusted project profiles cannot replace global profiles", async () => {
  await mkdir(join(cwd, ".pi/profiles"), { recursive: true });
  await writeFile(join(cwd, ".pi/profiles/pair.json"), JSON.stringify({ instructions: "UNTRUSTED_SENTINEL" }));
  const wrapper = await start();
  assert.match(wrapper.inner.systemPrompt, /PAIR_SENTINEL/);
  assert.doesNotMatch(wrapper.inner.systemPrompt, /UNTRUSTED_SENTINEL/);
  await writeFile(join(cwd, ".pi/profiles/project-only.json"), JSON.stringify({ instructions: "PRIVATE" }));
  await writeFile(join(workspace, "profiles/broken.json"), "{");
  const choices = await wrapper.send({ type: "get_profiles" });
  assert.equal(choices.profiles.find((profile) => profile.name === "pair").source, "global");
  assert.equal(choices.profiles.some((profile) => profile.name === "project-only"), false);
  assert.equal(choices.profiles.find((profile) => profile.name === "broken").available, false);
  await assert.rejects(wrapper.send({ type: "set_profile", profile: "project-only" }), /Unable to activate profile/);
  assert.equal(selected(wrapper), "pair");
});

test("catalog uses the launch default before startup, and no choices without integration", async () => {
  assert.equal((await listSessionProfiles(undefined, cwd)).active, "pair");
  const previous = process.env.PI_WEB_PROFILE;
  delete process.env.PI_WEB_PROFILE;
  try {
    assert.deepEqual(await listSessionProfiles({ getEntries: () => [] }, cwd), { profiles: [], diagnostics: [] });
  } finally {
    process.env.PI_WEB_PROFILE = previous;
  }
});

test("malformed saved profiles fail closed", () => {
  assert.throws(() => readSessionProfile([{ type: "custom", customType: "pi-profile-switch:profile", data: { version: 1, profile: "../../settings" } }]), /Invalid saved/);
});
