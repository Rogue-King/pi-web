import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("useAgentSession.ts", readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function callback(name, scope) {
  let found;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) found = node.initializer.arguments[0];
    else ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(found, name);
  const code = ts.transpileModule("(" + found.getText(source) + ")", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(code, scope);
}

test("profile catalog reads never start an agent, with or without a session", async () => {
  for (const id of [null, "old-session"]) {
    const urls = [];
    const load = callback("loadProfiles", {
      sessionIdRef: { current: id }, newSessionCwd: "/a project", encodeURIComponent,
      fetch: async (url) => { urls.push(url); return { ok: true, json: async () => ({ active: "dev", profiles: [] }) }; },
    });
    assert.equal((await load()).active, "dev");
    assert.deepEqual(urls, [id ? "/api/profiles?sessionId=old-session" : "/api/profiles?cwd=%2Fa%20project"]);
  }
});

test("profile selection bypasses prompt submission and initializes a fresh chat with the chosen name", async () => {
  for (const id of [null, "old-session"]) {
    const calls = [];
    const sessionIdRef = { current: id };
    const state = { systemPrompt: "NEW_PROFILE", extensionStatuses: [], extensionWidgets: [] };
    const change = callback("handleProfileChange", {
      sessionIdRef, sessionHookMountedRef: { current: true },
      ensureNewSession: async (profile) => { calls.push(["create", profile]); sessionIdRef.current = "new-session"; return "new-session"; },
      sendAgentCommand: async (sid, command) => { calls.push([sid, command.type, command.profile]); return state; },
      clearSlashCommands() {}, loadTools: async () => {},
      setSystemPrompt() {}, syncLiveModel() {}, setExtensionStatuses() {}, setExtensionWidgets() {},
    });
    await change("pair");
    if (!id) assert.deepEqual(calls.shift(), ["create", "pair"]);
    assert.deepEqual(calls, [[id ?? "new-session", "set_profile", "pair"], [id ?? "new-session", "get_state", undefined]]);
  }
});
