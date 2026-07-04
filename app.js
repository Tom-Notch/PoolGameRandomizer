"use strict";

/*
 * PoolGameRandomizer — DOM layer.
 *
 * All game logic lives in engine.js (window.PGREngine); this file only wires it
 * to the page: persistence, the spin animation, rendering, and the rule editor.
 *
 * A ruleset is a JSON document: { version, name, settings, rules[] }.
 * Each rule: { id, name, description, deck, weight, enabled, tags, effect }.
 * See README.md for the full schema.
 */

// Resolved once the engine is present. app.js must not touch E until boot()
// has confirmed window.PGREngine is loaded — see the bootstrap at the bottom.
let E = window.PGREngine;
const STORAGE_KEY = "pgr.ruleset.v1";

// Safety cap: a single draw sequence (the click plus any chained extra draws)
// never runs more than this many spins, so a ruleset full of extraDraws can't
// spin forever.
const MAX_DRAWS_PER_SEQUENCE = 25;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ruleset; // loaded in init(), once the engine is guaranteed present
let weights = {}; // id -> current (decayed) weight
let history = [];
let activeEffects = []; // { uid, id, name, turnsLeft }
let lastDrawn = null;
let drawSeqActive = false;
let uidCounter = 0;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const el = (id) => document.getElementById(id);
const resultEl = el("result");
const descriptionEl = el("description");
const drawButton = el("drawButton");
const resetButton = el("resetButton");
const editorButton = el("editorButton");
const editorPanel = el("editorPanel");
const probabilitiesTable = el("probabilitiesTable");
const historyContainer = el("historyContainer");
const activeEffectsEl = el("activeEffects");

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function loadRuleset() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return E.normalizeRuleset(JSON.parse(raw));
    }
  } catch (e) {
    console.warn("加载本地规则失败，使用默认规则", e);
  }
  return E.normalizeRuleset(E.deepClone(E.DEFAULT_RULESET));
}

function saveRuleset() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ruleset));
  } catch (e) {
    console.warn("保存规则失败", e);
  }
}

// ---------------------------------------------------------------------------
// Draw + effect resolution
// ---------------------------------------------------------------------------

// A click runs one "draw sequence": the primary draw plus any extra draws it
// spawns, played one spin at a time so animations never overlap. The button
// re-enables only when the whole sequence finishes.
function startDrawSequence() {
  if (drawSeqActive) {
    return;
  }
  drawSeqActive = true;
  drawButton.disabled = true;
  tickTurns(); // a top-level draw advances the turn counter

  let pending = 1; // the primary draw
  let drawsDone = 0;

  const runOne = () => {
    if (pending <= 0 || drawsDone >= MAX_DRAWS_PER_SEQUENCE) {
      drawSeqActive = false;
      drawButton.disabled = false;
      return;
    }
    pending--;
    drawsDone++;
    spin((chosen) => {
      let extra = 0;
      if (chosen) {
        extra = applyRule(chosen);
      }
      pending += Math.max(0, extra);
      // Extra draws get a short beat so the player can read each result.
      const beat = extra > 0 ? (ruleset.settings.extraDrawDelayMs ?? 700) : 0;
      setTimeout(runOne, beat);
    });
  };

  runOne();
}

// Run one slot-machine spin, then hand the resolved rule to `done`.
function spin(done) {
  const settings = ruleset.settings;
  const allEnabled = ruleset.rules.filter((r) => r.enabled);
  let count = 0;
  resultEl.classList.add("spinning");

  const interval = setInterval(() => {
    const r = allEnabled[Math.floor(Math.random() * allEnabled.length)];
    if (r) {
      resultEl.textContent = r.name;
    }
    if (++count >= settings.spinCount) {
      clearInterval(interval);
      resultEl.classList.remove("spinning");
      done(E.resolveDraw(ruleset, weights, Math.random));
    }
  }, settings.spinIntervalMs);
}

// Extra draws requested by the current rule's customScript via ctx.drawAgain().
// Accumulated during applyRule and folded into its return value so the draw
// sequence chains them without overlapping animations.
let scriptExtraDraws = 0;

// Apply a drawn rule's effects/rendering. Returns the number of extra draws it
// requests, so the caller (startDrawSequence) can chain them without overlap.
function applyRule(rule) {
  resultEl.textContent = rule.name;
  descriptionEl.textContent = rule.description;
  const eff = rule.effect || {};
  scriptExtraDraws = 0;

  if (eff.clearAllEffects) {
    clearEffects();
  }

  if (eff.repeatLast && lastDrawn && lastDrawn.id !== rule.id) {
    applyEffectOnly(lastDrawn);
    descriptionEl.textContent =
      rule.description + "\n↪ 重复上一张：" + lastDrawn.name;
  }

  if (eff.persistent) {
    addEffectChip(rule);
  }

  runCustomScript(rule);

  E.applyDecay(weights, rule, ruleset.settings.decayFactor);

  addHistory(rule);
  lastDrawn = rule;
  renderProbabilities();

  return (Number(eff.extraDraws) || 0) + scriptExtraDraws;
}

// Re-apply only the persistent/engine side of an effect (used by repeatLast).
function applyEffectOnly(rule) {
  const eff = rule.effect || {};
  if (eff.clearAllEffects) {
    clearEffects();
  }
  if (eff.persistent) {
    addEffectChip(rule);
  }
}

// ---------------------------------------------------------------------------
// Active (persistent) effects
// ---------------------------------------------------------------------------

function addEffectChip(rule) {
  const before = activeEffects.length;
  E.addEffect(activeEffects, rule, uidCounter + 1);
  if (activeEffects.length > before) {
    uidCounter++;
  }
  renderActiveEffects();
}

function removeEffect(uid) {
  const idx = activeEffects.findIndex((a) => a.uid === uid);
  if (idx >= 0) {
    activeEffects.splice(idx, 1);
    renderActiveEffects();
  }
}

function clearEffects() {
  activeEffects = [];
  renderActiveEffects();
}

// At the start of each top-level draw, persistent effects with a turn budget
// tick down and expire.
function tickTurns() {
  const { effects } = E.tickEffects(activeEffects);
  activeEffects = effects;
  renderActiveEffects();
}

// ---------------------------------------------------------------------------
// customScript escape hatch (arbitrary user logic)
// ---------------------------------------------------------------------------

function makeCtx(rule) {
  return {
    rule,
    state: { activeEffects, history, weights, lastDrawn },
    addEffect: (r) => addEffectChip(r || rule),
    removeEffect: (uid) => removeEffect(uid),
    clearEffects: () => clearEffects(),
    drawAgain: (n) => {
      scriptExtraDraws += Math.max(0, Number(n) || 1);
    },
    log: (msg) => {
      descriptionEl.textContent += "\n› " + msg;
    },
  };
}

function runCustomScript(rule) {
  const script = rule.effect && rule.effect.customScript;
  if (!script || typeof script !== "string" || !script.trim()) {
    return;
  }
  try {
    // The page runs the operator's own rules; this is a deliberate escape hatch.
    const fn = new Function("ctx", script);
    fn(makeCtx(rule));
  } catch (e) {
    console.error("customScript 执行出错 [" + rule.id + "]", e);
    descriptionEl.textContent += "\n⚠ customScript 出错：" + e.message;
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function addHistory(rule) {
  history.unshift({ name: rule.name, deck: rule.deck, at: new Date() });
  if (history.length > 50) {
    history.pop();
  }
  renderHistory();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderProbabilities() {
  const rows = E.computeDisplayProbabilities(ruleset, weights);
  probabilitiesTable.innerHTML = "";
  for (const { rule, p } of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" +
      escapeHtml(rule.name) +
      "</td><td>" +
      (rule.deck === "special" ? "特殊" : "普通") +
      "</td><td>" +
      (p * 100).toFixed(2) +
      "%</td>";
    probabilitiesTable.appendChild(tr);
  }
}

function renderHistory() {
  if (!history.length) {
    historyContainer.innerHTML =
      '<div class="history-item"><span>暂无历史记录</span></div>';
    return;
  }
  historyContainer.innerHTML = history
    .map(
      (h) =>
        '<div class="history-item"><span class="h-name">' +
        escapeHtml(h.name) +
        "</span><span>" +
        h.at.toLocaleTimeString("zh-CN") +
        "</span></div>",
    )
    .join("");
}

function renderActiveEffects() {
  if (!activeEffects.length) {
    activeEffectsEl.innerHTML = '<div class="active-empty">暂无持续效果</div>';
    return;
  }
  activeEffectsEl.innerHTML = "";
  for (const a of activeEffects) {
    const chip = document.createElement("span");
    chip.className = "effect-chip";
    let label = a.name;
    if (a.turnsLeft != null) {
      label += " · " + a.turnsLeft + "回合";
    }
    chip.innerHTML =
      "<span>" + escapeHtml(label) + '</span><span class="chip-x">✕</span>';
    chip
      .querySelector(".chip-x")
      .addEventListener("click", () => removeEffect(a.uid));
    activeEffectsEl.appendChild(chip);
  }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

// ---------------------------------------------------------------------------
// Editor (form + JSON)
// ---------------------------------------------------------------------------

function buildRuleRow(rule) {
  const tpl = el("ruleRowTemplate").content.cloneNode(true);
  const root = tpl.querySelector(".rule-row");
  const eff = rule.effect || {};
  root.querySelector(".rule-name").value = rule.name;
  root.querySelector(".rule-deck").value = rule.deck;
  root.querySelector(".rule-weight").value = rule.weight;
  root.querySelector(".rule-enabled").checked = rule.enabled;
  root.querySelector(".rule-desc").value = rule.description;
  root.querySelector(".eff-persistent").checked = !!eff.persistent;
  root.querySelector(".eff-stackable").checked = !!eff.stackable;
  root.querySelector(".eff-clear").checked = !!eff.clearAllEffects;
  root.querySelector(".eff-repeat").checked = !!eff.repeatLast;
  root.querySelector(".eff-extra").value = eff.extraDraws || "";
  root.querySelector(".eff-maxturns").value =
    eff.maxTurns != null ? eff.maxTurns : "";
  root.querySelector(".eff-script").value = eff.customScript || "";
  root.dataset.id = rule.id;
  root
    .querySelector(".rule-delete")
    .addEventListener("click", () => root.remove());
  return root;
}

function renderEditor() {
  el("setSpecialProb").value = ruleset.settings.specialDeckProbability;
  el("setDecay").value = ruleset.settings.decayFactor;
  const list = el("rulesEditorList");
  list.innerHTML = "";
  for (const r of ruleset.rules) {
    list.appendChild(buildRuleRow(r));
  }
  el("jsonEditor").value = JSON.stringify(ruleset, null, 2);
}

function collectFromForm() {
  const rules = [];
  for (const row of el("rulesEditorList").querySelectorAll(".rule-row")) {
    const name = row.querySelector(".rule-name").value.trim();
    if (!name) {
      continue;
    }
    const effect = {};
    if (row.querySelector(".eff-persistent").checked) effect.persistent = true;
    if (row.querySelector(".eff-stackable").checked) effect.stackable = true;
    if (row.querySelector(".eff-clear").checked) effect.clearAllEffects = true;
    if (row.querySelector(".eff-repeat").checked) effect.repeatLast = true;
    const extra = parseInt(row.querySelector(".eff-extra").value, 10);
    if (extra > 0) effect.extraDraws = extra;
    const mt = parseInt(row.querySelector(".eff-maxturns").value, 10);
    if (mt > 0) effect.maxTurns = mt;
    const script = row.querySelector(".eff-script").value.trim();
    if (script) effect.customScript = script;
    rules.push({
      id: row.dataset.id || "rule-" + Math.random().toString(36).slice(2, 8),
      name,
      description: row.querySelector(".rule-desc").value,
      deck: row.querySelector(".rule-deck").value,
      weight: parseFloat(row.querySelector(".rule-weight").value) || 1,
      enabled: row.querySelector(".rule-enabled").checked,
      tags: [],
      effect,
    });
  }
  return E.normalizeRuleset({
    version: ruleset.version,
    name: ruleset.name,
    settings: Object.assign({}, ruleset.settings, {
      specialDeckProbability: parseFloat(el("setSpecialProb").value),
      decayFactor: parseFloat(el("setDecay").value),
    }),
    rules,
  });
}

function applyNewRuleset(rs, persist) {
  ruleset = rs;
  weights = E.resetWeights(ruleset.rules);
  if (persist) {
    saveRuleset();
  }
  renderProbabilities();
  renderEditor();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
  ruleset = loadRuleset();
  weights = E.resetWeights(ruleset.rules);
  renderProbabilities();
  renderHistory();
  renderActiveEffects();

  drawButton.addEventListener("click", () => startDrawSequence());

  resetButton.addEventListener("click", () => {
    weights = E.resetWeights(ruleset.rules);
    clearEffects();
    history = [];
    lastDrawn = null;
    resultEl.textContent = "准备开球...";
    descriptionEl.textContent = "点击下方按钮开始游戏";
    renderProbabilities();
    renderHistory();
  });

  editorButton.addEventListener("click", () => {
    const show = editorPanel.style.display === "none";
    editorPanel.style.display = show ? "block" : "none";
    if (show) {
      renderEditor();
    }
  });

  // Tabs
  for (const btn of document.querySelectorAll(".tab-button")) {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".tab-button")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      el("tabForm").style.display = tab === "form" ? "block" : "none";
      el("tabJson").style.display = tab === "json" ? "block" : "none";
      if (tab === "json") {
        el("jsonEditor").value = JSON.stringify(collectFromForm(), null, 2);
      }
    });
  }

  el("addRuleButton").addEventListener("click", () => {
    el("rulesEditorList").appendChild(
      buildRuleRow({
        id: "rule-" + Math.random().toString(36).slice(2, 8),
        name: "新规则",
        description: "",
        deck: "normal",
        weight: 1,
        enabled: true,
        effect: {},
      }),
    );
  });

  el("saveRulesButton").addEventListener("click", () => {
    applyNewRuleset(collectFromForm(), true);
    flashStatus("已保存并生效 ✓", true);
  });

  el("applyJsonButton").addEventListener("click", () => {
    try {
      const parsed = E.normalizeRuleset(JSON.parse(el("jsonEditor").value));
      applyNewRuleset(parsed, true);
      flashStatus("JSON 已生效 ✓", true);
    } catch (e) {
      flashStatus("JSON 解析失败：" + e.message, false);
    }
  });

  el("exportButton").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(ruleset, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pool-rules.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  el("importButton").addEventListener("click", () => el("importFile").click());
  el("importFile").addEventListener("change", (ev) => {
    const file = ev.target.files[0];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        applyNewRuleset(E.normalizeRuleset(JSON.parse(reader.result)), true);
        flashStatus("已导入 ✓", true);
      } catch (e) {
        flashStatus("导入失败：" + e.message, false);
      }
    };
    reader.readAsText(file);
  });

  el("restoreDefaultButton").addEventListener("click", () => {
    if (confirm("恢复默认规则？当前自定义规则将被覆盖。")) {
      applyNewRuleset(E.normalizeRuleset(E.deepClone(E.DEFAULT_RULESET)), true);
      flashStatus("已恢复默认 ✓", true);
    }
  });
}

function flashStatus(msg, ok) {
  const s = el("jsonStatus");
  s.textContent = msg;
  s.className = "json-status " + (ok ? "ok" : "err");
  setTimeout(() => {
    s.textContent = "";
    s.className = "json-status";
  }, 4000);
}

// Bootstrap. app.js depends on engine.js (window.PGREngine). A browser holding
// a stale, cached index.html from before the engine.js split would load app.js
// without engine.js — so rather than crash into a blank page, we load engine.js
// on demand, then init. This makes app.js resilient to HTML caching.
function boot() {
  E = window.PGREngine;
  init();
}

function whenEngineReady(cb) {
  if (window.PGREngine) {
    cb();
    return;
  }
  const s = document.createElement("script");
  s.src = "engine.js";
  s.onload = cb;
  document.head.appendChild(s);
}

function bootstrap() {
  whenEngineReady(boot);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
