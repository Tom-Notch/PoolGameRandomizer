"use strict";

/*
 * PoolGameRandomizer — declarative rule engine.
 *
 * A ruleset is a JSON document: { version, name, settings, rules[] }.
 * Each rule: { id, name, description, deck, weight, enabled, tags, effect }.
 * Rules can be added/edited at runtime (form or raw JSON), persisted to
 * localStorage, and exported/imported. The optional effect{} block carries
 * engine-real behaviors plus a customScript escape hatch for arbitrary logic.
 *
 * See README.md for the full schema.
 */

const STORAGE_KEY = "pgr.ruleset.v1";

// Embedded default ruleset. Mirrors rules.default.json so the page works from
// file:// (no fetch) as well as when hosted. Keep the two in sync.
const DEFAULT_RULESET = {
  version: 1,
  name: "默认台球规则",
  settings: {
    specialDeckProbability: 0.05,
    decayFactor: 0.6,
    spinCount: 15,
    spinIntervalMs: 80,
  },
  rules: [
    {
      id: "no-look",
      name: "从不回头",
      description: "强者，从不回头看爆炸。你需要背身击球",
      deck: "normal",
      weight: 1,
      enabled: true,
      tags: ["debuff"],
      effect: {},
    },
    {
      id: "payback",
      name: "加倍奉还",
      description:
        "此效果将持续存在且不可叠加。【加倍奉还】生效的回合若出现犯规，则为该回合的效果赋予【复仇】标记。【加倍奉还】被清除时会解除当前场上所有的【复仇】标记。复仇：在【加倍奉还】生效的回合，被赋予【复仇】的效果将自动触发",
      deck: "normal",
      weight: 1,
      enabled: true,
      tags: ["persistent"],
      effect: {
        persistent: true,
        stackable: false,
        triggers: [{ on: "foul", action: "applyMark", mark: "复仇" }],
      },
    },
    {
      id: "ex-nihilo",
      name: "无中生有",
      description: "你打出一张【无中生有】，立即抽取两张牌，效果叠加",
      deck: "normal",
      weight: 1,
      enabled: true,
      tags: ["draw"],
      effect: { extraDraws: 2, stackable: true },
    },
    {
      id: "off-hand",
      name: "非惯用手",
      description: "使用非惯用手击球",
      deck: "normal",
      weight: 1,
      enabled: true,
      tags: ["debuff"],
      effect: {},
    },
    {
      id: "encore",
      name: "故技重施",
      description: "获得上一回合抽到的效果",
      deck: "normal",
      weight: 1,
      enabled: true,
      tags: ["meta"],
      effect: { repeatLast: true },
    },
    {
      id: "duality",
      name: "两仪反转",
      description:
        "仅本回合，将黑八与母球互换，黑八视作母球，白球视作黑八。若出现犯规，则按犯规回合的母球结算自由球并按击球回合的母球击打",
      deck: "normal",
      weight: 1,
      enabled: true,
      tags: ["swap"],
      effect: {},
    },
    {
      id: "flawless",
      name: "无懈可击",
      description: "你打出一张【无懈可击】，清除所有效果，且本回合正常击球",
      deck: "normal",
      weight: 1,
      enabled: true,
      tags: ["cleanse"],
      effect: { clearAllEffects: true },
    },
    {
      id: "dragon-ball",
      name: "天降龙珠",
      description:
        "仅本回合，将黑八视作【龙珠】。龙珠：一种可被任意玩家击打的目标球，若打进龙珠则【召唤神龙】。召唤神龙：神龙吞噬任意一颗己方目标球，并用黑八替代其位置，被神龙吞噬的球视作常规进球",
      deck: "normal",
      weight: 1,
      enabled: true,
      tags: ["special-ball"],
      effect: {},
    },
    {
      id: "secret-halo",
      name: "秘奥义：杀戮光环",
      description:
        "秘奥义：立刻清除所有其余效果。杀戮光环：获得自由球并获得【裁决】。裁决：连杆时触发，下一回合抽牌后立即打出一张【无懈可击】，随后立即获得【裁决】",
      deck: "special",
      weight: 1,
      enabled: true,
      tags: ["ultimate", "persistent"],
      effect: { clearAllEffects: true, persistent: true },
    },
    {
      id: "secret-tap-dance",
      name: "秘奥义：踢踏舞",
      description:
        "秘奥义：立刻清除所有其余效果。踢踏舞：此效果将持续存在，至多6回合；效果存在期间跳过抽卡阶段，且玩家必须在t=6秒内击球，随后t=t-1；若未能达成，则清除【踢踏舞】并记为犯规",
      deck: "special",
      weight: 1,
      enabled: true,
      tags: ["ultimate", "persistent", "timer"],
      effect: {
        clearAllEffects: true,
        persistent: true,
        maxTurns: 6,
        timerSeconds: 6,
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ruleset = loadRuleset();
let weights = {}; // id -> current (decayed) weight
let history = [];
let activeEffects = []; // { uid, id, name, turnsLeft, timerLeft, timerHandle }
let lastDrawn = null;
let isDrawing = false;
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
      return normalizeRuleset(JSON.parse(raw));
    }
  } catch (e) {
    console.warn("加载本地规则失败，使用默认规则", e);
  }
  return normalizeRuleset(deepClone(DEFAULT_RULESET));
}

function saveRuleset() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ruleset));
  } catch (e) {
    console.warn("保存规则失败", e);
  }
}

function normalizeRuleset(rs) {
  const out = {
    version: rs.version || 1,
    name: rs.name || "未命名规则",
    settings: Object.assign(
      {
        specialDeckProbability: 0.05,
        decayFactor: 0.6,
        spinCount: 15,
        spinIntervalMs: 80,
      },
      rs.settings || {},
    ),
    rules: (rs.rules || []).map((r, i) => ({
      id: r.id || "rule-" + i + "-" + Math.random().toString(36).slice(2, 7),
      name: r.name || "未命名",
      description: r.description || "",
      deck: r.deck === "special" ? "special" : "normal",
      weight: typeof r.weight === "number" && r.weight >= 0 ? r.weight : 1,
      enabled: r.enabled !== false,
      tags: Array.isArray(r.tags) ? r.tags : [],
      effect: r.effect && typeof r.effect === "object" ? r.effect : {},
    })),
  };
  return out;
}

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

// ---------------------------------------------------------------------------
// Probability helpers
// ---------------------------------------------------------------------------

function resetWeights() {
  weights = {};
  for (const r of ruleset.rules) {
    weights[r.id] = r.weight;
  }
}

function enabledByDeck(deck) {
  return ruleset.rules.filter((r) => r.enabled && r.deck === deck);
}

function sumWeights(rules) {
  return rules.reduce((acc, r) => acc + (weights[r.id] ?? r.weight), 0);
}

// Display probability for each enabled rule, accounting for the special-deck split.
function computeDisplayProbabilities() {
  const specialP = clamp01(ruleset.settings.specialDeckProbability);
  const normals = enabledByDeck("normal");
  const specials = enabledByDeck("special");
  const hasSpecial = specials.length > 0;
  const normalShare = hasSpecial ? 1 - specialP : 1;
  const specialShare = hasSpecial ? specialP : 0;
  const nSum = sumWeights(normals) || 1;
  const sSum = sumWeights(specials) || 1;
  const rows = [];
  for (const r of normals) {
    rows.push({ rule: r, p: normalShare * ((weights[r.id] ?? r.weight) / nSum) });
  }
  for (const r of specials) {
    rows.push({ rule: r, p: specialShare * ((weights[r.id] ?? r.weight) / sSum) });
  }
  return rows;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x) || 0));
}

function weightedPick(rules) {
  const total = sumWeights(rules);
  if (total <= 0) {
    return rules[rules.length - 1];
  }
  let rand = Math.random() * total;
  for (const r of rules) {
    rand -= weights[r.id] ?? r.weight;
    if (rand <= 0) {
      return r;
    }
  }
  return rules[rules.length - 1];
}

// ---------------------------------------------------------------------------
// Draw + effect resolution
// ---------------------------------------------------------------------------

function resolveDraw() {
  const normals = enabledByDeck("normal");
  const specials = enabledByDeck("special");
  const specialP = clamp01(ruleset.settings.specialDeckProbability);
  const goSpecial = specials.length > 0 && Math.random() < specialP;
  const pool = goSpecial ? specials : normals.length ? normals : specials;
  if (!pool.length) {
    return null;
  }
  return weightedPick(pool);
}

function drawEvent(isExtra) {
  if (isDrawing && !isExtra) {
    return;
  }
  if (!isExtra) {
    tickTurns(); // a top-level draw advances the turn counter
  }
  isDrawing = true;
  drawButton.disabled = true;

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
      const chosen = resolveDraw();
      if (chosen) {
        applyRule(chosen);
      }
      isDrawing = false;
      drawButton.disabled = false;
    }
  }, settings.spinIntervalMs);
}

function applyRule(rule) {
  resultEl.textContent = rule.name;
  descriptionEl.textContent = rule.description;
  const eff = rule.effect || {};

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

  // Decay: a drawn normal rule becomes less likely next time.
  if (rule.deck === "normal") {
    weights[rule.id] = (weights[rule.id] ?? rule.weight) * ruleset.settings.decayFactor;
  }

  addHistory(rule);
  lastDrawn = rule;
  renderProbabilities();

  // Extra draws happen after a short beat so the player can read each result.
  const extra = Number(eff.extraDraws) || 0;
  if (extra > 0 && !applyRule._extraGuard) {
    queueExtraDraws(extra);
  }
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

function queueExtraDraws(n) {
  let remaining = n;
  const step = () => {
    if (remaining <= 0) {
      return;
    }
    remaining--;
    setTimeout(() => {
      drawEvent(true);
      step();
    }, 700);
  };
  step();
}

// ---------------------------------------------------------------------------
// Active (persistent) effects
// ---------------------------------------------------------------------------

function addEffectChip(rule) {
  const eff = rule.effect || {};
  if (!eff.stackable && activeEffects.some((a) => a.id === rule.id)) {
    return; // non-stackable: already active
  }
  const entry = {
    uid: ++uidCounter,
    id: rule.id,
    name: rule.name,
    turnsLeft: Number.isFinite(eff.maxTurns) ? eff.maxTurns : null,
    timerLeft: Number.isFinite(eff.timerSeconds) ? eff.timerSeconds : null,
    timerHandle: null,
  };
  if (entry.timerLeft != null) {
    entry.timerHandle = setInterval(() => {
      entry.timerLeft--;
      if (entry.timerLeft <= 0) {
        removeEffect(entry.uid);
      } else {
        renderActiveEffects();
      }
    }, 1000);
  }
  activeEffects.push(entry);
  renderActiveEffects();
}

function removeEffect(uid) {
  const idx = activeEffects.findIndex((a) => a.uid === uid);
  if (idx >= 0) {
    if (activeEffects[idx].timerHandle) {
      clearInterval(activeEffects[idx].timerHandle);
    }
    activeEffects.splice(idx, 1);
    renderActiveEffects();
  }
}

function clearEffects() {
  for (const a of activeEffects) {
    if (a.timerHandle) {
      clearInterval(a.timerHandle);
    }
  }
  activeEffects = [];
  renderActiveEffects();
}

// At the start of each top-level draw, persistent effects with a turn budget tick down.
function tickTurns() {
  for (const a of [...activeEffects]) {
    if (a.turnsLeft != null) {
      a.turnsLeft--;
      if (a.turnsLeft <= 0) {
        removeEffect(a.uid);
      }
    }
  }
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
    drawAgain: (n) => queueExtraDraws(Number(n) || 1),
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
  const rows = computeDisplayProbabilities();
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
    if (a.timerLeft != null) {
      label += " · ⏱" + a.timerLeft + "s";
    }
    chip.innerHTML =
      "<span>" + escapeHtml(label) + '</span><span class="chip-x">✕</span>';
    chip.querySelector(".chip-x").addEventListener("click", () => removeEffect(a.uid));
    activeEffectsEl.appendChild(chip);
  }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
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
  root.querySelector(".eff-timer").value =
    eff.timerSeconds != null ? eff.timerSeconds : "";
  root.querySelector(".eff-script").value = eff.customScript || "";
  root.dataset.id = rule.id;
  root.querySelector(".rule-delete").addEventListener("click", () => root.remove());
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
    const ts = parseInt(row.querySelector(".eff-timer").value, 10);
    if (ts > 0) effect.timerSeconds = ts;
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
  return normalizeRuleset({
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
  resetWeights();
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
  resetWeights();
  renderProbabilities();
  renderHistory();
  renderActiveEffects();

  drawButton.addEventListener("click", () => drawEvent(false));

  resetButton.addEventListener("click", () => {
    resetWeights();
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
      const parsed = normalizeRuleset(JSON.parse(el("jsonEditor").value));
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
        applyNewRuleset(normalizeRuleset(JSON.parse(reader.result)), true);
        flashStatus("已导入 ✓", true);
      } catch (e) {
        flashStatus("导入失败：" + e.message, false);
      }
    };
    reader.readAsText(file);
  });

  el("restoreDefaultButton").addEventListener("click", () => {
    if (confirm("恢复默认规则？当前自定义规则将被覆盖。")) {
      applyNewRuleset(normalizeRuleset(deepClone(DEFAULT_RULESET)), true);
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

document.addEventListener("DOMContentLoaded", init);
