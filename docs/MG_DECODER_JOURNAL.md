# MG_DECODER_JOURNAL — `.mg` 原生二进制逆向工作日志

本文记录逆向 MasterGo `.mg` 原生格式的**过程与方法论**——从最初怎么从一堆字节起步(第零节)、
到破解数字编码这块罗塞塔石碑、再到 2026-07 一次系统性复盘中为什么这么做、踩了什么坑、用什么手段破解。
字段级的二进制规格是 [`MG_DECODER.md`](MG_DECODER.md)(活文档,权威);本文是它的“怎么得到的”背面。
未来继续逆向剩余缺口(effects / instance override / TEXT 分段)时,先读本文的方法论再动手。

---

## 零、最初怎么起步:从一堆字节到第一个突破口

> 这一节回答“`.mg` 是个二进制,最开始到底怎么下手逆的”。**没有现成的第三方 `.mg` 解析器可用**——
> MasterGo 的这套序列化是专有、未公开的(它内部代号见下),所以是从零逆向。但有两个“外部杠杆”让
> 起步没那么盲:`.mg` 里自带的明文情报,和 SendToFigma 导出的 v2 zip(每个节点的标准答案)。

### 第 1 层:容器几乎是免费的

`.mg` 文件头是 `50 4b`(`PK`)——它本身就是个标准 zip。解开后只有三类东西:

```
document                         11.9 MB   ← 唯一的硬骨头,专有二进制
meta.json                        538 B     ← 明文 JSON,免费情报
images/<hash>.png                …         ← 标准 PNG,直接能用
```

`meta.json` 是明文,一打开就泄露了关键线索:

```json
{ "turtleVersion": "^1.1.10", "schemaVersion": {"major":"4","minor":"1"},
  "imageMap": { "<hash>.png": "<存储路径>", … }, "fileId": …, "createTime": … }
```

- **`turtleVersion`**——MasterGo 内部把这套二进制序列化叫 **“turtle”**。知道格式的代号,能帮你判断
  版本兼容边界,搜索时也有了关键词。
- **`imageMap`** 把图片 hash 映射到存储路径,`images/` 里就是标准 PNG,不用逆。

所以真正要啃的只剩 `document` 一个 blob。逆向一个未知格式,**第一步永远是先把“不用逆的部分”剥干净**。

### 第 2 层:宏观结构——一眼能看出是 tagged field stream

把 `document` 开头 dump 成十六进制 + ASCII,规律肉眼可见:

```
09 f6 1a 01 04 02 00 03 02            ← 文件头(magic / 版本,未完全拆解)
01 30 3a 31 00                        =  01 "0:1" 00          tag01 + id字符串 + null
02 50 6c 75 67 69 6e 20 4e 6f 64 65…  =  02 "Plugin Node…" 00 tag02 + 名字
03 61 34 00                           =  03 "a4" 00           tag03 + sortCode
05 7f 00 00 00 7e ec eb eb …          =  tag05 + 二进制数字(背景色)
…
01 37 32 3a 32 37 33 35 00 02 54 65 6d 70 00  =  01 "72:2735" 00 02 "Temp" 00  ← 第二页
```

两个免费的结论:

1. **这是 tag 分隔的自描述字段流**,不是紧凑定长结构——每个字段一个小 tag(01/02/03…递增),字符串
   以 `00` 结尾。这类格式(protobuf 风格)最好逆:字段边界清晰,能逐个 tag 试探。
2. **字符串是明文可见的**。而节点名字在基准 zip / MasterGo 里都看得到——于是可以直接拿一个已知图层名
   在字节流里搜 ASCII,一搜一个准,立刻把“哪一段字节属于哪个节点”锚定下来。id(`0:1`、`72:2735`)也是
   明文,和 zip 里的 id 一一对应。

到这一步,结构、名字、id、层级关系其实都已经能读了——**卡住的只有数字**:坐标、尺寸、颜色、变换矩阵
全是那些 `7f 00 00 00`、`84 00 00 60` 的二进制。不破解数字,几何和样式一步都动不了。

### 第 3 层:数字编码——真正的罗塞塔石碑

这是整个逆向最关键、最有代表性的一步,用的是**已知答案攻击(known-plaintext)**:

从基准 zip 里知道某个矩形确切是**宽 44、高 22**。在它的记录里找到 width tag(`0e`)后面的 4 字节
`84 00 00 60`、height tag(`0f`)后面的 `83 00 00 60`,然后穷举“这 4 字节怎么变成 44 / 22”:

| 假设 | `84 00 00 60` 解出 | 结论 |
|---|---|---|
| 直接 IEEE-754 float32 大端 | −1.5×10⁻³⁶ | 乱数,否决 |
| 直接 IEEE-754 float32 小端 | 3.7×10¹⁹ | 乱数,否决 |
| **字节重排 [s0,s3,s2,s1] + 右移 1 位(保符号)后按大端 float32** | **44.0** ✓ | 命中 |

同一个变换拿去验其它已知值:`83 00 00 60`→22、颜色字节 `7e ec eb eb`→0.96……全部命中;再写 `encode()`
反向,`44`/`96` 也能编回原始字节。**双向都对上 = codec 破解。** 确切公式(见 `mgDecFloat`/`mgEncFloat`):

```
decode([s0,s1,s2,s3]) = float32_be( rotr1( uint32_be([s0,s3,s2,s1]) ) )
encode(v)             = 取 float32_be(v) 的 4 字节,整体左移 1 位,再重排成 [b0,b3,b2,b1]
```

**为什么是这么个奇怪的编码?(以下是推测,变换本身是确定并双向验证过的)**

- **右移/左移 1 位**极可能是 turtle 借用了浮点数的**最低位当 tag flag**——用 1 个 bit 区分“这是一个
  数字”还是别的值类型(引用 id / 短整数 / 布尔),写入时把 32 位浮点左移 1 位腾出最低位,读出时移回去。
  这是紧凑自描述格式里常见的手法。
- **字节重排 [s0,s3,s2,s1]**——把含符号位和高位指数的 `s0` 留在最前,其余三字节倒序。对整数型的取值
  (44、120 这类),尾数低位字节多为 0,这样排布可能是为了**让零字节聚集、利于后续压缩**,也可能只是
  turtle varint 流的副产物。动机存疑,但不影响使用。

- 补充规则(也是已知答案对出来的):值恰为 **0 时零压缩成单字节 `00`**;整块默认值(变换矩阵单位元、
  stop 位置 0、顶点 x=0…)**整字段省略**。几何 blob 另用 LEB128 varint,`ff ff ff ff 0f` 表示 −1。

### 第 4 层:把方法固化成 Rosetta Stone 工作流

数字一破,几何/颜色/变换全线打通,逆向就从“猜”变成了“查字典”。方法固定下来:

> **同一个设计文件,一份 `.mg`(待解二进制)+ 一份 SendToFigma 导出的 v2 zip(每个节点的精确答案,
> id 一一对应)。** 逆任何字段 = 在 zip 里查它的期望值 → 在 `.mg` 记录里找候选字节 → 交叉验证。

后续所有字段——page header、container subtype(`1c 07`)、vectorNetwork blob 表、paint 表,以及这次
2026-07 补上的 strokeAlign / strokeCap / 一族——用的都是同一套打法。它也直接催生了
`tools/compare_mg_import.js`:把“人肉查字典”自动化成“解码结果 vs 基准 zip 的逐字段 diff”。

> **教训零:逆向专有二进制,先剥掉免费的层(容器 + 明文元数据),再用“已知答案”从一个能双向验证的
> 锚点(这里是数字编码)撬开,最后把对照关系固化成自动 diff。有一份权威的“标准答案”(v2 zip)是
> 整件事成立的前提。**

---

## 一、一个“全零”的陷阱(2026-07 复盘的起点)

上一轮逆向把比对工具 `tools/compare_mg_import.js` 的所有计数打到了零,当时判定“完成”。
但那个工具**只逐字段检查它显式列出的属性**:type / parent / index / childOrder / geometry(仅
fills+strokes)/ transform / effect / text / font / vectorNetwork 存在性。凡是它没列进检查的属性:

> `strokeAlign`、`strokeCap`、`strokeJoin`、`textAutoResize`、`isMask`、`clipsContent`、
> `constraints`、auto-layout 的 padding/spacing/sizing/align、`dashPattern`、`arcData`、
> per-side 描边宽、`blendMode`、`exportSettings` ……

——全部处于“未验证”状态。解码器给它们填的都是构造默认值(strokeAlign 恒 INSIDE、blendMode 恒
NORMAL、textAutoResize 恒 NONE…),恰好在“全零 diff”里静默通过,只有在 Figma 里肉眼才看得出来。

> **教训一:比对工具的“全绿”只在它检查的维度上成立。基准里有、工具没比的字段,等于没测。**

---

## 二、这次的四个显性问题,和它们底下的一整族

用户在 Figma 里肉眼发现四个还原错误:

1. 文本 Auto width → 被还原成 Fixed size
2. 线条端点 Round → 被还原成 None
3. 形状居中(CENTER)描边 → 变成 Inside 描边
4. Group `BqEXhIA8X8` 下的 Mask 图层 → 没有还原

处理策略不是“就修这四个”,而是先**把检测网织密**:给比对工具加了一个递归全字段 deep-diff
(`deepDiffProps`),把解码结果和基准的 `props` 对象逐字段深比(数值 0.015 容差),并计入退出码。

一跑,暴露出 **43 类差异路径、几百个节点**。四个显性问题只是露出水面的部分,水下压着一整族同源缺陷:
`blendMode` 全线 NORMAL→PASS_THROUGH、`constraints` 的 SCALE 全丢、auto-layout 的
padding/spacing/sizing 全缺、组件圆角丢失、per-side 描边宽缺失、arcData 缺失……

> **教训二:显性 bug 常是一类系统性缺陷的表面。先织密检测网再动手,比逐个打地鼠高效得多。**

---

## 三、破解方法论(可复用于剩余缺口)

### 1. 已知答案攻击(known-plaintext)

基准 zip 给出每个节点的**精确期望值**。逆向一个字段时不盲猜字节含义,而是:

- 把节点按期望值分组(如 `strokeAlign` 分成 CENTER / INSIDE / OUTSIDE 三组);
- 从每个节点的原生记录里提取所有候选字节(tag→value);
- **交叉制表**(cross-tab),看哪个字节位置的取值与期望值分组完全对齐。

`strokeAlign` 就是这样定位到标量 tag `13`(1=CENTER 2=INSIDE 3=OUTSIDE),175 个节点零例外——
而此前的代码把这个 `13` 误当成“paint 引用计数”。`constraints`(`0b`/`0c`,枚举 0..4 恰为 Figma
ConstraintType 顺序)、`blendMode`(`0d`)、`isMask`(`09 01`)、`textAutoResize`(TEXT 对象首字段
`03`)全部用同一手法定位。分析脚本用一次性的 `node -e` / scratchpad 脚本即可,抄
`compare_mg_import.js` 的 zip 读取 + vm sandbox 加载解码器的骨架。

### 2. 顺序字段 walker,而不是正则乱扫

`.mg` 的 float 编码是 4 字节 twisted-float,**tag 字节会自然出现在别的字段的 float 载荷里**。
早期解码器靠正则在记录块里找 `\x1c`(类型标签),踩了这个坑:高度 1080 的 float 编码含 0x1c,被误判
成类型标签,直接导致 `case 4` 整个子树(3 条记录)丢失。

破法:从名字结束处**顺序步进**解析(`mgWalkScalarFields` / `mgParseTrailer` /
`mgParseContainerMeta`)。每个 tag 消费固定或可变长度后步进到下一个 tag,顺序解析天然免疫载荷冲突,
还顺带解出了一连串连号字段(`08/09/0b/0c/0d/12/13/14`)。尾部 `1d 01` 用**候选 + 校验式前向解析**:
字符串字段(`23` 样式 id、`2a` tokens JSON)会骗跑朴素解析,所以要求解析到干净的 `00` 终止符才认。

### 3. “缺失”即“默认”

MasterGo 大量使用“省略即默认”,读格式必须区分“字段不存在”和“字段值为 0”,两者语义完全不同:

- 间距/内边距字段整个缺失 = 运行时默认 **10**(显式 0 才写 `09 00` / 四个零 padding 子字段);
- `strokeWeight` tag 缺失 = 默认 **1**;
- 尾部 sizing 字段 `21`/`22` 缺失 = **AUTO**(存在=FIXED);
- `blendMode`(`0d`)缺失 = **PASS_THROUGH**(SECTION/SLICE 例外为 NORMAL);
- `constraints` 缺失 = **START**;`clipsContent`(`03`)缺失 = FRAME 族 **true**。

这条规则解释了一个反直觉现象:组和布尔节点导出的 padding 是 10——因为它们的 `0a` padding 对象是**空的**。

### 4. 有些属性是“推导”出来的,不在字节里

不是每个 v2 属性都对应一个二进制字段:

- `layoutPositioning=ABSOLUTE`:GROUP 的子节点,且其最近的非组祖先是 auto-layout 帧(SLICE 除外)——
  在总装阶段按父子关系推导。
- `fontWeight`:从字体 style 字符串映射(`Semi Bold`→600),而非独立字段。
- `imageRef`:导出端按首次出现顺序命名 `image-001/002`;解码器保留内容哈希文件名,总装时按同序起别名对齐。
- `exportSettings`:**节点记录里根本没有**(切片的 `1c 0a` 对象是空的),只能从嵌入 JSON 孪生记录 overlay。

---

## 四、这次的破解结论一览(细节见 MG_DECODER.md)

| 属性 | 编码位置 |
|---|---|
| constrainProportions | 标量 `08 01` |
| isMask | 标量 `09 01` |
| constraints h/v | 标量 `0b`/`0c`(0=START 1=CENTER 2=END 3=STRETCH 4=SCALE) |
| blendMode | 标量 `0d`(16 项标准表,无 LINEAR;15=LUMINOSITY) |
| strokeJoin | 标量 `12`(2=ROUND) |
| **strokeAlign** | 标量 `13`(1=CENTER 2=INSIDE 3=OUTSIDE) |
| dashPattern | 标量 `14 <n> <n×f>` |
| strokeWeight | 标量 `10`(缺失=默认 1) |
| **strokeCap** | 尾部 `2c`(1=ROUND) |
| per-side 描边宽 | 尾部 `2d <4×f>`(仅矩形/画框类) |
| sizing primary/counter | 尾部 `21`/`22`(存在=FIXED,缺失=AUTO) |
| clipsContent | 容器 `1c 07` 字段 `03`(缺失=FRAME 族 true) |
| layoutMode | 容器 `08`(1=H 2=V);itemSpacing `09`;paddings `0a`(缺失=默认 10) |
| align primary/counter | 容器 `0d`/`0e`(2=CENTER) |
| 四角圆角 | 容器 `04 04 <4×f>` |
| **textAutoResize** | TEXT `1c 08` 字段 `03`(0=W_AND_H 1=HEIGHT 缺失=NONE) |
| arcData | ELLIPSE `1c 04 01`(字段1=圈数分数,-1→−2π) |

粗体是用户直接报的四个问题;其余是同一轮 deep-diff 顺带扫出并破解的。

---

## 五、仍未破解 / 交给下一轮

| 缺口 | 现状 | 建议手法 |
|---|---|---|
| 原生 effects(阴影) | 嵌入 JSON overlay + 名字规则 fallback | `enc(阴影参数)` 在记录附近 grep 定位字段,再 deep-diff 验证 |
| instance override 表 | 已定位在 `1c 07` 字段 `15`,未解码 | 解出可替换 `mgApplyButton/CardInstance...` 名字规则 hack |
| TEXT 精确字号 + 富文本分段 | 字号靠盒高推断,分段靠 fixture fallback | 解 `1c 08` 的 `05` run blob |
| exportSettings | 仅嵌入 JSON 孪生 | 节点记录里确实没有,可能需另找导出设置表 |
| star/polygon 点数 | 类型默认值 | 找对应的 `1c 05`/`1c 06` 对象字段 |

---

## 六、留下的防回归资产

- **基准对**:`插件测试.mg` ↔ `mastergo2figma-partial-pages-2026-07-06T12-25-25-320Z.zip`,当前**全零** diff。
- **递归 deep-diff**:`compare_mg_import.js` 的 `deepDiffProps` 已计入退出码。以后任何 props 字段
  (哪怕是这次这种没人显式检查的)偏离基准,都会直接报红,不会再出现“全绿的假象”。
- 改解码器后的标准验证:
  `node tools/compare_mg_import.js 插件测试.mg mastergo2figma-partial-pages-2026-07-06T12-25-25-320Z.zip`
  → 期望所有计数为 0(含 Deep prop mismatches)、exit 0。

## Mirror

与仓库 `MG_DECODER.md`(字段规格)、auto-memory `mg-binary-format.md`(跨会话钩子)互补。
逆向有新进展时,规格进 MG_DECODER.md,过程/教训进本文。
# 2026-07-10 — fresh ZIP parity baseline

The fresh `新文件.mg` / `mastergo2figma-partial-pages-2026-07-10T02-21-12-362Z.zip`
pair established an exact structural invariant: 43 raw VECTOR overrides of
Boolean template slots replace 94 template operands. The criterion is native
type plus template-slot subtype, not visibility, name, depth, or a broad
"all booleans in instances" rule. Applying it reduced the converted package
from 1482 to 1388 records with zero extra records, child-order differences,
root-index differences, or vector-network-presence differences.

The same fixture also disproved two tempting shortcuts. `0x4000` alone does not
mean "multiply every VECTOR field by instance scale", and gradient subfield
`0x0a/0x06/0x03` is not directly the minor/major axis ratio. Both guesses made
the full deep comparator worse. Boolean dimensions must first be classified as
natural, already scaled, or slot-sourced; group rebasing must wait until leaf
geometry is trustworthy.

After visibility, explicit stroke clearing, text case/runs, effects, arcs,
paint-list multiplicity, Boolean pruning, and Boolean leaf size provenance,
the fresh comparator reached 1388/1388 records, zero structural/effect/text/
font/vector-network mismatches, 144 geometry mismatches, 124 transform
mismatches, 16 paint mismatches, and 480 deep-property mismatches.

## 2026-07-10 — geometry/source-precedence pass

The radial scalar was solved by cross-tabling three non-square samples instead
of fitting a reciprocal guess: `minor/major = 2 × |p1 − p0| / axisScale`. This
removed all 16 paint mismatches without changing any geometry category.

Instance geometry required several deliberately narrow precedence rules:

- Sparse `0x80` FRAME records that stand in for Boolean slots inherit omitted
  translation axes; VECTOR/TEXT omissions remain explicit zero.
- Synthesized GROUPs rebase from visible direct children, including mask-defined
  bounds, while every direct child (hidden children included) receives the
  inverse translation.
- Quarter-stroke direction icons rebase their inner SUBTRACT first and their
  outer UNION second. Stroke/side-weight and child-type structure are the gate;
  a broad "rebase every Boolean" experiment caused hundreds of regressions.
- Childless Boolean vectors remain empty vector networks. Two native structures
  have independently verified natural bounds: a sole SUBTRACT under a UNION,
  and `UNION(EXCLUDE, VECTOR)`. Applying operand bounds to all 43 leaves made
  32 already-correct leaves worse, so the general rule was rejected.
- Missing positional constraints are not globally CENTER. CENTER is used only
  for cross-fixture structural families whose parent resize delta predicts the
  baseline exactly (mirrored vector GROUPs, summary columns, full-width artwork,
  Boolean-shell frames, and two-vector UNIONs).

The accepted pass ends at 1388/1388 records with zero structural, paint,
effect, text, font, or vector-network mismatches. Residuals are 40 geometry,
27 transform, and 129 deep-property lines, all under `layout`: 32 records are
live Montserrat text metrics or their derived containers, seven are one empty-
Boolean 1×1 fallback family, and one is a text-derived GROUP. Those are left
unhardcoded for the next Figma-runtime validation.

## 2026-07-10 — 文本/渐变全对齐 pass（插件测试.mg，全类别归零）

基准对：`插件测试.mg` × `mastergo2figma-partial-pages-2026-07-10T10-06-04-636Z.zip`
（191/191 records）。起点差异：deep-prop 83、font 7、paint 9、geometry 3、
transform 1、text 1。终点：**全部 0**（含递归 deep-diff），`npm run build` 通过。

### 方法论（可复用流程）

1. **先跑 `tools/compare_mg_import.js --json`，按属性路径聚类** deep-prop 差异
   （去掉数组下标后 groupBy），一眼看出 83 条里 61 条是文本、18 条是渐变 —
   决定主攻方向，不逐条追。
2. **写一次性 probe harness**（vm 加载 `mgPackage.js` + `__test.decodeNativeNodes`
   拿中间结构），把「zip 期望值 ↔ mg 原始解码值 ↔ 文件原始字节」三层并排打印。
   本轮所有根因都是三层对照后一眼定位的，没有一处是猜出来的。
3. **已知答案交叉表**（AGENTS.md 血泪教训的再次胜利）：
   - 渐变：把基准 transform 逆推出 neededRatio，与文件标量逐行对照 —
     新 fixture 每行 ratio == scalar 直存；但旧测试里冻结的三个非方形样本
     （|p1−p0|≠0.5、scalar>1）确凿满足旧公式 `2×|major|/scalar`。两种编码
     并存，`min(scalar, 2×|major|/scalar)` 对全部 7 个已知答案成立
     （圆形 scalar=1 时两式同值）。教训：交叉表必须把新旧样本都摆上桌。
   - 字体：失败节点的样式表条目 hexdump 出 `0c Inter-Bold` / `12 Bold` —
     旧 scanner 只读 `03` 家族字段（"Inter"）→ 一律 Regular。
4. **顺序步进解析，拒绝 tag 正则**：新的 `mgScanFontStyles` / `mgParseFontRuns`
   全部从锚点顺序消费字段，未知 tag 即停（保留已解字段）或整体放弃回退旧
   heuristic。旧 scanner 的 `05 <b> 03` 正则漏掉带 decoration 字节
   （`05 03 01 01 03`）的下划线条目，正是富文本节点需要 fixture 硬编码的原因。

### 本轮破解

- **样式表条目全字段**：`01 <deco>`（下划线）、`03 family`、`04 fontSize`、
  `05 lineHeight（-1=AUTO 哨兵）`、`0a textCase`、`0c psName`、`12 styleName`。
- **font-run 列表语法**（`1c 08` 对象）：`06 <count>` 后每 run 携带
  sortId/文本/styleRef/字形表/字体串/字形 id 表；run 存储顺序任意，按 sortId
  排序拼接得 characters（旧「取第一个 02 字符串」会抓到中段 run，"underlined"
  事故）。颜色 run 表（`09`）独立分段；styledTextSegments = 两种边界取并集切分，
  与基准 9 段富文本完全一致，`mgFidelityStyledTextSegments` 名字硬编码删除。
- **渐变 `06/03` ratio 统一为 `min(scalar, 2×|p1−p0|/scalar)`**（缺省=1），
  同时覆盖直存与倒数两种已观测编码；真 ratio>1 的样本出现时需重新交叉表。
- **显式零尺寸**：细线 VECTOR 的宽度是显式 `0e 00`（真 0），vn-bounds 尺寸
  推导只在字段**缺失**时触发（新增 `hasExplicitW/H`），不再把 0 抬成 1。
- **按钮居中 hack 收窄**：只平移仍停在模板 x 上的子节点。浅记录已存回流后
  坐标，再平移就是双重应用（label +3.5 事故）；无 override 记录的 icon 仍需要。

### 踩坑记录

- 同名 fixture 会被静默替换：本轮开局对比的还是旧 `插件测试.mg`（21MB），
  换文件后 records 从 1579→191。跑对比前先核对文件 mtime/大小。
- 文档里的「Verified ✓」不等于判别性验证：本轮新 fixture 里旧公式的“通过样本”
  全是两种假设同值的退化圆形；而旧公式真正的判别样本冻结在测试里，差点被当作
  “已删 fixture 的过拟合”推翻。交叉表必须新旧判别样本同桌，测试是最好的存档。

## 2026-07-11 — letterSpacing 破解 + 渐变 ratio 的"视觉真值"翻案（测试集 0711-1）

基准对：`测试集/0711-1/测试集 0711-1.mg` × 同目录 zip（23/23）。用户报告两问题：
部分文本 4px 字距导入后变 0%；Tesla 车身 Vector 3 径向渐变 zip/mg 双双还原过暗。

### letterSpacing（快速收口）

样式条目 flag 直方图交叉表（新旧两个 fixture 全量条目）拆出三个字段：
`08 <f>` = 字距值（twisted float，负值=压缩字距）、`0b 01` = 字距单位 PIXELS
（缺省=PERCENT）、`06 01` = 行高单位 PIXELS（缺省+正值待定、-1=AUTO）。
`{0,PIXELS}` 与 `{4,PIXELS}` 条目都带 `0b`，全 PERCENT 的旧 fixture 条目都不带 —
06/0b 的归属由 tag 邻接 + 直方图里的单独出现行（f06 无 f0b / f0b 无 f06）判定。

### 渐变 ratio：zip 基准本身是错的

视觉截图（MasterGo 宽扁光晕 vs Figma 两侧全黑）证明车身真 ratio = 3.5696 =
.mg 里的 scalar 直存值；而本轮 zip 携带 0.4117 = `min(ratio, 2|major|/ratio)`。
结论链：

1. MasterGo 插件 API 只暴露两个 handle + 一个 transform（typings 实锤），该
   transform 用**折叠后**的 ratio 构建 — API 与自家渲染器在 `ratio² > 2|major|`
   时不一致，且折叠不可逆 → SendToFigma 从 API 无法恢复真值。
2. 昨天的 min() 规则、前天的倒数规则、扩展形式的 field06/field03 除法 —
   全部是"对着折叠 zip 验证"的产物。**已知答案交叉表的已知答案本身可以是错的**：
   zip 只有在其生成链无损时才是 ground truth，渲染类字段要用截图/肉眼终审。
3. 扩展 06 子对象的两个数构成分支对 `{scalar, field06/scalar}`，真值取较大者：
   同一设计两次导出存了相反分支（0710-2 存 0.4117 除法得 3.5696；0711-1 直存
   3.5696），max() 同时满足两个文件全部样本；全部已见扩展样本 ratio>1。
4. 比较器新增 fold 归一化（`foldGradientTransform`）：mg 携带渲染真值、zip 携带
   API 折叠值属已知导出端缺陷，归一化后不再误报 decoder 回归。
5. SendToFigma 端：改为优先信运行时可能提供的真实第 3 个 handle（typings 声明
   两个但保守），否则维持 transform 恢复 — 若用户重导出仍折叠，则 API 端确无
   真值来源，zip 路径保持近似并以 .mg 路径为准。

### 其余

- SECTION 恒 FIXED/FIXED（trailer 21/22 对 SECTION 无意义）。
- 0:50 Subtract 尺寸（67.25 vs 65.57）：.mg 存 MasterGo 自身包围盒，zip 存 API
  重算的布尔结果盒；无路径求值器无法在包级复现，导入端 figma.subtract 会重算，
  记为已知残差（同"空布尔 1×1 fallback"家族）。

### 2026-07-11 追加 — zip 导出端径向渐变自证（SVG 逃生舱）

API 折叠不可逆已证死，但发现 `node.exportAsync({format:"SVG"})` 的输出来自
渲染器本身：`<radialGradient gradientTransform>` 携带真椭圆。导出端新增
`enrichRadialGradientTruth`（nodeSerializer）+ 纯函数模块 `svgGradientTruth.ts`：

- 只需 G 矩阵、单位模式（userSpaceOnUse/objectBoundingBox）与节点宽高 ——
  ratio 对 viewBox 描边留白平移与统一导出缩放**不变**，对 SVG 序列化细节鲁棒。
- 按渐变 stops 匹配 paint（±0.015 offset / ±0.02 颜色通道），方向与圆心仍锚定
  API handles，只替换 ratio → 与 mg 端 `mgRadialGradientTransform` 输出严格同式
  （跨插件断言测试）。
- 门槛：子树 ≤40 节点、SVG ≤2MB；解析失败静默回退折叠值。角向/菱形无 SVG
  等价物，维持折叠近似。
- 测试 `tools/tests/svgGradientTruth.test.js`（esbuild 即时编译 TS 模块）：
  合成 Tesla 用例双单位模式命中 3.5696、stops 匹配、跨插件 transform 一致，4/4。

### 2026-07-11 追加 2 — MasterGo SVG 半径槽位互换（第一次自证尝试翻车与修复）

用户用 SVG 自证版重导出 zip 后，Vector 3 出现**第三个错误值** 0.2006（既非真值
3.5696 也非折叠 0.4117）。用 Figma MCP 直接抓取导入结果的资产 SVG + 解剖重导出
zip 反推：MasterGo 的 SVG 导出器把两个半径**写反槽位**（沿手柄轴半径写进垂直槽、
垂直半径写进沿轴槽）——其 SVG 按规范解读是把椭圆转了 90°，与它自家画布渲染不符，
但两个真半径都在。两节点四位有效数字全中：0.2006=swap(3.5696)、0.042=swap(1.1976)。

修复：`svgRadialAxisRatio` 同时计算按写读取与换槽读取两个候选，用模型不变量
「沿轴半径 == |p1−p0|」（5% 容差）仲裁——规范排放同样通过，两者皆不符（如缩放
viewport）则返回 null 回退折叠值。不硬编码 swap，MasterGo 未来修正后无需改动。

教训：**渲染器的导出物也不等于渲染真值**——MasterGo 的 fold 混乱延伸到了它的
SVG 导出器；任何"真值通道"都要先用已知答案标定再信。

## 2026-07-11 — 大文件导入计数崩溃（特斯拉 Model 3 车载系统，5779/5643）

真实项目文件（29.7MB，5779+1388 记录）导入报"页面还原数量不一致
expected=5779, actual=5643"。定位方法论：

1. **可达性审计**（转换端）：convertMgPackageToV2Entries 输出 → 从 rootNodeIds
   沿 childIds 走图 → 5779 全可达、0 孤儿 → 包结构自洽，问题在还原语义。
2. **还原计数模拟**（插件端语义离线复刻）：BOOLEAN/GROUP 走 shell 递归，其余
   类型仅当 Figma 节点可挂子（canContainRestoredChildren）才递归 → 模拟结果
   **5643，与报错分毫不差**；差值全部来自 61 个带 2 子的 `VECTOR/PEN "Subtract"`
   记录（136 个后代被静默跳过）。
3. 根因：**无斜杠 id 的顶层 raw VECTOR 覆盖 Boolean 槽位** ——
   `mgIsInstanceBooleanLeafCandidate` 只认 `id 含 "/"` 的浅层实例记录，这批
   漏过剪枝，模板操作数克隆挂到了它们名下；且这批自身 vn/fills 全空（几何在
   操作数里），剪枝会变透明图标，不能照搬旧规则。
4. 修复：发射循环终局检查——`type === "VECTOR" 且仍带子` → 改判
   BOOLEAN_OPERATION（booleanOperation 按名字 Subtract/交集/排除 → 对应枚举，
   缺省 UNION），删除空 vn/constraints，走插件布尔树真实合成。计数一致 + 图标
   真实还原。四个回归集 vector-with-children 均为 0 → 改动零触发、比较器全数
   持平（0 全零 / 45·32·157 / 7·9 / Subtract 族）。
5. 顺手修掉转换端二次方热点：`mgFindTemplateRoot` 此前对**每个无子节点**先建
   全节点数组再做名字判断，5.8k 记录文件 Node 端 10 分钟未出；名字门槛前置后
   全流程秒级（浏览器端同样受益）。

遗留观察：这 61 个方向图标（0.25 描边 ROUND）的 fills/strokes 为空，疑走
trailer `0x23` 样式库引用（未利用字段）——视觉核验若发现无描边，下一轮以此
为切入点。
