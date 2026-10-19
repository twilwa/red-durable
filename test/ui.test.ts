import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// A deliberately small DOM fixture for event/state regression tests. This does
// not model layout, CSS, or a browser, and does not establish a visual QA pass.
class Element {
  tagName: string;
  id = "";
  value = "";
  hidden = false;
  disabled = false;
  open = false;
  checked = false;
  tabIndex = 0;
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  childNodes: (Element | string)[] = [];
  parentElement: Element | null = null;
  listeners: Record<string, ((event: any) => unknown)[]> = {};
  onclick?: (event?: any) => unknown;
  onsubmit?: (event?: any) => unknown;
  oninput?: (event?: any) => unknown;
  onkeydown?: (event?: any) => unknown;
  ontoggle?: (event?: any) => unknown;
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 900;
  selectionStart = 0;
  selectionEnd = 0;
  ownerDocument: any;
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
  }
  get children() {
    return this.childNodes.filter((node) => node instanceof Element);
  }
  get textContent(): string {
    return this.childNodes
      .map((node) => (typeof node === "string" ? node : node.textContent))
      .join("");
  }
  set textContent(value: string) {
    this.replaceChildren(String(value));
  }
  get options() {
    return this.children.filter((node) => node.tagName === "OPTION");
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastElementChild() {
    return this.children.at(-1) ?? null;
  }
  get isConnected(): boolean {
    return this.parentElement !== null;
  }
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (...names: string[]) => {
      this.className = [
        ...new Set([...this.className.split(/\s+/).filter(Boolean), ...names]),
      ].join(" ");
    },
    remove: (...names: string[]) => {
      this.className = this.className
        .split(/\s+/)
        .filter((name) => !names.includes(name))
        .join(" ");
    },
    toggle: (name: string, force?: boolean) => {
      const include = force ?? !this.classList.contains(name);
      if (include) this.classList.add(name);
      else this.classList.remove(name);
      return include;
    },
  };
  append(...nodes: (Element | string)[]) {
    for (const node of nodes) {
      if (node instanceof Element) node.parentElement = this;
      this.childNodes.push(node);
    }
  }
  appendChild(node: Element) {
    this.append(node);
    return node;
  }
  prepend(...nodes: (Element | string)[]) {
    const old = [...this.childNodes];
    this.replaceChildren(...nodes, ...old);
  }
  replaceChildren(...nodes: (Element | string)[]) {
    for (const node of this.children) node.parentElement = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name === "id") this.id = String(value);
    if (name === "class") this.className = String(value);
    if (name === "value") this.value = String(value);
    if (name === "tabindex") this.tabIndex = Number(value);
    if (name === "hidden") this.hidden = true;
    if (name === "disabled") this.disabled = true;
    if (name.startsWith("data-"))
      this.dataset[
        name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      ] = String(value);
  }
  getAttribute(name: string) {
    if (name === "class") return this.className;
    if (name === "tabindex") return String(this.tabIndex);
    if (name.startsWith("data-"))
      return (
        this.dataset[
          name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        ] ?? null
      );
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === "hidden") this.hidden = false;
    if (name === "disabled") this.disabled = false;
  }
  matches(selector: string) {
    const attr = selector.match(/\[([^=\]]+)(?:=["']?([^\]"']*)["']?)?\]/);
    if (
      attr &&
      (this.getAttribute(attr[1]) === null ||
        (attr[2] !== undefined && this.getAttribute(attr[1]) !== attr[2]))
    )
      return false;
    const simple = selector.replace(/\[[^\]]+\]/g, "");
    if (simple.startsWith("#")) return this.id === simple.slice(1);
    if (simple.startsWith(".")) return this.classList.contains(simple.slice(1));
    return (
      !simple ||
      simple === "*" ||
      this.tagName.toLowerCase() === simple.toLowerCase()
    );
  }
  querySelectorAll(selector: string): Element[] {
    const selectors = selector.split(",").map((part) => part.trim());
    return this.children.flatMap((child) => [
      ...(selectors.some((part) => child.matches(part)) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  closest(selector: string): Element | null {
    return this.matches(selector)
      ? this
      : (this.parentElement?.closest(selector) ?? null);
  }
  contains(node: Element): boolean {
    return this === node || this.children.some((child) => child.contains(node));
  }
  addEventListener(name: string, fn: (event: any) => unknown) {
    (this.listeners[name] ??= []).push(fn);
  }
  removeEventListener(name: string, fn: (event: any) => unknown) {
    this.listeners[name] = (this.listeners[name] ?? []).filter(
      (item) => item !== fn,
    );
  }
  dispatchEvent(event: any) {
    event.target ??= this;
    const handler = (this as any)["on" + event.type];
    handler?.(event);
    for (const listener of this.listeners[event.type] ?? []) listener(event);
    return true;
  }
  click() {
    if (!this.disabled)
      this.dispatchEvent({ type: "click", preventDefault() {} });
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  scrollTo(options: any) {
    this.scrollTop = options.top ?? 0;
  }
  scrollIntoView() {}
  setSelectionRange(start: number, end: number) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  requestSubmit() {
    this.dispatchEvent({ type: "submit", preventDefault() {} });
  }
}
function dom() {
  const nodes = new Map<string, Element>();
  const root = new Element("document");
  const document: any = {
    activeElement: null,
    getElementById: (id: string) => nodes.get(id) ?? null,
    createElement: (tag: string) => {
      const node = new Element(tag);
      node.ownerDocument = document;
      return node;
    },
    createTextNode: (text: string) => String(text),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    querySelector: (selector: string) => root.querySelector(selector),
    addEventListener: (...args: any[]) =>
      (root.addEventListener as any)(...args),
    dispatchEvent: (event: any) => root.dispatchEvent(event),
  };
  const stack = [root];
  const html = readFileSync(
    new URL("../public/index.html", import.meta.url),
    "utf8",
  );
  for (const token of html.matchAll(
    /<!--[\s\S]*?-->|<![^>]+>|<\/[^>]+>|<[\w-]+\b[^>]*>|[^<]+/g,
  )) {
    const text = token[0];
    if (text.startsWith("<!")) continue;
    if (text.startsWith("</")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const start = text.match(/^<([\w-]+)\b([^>]*)>/);
    if (!start) {
      stack.at(-1)!.append(text);
      continue;
    }
    const node = document.createElement(start[1]);
    for (const attribute of start[2].matchAll(
      /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
    ))
      node.setAttribute(
        attribute[1],
        attribute[2] ?? attribute[3] ?? attribute[4] ?? "",
      );
    if (node.id) nodes.set(node.id, node);
    stack.at(-1)!.append(node);
    if (
      !/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(
        start[1],
      ) &&
      !text.endsWith("/>")
    )
      stack.push(node);
  }
  document.body = root.querySelector("body");
  document.documentElement = root.querySelector("html");
  return { document, nodes };
}
function app(fetcher: typeof fetch) {
  const { document, nodes } = dom();
  const confirmations: string[] = [];
  let allowConfirmation = false;
  const intervalCallbacks = new Map<number, () => unknown>();
  const intervalDelays = new Map<number, number>();
  let timer = 0;
  let mobile = false;
  const matchMedia = () => ({
    matches: mobile,
    addEventListener() {},
    removeEventListener() {},
  });
  const windowListeners: Record<string, ((event: any) => unknown)[]> = {};
  const window = {
    location: { hostname: "127.0.0.1" },
    innerWidth: 1440,
    matchMedia,
    addEventListener(name: string, fn: (event: any) => unknown) {
      (windowListeners[name] ??= []).push(fn);
    },
    removeEventListener() {},
  };
  const context = vm.createContext({
    document,
    window,
    fetch: fetcher,
    crypto,
    Date,
    JSON,
    Error,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    URL,
    AbortController,
    encodeURIComponent,
    HTMLElement: Element,
    Element,
    matchMedia,
    confirm: (message: string) => {
      confirmations.push(message);
      return allowConfirmation;
    },
    setInterval: (fn: () => unknown, delay: number) => {
      const id = ++timer;
      intervalCallbacks.set(id, fn);
      intervalDelays.set(id, delay);
      return id;
    },
    clearInterval: (id: number) => {
      intervalCallbacks.delete(id);
      intervalDelays.delete(id);
    },
    setTimeout: () => ++timer,
    clearTimeout() {},
    requestAnimationFrame: (fn: () => void) => {
      fn();
      return 1;
    },
  });
  for (const file of ["api.js", "app.js"])
    vm.runInContext(
      readFileSync(new URL("../public/" + file, import.meta.url), "utf8"),
      context,
      { filename: file },
    );
  return {
    context,
    nodes,
    document,
    confirmations,
    intervalCallbacks,
    intervalDelays,
    emitWindow: (name: string, event = {}) => {
      for (const listener of windowListeners[name] ?? []) listener(event);
    },
    allowConfirmation: (value: boolean) => {
      allowConfirmation = value;
    },
    setMobile: (value: boolean) => {
      mobile = value;
    },
    get: (id: string) => {
      const node = nodes.get(id);
      assert.ok(node, "Missing actual HTML element #" + id);
      return node;
    },
    run: (code: string) => vm.runInContext(code, context),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
const state = (overrides: Record<string, unknown> = {}) => ({
  inference: {
    mode: "subscription",
    models: ["fixture-model"],
    selected: "fixture-model",
    lastSeen: Date.now(),
    jobs: [],
    failures: [],
  },
  history: [],
  historyHasMore: false,
  pending: [],
  memory: { messages: 0, viewBytes: 0 },
  releases: [],
  active: null,
  ...overrides,
});
const companion = (version = 1, text = "Saved charter") => ({
  charter: { version, text, recordedAt: "2026-10-12T00:00:00Z" },
  beliefs: [],
  commitments: [],
  authorization: "Evidence is not permission.",
});
function fixture(
  handler?: (
    path: string,
    body: any,
    init: RequestInit,
  ) => Response | Promise<Response> | undefined,
) {
  const calls: { path: string; body: any; init: RequestInit }[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const path = String(input).replace(/^\/api\//, "");
    const body =
      typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path, body, init });
    const custom = handler?.(path, body, init);
    if (custom !== undefined) return await custom;
    if (path === "state") return Response.json(state());
    if (path === "providers")
      return Response.json({
        available: false,
        message: "Provider setup is available on the local bridge UI.",
      });
    if (path === "companion") return Response.json(companion());
    if (path === "skills") return Response.json({ skills: [], telemetry: {} });
    if (path === "source")
      return Response.json({ source: "export class MutableAgent {}" });
    if (path === "memory")
      return Response.json({ view: "Synthetic memory", stats: {} });
    return Response.json({});
  }) as typeof fetch;
  return { ...app(fetcher), calls };
}
async function connect(
  ui: ReturnType<typeof fixture>,
  session = "fixture-session",
) {
  ui.get("token").value = "synthetic-owner-token-never-a-real-credential";
  ui.get("session").value = session;
  ui.get("connect").requestSubmit();
  await settle();
}
function input(node: Element, value: string) {
  node.value = value;
  node.dispatchEvent({ type: "input", preventDefault() {} });
}
function buttons(node: Element) {
  return node.querySelectorAll("button");
}

// Register the lock before the caller's await continuation. Unlike delaying
// fetch, this runs after RedClient has already accepted the response generation.
function lockAfterFulfillment(ui: ReturnType<typeof fixture>, target: string) {
  ui.run(`(() => {
    const original = ${target}.bind(${target.startsWith("client.") ? "client" : "null"});
    ${target} = (...args) => {
      const request = original(...args);
      request.then(() => lock(), () => {});
      return request;
    };
  })()`);
}
function assertLocked(ui: ReturnType<typeof fixture>) {
  assert.equal(ui.run("ui.connected"), false);
  assert.equal(ui.run("ui.connecting"), false);
  assert.equal(ui.run("ui.latest"), null);
  assert.equal(ui.run("ui.companion"), null);
  assert.equal(ui.run("ui.skills.length"), 0);
  assert.equal(ui.run("ui.lastSubmission"), null);
  assert.equal(ui.run("ui.sourceBaseline"), "");
  assert.equal(ui.run("ui.charterBaseline"), "");
  assert.equal(ui.run("ui.charterVersion"), 0);
  assert.equal(ui.run("ui.charterRemote"), null);
  assert.equal(ui.get("workspace").hidden, true);
  assert.equal(ui.get("login").hidden, false);
  assert.equal(ui.get("inspector").hidden, true);
  assert.equal(ui.intervalCallbacks.size, 0);
  for (const id of ["token", "prompt", "source", "description", "charter"])
    assert.equal(ui.get(id).value, "", id);
  for (const id of [
    "messages",
    "beliefs",
    "commitments",
    "skillPanel",
    "revisions",
    "memoryView",
    "runtimeDetails",
    "notice",
    "error",
  ])
    assert.equal(ui.get(id).textContent, "", id);
}

// Tests below use only synthetic API fixtures; there is no live account/model.
test("owner client keeps credentials in headers and rejects responses after a session change", async () => {
  const pending = deferred<Response>();
  const ui = fixture((path) =>
    path === "state" ? pending.promise : undefined,
  );
  ui.run("client.connect('synthetic-owner', 'fixture-old')");
  const request = ui.run("client.state()");
  const rejected = assert.rejects(request, /Session changed/);
  assert.equal(ui.calls[0].path, "state");
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[0].init.headers)), {
    Authorization: "Bearer synthetic-owner",
    "X-Session": "fixture-old",
  });
  assert.equal(ui.calls[0].init.cache, "no-store");
  ui.run("client.clear()");
  assert.equal(ui.calls[0].init.signal?.aborted, true);
  pending.resolve(
    Response.json(
      state({
        history: [
          {
            id: 1,
            kind: "user",
            text: "Old private conversation",
            date: "2026-10-12",
          },
        ],
      }),
    ),
  );
  await rejected;
});

test("connect opens the conversation, clears the token input, and lock erases private UI and drafts", async () => {
  const ui = fixture((path) =>
    path === "state"
      ? Response.json(
          state({
            history: [
              {
                id: 1,
                kind: "user",
                text: "Synthetic private conversation",
                date: "2026-10-12",
              },
            ],
          }),
        )
      : undefined,
  );
  await connect(ui);
  assert.equal(ui.get("workspace").hidden, false);
  assert.equal(ui.get("login").hidden, true);
  assert.equal(ui.get("token").value, "");
  assert.match(
    ui.get("messages").textContent,
    /Synthetic private conversation/,
  );
  await ui.run("openInspector('continuity')");
  for (const id of [
    "source",
    "description",
    "prompt",
    "charter",
    "memorySearch",
  ])
    input(ui.get(id), "Synthetic private draft");
  for (const id of ["memoryView", "runtimeDetails"])
    ui.get(id).textContent = "Synthetic private details";
  ui.get("disconnect").click();
  assert.equal(ui.get("workspace").hidden, true);
  assert.equal(ui.get("login").hidden, false);
  for (const id of [
    "source",
    "description",
    "prompt",
    "charter",
    "memorySearch",
    "token",
  ])
    assert.equal(ui.get(id).value, "", id);
  for (const id of [
    "messages",
    "beliefs",
    "commitments",
    "skillPanel",
    "revisions",
    "connectionDetails",
    "memoryView",
    "runtimeDetails",
  ])
    assert.equal(ui.get(id).textContent, "", id);
  assert.equal(ui.get("inspector").hidden, true);
  assert.equal(ui.get("navigation").hidden, true);
  assert.equal(ui.intervalCallbacks.size, 0);
  assert.equal(ui.run("ui.latest"), null);
  assert.equal(ui.run("ui.charterVersion"), 0);
  assert.equal(ui.run("ui.lastSubmission"), null);
});

test("locking invalidates delayed state and continuity views", async () => {
  const oldState = deferred<Response>();
  const oldCompanion = deferred<Response>();
  let delayed = false;
  const ui = fixture((path) =>
    delayed && path === "state"
      ? oldState.promise
      : delayed && path === "companion"
        ? oldCompanion.promise
        : undefined,
  );
  await connect(ui);
  delayed = true;
  const refresh = ui.get("refresh").onclick!();
  const continuity = ui.run("openInspector('continuity')");
  ui.get("disconnect").click();
  oldState.resolve(
    Response.json(
      state({
        history: [
          {
            id: 1,
            kind: "user",
            text: "Old session content",
            date: "2026-10-12",
          },
        ],
      }),
    ),
  );
  oldCompanion.resolve(Response.json(companion(8, "Old session charter")));
  await Promise.all([refresh, continuity]);
  assert.equal(ui.get("messages").textContent, "");
  assert.equal(ui.get("charter").value, "");
  assert.equal(ui.get("error").textContent, "");
  assert.equal(ui.get("workspace").hidden, true);
  assert.equal(ui.run("ui.companion"), null);
});

test("repeated send clicks admit once and preserve a newer prompt typed during admission", async () => {
  const pending = deferred<Response>();
  const ui = fixture((path) => (path === "chat" ? pending.promise : undefined));
  await connect(ui);
  input(ui.get("prompt"), "First fixture message");
  const sending = ui.get("composer").onsubmit!({ preventDefault() {} });
  ui.get("composer").requestSubmit();
  assert.equal(ui.calls.filter((call) => call.path === "chat").length, 1);
  assert.equal(ui.get("send").disabled, true);
  input(ui.get("prompt"), "A newer unsent draft");
  pending.resolve(Response.json({ accepted: true }, { status: 202 }));
  await sending;
  assert.equal(ui.get("prompt").value, "A newer unsent draft");
  assert.equal(ui.get("send").disabled, false);
  assert.equal(ui.run("ui.lastSubmission"), "First fixture message");
});

test("failed admissions retry the same request ID until the prompt changes", async () => {
  const ui = fixture((path) =>
    path === "chat"
      ? Response.json({ error: "Fixture bridge unavailable" }, { status: 503 })
      : undefined,
  );
  await connect(ui);
  input(ui.get("prompt"), "Retry this synthetic message");
  await ui.get("composer").onsubmit!({ preventDefault() {} });
  await ui.get("composer").onsubmit!({ preventDefault() {} });
  let chats = ui.calls.filter((call) => call.path === "chat");
  assert.equal(chats.length, 2);
  assert.equal(chats[0].body.id, chats[1].body.id);
  assert.equal(ui.get("prompt").value, "Retry this synthetic message");
  input(ui.get("prompt"), "A different synthetic message");
  await ui.get("composer").onsubmit!({ preventDefault() {} });
  chats = ui.calls.filter((call) => call.path === "chat");
  assert.notEqual(chats[2].body.id, chats[0].body.id);
  assert.match(ui.get("error").textContent, /Fixture bridge unavailable/);
});

test("old-session send completion cannot release a new session's admission guard", async () => {
  const oldRequest = deferred<Response>();
  const newRequest = deferred<Response>();
  let sends = 0;
  const ui = fixture((path) =>
    path === "chat"
      ? ++sends === 1
        ? oldRequest.promise
        : newRequest.promise
      : undefined,
  );
  await connect(ui, "fixture-old");
  input(ui.get("prompt"), "Old request");
  const oldSend = ui.get("composer").onsubmit!({ preventDefault() {} });
  ui.get("disconnect").click();
  await connect(ui, "fixture-new");
  input(ui.get("prompt"), "New request");
  const newSend = ui.get("composer").onsubmit!({ preventDefault() {} });
  oldRequest.resolve(Response.json({ accepted: true }, { status: 202 }));
  await oldSend;
  assert.equal(ui.run("ui.submitting"), true);
  assert.equal(ui.get("prompt").value, "New request");
  ui.get("composer").requestSubmit();
  assert.equal(sends, 2);
  newRequest.resolve(Response.json({ accepted: true }, { status: 202 }));
  await newSend;
  assert.equal(ui.run("ui.submitting"), false);
  assert.equal(ui.get("prompt").value, "");
});

test("charter drafts survive navigation and remote version changes without silently rebasing", async () => {
  let remote = companion(2, "Saved fixture charter");
  const ui = fixture((path, body) =>
    path === "companion" && !body ? Response.json(remote) : undefined,
  );
  await connect(ui);
  await ui.run("openInspector('continuity')");
  input(ui.get("charter"), "Unsaved owner draft");
  await ui.run("openInspector('skills')");
  await ui.run("openInspector('continuity')");
  assert.equal(ui.get("charter").value, "Unsaved owner draft");
  assert.equal(ui.run("ui.charterVersion"), 2);
  assert.equal(ui.get("saveCharter").disabled, false);
  remote = companion(3, "Changed in a different tab");
  await ui.run("loadContinuity()");
  assert.equal(ui.get("charter").value, "Unsaved owner draft");
  assert.equal(ui.run("ui.charterVersion"), 2);
  assert.equal(ui.run("ui.charterConflict"), true);
  assert.equal(ui.get("saveCharter").disabled, true);
  ui.get("resetCharter").click();
  assert.equal(ui.get("charter").value, "Unsaved owner draft");
  ui.allowConfirmation(true);
  ui.get("resetCharter").click();
  assert.equal(ui.get("charter").value, "Changed in a different tab");
  assert.equal(ui.run("ui.charterVersion"), 3);
  assert.equal(ui.run("ui.charterConflict"), false);
});

test("charter saves use the reviewed version and keep edits typed while saving", async () => {
  const save = deferred<Response>();
  let remote = companion(2, "Saved fixture charter");
  const ui = fixture((path, body) =>
    path === "companion"
      ? body
        ? save.promise
        : Response.json(remote)
      : undefined,
  );
  await connect(ui);
  await ui.run("openInspector('continuity')");
  input(ui.get("charter"), "Submitted charter draft");
  const saving = ui.get("saveCharter").onclick!();
  ui.get("saveCharter").onclick!();
  input(ui.get("charter"), "A newer charter edit");
  const writes = ui.calls.filter(
    (call) => call.path === "companion" && call.body,
  );
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, {
    action: "charter",
    text: "Submitted charter draft",
    expectedVersion: 2,
  });
  remote = companion(3, "Submitted charter draft");
  save.resolve(Response.json(remote.charter));
  await saving;
  assert.equal(ui.get("charter").value, "A newer charter edit");
  assert.equal(ui.run("ui.charterVersion"), 3);
  assert.equal(ui.run("ui.charterBaseline"), "Submitted charter draft");
  assert.equal(ui.run("ui.charterDirty"), true);
  assert.equal(ui.get("saveCharter").disabled, false);
});

test("a stale charter rejection preserves the draft and loads the new version only on request", async () => {
  let remote = companion(2, "Saved fixture charter");
  const ui = fixture((path, body) => {
    if (path !== "companion") return;
    if (!body) return Response.json(remote);
    remote = companion(3, "Other tab's accepted charter");
    return Response.json({ error: "Stale charter version" }, { status: 400 });
  });
  await connect(ui);
  await ui.run("openInspector('continuity')");
  input(ui.get("charter"), "Draft that must not be erased");
  await ui.get("saveCharter").onclick!();
  assert.equal(ui.get("charter").value, "Draft that must not be erased");
  assert.equal(ui.run("ui.charterVersion"), 2);
  assert.equal(ui.run("ui.charterConflict"), true);
  assert.match(ui.get("charterStatus").textContent, /changed elsewhere/);
  assert.equal(ui.get("saveCharter").disabled, true);
});

test("inspector tab navigation keeps conversation visible and synchronizes selection and keyboard focus", async () => {
  const ui = fixture();
  await connect(ui);
  const panels = [
    "continuity",
    "commitmentPanel",
    "skills",
    "evolution",
    "connection",
  ];
  const tabs = [
    "continuityTab",
    "commitmentsTab",
    "skillsTab",
    "releasesTab",
    "connectionTab",
  ];
  for (let index = 0; index < tabs.length; index++) {
    await ui.get(tabs[index]).onclick!();
    assert.equal(ui.get("chat").hidden, false);
    assert.equal(ui.get("inspector").hidden, false);
    for (let other = 0; other < panels.length; other++) {
      assert.equal(ui.get(panels[other]).hidden, index !== other);
      assert.equal(
        ui.get(tabs[other]).getAttribute("aria-selected"),
        String(index === other),
      );
      assert.equal(ui.get(tabs[other]).tabIndex, index === other ? 0 : -1);
    }
  }
  await ui.get("connectionTab").onkeydown!({
    key: "ArrowRight",
    preventDefault() {},
  });
  assert.equal(ui.document.activeElement.id, "continuityTab");
  assert.equal(ui.get("continuity").hidden, false);
  await ui.get("continuityTab").onkeydown!({ key: "End", preventDefault() {} });
  assert.equal(ui.document.activeElement.id, "connectionTab");
  ui.document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(ui.get("inspector").hidden, true);
  assert.equal(
    ui.get("toggleInspector").getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(ui.document.activeElement.id, "toggleInspector");
  ui.get("toggleNav").click();
  assert.equal(ui.get("navigation").hidden, false);
  ui.get("chatTab").click();
  assert.equal(ui.get("navigation").hidden, true);
  assert.equal(ui.document.activeElement.id, "prompt");
});

test("source read and smoke tests never activate; explicit approval sends the reviewed active revision", async () => {
  const revision = {
    id: "fixture-proposed",
    description: "Synthetic revision",
    createdAt: "2026-10-12",
  };
  const ui = fixture((path) => {
    if (path === "state")
      return Response.json(
        state({
          active: { revisionId: "fixture-active", activatedAt: "2026-10-12" },
          releases: [revision],
        }),
      );
    if (path === "revision?id=fixture-proposed")
      return Response.json({
        ...revision,
        source: "export class MutableAgent {}",
      });
  });
  await connect(ui);
  const card = ui.get("revisions").children[0];
  const details = card.querySelector("details")!;
  details.open = true;
  await details.ontoggle!();
  assert.match(details.textContent, /export class MutableAgent/);
  const smoke = buttons(card).find((node) =>
    /smoke test/i.test(node.textContent),
  )!;
  await smoke.onclick!();
  assert.equal(ui.calls.filter((call) => call.path === "test").length, 1);
  assert.equal(ui.calls.filter((call) => call.path === "activate").length, 0);
  const activate = buttons(card).find((node) =>
    /Activate \/ roll back/.test(node.textContent),
  )!;
  await activate.onclick!();
  assert.equal(ui.calls.filter((call) => call.path === "activate").length, 0);
  ui.allowConfirmation(true);
  // Simulate a newer state that was not the basis of this detached card's review.
  ui.run("ui.latest.active = {revisionId: 'fixture-newer-active'}");
  await activate.onclick!();
  const activation = ui.calls.find((call) => call.path === "activate")!;
  assert.deepEqual(activation.body, {
    id: "fixture-proposed",
    expectedActiveRevisionId: "fixture-active",
    confirm: "ACTIVATE",
  });
  assert.match(ui.confirmations.at(-1)!, /Data migrations are not rolled back/);
});

test("staging source leaves activation separate and template loads preserve newly typed source", async () => {
  const pending = deferred<Response>();
  const ui = fixture((path) =>
    path === "source" ? pending.promise : undefined,
  );
  await connect(ui);
  const loading = ui.get("loadTemplate").onclick!();
  input(ui.get("source"), "export class NewerOwnerDraft {}");
  pending.resolve(Response.json({ source: "export class FixtureStarter {}" }));
  await loading;
  assert.equal(ui.get("source").value, "export class NewerOwnerDraft {}");
  ui.get("description").value = "Synthetic source for review";
  await ui.get("stage").onclick!();
  assert.deepEqual(ui.calls.find((call) => call.path === "revisions")!.body, {
    source: "export class NewerOwnerDraft {}",
    description: "Synthetic source for review",
  });
  assert.equal(ui.calls.filter((call) => call.path === "activate").length, 0);
  assert.match(ui.get("notice").textContent, /Nothing was activated/);
});

test("skill activation requires confirmation and keeps the expected active skill revision", async () => {
  const skills = [
    {
      name: "fixture-skill",
      revisionId: "fixture-old-skill",
      description: "An active fixture",
      status: "active",
    },
    {
      name: "fixture-skill",
      revisionId: "fixture-new-skill",
      description: "A tested fixture",
      status: "tested",
    },
  ];
  const ui = fixture((path) =>
    path === "skills" ? Response.json({ skills, telemetry: {} }) : undefined,
  );
  await connect(ui);
  await ui.run("openInspector('skills')");
  const activation = buttons(ui.get("skillPanel")).find(
    (node) => node.textContent === "Activate skill",
  )!;
  await activation.onclick!();
  assert.equal(
    ui.calls.filter((call) => call.path === "skills/activate").length,
    0,
  );
  ui.allowConfirmation(true);
  await activation.onclick!();
  assert.deepEqual(
    ui.calls.find((call) => call.path === "skills/activate")!.body,
    {
      id: "fixture-new-skill",
      expectedActiveRevisionId: "fixture-old-skill",
      confirm: "ACTIVATE",
    },
  );
  assert.match(ui.confirmations.at(-1)!, /do not prove better performance/);
});

test("interrupted login ignores late success and cannot reopen a locked workspace", async () => {
  const pending = deferred<Response>();
  const ui = fixture((path) =>
    path === "state" ? pending.promise : undefined,
  );
  ui.get("token").value = "synthetic-owner-token";
  ui.get("session").value = "fixture-session";
  const connecting = ui.get("connect").onsubmit!({ preventDefault() {} });
  ui.get("connect").requestSubmit();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.get("connectButton").disabled, true);
  ui.run("lock()");
  pending.resolve(Response.json(state()));
  await connecting;
  assert.equal(ui.run("ui.connected"), false);
  assert.equal(ui.run("ui.connecting"), false);
  assert.equal(ui.get("workspace").hidden, true);
  assert.equal(ui.get("login").hidden, false);
  assert.equal(ui.get("token").value, "");
  assert.equal(ui.get("connectButton").disabled, false);
  assert.equal(ui.intervalCallbacks.size, 0);
});

test("owner rejection during refresh locks and clears private state", async () => {
  let rejected = false;
  const ui = fixture((path) =>
    path === "state" && rejected
      ? Response.json({ error: "Unauthorized" }, { status: 401 })
      : undefined,
  );
  await connect(ui);
  input(ui.get("prompt"), "Synthetic private draft");
  rejected = true;
  await ui.get("refresh").onclick!();
  assert.equal(ui.get("workspace").hidden, true);
  assert.equal(ui.get("prompt").value, "");
  assert.equal(ui.run("ui.connected"), false);
  assert.equal(ui.intervalCallbacks.size, 0);
  assert.match(ui.get("error").textContent, /Owner access was rejected/);
  assert.equal(ui.get("refresh").dataset.busy, undefined);
  assert.equal(ui.get("refresh").disabled, false);
});

test("out-of-order continuity requests do not overwrite a newer panel response", async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  let requests = 0;
  const ui = fixture((path) =>
    path === "companion"
      ? ++requests === 1
        ? first.promise
        : second.promise
      : undefined,
  );
  await connect(ui);
  const older = ui.run("openInspector('continuity')");
  const newer = ui.run("openInspector('commitmentPanel')");
  second.resolve(Response.json(companion(3, "Newer continuity response")));
  await newer;
  first.resolve(Response.json(companion(2, "Older continuity response")));
  await older;
  assert.equal(ui.get("charter").value, "Newer continuity response");
  assert.equal(ui.run("ui.charterVersion"), 3);
  assert.equal(ui.get("commitmentPanel").hidden, false);
  assert.equal(ui.get("continuity").hidden, true);
  assert.equal(ui.get("panelStatus").textContent, "");
});

test("mobile panel controls keep overlays exclusive and restore chat interactivity on dismissal", async () => {
  const ui = fixture();
  ui.setMobile(true);
  await connect(ui);
  ui.get("toggleNav").click();
  assert.equal(ui.get("navigation").hidden, false);
  assert.equal((ui.get("chat") as any).inert, true);
  await ui.get("memoryNav").onclick!();
  assert.equal(ui.get("navigation").hidden, true);
  assert.equal(ui.get("inspector").hidden, false);
  assert.equal((ui.get("chat") as any).inert, true);
  ui.get("closeInspector").click();
  assert.equal(ui.get("inspector").hidden, true);
  assert.equal((ui.get("chat") as any).inert, false);
  assert.equal(ui.get("toggleNav").getAttribute("aria-expanded"), "false");
  assert.equal(
    ui.get("toggleInspector").getAttribute("aria-expanded"),
    "false",
  );
});

test("empty prompts and ordinary or composing Enter keys cannot accidentally submit", async () => {
  const ui = fixture();
  await connect(ui);
  input(ui.get("prompt"), "   ");
  ui.get("composer").requestSubmit();
  assert.equal(ui.calls.filter((call) => call.path === "chat").length, 0);
  input(ui.get("prompt"), "Synthetic keyboard draft");
  ui.get("prompt").onkeydown!({ key: "Enter", preventDefault() {} });
  ui.get("prompt").onkeydown!({
    key: "Enter",
    ctrlKey: true,
    isComposing: true,
    preventDefault() {},
  });
  assert.equal(ui.calls.filter((call) => call.path === "chat").length, 0);
  ui.get("prompt").onkeydown!({
    key: "Enter",
    ctrlKey: true,
    isComposing: false,
    preventDefault() {},
  });
  await settle();
  assert.equal(ui.calls.filter((call) => call.path === "chat").length, 1);
});

test("conversation content remains literal text and model changes stay disabled during work", async () => {
  const ui = fixture((path) =>
    path === "state"
      ? Response.json(
          state({
            pending: [{ id: "fixture-run" }],
            history: [
              {
                id: 1,
                kind: "user",
                text: '<img src="x" onerror="alert(1)">',
                date: "2026-10-12",
              },
            ],
          }),
        )
      : undefined,
  );
  await connect(ui);
  assert.match(ui.get("messages").textContent, /<img src=/);
  assert.equal(ui.get("messages").querySelectorAll("img").length, 0);
  assert.equal(ui.get("setModel").disabled, true);
  assert.equal(ui.get("abort").disabled, false);
  ui.get("setModel").click();
  assert.equal(ui.calls.filter((call) => call.path === "model").length, 0);
});

function privacyRaceFixture() {
  const revision = {
    id: "fixture-revision",
    description: "Synthetic behavior proposal",
    createdAt: "2026-10-12",
  };
  const skills = [
    {
      name: "fixture-skill",
      revisionId: "fixture-active-skill",
      description: "Synthetic active skill",
      status: "active",
    },
    {
      name: "fixture-skill",
      revisionId: "fixture-tested-skill",
      description: "Synthetic tested skill",
      status: "tested",
    },
  ];
  return fixture((path, body) => {
    if (path === "state")
      return Response.json(
        state({
          history: [
            {
              id: 1,
              kind: "user",
              text: "Synthetic private history",
              date: "2026-10-12",
            },
          ],
          releases: [revision],
          inference: {
            ...state().inference,
            failures: [
              {
                id: "fixture-summary",
                summary: true,
                error: { message: "Synthetic summary failure" },
              },
            ],
          },
        }),
      );
    if (path === "companion") {
      if (body)
        return Response.json(
          body.action === "charter"
            ? { version: 2, text: body.text, recordedAt: "2026-10-12" }
            : {},
        );
      return Response.json({
        ...companion(),
        beliefs: [
          {
            id: 1,
            kind: "fact",
            text: "Synthetic private belief",
            scope: "fixture",
            confidence: 0.5,
            status: "proposed",
            sourceEventIds: [1],
          },
        ],
        commitments: [
          { id: 1, text: "Synthetic proposed work", status: "proposed" },
          { id: 2, text: "Synthetic open work", status: "open" },
        ],
      });
    }
    if (path === "skills") return Response.json({ skills, telemetry: {} });
    if (path.startsWith("skill?id="))
      return Response.json({
        ...skills[0],
        instructions: "Synthetic private skill instructions",
        whenToUse: ["Fixture use"],
        whenNotToUse: ["Fixture exclusion"],
        useExamples: ["Fixture positive"],
        avoidExamples: ["Fixture negative"],
        evidenceRunIds: ["fixture-run"],
        evaluation: null,
      });
    if (path.startsWith("revision?id="))
      return Response.json({
        ...revision,
        source: "export class SyntheticPrivateRevision {}",
      });
  });
}
function namedButton(
  ui: ReturnType<typeof fixture>,
  id: string,
  label: string,
) {
  const control = buttons(ui.get(id)).find(
    (node) => node.textContent === label,
  );
  assert.ok(control, "Missing button: " + label);
  return control;
}

test("a lock after transport fulfillment prevents every private view from being restored", async () => {
  for (const [method, invoke] of [
    ["memory", "$('loadMemory').onclick()"],
    ["source", "$('loadTemplate').onclick()"],
    ["companion", "openInspector('continuity')"],
    ["skills", "openInspector('skills')"],
    ["state", "$('refresh').onclick()"],
  ]) {
    const ui = privacyRaceFixture();
    await connect(ui);
    lockAfterFulfillment(ui, "client." + method);
    const before = ui.calls.length;
    await ui.run(invoke);
    assert.equal(ui.calls.length, before + 1, method + " follow-on request");
    assertLocked(ui);
  }
});

test("login cannot reopen after a lock at either state or refresh fulfillment", async () => {
  for (const target of ["client.state", "refresh"]) {
    const ui = privacyRaceFixture();
    lockAfterFulfillment(ui, target);
    ui.get("token").value = "synthetic-owner-token";
    ui.get("session").value = "fixture-session";
    await ui.get("connect").onsubmit!({ preventDefault() {} });
    assert.equal(ui.calls.length, 1);
    assertLocked(ui);
    assert.equal(ui.get("connectButton").disabled, false);
  }
});

const mutationRaces = [
  {
    name: "chat admission",
    method: "chat",
    after: "refresh",
    prepare: "$('prompt').value = 'Synthetic submitted message'",
    invoke: "$('composer').onsubmit({ preventDefault() {} })",
  },
  {
    name: "charter save",
    method: "changeCompanion",
    after: "loadContinuity",
    prepare:
      "loadContinuity().then(() => { $('charter').value = 'Synthetic charter edit'; setCharterStatus(); })",
    invoke: "$('saveCharter').onclick()",
  },
  {
    name: "source staging",
    method: "stageRevision",
    after: "refresh",
    prepare: "$('source').value = 'export class SyntheticPrivateDraft {}'",
    invoke: "$('stage').onclick()",
  },
  {
    name: "model selection",
    method: "setModel",
    after: "refresh",
    prepare: "$('modelSelect').value = 'fixture-model'; ui.modelDirty = true",
    invoke: "$('setModel').onclick()",
  },
  {
    name: "turn abort",
    method: "abort",
    after: "refresh",
    prepare: "undefined",
    invoke: "$('abort').onclick()",
  },
  {
    name: "summary retry",
    method: "retrySummary",
    after: "refresh",
    prepare: "undefined",
    invoke: "$('inferenceErrors').querySelector('button').onclick()",
  },
];
for (const scenario of mutationRaces)
  test(`${scenario.name} cannot mutate a locked view or continue old-session work`, async () => {
    for (const target of ["client." + scenario.method, scenario.after]) {
      const ui = privacyRaceFixture();
      await connect(ui);
      await ui.run(scenario.prepare);
      ui.allowConfirmation(true);
      lockAfterFulfillment(ui, target);
      const before = ui.calls.length;
      await ui.run(scenario.invoke);
      assert.equal(
        ui.calls.length,
        before + (target.startsWith("client.") ? 1 : 2),
        target + " follow-on request",
      );
      assertLocked(ui);
    }
  });

test("companion approval and status handlers stop after post-fulfillment locks", async () => {
  for (const [panel, label] of [
    ["beliefs", "Accept memory"],
    ["commitments", "Accept commitment"],
    ["commitments", "Mark completed"],
    ["commitments", "Cancel commitment"],
  ]) {
    for (const target of ["client.changeCompanion", "loadContinuity"]) {
      const ui = privacyRaceFixture();
      await connect(ui);
      await ui.run("loadContinuity()");
      ui.allowConfirmation(true);
      const control = namedButton(ui, panel, label);
      lockAfterFulfillment(ui, target);
      const before = ui.calls.length;
      await control.onclick!();
      assert.equal(
        ui.calls.length,
        before + (target.startsWith("client.") ? 1 : 2),
        label + " follow-on request",
      );
      assertLocked(ui);
    }
  }
});

test("source review, smoke tests and approval cannot update detached controls after lock", async () => {
  for (const target of [
    "client.revision",
    "client.testRevision",
    "client.activateRevision",
    "refresh",
  ]) {
    const ui = privacyRaceFixture();
    await connect(ui);
    ui.allowConfirmation(true);
    const card = ui.get("revisions").children[0];
    const details = card.querySelector("details")!;
    const smoke = namedButton(ui, "revisions", "Run smoke test");
    const activate = namedButton(ui, "revisions", "Activate / roll back");
    lockAfterFulfillment(ui, target);
    const before = ui.calls.length;
    if (target === "client.revision") {
      details.open = true;
      await details.ontoggle!();
      assert.doesNotMatch(details.textContent, /SyntheticPrivateRevision/);
    } else if (target === "client.testRevision") {
      await smoke.onclick!();
      assert.equal(smoke.textContent, "Run smoke test");
    } else await activate.onclick!();
    assert.equal(ui.calls.length, before + (target === "refresh" ? 2 : 1));
    assertLocked(ui);
  }
});

test("skill review and activation handlers cannot resume after a post-fulfillment lock", async () => {
  for (const [method, label] of [
    ["skill", "Read full revision"],
    ["activateSkill", "Activate skill"],
    ["deactivateSkill", "Deactivate skill"],
  ]) {
    for (const target of [
      "client." + method,
      ...(method === "skill" ? [] : ["loadSkills"]),
    ]) {
      const ui = privacyRaceFixture();
      await connect(ui);
      await ui.run("loadSkills()");
      ui.allowConfirmation(true);
      const control = namedButton(ui, "skillPanel", label);
      const card = control.parentElement!;
      lockAfterFulfillment(ui, target);
      const before = ui.calls.length;
      await control.onclick!();
      assert.equal(
        ui.calls.length,
        before + (target.startsWith("client.") ? 1 : 2),
      );
      assert.doesNotMatch(
        card.textContent,
        /Synthetic private skill instructions/,
      );
      assert.equal(control.textContent, label);
      assertLocked(ui);
    }
  }
});

test("manual refresh and Changes navigation do not continue after refresh fulfillment locks", async () => {
  for (const invoke of [
    "$('refresh').onclick()",
    "openInspector('evolution')",
  ]) {
    const ui = privacyRaceFixture();
    await connect(ui);
    await ui.run("openInspector('continuity')");
    lockAfterFulfillment(ui, "refresh");
    const before = ui.calls.length;
    await ui.run(invoke);
    assert.equal(ui.calls.length, before + 1);
    assertLocked(ui);
  }
});

test("desktop-to-mobile resize keeps one focused panel and Escape restores interactive chat", async () => {
  for (const [focused, retained, expectedFocus] of [
    ["charter", "inspector", "charter"],
    ["chatTab", "navigation", "chatTab"],
    ["prompt", "inspector", "continuityTab"],
  ]) {
    const ui = fixture();
    await connect(ui);
    ui.get("toggleNav").click();
    await ui.run("openInspector('continuity')");
    assert.equal(ui.get("navigation").hidden, false);
    assert.equal(ui.get("inspector").hidden, false);
    ui.get(focused).focus();
    ui.setMobile(true);
    ui.run("syncLayout()");
    assert.equal(ui.get("navigation").hidden, retained !== "navigation");
    assert.equal(ui.get("inspector").hidden, retained !== "inspector");
    assert.equal(ui.run("ui.navOpen"), retained === "navigation");
    assert.equal(ui.run("ui.inspectorOpen"), retained === "inspector");
    assert.equal(
      ui.get("toggleNav").getAttribute("aria-expanded"),
      String(retained === "navigation"),
    );
    assert.equal(
      ui.get("toggleInspector").getAttribute("aria-expanded"),
      String(retained === "inspector"),
    );
    assert.equal((ui.get("chat") as any).inert, true);
    assert.equal(ui.document.activeElement.id, expectedFocus);
    assert.equal(ui.get(retained).contains(ui.document.activeElement), true);
    ui.document.dispatchEvent({ type: "keydown", key: "Escape" });
    assert.equal(ui.get("navigation").hidden, true);
    assert.equal(ui.get("inspector").hidden, true);
    assert.equal((ui.get("chat") as any).inert, false);
    assert.equal(
      ui.document.activeElement.id,
      retained === "navigation" ? "toggleNav" : "toggleInspector",
    );
    assert.equal(ui.get("toggleNav").getAttribute("aria-expanded"), "false");
    assert.equal(
      ui.get("toggleInspector").getAttribute("aria-expanded"),
      "false",
    );
  }
});

const providerFlow = (overrides: Record<string, unknown> = {}) => ({
  id: "synthetic-flow",
  providerId: "openai",
  status: "waiting",
  url: "https://auth.openai.com/oauth/authorize?state=synthetic-fixture",
  message: "Finish sign-in on OpenAI.",
  expiresAt: Date.now() + 600000,
  ...overrides,
});
const providers = (flow: ReturnType<typeof providerFlow> | null = null) => ({
  available: true,
  providers: [
    ["openai", "ChatGPT subscription", "oauth"],
    ["openrouter", "OpenRouter", "api_key"],
    ["opencode-zen", "OpenCode Zen", "api_key"],
    ["opencode-go", "OpenCode Go", "subscription"],
  ].map(([id, name, kind]) => ({
    id,
    name,
    kind,
    connected: false,
    status: id === "opencode-go" ? "disabled" : "disconnected",
    message: "Synthetic provider status.",
    models: [],
  })),
  flow,
});
function providerButton(
  ui: ReturnType<typeof fixture>,
  id: string,
  label: string,
) {
  const card = ui
    .get("providerCards")
    .querySelector('[data-provider="' + id + '"]');
  assert.ok(card, "Missing provider card " + id);
  const control = buttons(card).find((node) => node.textContent === label);
  assert.ok(control, "Missing provider control " + label);
  return control;
}
async function openProviders(ui: ReturnType<typeof fixture>) {
  await connect(ui);
  await ui.run("openInspector('connection')");
}

test("provider setup explains local-host access without linking loopback from a remote Worker", async () => {
  const ui = fixture();
  await openProviders(ui);
  assert.equal(ui.get("providerGuide").hidden, false);
  assert.match(ui.get("providerGuide").textContent, /npm run bridge:serve/);
  assert.equal(ui.get("localBridgeLink").hidden, false);
  ui.run("window.location.hostname = 'example.workers.dev'");
  await ui.run("loadProviders()");
  assert.equal(ui.get("localBridgeLink").hidden, true);
  assert.equal(ui.get("providerCards").children.length, 0);
  assert.equal(ui.get("refreshProviders").disabled, false);
  assert.equal(
    ui.calls.filter((call) => call.path.startsWith("providers/")).length,
    0,
  );
});

test("OpenCode Go stays disabled and explains why the shared companion harness is incompatible", async () => {
  const ui = fixture((path) =>
    path === "providers" ? Response.json(providers()) : undefined,
  );
  await openProviders(ui);
  const card = ui
    .get("providerCards")
    .querySelector('[data-provider="opencode-go"]')!;
  assert.match(card.textContent, /cannot isolate a Go coding session/);
  assert.equal(buttons(card)[0].disabled, true);
  assert.equal(
    card.querySelector("a")?.getAttribute("href"),
    "https://opencode.ai/v2/docs/console/go/",
  );
  buttons(card)[0].click();
  assert.equal(
    ui.calls.filter((call) => call.path.startsWith("providers/")).length,
    0,
  );
});

test("API key save clears the password immediately, deduplicates submits and does not select a paid model", async () => {
  const saved = deferred<Response>();
  const ui = fixture((path) =>
    path === "providers"
      ? Response.json(providers())
      : path === "providers/key"
        ? saved.promise
        : undefined,
  );
  await openProviders(ui);
  providerButton(ui, "openrouter", "Connect API key").click();
  assert.equal(ui.get("providerKey").getAttribute("type"), "password");
  assert.match(
    ui.get("providerKeyForm").textContent,
    /existing\s+provider credits/,
  );
  input(ui.get("providerKey"), "synthetic-api-key-not-a-credential");
  const pending = ui.get("providerKeyForm").onsubmit!({ preventDefault() {} });
  ui.get("providerKeyForm").requestSubmit();
  assert.equal(ui.get("providerKey").value, "");
  assert.equal(ui.get("cancelProviderKey").disabled, true);
  const calls = ui.calls.filter((call) => call.path === "providers/key");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    providerId: "openrouter",
    apiKey: "synthetic-api-key-not-a-credential",
    confirm: "STORE_METERED_KEY",
  });
  assert.equal(
    (calls[0].init.headers as Record<string, string>).Authorization,
    "Bearer synthetic-owner-token-never-a-real-credential",
  );
  saved.resolve(Response.json({ stored: true }));
  await pending;
  assert.equal(ui.get("providerKeyForm").hidden, true);
  assert.equal(ui.calls.filter((call) => call.path === "model").length, 0);
  assert.equal(ui.get("modelSelect").value, "fixture-model");
  assert.doesNotMatch(ui.document.body.textContent, /synthetic-api-key/);
});

test("provider key cancel and navigation erase the secret without sending it", async () => {
  const ui = fixture((path) =>
    path === "providers" ? Response.json(providers()) : undefined,
  );
  await openProviders(ui);
  for (const finish of [
    () => ui.get("cancelProviderKey").click(),
    () => ui.get("closeInspector").click(),
    () => ui.get("disconnect").click(),
  ]) {
    if (!ui.run("ui.connected")) await connect(ui);
    await ui.run("openInspector('connection')");
    providerButton(ui, "opencode-zen", "Connect API key").click();
    input(ui.get("providerKey"), "synthetic-unsaved-key");
    finish();
    assert.equal(ui.get("providerKey").value, "");
    assert.equal(ui.get("providerKeyForm").hidden, true);
  }
  assert.equal(
    ui.calls.filter((call) => call.path === "providers/key").length,
    0,
  );
});

test("metered model selection requires a billing confirmation that includes background memory and session persistence", async () => {
  const ui = fixture((path) =>
    path === "state"
      ? Response.json(
          state({
            inference: {
              ...state().inference,
              models: [
                "fixture-model",
                "openrouter::vendor/model",
                "opencode-zen::model",
              ],
            },
          }),
        )
      : undefined,
  );
  await connect(ui);
  ui.get("modelSelect").value = "openrouter::vendor/model";
  ui.get("modelSelect").dispatchEvent({ type: "change" });
  await ui.get("setModel").onclick!();
  assert.equal(ui.calls.filter((call) => call.path === "model").length, 0);
  assert.match(
    ui.confirmations[0],
    /Conversation and background memory summaries/,
  );
  assert.match(ui.confirmations[0], /existing\s+provider credits/);
  assert.match(ui.confirmations[0], /persists for this named session/);
  ui.allowConfirmation(true);
  await ui.get("setModel").onclick!();
  assert.deepEqual(ui.calls.find((call) => call.path === "model")?.body, {
    id: "openrouter::vendor/model",
    confirmPaid: "USE_METERED_PROVIDER",
  });
  ui.get("modelSelect").value = "fixture-model";
  await ui.get("setModel").onclick!();
  assert.deepEqual(
    ui.calls.filter((call) => call.path === "model").at(-1)?.body,
    { id: "fixture-model" },
  );
});

test("a paid-only catalog never automatically picks a model", async () => {
  const ui = fixture((path) =>
    path === "state"
      ? Response.json(
          state({
            inference: {
              ...state().inference,
              selected: undefined,
              models: ["opencode-zen::fixture-model"],
            },
          }),
        )
      : undefined,
  );
  await connect(ui);
  assert.equal(ui.get("modelSelect").value, "");
  assert.equal(ui.get("setModel").disabled, true);
  assert.match(
    ui.get("modelBilling").textContent,
    /No paid model is selected automatically/,
  );
  assert.equal(ui.calls.filter((call) => call.path === "model").length, 0);
});

test("ChatGPT sign-in is admitted once and polls every three seconds only while active", async () => {
  const login = deferred<Response>();
  const ui = fixture((path) =>
    path === "providers"
      ? Response.json(providers())
      : path === "providers/login"
        ? login.promise
        : undefined,
  );
  await openProviders(ui);
  const signIn = providerButton(ui, "openai", "Sign in with ChatGPT");
  const pending = signIn.onclick!();
  signIn.onclick!();
  assert.equal(
    ui.calls.filter((call) => call.path === "providers/login").length,
    1,
  );
  assert.equal(ui.get("providerFlow").hidden, false);
  login.resolve(Response.json(providerFlow()));
  await pending;
  assert.equal(
    ui.get("providerAuthLink").getAttribute("href"),
    providerFlow().url,
  );
  assert.equal(ui.get("providerAuthLink").getAttribute("target"), "_blank");
  assert.ok([...ui.intervalDelays.values()].includes(3000));
  ui.get("closeInspector").click();
  assert.equal(ui.get("providerAuthLink").getAttribute("href"), null);
  assert.deepEqual([...ui.intervalDelays.values()], [2500]);
  assert.deepEqual(
    ui.calls.find((call) => call.path === "providers/cancel")?.body,
    { id: "synthetic-flow" },
  );
});

test("provider sign-in links reject foreign origins, credentials and script URLs", async () => {
  let url = "";
  const ui = fixture((path) =>
    path === "providers"
      ? Response.json(providers(providerFlow({ url })))
      : undefined,
  );
  await connect(ui);
  for (url of [
    "javascript:alert(1)",
    "https://auth.openai.com.evil.test/oauth",
    "https://evil.test/auth.openai.com",
    "http://auth.openai.com/oauth",
    "https://owner:secret@auth.openai.com/oauth",
  ]) {
    await ui.run("openInspector('connection')");
    assert.equal(ui.get("providerAuthLink").hidden, true, url);
    assert.equal(ui.get("providerAuthLink").getAttribute("href"), null, url);
    assert.match(
      ui.get("providerFlowStatus").textContent,
      /unexpected sign-in address/,
    );
  }
});

test("closing during login creation cancels without an ID and ignores the late flow", async () => {
  const login = deferred<Response>();
  const ui = fixture((path) =>
    path === "providers"
      ? Response.json(providers())
      : path === "providers/login"
        ? login.promise
        : undefined,
  );
  await openProviders(ui);
  const pending = providerButton(ui, "openai", "Sign in with ChatGPT")
    .onclick!();
  ui.get("closeInspector").click();
  const cancel = ui.calls.find((call) => call.path === "providers/cancel")!;
  assert.deepEqual(cancel.body, { id: null });
  assert.equal(cancel.init.keepalive, true);
  assert.equal(cancel.init.signal, undefined);
  login.resolve(Response.json(providerFlow()));
  await pending;
  assert.equal(ui.get("providerFlow").hidden, true);
  assert.equal(ui.run("ui.providerFlow"), null);
  assert.equal(ui.get("providerAuthLink").getAttribute("href"), null);
  assert.deepEqual(
    ui.calls.filter((call) => call.path === "providers/cancel").at(-1)?.body,
    { id: "synthetic-flow" },
  );
  assert.deepEqual([...ui.intervalDelays.values()], [2500]);
});

test("Lock sends best-effort cancellation before erasing owner auth and cannot restore a flow", async () => {
  const ui = fixture((path) =>
    path === "providers"
      ? Response.json(
          providers(
            providerFlow({
              prompt: {
                type: "manual_code",
                message: "Synthetic one-time code",
              },
            }),
          ),
        )
      : undefined,
  );
  await openProviders(ui);
  input(ui.get("providerResponse"), "synthetic-one-time-response");
  ui.get("disconnect").click();
  const cancel = ui.calls.find((call) => call.path === "providers/cancel")!;
  assert.deepEqual(cancel.body, { id: "synthetic-flow" });
  assert.equal(
    (cancel.init.headers as Record<string, string>).Authorization,
    "Bearer synthetic-owner-token-never-a-real-credential",
  );
  assert.equal(cancel.init.keepalive, true);
  assertLocked(ui);
  assert.equal(ui.get("providerResponse").value, "");
  assert.equal(ui.get("providerCards").textContent, "");
  assert.equal(ui.get("providerAuthLink").getAttribute("href"), null);
  assert.equal(ui.run("ui.providers"), null);
});

test("cancel invalidates an in-flight poll and repeated cancellation does not admit another request", async () => {
  const poll = deferred<Response>(),
    cancellation = deferred<Response>();
  let delayed = false,
    cancelled = false;
  const ui = fixture((path) => {
    if (path === "providers")
      return delayed && !cancelled
        ? poll.promise
        : Response.json(providers(cancelled ? null : providerFlow()));
    if (path === "providers/cancel") {
      cancelled = true;
      return cancellation.promise;
    }
    return undefined;
  });
  await openProviders(ui);
  delayed = true;
  const reading = ui.run("loadProviders()");
  const pending = ui.get("cancelProviderFlow").onclick!();
  ui.get("cancelProviderFlow").onclick!();
  assert.equal(
    ui.calls.filter((call) => call.path === "providers/cancel").length,
    1,
  );
  cancellation.resolve(Response.json({ cancelled: true }));
  await pending;
  poll.resolve(Response.json(providers(providerFlow())));
  await reading;
  assert.equal(ui.run("ui.providerFlow"), null);
  assert.equal(ui.get("providerFlow").hidden, true);
  assert.equal(ui.get("providerAuthLink").getAttribute("href"), null);
  assert.deepEqual([...ui.intervalDelays.values()], [2500]);
});

test("an old session's login completion cannot release a new session's provider guard", async () => {
  const oldLogin = deferred<Response>(),
    newLogin = deferred<Response>();
  let count = 0;
  const ui = fixture((path) =>
    path === "providers"
      ? Response.json(providers())
      : path === "providers/login"
        ? ++count === 1
          ? oldLogin.promise
          : newLogin.promise
        : undefined,
  );
  await openProviders(ui);
  const old = providerButton(ui, "openai", "Sign in with ChatGPT").onclick!();
  ui.get("disconnect").click();
  await connect(ui, "new-fixture-session");
  await ui.run("openInspector('connection')");
  const next = providerButton(ui, "openai", "Sign in with ChatGPT").onclick!();
  oldLogin.resolve(Response.json(providerFlow({ id: "old-flow" })));
  await old;
  assert.equal(ui.run("ui.providerBusy"), true);
  assert.equal(ui.run("ui.providerFlowStarting"), true);
  assert.equal(ui.run("ui.providerFlow"), null);
  newLogin.resolve(Response.json(providerFlow({ id: "new-flow" })));
  await next;
  assert.equal(ui.run("ui.providerFlow.id"), "new-flow");
  assert.equal(ui.run("ui.providerBusy"), false);
});

test("post-fulfillment provider status and key-save races cannot populate a locked view", async () => {
  for (const target of ["client.providers", "client.storeProviderKey"]) {
    const ui = fixture((path) =>
      path === "providers" ? Response.json(providers()) : undefined,
    );
    await openProviders(ui);
    lockAfterFulfillment(ui, target);
    if (target === "client.providers") await ui.run("loadProviders()");
    else {
      providerButton(ui, "openrouter", "Connect API key").click();
      input(ui.get("providerKey"), "synthetic-api-key");
      await ui.get("providerKeyForm").onsubmit!({ preventDefault() {} });
    }
    assertLocked(ui);
    assert.equal(ui.get("providerCards").textContent, "");
    assert.equal(ui.get("providerKey").value, "");
    assert.equal(ui.get("providerFlow").hidden, true);
  }
});

test("one-time OAuth responses are wiped, deduplicated and preserved only as unsent drafts during polling", async () => {
  const response = deferred<Response>();
  const flow = providerFlow({
    prompt: {
      type: "manual_code",
      message: "Enter a synthetic one-time response",
    },
  });
  const ui = fixture((path) =>
    path === "providers"
      ? Response.json(providers(flow))
      : path === "providers/respond"
        ? response.promise
        : undefined,
  );
  await openProviders(ui);
  input(ui.get("providerResponse"), "synthetic-response");
  await ui.run("loadProviders()");
  assert.equal(ui.get("providerResponse").value, "synthetic-response");
  const pending = ui.get("providerResponseForm").onsubmit!({
    preventDefault() {},
  });
  ui.get("providerResponseForm").requestSubmit();
  assert.equal(ui.get("providerResponse").value, "");
  assert.equal(
    ui.calls.filter((call) => call.path === "providers/respond").length,
    1,
  );
  assert.deepEqual(
    ui.calls.find((call) => call.path === "providers/respond")?.body,
    { id: "synthetic-flow", value: "synthetic-response" },
  );
  response.resolve(Response.json(providers(flow)));
  await pending;
  assert.equal(ui.get("providerResponse").value, "");
  ui.emitWindow("pagehide");
  assert.equal(ui.get("providerFlow").hidden, true);
  assert.deepEqual([...ui.intervalDelays.values()], [2500]);
});

test("expired OAuth flows stop polling and clear any response field", async () => {
  const ui = fixture((path) =>
    path === "providers"
      ? Response.json(providers(providerFlow({ expiresAt: Date.now() - 1000 })))
      : undefined,
  );
  await openProviders(ui);
  assert.match(ui.get("providerFlowStatus").textContent, /Sign-in expired/);
  assert.equal(ui.get("providerAuthLink").hidden, true);
  assert.equal(ui.get("providerResponseForm").hidden, true);
  assert.deepEqual([...ui.intervalDelays.values()], [2500]);
  assert.deepEqual(
    ui.calls.find((call) => call.path === "providers/cancel")?.body,
    { id: "synthetic-flow" },
  );
});

test("every active manager OAuth state keeps polling and supports local cancellation", async () => {
  for (const status of ["starting", "waiting", "exchanging", "saving"]) {
    const ui = fixture((path) =>
      path === "providers"
        ? Response.json(providers(providerFlow({ status })))
        : undefined,
    );
    await openProviders(ui);
    assert.ok([...ui.intervalDelays.values()].includes(3000), status);
    assert.equal(
      ui.get("cancelProviderFlow").textContent,
      "Cancel sign-in",
      status,
    );
    assert.equal(
      providerButton(ui, "openai", "Sign in with ChatGPT").disabled,
      true,
      status,
    );
    ui.get("closeInspector").click();
    assert.deepEqual(
      ui.calls.find((call) => call.path === "providers/cancel")?.body,
      { id: "synthetic-flow" },
      status,
    );
    assert.deepEqual([...ui.intervalDelays.values()], [2500], status);
  }
});

test("terminal manager flow states do not poll or retain OAuth links", async () => {
  for (const status of ["connected", "cancelled", "expired", "error"]) {
    const ui = fixture((path) =>
      path === "providers"
        ? Response.json(providers(providerFlow({ status, message: undefined })))
        : undefined,
    );
    await openProviders(ui);
    assert.deepEqual([...ui.intervalDelays.values()], [2500], status);
    assert.equal(ui.get("providerAuthLink").hidden, true, status);
    assert.equal(ui.get("providerAuthLink").getAttribute("href"), null, status);
    assert.equal(ui.get("cancelProviderFlow").textContent, "Dismiss", status);
    assert.notEqual(
      ui.get("providerFlowStatus").textContent,
      "undefined",
      status,
    );
    await ui.get("cancelProviderFlow").onclick!();
    assert.equal(ui.get("providerFlow").hidden, true, status);
    assert.equal(
      ui.calls.filter((call) => call.path === "providers/cancel").length,
      0,
      status,
    );
  }
});

test("saved credentials are not presented as verified and ChatGPT requires local removal before reauthorization", async () => {
  const catalog = providers();
  for (const item of catalog.providers) {
    if (item.id === "openai" || item.id === "opencode-zen") {
      item.connected = true;
      item.status = "unverified";
    }
  }
  const ui = fixture((path) =>
    path === "providers" ? Response.json(catalog) : undefined,
  );
  await openProviders(ui);
  const chatgpt = ui
    .get("providerCards")
    .querySelector('[data-provider="openai"]')!;
  const zen = ui
    .get("providerCards")
    .querySelector('[data-provider="opencode-zen"]')!;
  assert.match(chatgpt.textContent, /Saved · unverified/);
  assert.match(zen.textContent, /Saved · unverified/);
  assert.match(
    chatgpt.textContent,
    /different account needs a separate private bridge directory/,
  );
  assert.equal(
    buttons(chatgpt).filter((node) =>
      /Sign in|Reconnect/.test(node.textContent),
    ).length,
    0,
  );
  const remove = providerButton(ui, "openai", "Remove local connection");
  await remove.onclick!();
  assert.match(ui.confirmations[0], /does not revoke the OAuth grant/);
  assert.match(ui.confirmations[0], /ChatGPT connected apps\/settings/);
  assert.equal(
    ui.calls.filter((call) => call.path === "providers/disconnect").length,
    0,
  );
  ui.allowConfirmation(true);
  await remove.onclick!();
  assert.deepEqual(
    ui.calls.find((call) => call.path === "providers/disconnect")?.body,
    { providerId: "openai", confirm: "DISCONNECT" },
  );
});

test("provider flow prompt text is literal and a newer prompt clears the earlier response draft", async () => {
  let prompt = "Synthetic <img src=x onerror=alert(1)> prompt";
  const ui = fixture((path) =>
    path === "providers"
      ? Response.json(
          providers(
            providerFlow({ prompt: { type: "manual_code", message: prompt } }),
          ),
        )
      : undefined,
  );
  await openProviders(ui);
  assert.equal(ui.get("providerPromptLabel").textContent, prompt);
  assert.equal(ui.get("providerPromptLabel").children.length, 0);
  input(ui.get("providerResponse"), "synthetic-stale-response");
  prompt = "A new synthetic one-time response prompt";
  await ui.run("loadProviders()");
  assert.equal(ui.get("providerResponse").value, "");
  assert.equal(ui.get("providerPromptLabel").textContent, prompt);
});

test("the UI expires a flow even while provider status cannot be fetched", async () => {
  const ui = fixture((path) =>
    path === "providers" ? Response.json(providers(providerFlow())) : undefined,
  );
  await openProviders(ui);
  const timer = [...ui.intervalDelays.entries()].find(
    ([, delay]) => delay === 3000,
  )![0];
  const previousReads = ui.calls.filter(
    (call) => call.path === "providers",
  ).length;
  ui.run("ui.providerFlow.expiresAt = Date.now() - 1");
  ui.intervalCallbacks.get(timer)!();
  assert.equal(
    ui.calls.filter((call) => call.path === "providers").length,
    previousReads,
  );
  assert.equal(ui.run("ui.providerFlow.status"), "expired");
  assert.equal(ui.get("providerAuthLink").hidden, true);
  assert.equal(ui.get("providerResponse").value, "");
  assert.deepEqual([...ui.intervalDelays.values()], [2500]);
});

function journalFixture(
  sourceRead: (path: string) => Response | Promise<Response>,
) {
  return fixture((path) => {
    if (path.startsWith("companion/event?")) return sourceRead(path);
    if (path === "companion")
      return Response.json({
        ...companion(),
        commitments: [
          {
            id: 9,
            text: "Synthetic blocked work",
            scope: "fixture",
            status: "blocked",
            sourceEventIds: [4],
            history: [],
          },
        ],
        journal: {
          entries: [
            {
              key: "commitment-change:3",
              commitmentId: 9,
              text: "<script>literal fixture</script>",
              status: "blocked",
              recordedAt: "2026-10-19",
              evidenceEventIds: [4],
            },
          ],
          omitted: 2,
        },
      });
  });
}
function openJournalEvidence(ui: ReturnType<typeof fixture>) {
  const details = ui.get("workJournal").querySelectorAll("details")[0];
  details.open = true;
  return {
    details,
    read: namedButton(ui, "workJournal", "Read source event #4"),
  };
}
const eventPage = (text: string, nextOffset: number | null) => ({
  id: 4,
  source: "assistant",
  sourceRef: "fixture-source",
  occurredAt: "2026-10-19",
  text,
  nextOffset,
});

test("work journal renders literal progress and pages exact source evidence without duplicate reads", async () => {
  const pending = deferred<Response>();
  const ui = journalFixture((path) =>
    path.endsWith("offset=0")
      ? pending.promise
      : Response.json(eventPage("second part", null)),
  );
  await connect(ui);
  await ui.run("openInspector('commitmentPanel')");
  assert.match(ui.get("commitments").textContent, /Blocked. Inspect/);
  assert.match(ui.get("workJournal").textContent, /recorded blocked/);
  assert.match(
    ui.get("workJournal").textContent,
    /<script>literal fixture<\/script>/,
  );
  assert.match(ui.get("workJournal").textContent, /2 older journal/);
  const { read } = openJournalEvidence(ui);
  const click = read.onclick!();
  read.onclick!();
  assert.equal(
    ui.calls.filter((c) => c.path.startsWith("companion/event?")).length,
    1,
  );
  pending.resolve(Response.json(eventPage("first part", 2000)));
  await click;
  assert.match(ui.get("workJournal").textContent, /assistant · fixture-source/);
  await read.onclick!();
  assert.equal(ui.calls.at(-1)!.path, "companion/event?id=4&offset=2000");
  assert.match(ui.get("workJournal").textContent, /second part/);
  assert.equal(read.hidden, true);
  ui.run("lock()");
  assert.equal(ui.get("workJournal").textContent, "");
});

test("closing source evidence or locking during a read never restores late private content", async () => {
  for (const interruption of ["collapse", "lock", "close-panel", "refresh"]) {
    const pending = deferred<Response>();
    const ui = journalFixture(() => pending.promise);
    await connect(ui);
    await ui.run("openInspector('commitmentPanel')");
    const { details, read } = openJournalEvidence(ui);
    const click = read.onclick!();
    if (interruption === "collapse") details.open = false;
    else if (interruption === "lock") ui.run("lock()");
    else if (interruption === "refresh") await ui.run("loadContinuity()");
    else ui.run("closeInspector()");
    pending.resolve(Response.json(eventPage("LATE PRIVATE SOURCE", null)));
    await click;
    assert.doesNotMatch(
      ui.get("workJournal").textContent,
      /LATE PRIVATE SOURCE/,
    );
  }
});

test("owner rejection while reading journal evidence locks and clears the journal", async () => {
  const ui = journalFixture(() =>
    Response.json({ error: "Unauthorized" }, { status: 401 }),
  );
  await connect(ui);
  await ui.run("openInspector('commitmentPanel')");
  const { read } = openJournalEvidence(ui);
  await read.onclick!();
  assert.equal(ui.run("ui.connected"), false);
  assert.equal(ui.get("workJournal").textContent, "");
  assert.match(ui.get("error").textContent, /Owner access was rejected/);
});

const bootstrapState = (overrides = {}) => ({
  version: 2,
  policyVersion: 1,
  stopped: false,
  bootstrapReady: true,
  blockers: [],
  reservedAttempts: 0,
  policy: { revisionId: "a".repeat(64), maxAttempts: 1 },
  ...overrides,
});
test("bootstrap controls reflect exhausted quota and armed state after action finalizers, then disable on lock", async () => {
  let bootstrap = bootstrapState();
  const ui = fixture((path) => {
    if (path === "state") return Response.json(state({ autonomy: bootstrap }));
    if (path === "autonomy/validate") {
      bootstrap = bootstrapState({
        bootstrapReady: false,
        reservedAttempts: 1,
        blockers: ["attempt-budget-exhausted"],
      });
      return Response.json(bootstrap);
    }
  });
  await connect(ui);
  assert.equal(ui.get("validateBootstrap").disabled, false);
  assert.equal(ui.get("startBootstrap").disabled, true);
  await ui.get("validateBootstrap").onclick!();
  assert.equal(ui.get("validateBootstrap").disabled, true);
  assert.equal(ui.get("startBootstrap").disabled, true);
  ui.run("lock()");
  for (const id of [
    "validateBootstrap",
    "startBootstrap",
    "stopBootstrap",
    "configureBootstrap",
    "loadBootstrapHistory",
  ])
    assert.equal(ui.get(id).disabled, true);
  assert.equal(ui.get("bootstrapStatus").textContent, "");
});
test("bootstrap history late response cannot restore private data after lock", async () => {
  const pending = deferred<Response>();
  const ui = fixture((path) => {
    if (path === "state")
      return Response.json(state({ autonomy: bootstrapState() }));
    if (path.startsWith("autonomy/history")) return pending.promise;
  });
  await connect(ui);
  const click = ui.get("loadBootstrapHistory").onclick!();
  ui.run("lock()");
  pending.resolve(
    Response.json({ events: ["PRIVATE"], nextAfterVersion: null }),
  );
  await click;
  assert.equal(ui.get("bootstrapHistory").textContent, "");
});

test("expired and exhausted stopped bootstrap policies cannot be started from the UI", async () => {
  for (const blocker of ["policy-expired", "attempt-budget-exhausted"]) {
    const ui = fixture((path) =>
      path === "state"
        ? Response.json(
            state({
              autonomy: bootstrapState({
                stopped: true,
                bootstrapReady: false,
                blockers: ["owner-stop-latched", blocker],
              }),
            }),
          )
        : undefined,
    );
    await connect(ui);
    assert.equal(ui.get("startBootstrap").disabled, true);
    assert.equal(ui.get("validateBootstrap").disabled, true);
  }
});

test("bootstrap shows latest failure directly and history traverses beyond twenty events", async () => {
  const ui = fixture((path) => {
    if (path === "state")
      return Response.json(
        state({
          autonomy: bootstrapState({
            attempts: [{ id: "recent-failure", status: "failed" }],
          }),
        }),
      );
    if (path === "autonomy/history?afterVersion=0")
      return Response.json({
        events: Array.from({ length: 20 }, (_, i) => ({ version: i + 1 })),
        nextAfterVersion: 20,
      });
    if (path === "autonomy/history?afterVersion=20")
      return Response.json({
        events: [{ version: 21, event: "candidate-failed" }],
        nextAfterVersion: null,
      });
  });
  await connect(ui);
  assert.match(ui.get("bootstrapStatus").textContent, /recent-failure: failed/);
  await ui.get("loadBootstrapHistory").onclick!();
  assert.equal(ui.get("loadBootstrapHistory").textContent, "Next history page");
  await ui.get("loadBootstrapHistory").onclick!();
  assert.equal(ui.calls.at(-1)!.path, "autonomy/history?afterVersion=20");
  assert.match(ui.get("bootstrapHistory").textContent, /candidate-failed/);
  assert.equal(
    ui.get("loadBootstrapHistory").textContent,
    "Reload bootstrap history",
  );
});
