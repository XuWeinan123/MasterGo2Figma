# 测试集 0712-2 · Figma 特性覆盖样本（往返答案卡）

本文件是为 **MasterGo → Figma 往返测试**手工搭建的 Figma 特性样本的**权威规格**。
用途：把这个 Figma 文件导入 MasterGo，再从 MasterGo 分别导出原生 `.mg` 与 SendToFigma
v2 zip 基准，用 `tools/compare_mg_import.js` 验证解码器对这些特性的支持。本文档记录
**样本里应该有什么**，供带回 `.mg`+zip 后逐项核对——它是往返保真度的“答案卡”。

## 来源与往返流程

- **Figma 文件 key**：`TUzF5z3CRvrY3FDNGvhIJX`，页名 `测试集 0712-2`（page id `0:1`）。
- 搭建方式：Figma MCP `use_figma`（Plugin API），非 MasterGo 原生绘制。
- 往返步骤：
  1. 把该 Figma 文件导入 MasterGo。
  2. 在 MasterGo 里**同时导出两份**：SendToFigma 插件 → v2 zip（基准），原生 `.mg`。
  3. 落到 `测试集/0713-x/`，`node tools/compare_mg_import.js <mg> <zip>`。
- ⚠️ **能测到什么取决于 MasterGo 从 Figma 导入时保留了什么**。Figma 独有能力
  （背景模糊、variant property 的命名模型等）可能在进 MasterGo 时丢失或降级——
  那本身是有用的发现，用于划清“解码器该支持” vs “MasterGo 根本不产出”的边界。

## 目标：此前从未被任何测试集覆盖的解码器空白

见 `docs/MG_DECODER_UNKNOWN_FIELDS.md` 与 `docs/MG_DECODER.md` 的“仍未破解”清单。
本样本八区一一对应这些空白。

## 样式库（本地 styles，被各区引用）

| 类型 | 名称 |
|---|---|
| Paint（纯色） | `Brand/Blue` `Brand/Indigo` `Accent/Pink` `Accent/Amber` `Neutral/900` `Neutral/500` `Neutral/100` |
| Paint（渐变） | `Gradient/Sunset`（线性，Amber→Pink） |
| Effect | `Shadow/Small`(drop) `Shadow/Large`(drop) `Inner/Subtle`(inner shadow) `Blur/Layer`(layer blur) |
| Text | `Heading/H1`(Inter Semi Bold 32/40, ls −1%) `Heading/H2`(Inter Semi Bold 24/32) `Body/Regular`(Inter Regular 16/24) `Body/Small`(Inter Regular 13/20) `Mono/Code`(Roboto Mono Regular 14/20, ls 0.5px) `CJK/Body`(Noto Sans SC Regular 16/26) |

字体族：Inter、Roboto Mono、Noto Sans SC（CJK）。注意 Inter 的半粗体样式串是
`Semi Bold`（带空格），Roboto/Montserrat/Poppins 是 `SemiBold`（无空格）。

## 区块清单（页内节点 id 为搭建时快照，导入后会变，仅供人工定位）

| 区 | section 节点 | 覆盖的空白 | 关键内容 |
|---|---|---|---|
| ① Color Styles | `4:2` | 颜色样式 → paint style | 8 色块 `setFillStyleIdAsync` 引用上表 paint（含渐变） |
| ② Text Styles | `4:29` | 文字样式库 | 6 行文本各应用一个 text 样式（含等宽、CJK） |
| ③ Effect Styles | `5:2` | 效果样式库 | 4 卡片 `setEffectStyleIdAsync` 引用 effect 样式 |
| ④ Direct Effects | `7:2` | effect 类型覆盖 | 多投影叠加 / 内阴影 / 强图层模糊 / **背景模糊** / 投影+内阴影 |
| ⑤ Rich Text | `8:2` | 文本分段 | 见下方“富文本分段规格” |
| ⑥ Button ComponentSet | set `9:38` | **ComponentSet / variant properties（最高价值）** | 见下方“变体规格” |
| ⑥ Usage instances | frame `12:2` | 实例的变体选择 + 属性覆盖 | 4 个实例，见“实例规格” |
| ⑦ Stars & Polygons | `12:24` | pointCount / innerRadius | 星形 5 种、多边形 4 种 |
| ⑧ Image scaleMode | `13:13` | 裁剪 transform / 平铺 | FILL / FIT / CROP / TILE，imageHash `f44558940e700f90bd8cb75447dfd2d3ea65c0c4` |
| 顶部横幅 | `15:11` | — | 渐变标题条 |

### ④ 直接效果（非样式，逐节点 effect 数组）

- `multi drop-shadow`：2× DROP_SHADOW（蓝左上 + 粉右下，各 radius 12）。
- `inner shadow`：INNER_SHADOW offset(0,4) radius 8 spread 1。
- `layer blur`：LAYER_BLUR radius 14（渐变底）。
- `background blur`：BACKGROUND_BLUR radius 12（半透明白 glass 叠在三色渐变上）。
- `drop + inner`：DROP_SHADOW + INNER_SHADOW 组合。

### ⑤ 富文本分段规格

- 单段混排 `Design 设计 Дизайн`：`Design `=Inter Bold 28 蓝、`设计`=Noto Sans SC Bold 32 粉、`Дизайн`=Inter Italic 28 琥珀（拉丁+CJK+西里尔三脚本）。
- 句中强调 `This word is HUGE and bold in the middle.`：`HUGE`=Inter Bold 30 粉。
- textCase：三段分别 `UPPER` / `LOWER` / `TITLE`。
- 字距：`TRACKING +8px`（PIXELS 8） 与 `TRACKING +20%`（PERCENT 20）——**测 px vs % 单位**。
- 装饰：一段 `UNDERLINE`（蓝）+ 一段 `STRIKETHROUGH`（粉）。

### ⑥ 变体规格

- 组件集 `Button`，变体轴：`Size`(Small/Medium/Large) × `Type`(Primary/Secondary) × `State`(Default/Disabled) = **12 变体**。
- 每变体：横向 auto-layout，`icon`(ellipse) + `label`(text)；Primary=蓝底白字，Secondary=浅底蓝描边深字；Disabled=opacity 0.4。
- 组件属性：TEXT `Label`（key `Label#10:0`，绑 label.characters）、BOOLEAN `Show icon`（key `Show icon#10:13`，绑 icon.visible）。

### ⑥ 实例规格（4 个，验证变体选择 + 属性覆盖）

| 实例 | Size | Type | State | Label | Show icon |
|---|---|---|---|---|---|
| Save | Large | Primary | Default | Save | true |
| Cancel | Medium | Secondary | Default | Cancel | false |
| Loading | Small | Primary | Disabled | Loading | true |
| Continue | Large | Secondary | Default | Continue | true |

### ⑦ 星形 / 多边形

- 星形（琥珀填充）：`(pointCount, innerRadius)` = (3,0.5) (5,0.38) (5,0.7) (6,0.5) (8,0.6) (12,0.75)。
- 多边形（蓝填充）：pointCount 3 / 5 / 6 / 8。

### ⑧ 图片 scaleMode

离屏图案（渐变底 + 白星 + 粉点）`exportAsync` 成真实 PNG，贴到 4 个 150×96 矩形：
- `FILL`、`FIT`、`CROP`（imageTransform `[[0.5,0,0.25],[0,0.5,0.25]]` 中心放大裁剪）、`TILE`（scalingFactor 0.5）。

## 往返核对清单（带 .mg + zip 回来后按此逐项过）

- [ ] 样式引用：色块/文本/卡片是否携带对 paint/text/effect 样式的**引用**，还是被摊平成内联值？（MasterGo 有无“样式库”对应物）
- [ ] effect 类型：inner shadow / layer blur / **background blur** / 多 effect 是否保真？
- [ ] 富文本：分段字体/字号/颜色、textCase、**字距 px vs %**、下划线/删除线是否逐段还原？
- [ ] ComponentSet：变体轴与 variant 命名、组件属性（Label/Show icon）是否保留？实例的变体选择 + 属性覆盖是否还原？
- [ ] star pointCount/innerRadius、polygon pointCount 是否精确？
- [ ] image CROP 的 imageTransform、TILE 的 scalingFactor 是否保真？

## Mirror

样本存在性与覆盖速记见自动记忆 `testset-0712-2-figma-specimen.md`；解码器现状见
[`MG_DECODER.md`](MG_DECODER.md) 与 [`MG_DECODER_UNKNOWN_FIELDS.md`](MG_DECODER_UNKNOWN_FIELDS.md)。

## 首轮往返结果（2026-07-12，落盘为 测试集/0712-3）

比较器:初始 deep 153 / Effect 5 / Font 36 / Paint 3 → **终态 deep 5、其余全零**。
一轮破解七族 + 样式库还原落地(细节见 `MG_DECODER_JOURNAL.md` 同日条目):
effect kind 0=INNER/3=BG_BLUR + `0f`=spread、star/polygon zigzag pointCount +
innerRadius、image scaleMode 4=TILE、对齐枚举 1=MAX、decoration 4=STRIKETHROUGH、
裸模板引用记录的 strokeWeight 填充规则、混排文本节点 fill=首段。样式库=
`文字/`(text)、`填充/`(fill)、`特效/`(effect)前缀具名记录 → styles.json +
记录级 style ref → 导入端重建 Figma styles 并绑定。

核对清单结论(经用户实测二轮修正):样式引用 ✓(还原为本地样式+绑定)、
effect 全类型 ✓(第二轮修掉导入端 showShadowBehindNode-塞给-INNER_SHADOW 的
applier bug,此前内阴影在 mg/zip 两路都全灭)、富文本分段/字距单位/装饰 ✓、
star/polygon ✓、image FILL/FIT ✓、**CROP ✓(超越 zip:解码 04 子对象显示矩形
→ imageTransform 逐位还原;zip 基准整个丢裁剪窗)**、**TILE ✓(导入端补
ratio→scalingFactor 映射,zip 路径同受益)**;ComponentSet 变体结构 ✓ 但变体名
保留 MasterGo 括号原形(`Size[a2]=Large`,基准如此,勿归一化)。

**"MasterGo 不产出"边界(mg/zip 都无从还原)**:textCase **TITLE**(UPPER 条目
带 `0a 01`,TITLE 条目无 `0a` 字段)、组件属性定义(Label/Show icon 降级为普通
覆盖)。遗留 deep 6 行:CROP imageTransform +1(超越基准,故意)、变体名 12 选
1 被 MasterGo 洗 1 行、隐藏 icon 清零变换 4 行。
