"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../engine.js");

// A deterministic RNG that replays a fixed list of values, then holds the last.
function seq(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

const RULES = (overrides = {}) =>
  E.normalizeRuleset(
    Object.assign(
      {
        rules: [
          { id: "a", name: "A", deck: "normal", weight: 1 },
          { id: "b", name: "B", deck: "normal", weight: 3 },
          { id: "s", name: "S", deck: "special", weight: 1 },
        ],
      },
      overrides,
    ),
  );

test("normalizeRuleset fills defaults and coerces fields", () => {
  const rs = E.normalizeRuleset({
    rules: [{ name: "X", deck: "weird", weight: -5, enabled: false }],
  });
  assert.equal(rs.version, 1);
  assert.equal(rs.settings.specialDeckProbability, 0.05);
  assert.equal(rs.settings.decayFactor, 0.6);
  const r = rs.rules[0];
  assert.equal(r.deck, "normal", "unknown deck falls back to normal");
  assert.equal(r.weight, 1, "negative weight falls back to 1");
  assert.equal(r.enabled, false);
  assert.ok(r.id, "an id is generated");
  assert.deepEqual(r.tags, []);
  assert.deepEqual(r.effect, {});
});

test("normalizeRuleset tolerates empty / missing input", () => {
  const rs = E.normalizeRuleset();
  assert.deepEqual(rs.rules, []);
  assert.equal(rs.name, "未命名规则");
});

test("resetWeights mirrors each rule's base weight", () => {
  const rs = RULES();
  const w = E.resetWeights(rs.rules);
  assert.deepEqual(w, { a: 1, b: 3, s: 1 });
});

test("computeDisplayProbabilities sums to 1 with both decks", () => {
  const rs = RULES({ settings: { specialDeckProbability: 0.05 } });
  const w = E.resetWeights(rs.rules);
  const rows = E.computeDisplayProbabilities(rs, w);
  const total = rows.reduce((acc, r) => acc + r.p, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `total=${total}`);
  // normals share (1 - 0.05) split 1:3 between a and b
  const pa = rows.find((r) => r.rule.id === "a").p;
  const pb = rows.find((r) => r.rule.id === "b").p;
  const ps = rows.find((r) => r.rule.id === "s").p;
  assert.ok(Math.abs(pa - 0.95 * 0.25) < 1e-9);
  assert.ok(Math.abs(pb - 0.95 * 0.75) < 1e-9);
  assert.ok(Math.abs(ps - 0.05) < 1e-9);
});

test("computeDisplayProbabilities sums to 1 with only normals (empty-deck edge)", () => {
  const rs = RULES({
    rules: [
      { id: "a", name: "A", deck: "normal", weight: 1 },
      { id: "b", name: "B", deck: "normal", weight: 1 },
    ],
  });
  const w = E.resetWeights(rs.rules);
  const rows = E.computeDisplayProbabilities(rs, w);
  const total = rows.reduce((acc, r) => acc + r.p, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `total=${total}`);
});

test("computeDisplayProbabilities sums to 1 with only specials (empty-deck edge)", () => {
  const rs = RULES({
    settings: { specialDeckProbability: 0.05 },
    rules: [{ id: "s", name: "S", deck: "special", weight: 1 }],
  });
  const w = E.resetWeights(rs.rules);
  const rows = E.computeDisplayProbabilities(rs, w);
  const total = rows.reduce((acc, r) => acc + r.p, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `total=${total}`);
});

test("weightedPick respects weights via injected rng", () => {
  const rs = RULES();
  const w = E.resetWeights(rs.rules);
  const normals = E.enabledByDeck(rs.rules, "normal"); // a(1), b(3), total 4
  // rng*4: 0.1 -> 0.4 lands in a's [0,1); 0.9 -> 3.6 lands in b's [1,4)
  assert.equal(E.weightedPick(normals, w, seq([0.1])).id, "a");
  assert.equal(E.weightedPick(normals, w, seq([0.9])).id, "b");
});

test("weightedPick returns null for an empty pool and last for zero weights", () => {
  assert.equal(E.weightedPick([], {}, seq([0.5])), null);
  const rules = [{ id: "x", weight: 0 }];
  assert.equal(E.weightedPick(rules, { x: 0 }, seq([0.5])).id, "x");
});

test("resolveDraw picks special vs normal deck by threshold", () => {
  const rs = RULES({ settings: { specialDeckProbability: 0.05 } });
  const w = E.resetWeights(rs.rules);
  // first rng() < 0.05 -> special deck, then pick within specials
  assert.equal(E.resolveDraw(rs, w, seq([0.01, 0.5])).deck, "special");
  // first rng() >= 0.05 -> normal deck
  assert.equal(E.resolveDraw(rs, w, seq([0.5, 0.1])).deck, "normal");
});

test("resolveDraw returns null when nothing is enabled", () => {
  const rs = RULES({
    rules: [{ id: "a", name: "A", deck: "normal", weight: 1, enabled: false }],
  });
  const w = E.resetWeights(rs.rules);
  assert.equal(E.resolveDraw(rs, w, seq([0.5])), null);
});

test("applyDecay only decays normal-deck rules", () => {
  const w = { a: 1, s: 1 };
  E.applyDecay(w, { id: "a", deck: "normal", weight: 1 }, 0.6);
  E.applyDecay(w, { id: "s", deck: "special", weight: 1 }, 0.6);
  assert.equal(w.a, 0.6);
  assert.equal(w.s, 1, "special weight is untouched");
});

test("addEffect dedupes non-stackable and stacks stackable", () => {
  const rule = { id: "p", name: "P", effect: { persistent: true } };
  const eff = [];
  E.addEffect(eff, rule, 1);
  E.addEffect(eff, rule, 2);
  assert.equal(eff.length, 1, "non-stackable stays single");

  const stk = {
    id: "q",
    name: "Q",
    effect: { persistent: true, stackable: true },
  };
  const eff2 = [];
  E.addEffect(eff2, stk, 1);
  E.addEffect(eff2, stk, 2);
  assert.equal(eff2.length, 2, "stackable allows duplicates");
});

test("addEffect records a turn budget from maxTurns", () => {
  const eff = [];
  E.addEffect(eff, { id: "t", name: "T", effect: { maxTurns: 6 } }, 1);
  assert.equal(eff[0].turnsLeft, 6);
  E.addEffect(eff, { id: "u", name: "U", effect: {} }, 2);
  assert.equal(eff[1].turnsLeft, null, "no maxTurns -> no budget");
});

test("tickEffects decrements budgets and expires at zero", () => {
  const eff = [
    { uid: 1, id: "t", name: "T", turnsLeft: 2 },
    { uid: 2, id: "p", name: "P", turnsLeft: null },
    { uid: 3, id: "x", name: "X", turnsLeft: 1 },
  ];
  const r1 = E.tickEffects(eff);
  assert.deepEqual(r1.expired, [3], "the 1-turn effect expires");
  assert.equal(r1.effects.length, 2);
  assert.equal(r1.effects.find((a) => a.uid === 1).turnsLeft, 1);
  assert.equal(r1.effects.find((a) => a.uid === 2).turnsLeft, null);
  // input is not mutated
  assert.equal(eff[0].turnsLeft, 2);
});

test("default ruleset is timer-free (regression for removed timer feature)", () => {
  const json = JSON.stringify(E.DEFAULT_RULESET);
  assert.ok(!json.includes("timerSeconds"), "no timerSeconds field");
  assert.ok(!json.includes("timerLeft"), "no timerLeft field");
  for (const r of E.DEFAULT_RULESET.rules) {
    assert.ok(!r.tags.includes("timer"), `rule ${r.id} has no timer tag`);
    assert.ok(
      !("timerSeconds" in (r.effect || {})),
      `rule ${r.id} effect has no timerSeconds`,
    );
    assert.ok(
      !/t=\d+秒/.test(r.description),
      `rule ${r.id} description has no seconds timer`,
    );
  }
});

test("engine DEFAULT_RULESET stays in sync with rules.default.json", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const disk = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "rules.default.json"), "utf8"),
  );
  // Normalize both sides so incidental key ordering / defaults don't matter.
  assert.deepEqual(
    E.normalizeRuleset(disk),
    E.normalizeRuleset(E.DEFAULT_RULESET),
  );
});
