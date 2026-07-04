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

function installDom(storedRuleset) {
  const byId = {};
  const el = (id) => (byId[id] ||= new El());
  // editorPanel toggling reads style.display; keep it hidden.
  el("editorPanel").style.display = "none";

  global.document = {
    getElementById: el,
    querySelectorAll: () => [],
    createElement: (t) => new El(t),
    addEventListener: (ev, fn) => {
      if (ev === "DOMContentLoaded") global.__domReady = fn;
    },
  };
  global.window = { PGREngine: require("../engine.js") };
  const store = {};
  if (storedRuleset) {
    store["pgr.ruleset.v1"] = JSON.stringify(storedRuleset);
  }
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = v;
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
