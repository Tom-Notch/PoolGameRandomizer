"use strict";

/*
 * PoolGameRandomizer — pure rule engine (no DOM).
 *
 * This module holds every piece of game logic that does not touch the page:
 * ruleset normalization, probability math, weighted draws, weight decay, and
 * the persistent-effect state machine. Randomness is injected (an `rng`
 * argument defaulting to Math.random) so the behavior is fully testable.
 *
 * It loads both as a plain browser global (window.PGREngine, so index.html
 * keeps working from file:// with no module/CORS fuss) and as a CommonJS
 * module (require("./engine.js")) for the Node test suite.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PGREngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  const DEFAULT_SETTINGS = {
    specialDeckProbability: 0.05,
    decayFactor: 0.6,
    spinCount: 15,
    spinIntervalMs: 80,
    extraDrawDelayMs: 700, // beat between chained extra draws
  };

  // Canonical default ruleset. rules.default.json mirrors this for hosted
  // fetch use; keep the two in sync.
  const DEFAULT_RULESET = {
    version: 1,
    name: "默认台球规则",
    settings: Object.assign({}, DEFAULT_SETTINGS),
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
          "秘奥义：立刻清除所有其余效果。踢踏舞：此效果将持续存在，至多6回合；效果存在期间跳过抽卡阶段，超过6回合后清除【踢踏舞】。",
        deck: "special",
        weight: 1,
        enabled: true,
        tags: ["ultimate", "persistent"],
        effect: {
          clearAllEffects: true,
          persistent: true,
          maxTurns: 6,
        },
      },
    ],
  };

  function deepClone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function clamp01(x) {
    return Math.max(0, Math.min(1, Number(x) || 0));
  }

  function normalizeRuleset(rs) {
    rs = rs || {};
    return {
      version: rs.version || 1,
      name: rs.name || "未命名规则",
      settings: Object.assign({}, DEFAULT_SETTINGS, rs.settings || {}),
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
  }

  function resetWeights(rules) {
    const weights = {};
    for (const r of rules) {
      weights[r.id] = r.weight;
    }
    return weights;
  }

  function enabledByDeck(rules, deck) {
    return rules.filter((r) => r.enabled && r.deck === deck);
  }

  function sumWeights(rules, weights) {
    return rules.reduce((acc, r) => acc + (weights[r.id] ?? r.weight), 0);
  }

  // Resolve how probability mass splits between the two decks, handling the
  // cases where one deck is empty (the empty-deck edge the old code got wrong:
  // display and draw disagreed when only one deck had enabled rules).
  function deckShares(ruleset) {
    const specialP = clamp01(ruleset.settings.specialDeckProbability);
    const normals = enabledByDeck(ruleset.rules, "normal");
    const specials = enabledByDeck(ruleset.rules, "special");
    let normalShare;
    let specialShare;
    if (normals.length && specials.length) {
      normalShare = 1 - specialP;
      specialShare = specialP;
    } else if (specials.length) {
      normalShare = 0;
      specialShare = 1;
    } else {
      normalShare = 1;
      specialShare = 0;
    }
    return { normals, specials, normalShare, specialShare };
  }

  // Per-rule display probabilities. The returned p values sum to 1 whenever at
  // least one rule is enabled.
  function computeDisplayProbabilities(ruleset, weights) {
    const { normals, specials, normalShare, specialShare } =
      deckShares(ruleset);
    const nSum = sumWeights(normals, weights) || 1;
    const sSum = sumWeights(specials, weights) || 1;
    const rows = [];
    for (const r of normals) {
      rows.push({
        rule: r,
        p: normalShare * ((weights[r.id] ?? r.weight) / nSum),
      });
    }
    for (const r of specials) {
      rows.push({
        rule: r,
        p: specialShare * ((weights[r.id] ?? r.weight) / sSum),
      });
    }
    return rows;
  }

  function weightedPick(rules, weights, rng) {
    rng = rng || Math.random;
    if (!rules.length) {
      return null;
    }
    const total = sumWeights(rules, weights);
    if (total <= 0) {
      return rules[rules.length - 1];
    }
    let rand = rng() * total;
    for (const r of rules) {
      rand -= weights[r.id] ?? r.weight;
      if (rand <= 0) {
        return r;
      }
    }
    return rules[rules.length - 1];
  }

  // Pick the actually-drawn rule, consistent with computeDisplayProbabilities.
  function resolveDraw(ruleset, weights, rng) {
    rng = rng || Math.random;
    const { normals, specials, specialShare } = deckShares(ruleset);
    if (!normals.length && !specials.length) {
      return null;
    }
    const goSpecial = specials.length > 0 && rng() < specialShare;
    const pool = goSpecial ? specials : normals.length ? normals : specials;
    return weightedPick(pool, weights, rng);
  }

  // A drawn normal rule becomes less likely next time. Mutates and returns weights.
  function applyDecay(weights, rule, decayFactor) {
    if (rule.deck === "normal") {
      weights[rule.id] = (weights[rule.id] ?? rule.weight) * decayFactor;
    }
    return weights;
  }

  // Add a persistent effect chip. Non-stackable effects that are already active
  // are ignored. Mutates and returns the activeEffects array.
  function addEffect(activeEffects, rule, uid) {
    const eff = rule.effect || {};
    if (!eff.stackable && activeEffects.some((a) => a.id === rule.id)) {
      return activeEffects;
    }
    activeEffects.push({
      uid,
      id: rule.id,
      name: rule.name,
      turnsLeft: Number.isFinite(eff.maxTurns) ? eff.maxTurns : null,
    });
    return activeEffects;
  }

  // Advance one turn: effects with a turn budget tick down; expired ones drop.
  // Returns { effects, expired } (expired = removed uids). Does not mutate input.
  function tickEffects(activeEffects) {
    const expired = [];
    const effects = [];
    for (const a of activeEffects) {
      if (a.turnsLeft == null) {
        effects.push(a);
        continue;
      }
      const turnsLeft = a.turnsLeft - 1;
      if (turnsLeft <= 0) {
        expired.push(a.uid);
      } else {
        effects.push(Object.assign({}, a, { turnsLeft }));
      }
    }
    return { effects, expired };
  }

  return {
    DEFAULT_SETTINGS,
    DEFAULT_RULESET,
    deepClone,
    clamp01,
    normalizeRuleset,
    resetWeights,
    enabledByDeck,
    sumWeights,
    deckShares,
    computeDisplayProbabilities,
    weightedPick,
    resolveDraw,
    applyDecay,
    addEffect,
    tickEffects,
  };
});
