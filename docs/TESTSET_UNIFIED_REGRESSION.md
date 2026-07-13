# 统一回归测试集（插件测试文件 · 回归 2026-07 section）· 答案卡

本文件是**近几轮问题图层合并回归集**的权威规格。目标：一次往返覆盖 2026-07 各轮
（0712-2 / 0711-3 特斯拉 / 0712-3 特性样本三轮 / 0711-2）出现过的问题机制，
让旧的分散测试集可以退役，减少后续对比的上下文开销。

## 位置与往返流程

- **Figma 文件 key**：`VOxB5rJq5fji1l64tOfq2o`（文件名「插件测试」），页 `8:3`
  （Plugin Node Coverage Demo）。
- 新增内容集中在 **section `17:12`「回归 2026-07 近期问题图层」**（页面下方
  x130 y1800 起，2140×1720），九个子区 R01–R09。
- **同页既有覆盖（早期问题图层，勿重复建）**：`8:4` 节点覆盖总览（含 MasterGo
  括号变体命名形态）、`8:71` 保真度测试（富文本/线性·径向·角向·菱形渐变/嵌套
  分组/缺失图片）、`8:107` Strokes 描边矩阵、`8:118` BoolOperation 布尔 16 连、
  `8:183` 复杂形状真实 case、`8:225` 位图+蒙版。
- 往返步骤：整页导入 MasterGo → 同时导出原生 `.mg` 与 SendToFigma v2 zip →
  `node tools/compare_mg_import.js <mg> <zip>`；导入端问题（比较器盲区）用
  Figma 里 origin/zip/mg 三页肉眼+MCP 对比。

## 样式库（本地 styles，`回归/` 前缀，R01 引用）

| 类型 | 名称 | 值 |
|---|---|---|
| Paint | `回归/Brand Blue` | #2563EB |
| Paint | `回归/Accent Pink` | #EC4899 |
| Paint | `回归/夕阳渐变`（**中文名**，测 UTF-8 名字段） | 线性 Amber→Pink |
| Text | `回归/标题 H2` | Inter Semi Bold 24/32px，ls −1% |
| Text | `回归/正文` | Inter Regular 16/24px |
| Text | `回归/Mono Code` | Roboto Mono Regular 14/20px，ls 0.5px |
| Text | `回归/中文正文` | Noto Sans SC Regular 16/26px |
| Effect | `回归/Shadow SM` | drop (0,2) r8 rgba(15,23,42,.18) |
| Effect | `回归/内阴影`（中文名） | inner (0,4) r8 spread1 rgba(0,0,0,.25) |
| Effect | `回归/Layer Blur` | layer blur 10 |

## 九区规格（node id 为搭建时快照，导入后会变）

| 区 | 复现机制 | 来源轮次 |
|---|---|---|
| R01 样式库引用 `18:2` | paint/text/effect 样式 → styles.json + 记录级 ref + 导入端重建绑定 | 0712-3 样式弧 |
| R02 直接效果 `19:2` | 内阴影零压缩(05 省略)、drop+inner 同节点（showShadowBehindNode applier bug）、多投影、层模糊、**背景模糊** | 0712-3 二轮 |
| R03 图片模式 `20:5` | FILL / FIT(信箱,150×130) / **CROP 裁剪窗** transform `[[0.5,0,0.25],[0,0.5,0.25]]` / **TILE** scalingFactor **0.3** | 0712-3 二三轮 |
| R04 文本特性 `21:2` | textCase UPPER/LOWER/**TITLE**(0a 03)、字距 8px vs 20%、下划线/删除线(0x04)、混排三段(首段 fill 规则；拉丁蓝28B+中文粉32B+西里尔琥珀28I) | 0712-3 + letterSpacing 弧 |
| R05 星形多边形 `22:2` | zigzag pointCount+innerRadius：star (5,.38)(8,.6)(12,.75)+**(5,.5) 双默认省略**；poly **3=默认省略**/6/8；星形椭圆径向渐变(vector+radial ratio) | 0712-3 + 径向渐变弧 |
| R06 组件变体 `23:2` | 变体轴 Size×Type=4、TEXT/BOOLEAN 组件属性(`Label#23:0`/`Show icon#23:5`)、**每变体含隐藏样式文本**(0711-2 残差族)、实例变体选择+Label 覆盖+隐藏 icon(`用例/Save`,`用例/Ghost`)、**布尔在自动布局组件内**+实例(`回归BoolChip`) | 0712-3 + 0711-2 残差 |
| R07 缩放实例 `25:12` | hug×hug 组件`回归TagChip`+自动宽度文本"v8.1 (2017.30 37cacf)"，实例 rescale **1 / 0.83 / 1.37**（Figma rescale hug 怪癖 → textAutoResize=NONE 钉扎） | 0712-2 v8.1 |
| R08 组件拓扑 `26:15` | Dot→Badge→Card 三层嵌套组件链；**canvas 实例在图层顺序上排在组件定义之前**（导入端拓扑排序还原） | 0711-3 特斯拉 |
| R09 自动布局 `27:28` | counter **MAX**(枚举1)+非对称 padding、SPACE_BETWEEN×3、**单子节点 SPACE_BETWEEN**(导入端清理路径)、**padding=10+gap=10 省略即默认陷阱**、纵向 primary MAX | 0712-3 对齐枚举 + 历史默认值教训 |

## 往返核对清单

- [ ] R01：三类样式是否还原为本地样式并**绑定**（含中文样式名 UTF-8 解码）？
- [ ] R02：内阴影单独存在？drop+inner 不整组丢失？背景模糊类型正确？
- [ ] R03：CROP 裁剪窗逐位（mg 超越 zip 基线，比较器 deep +1 是**故意的**）；TILE ratio→scalingFactor？
- [ ] R04：TITLE case 幸存？（**先在 MasterGo 里确认 Case 设置还在**——Figma→MasterGo 导入会丢 TITLE，丢了需手动补设再导出，这是 MasterGo 边界不是解码器 bug）
- [ ] R05：双默认省略样本 (5,.5)/poly3 不被误判；径向渐变椭圆比例？
- [ ] R06：变体名会被 MasterGo 洗成 `Size[a2]=Small` 括号形态（基线如此，勿归一化）；组件属性定义会**降级为普通覆盖**（MasterGo 不产出）；隐藏样式文本、布尔在实例内还原？
- [ ] R07：三档缩放实例位置无漂移（亚像素残差可接受）？
- [ ] R08：实例先于定义时组件还原顺序正确、无空实例？
- [ ] R09：MAX 对齐、单子 SPACE_BETWEEN、padding=10 全保真？

## 与旧测试集的关系

- 本集跑绿后，`测试集/0712-3`（0712-2 特性样本的往返产物）覆盖已**全部并入**本集，可退役；
  历史答案卡 `TESTSET_0712-2_FIGMA_SPECIMEN.md` 保留作过程记录。
- **必须保留的 `.mg` 锚**（手搭集无法复现的 MasterGo 导出侧二进制形态与规模）：
  `0711-2`（share 斜杠覆盖形态 + 29k 真实节点规模/超时/OOM 回归）、
  `0711-3` 特斯拉（**物化实例形态** + 大规模拓扑）。
- 其余小集（set0/1/2、0712-1 等）在本集跑绿后按需清理。

## 首轮往返结果（2026-07-13，落盘为 测试集/插件测试 0712 汇总）

比较器：初始 **deep 54 / paint 3 / effect 1** → 终态 **deep 14 / paint 1 / effect 0**
（344/344 记录，无缺失/类型错）。九套旧集回归全持平，0712-3 净改善一行（默认变体名
wash 闭环了它的"12 选 1 被洗"残差）。十族修复详录见 `MG_DECODER_JOURNAL.md` 2026-07-13
条目，速记：对齐枚举分轴（`0d 03`=SPACE_BETWEEN）、padding 逐槽省略=10、trailer
`2e`=ABSOLUTE（并处决组子节点启发式+嵌入副本覆盖）、效果 radius 省略=10 全类型、径向
ratio 三层规则（裸 03 直读/链谱写逐节点 ×(w/h)²/角菱恒直读）、默认变体名 wash、缩放
实例布局字段随 trailer-26 缩放、三个 set1 时代名字 hack 退役；导入端：同根
use-before-def 延迟重链（R08 实例化修复）、多轴变体名规范化（R06 combineAsVariants
修复）。

**终态 14 行 deep 残差全部归档为可接受**：CROP imageTransform +1（mg 超越 zip，故意）、
切片 exportSettings 2（结构性缺口）、隐藏元素被 MasterGo 清零 5（hint 文本 96→1、隐藏
icon 变换）、缩放文本盒亚像素取整 4、布尔重算宽 0.023px、Card 文本行盒 3px。

**用户报告六处的定性**：⑧/⑥/⑨/00_ 四处 = 上述真修复；渐变区 = 径向修复 + 角向为
MasterGo 导入洗失边界（mg==zip 同错，origin 的径向/菱形本就是压扁横条历史产物）；
**CROP 为误报**（fills 与 origin 逐位相同，截图与 MCP 双确认）。

**边界补录**：单子节点 SPACE_BETWEEN 被 MasterGo 洗成 CENTER（两路一致，无从还原）；
set0（已退役）保留 3 行诚实残差（era 名字 wash 差异 1 + 次按钮图标居中位移 2，原为
名字 hack 伪装，解开 `06 01 15` override 表可归零）。

## Mirror

速记见自动记忆 `testset-unified-regression.md`；解码器现状见
[`MG_DECODER.md`](MG_DECODER.md) 与 [`MG_DECODER_UNKNOWN_FIELDS.md`](MG_DECODER_UNKNOWN_FIELDS.md)。
