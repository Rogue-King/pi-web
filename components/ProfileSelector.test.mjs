import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("ProfileSelector.tsx", readFileSync(new URL("./ProfileSelector.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === "ProfileSelector");
const code = ts.transpileModule(component.getText(source), {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

// Exercise the real component callbacks with deterministic hook state; no DOM or network.
function harness(loadProfiles, { mobile = false, select } = {}) {
  const slots = [];
  let cursor = 0;
  const selected = [];
  const hook = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = initial;
    return [slots[index], (value) => { slots[index] = value; }];
  };
  const context = {
    exports: {},
    React: { Fragment: "fragment", createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) },
    useState: hook,
    useRef: (value) => hook({ current: value })[0],
    useI18n: () => ({ t: (key) => key }),
    useIsMobile: () => mobile,
    SidebarMenu: "menu",
    Error,
  };
  vm.runInNewContext(code, context);
  const render = () => {
    cursor = 0;
    const tree = context.exports.ProfileSelector({ loadProfiles, onSelect: async (name) => { selected.push(name); await select?.(name); }, showLabel: true, isStrayClick: () => false });
    const button = tree.children[0];
    button.props.ref.current = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 32 }) };
    return { button: button.props, menu: tree.children[1].props };
  };
  return { render, selected };
}
const choices = { active: "pair", diagnostics: [], profiles: [
  { name: "pair", source: "global", available: true },
  { name: "review", source: "global", available: true },
  { name: "broken", source: "global", available: false, error: "Invalid profile" },
] };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test("picker loads on demand, marks active, refuses unavailable, and selects by name", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return choices; }, { mobile: true });
  assert.equal(calls, 0);
  h.render().button.onClick({});
  assert.equal(h.render().menu.items[0].label, "sessionPanel.loading");
  await settle();
  const { menu } = h.render();
  assert.equal(menu.sheet, true);
  assert.equal(menu.items[0].checked, true);
  menu.items[0].onSelect();
  assert.equal(menu.items[2].disabled, true);
  menu.items[2].onSelect();
  assert.deepEqual(h.selected, []);
  menu.items[1].onSelect({ keepOpen() {} });
  assert.deepEqual(h.selected, ["review"]);
  menu.onClose("escape");
  assert.equal(h.render().button["aria-expanded"], false);
});

test("a pending switch stays open and disabled, and a failure leaves choices available", async () => {
  let rejectSwitch;
  const h = harness(async () => choices, { select: () => new Promise((_, reject) => { rejectSwitch = reject; }) });
  h.render().button.onClick({});
  await settle();
  let keptOpen = false;
  h.render().menu.items[1].onSelect({ keepOpen() { keptOpen = true; } });
  const pending = h.render();
  assert.equal(keptOpen, true);
  assert.equal(pending.button["aria-expanded"], true);
  assert.ok(pending.menu.items.every((item) => item.disabled));
  assert.equal(pending.menu.footer.children[0], "chat.profilesSwitching");
  rejectSwitch(new Error("Activation failed"));
  await new Promise((resolve) => setImmediate(resolve));
  const failed = h.render();
  assert.equal(failed.button["aria-expanded"], true);
  assert.equal(failed.menu.items[1].disabled, false);
  assert.equal(failed.menu.footer.children[0], "Activation failed");
});

test("picker errors offer retry and closed requests cannot replace reopened data", async () => {
  let resolveOld;
  let calls = 0;
  const h = harness(() => {
    calls++;
    if (calls === 1) return Promise.reject(new Error("Cannot read profiles"));
    if (calls === 2) return new Promise((resolve) => { resolveOld = resolve; });
    return Promise.resolve(choices);
  });
  h.render().button.onClick({});
  await settle();
  const retry = h.render().menu.items.find((item) => item.id === "retry");
  assert.ok(retry);
  retry.onSelect({ keepOpen() {} });
  h.render().menu.onClose("outside");
  h.render().button.onClick({});
  await settle();
  resolveOld({ profiles: [], diagnostics: [] });
  await settle();
  assert.equal(h.render().menu.items[0].id, "pair");
});
