"use strict";

// A tiny, zero-dependency DOM stub — just enough to load app.js and drive a
// real draw sequence. This guards the DOM wiring (and specifically that the
// extra-draw sequence always terminates and re-enables the button, the bug
// that used to let spins overlap).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

class El {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this._text = "";
    this.innerHTML = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.style = { display: "none" };
    this.dataset = {};
    this.files = [];
    this._listeners = {};
    const set = new Set();
    this.classList = {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
    };
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = String(v);
  }
  get content() {
    return this;
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  addEventListener(ev, fn) {
    (this._listeners[ev] ||= []).push(fn);
  }
  dispatch(ev) {
    (this._listeners[ev] || []).forEach((fn) => fn({ target: this }));
  }
  click() {
    this.dispatch("click");
  }
  cloneNode() {
    return new El();
  }
  querySelector() {
    return new El();
  }
  querySelectorAll() {
    return [];
  }
  remove() {}
}

function installDom(defaultRuleset, { withEngine = true } = {}) {
  const byId = {};
  const el = (id) => (byId[id] ||= new El());
  // editorPanel toggling reads style.display; keep it hidden.
  el("editorPanel").style.display = "none";

  // The app has no persistence — it always loads E.DEFAULT_RULESET. To drive a
  // specific ruleset in the test, override the engine's default. (node --test
  // runs each file in its own process, so this doesn't leak into engine.test.js.)
  const loadEngine = () => {
    const eng = require("../engine.js");
    if (defaultRuleset) {
      eng.DEFAULT_RULESET = defaultRuleset;
    }
    return eng;
  };

  global.window = withEngine ? { PGREngine: loadEngine() } : {};

  global.document = {
    readyState: "loading", // so app.js registers its DOMContentLoaded bootstrap
    getElementById: el,
    querySelectorAll: () => [],
    createElement: (t) => new El(t),
    // Simulate a <script src="engine.js"> injection: load the engine and fire onload,
    // which is how app.js self-heals from a stale index.html that lacks engine.js.
    head: {
      appendChild: (node) => {
        if (node && node.src === "engine.js") {
          global.window.PGREngine = loadEngine();
          if (typeof node.onload === "function") node.onload();
        }
      },
    },
    addEventListener: (ev, fn) => {
      if (ev === "DOMContentLoaded") global.__domReady = fn;
    },
  };
  // Storage stub: the app only ever calls removeItem now (no persistence).
  const store = {};
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = v;
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
  return { byId, el };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("app.js: init and a draw sequence run without throwing and re-enable the button", async () => {
  const { el } = installDom({
    version: 1,
    name: "smoke",
    // Tiny spin so the test is fast; include an extraDraws rule so the
    // sequence has to chain draws and still terminate.
    settings: {
      specialDeckProbability: 0,
      decayFactor: 0.6,
      spinCount: 1,
      spinIntervalMs: 1,
      extraDrawDelayMs: 0, // chain extras immediately so the test is deterministic
    },
    rules: [
      { id: "plain", name: "Plain", deck: "normal", weight: 1, effect: {} },
      {
        id: "double",
        name: "Double",
        deck: "normal",
        weight: 1,
        effect: { extraDraws: 1 },
      },
    ],
  });

  // Loading app.js executes it against the stubbed globals.
  delete require.cache[require.resolve(path.join(__dirname, "..", "app.js"))];
  require("../app.js");
  assert.equal(typeof global.__domReady, "function", "DOMContentLoaded wired");
  global.__domReady(); // run init()

  const drawButton = el("drawButton");
  const resultEl = el("result");

  drawButton.click();
  assert.equal(drawButton.disabled, true, "button disabled while drawing");

  // Wait out the (fast) spin plus any chained extra draws.
  await wait(300);

  assert.equal(drawButton.disabled, false, "button re-enabled after sequence");
  assert.ok(resultEl.textContent.length > 0, "a result was rendered");
});

test("app.js self-heals from a stale index.html that never loaded engine.js", () => {
  // Simulate the cache bug: a cached index.html loads app.js WITHOUT engine.js
  // (window.PGREngine is undefined). app.js must inject engine.js and still
  // render the default ruleset — not crash into a blank page.
  const { el } = installDom(
    {
      version: 1,
      name: "stale-cache",
      settings: { specialDeckProbability: 0 },
      rules: [
        { id: "r1", name: "Rule One", deck: "normal", weight: 1 },
        { id: "r2", name: "Rule Two", deck: "normal", weight: 1 },
      ],
    },
    { withEngine: false },
  );
  assert.equal(global.window.PGREngine, undefined, "engine absent at load");

  delete require.cache[require.resolve(path.join(__dirname, "..", "app.js"))];
  require("../app.js");
  assert.equal(typeof global.__domReady, "function", "bootstrap wired");
  global.__domReady(); // bootstrap -> loads engine.js -> init()

  assert.ok(global.window.PGREngine, "engine was injected on demand");
  const table = el("probabilitiesTable");
  assert.ok(
    table.children.length >= 2,
    "default rules rendered after self-heal (not a blank page)",
  );
});

test("no persistence: loading clears any stored ruleset and never writes one", () => {
  installDom({
    version: 1,
    name: "no-persist",
    settings: { specialDeckProbability: 0 },
    rules: [{ id: "r1", name: "R1", deck: "normal", weight: 1 }],
  });
  // Simulate a ruleset left behind by an older, persisting version.
  global.localStorage.setItem("pgr.ruleset.v1", JSON.stringify({ rules: [] }));
  // Trip a write if the app ever tries to persist.
  let wroteRuleset = false;
  const rawSet = global.localStorage.setItem;
  global.localStorage.setItem = (k, v) => {
    if (k === "pgr.ruleset.v1") wroteRuleset = true;
    rawSet(k, v);
  };

  delete require.cache[require.resolve(path.join(__dirname, "..", "app.js"))];
  require("../app.js");
  global.__domReady();

  assert.equal(
    global.localStorage.getItem("pgr.ruleset.v1"),
    null,
    "existing stored ruleset was cleared on load",
  );
  assert.equal(wroteRuleset, false, "load never persists a ruleset");
});
