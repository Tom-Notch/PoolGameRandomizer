<h1 align="center">PoolGameRandomizer</h1>

<p align="center">
  <em>台球“抽卡”随机器 —— 声明式规则引擎，随时加规则，复杂规则也支持</em>
</p>

<p align="center">
  <a href="https://github.com/Tom-Notch/PoolGameRandomizer/actions/workflows/pre-commit.yml"><img src="https://github.com/Tom-Notch/PoolGameRandomizer/actions/workflows/pre-commit.yml/badge.svg" alt="pre-commit"></a>
  <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT">
</p>

每杆开球前抽一张“效果牌”，给台球加点花样。原版（poolgamerandomizer.mingfan.uk）把事件、描述、特殊牌写死在几个平行数组里，加规则要改代码。这一版把它换成了**声明式规则引擎**：规则是数据（JSON），可以在页面里随时增删改、导入导出、本地持久化，并且支持带“持续 / 叠加 / 倒计时 / 额外抽牌 / 自定义脚本”等复杂行为的规则。

零构建、纯静态（`index.html` + `styles.css` + `app.js`），直接丢到 GitHub Pages / Cloudflare Pages 就能跑，也能本地双击打开。

## 玩法

- **下一杆**：按当前概率抽一张牌，展示名称与描述。
- **概率分布**：实时显示每张牌的概率。抽到的普通牌概率会按 `decayFactor` 衰减（默认 ×0.6），让结果更均匀；特殊牌堆按固定概率触发。
- **当前生效**：持续型效果以“药丸”形式挂在这里，带回合数 / 倒计时，可手动移除。
- **重置概率**：恢复初始权重、清空历史与持续效果。
- **规则编辑器**：表单或 JSON 两种方式编辑规则，保存即生效并存到浏览器 `localStorage`。

## 规则 Schema

一套规则就是一个 JSON 文档，默认内容见 [rules.default.json](rules.default.json)：

```jsonc
{
  "version": 1,
  "name": "默认台球规则",
  "settings": {
    "specialDeckProbability": 0.05, // 每次抽牌进入“特殊牌堆”的概率
    "decayFactor": 0.6, // 抽中的普通牌权重 ×= 此值
    "spinCount": 15, // 抽奖动画帧数
    "spinIntervalMs": 80 // 动画帧间隔(ms)
  },
  "rules": [
    {
      "id": "ex-nihilo", // 唯一 id
      "name": "无中生有",
      "description": "抽到时展示给玩家的文字",
      "deck": "normal", // "normal" | "special"
      "weight": 1, // 同一牌堆内的相对权重
      "enabled": true,
      "tags": ["draw"],
      "effect": { "extraDraws": 2, "stackable": true }
    }
  ]
}
```

### `effect{}` —— 复杂规则

所有字段都可选；不写就是一张“纯展示”的牌。

- `persistent` (bool)：抽到后作为持续效果挂到“当前生效”区
- `stackable` (bool)：持续效果是否可叠加（false 时同名只保留一个）
- `maxTurns` (int)：持续效果最多存在多少个回合（每次顶层抽牌算一回合，到 0 移除）
- `timerSeconds` (int)：持续效果附带的倒计时（秒），归零自动移除
- `extraDraws` (int)：抽到后立即追加抽 N 张（实现“无中生有”）
- `repeatLast` (bool)：重新施加上一张牌的效果（实现“故技重施”）
- `clearAllEffects` (bool)：立刻清除所有持续效果（实现“无懈可击”）
- `triggers` (array)：声明式触发器（如犯规打标记），供桌面裁定参考
- `customScript` (string)：**逃生舱**，任意 JS 函数体 `(ctx) => { ... }`，见下

### customScript —— 任意复杂逻辑

当声明式字段不够用时，直接写一段 JS。它在抽到该牌时执行，`ctx` 提供：

```js
ctx.rule; // 当前规则对象
ctx.state; // { activeEffects, history, weights, lastDrawn }
ctx.addEffect(rule); // 追加一个持续效果（默认用当前规则）
ctx.removeEffect(uid); // 按 uid 移除
ctx.clearEffects(); // 清空所有持续效果
ctx.drawAgain(n); // 追加抽 n 张
ctx.log(msg); // 在描述区追加一行提示
```

例：50% 概率再抽一张，否则清场——

```js
if (Math.random() < 0.5) {
  ctx.drawAgain(1);
} else {
  ctx.clearEffects();
  ctx.log("场面清空");
}
```

> ⚠️ `customScript` 会以 `new Function` 执行，相当于运行你自己写进规则里的代码。仅给可信的人编辑规则；不要导入来路不明的规则文件。

## 加规则的三种方式

1. **表单**：规则编辑器 → 「+ 新增规则」，填名称/描述/权重，展开「高级效果」勾选行为 → 保存并生效。
1. **JSON**：规则编辑器 → 「JSON 编辑」标签，直接改整套 JSON → 应用 JSON。
1. **文件**：导出当前规则为 `pool-rules.json`，编辑后再导入。

所有改动存浏览器 `localStorage`，刷新不丢；想回到出厂设置点「恢复默认」。

## 本地开发

```shell
bash scripts/dev-setup.sh   # 安装并启用 pre-commit 钩子
```

纯静态、无需构建。本地预览：

```shell
python3 -m http.server 8000   # 然后打开 http://localhost:8000
```

## 部署

把 `index.html` / `styles.css` / `app.js` / `rules.default.json` 作为静态资源发布即可：GitHub Pages（仓库 Settings → Pages → 选分支根目录）、Cloudflare Pages、或任意静态托管。

## License

[MIT](LICENSE)
