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

## 2026-07-11 — INDEX_MISMATCH 校验失败：幽灵子记录导致兄弟 index 整体偏移（测试集 0711-2）

新测试集（29008 记录）导入即被包校验拦截：`INDEX_MISMATCH（2:09860/2:08565)`,
共 295 处。先怀疑校验算法,实际**校验没错,是转换端自相矛盾**：

1. 定位：dump 出错节点后发现全部是实例子树,声明 index 为 1,2,3,4 而在父
   childIds 里位置是 0,1,2,3——不是乱序,是整体 +1。
2. 根因：部分父节点的原始子列表开头有 `type=null, name=null` 的**幽灵原生记录**
   （如 `2:09860/2:30074`、`2:30065`,基准 zip 里完全不存在）。发射 record 时
   `childIds` 会 `filter(nodes[c] && nodes[c].type)` 把它们滤掉,但
   `indexInParent` 是在**过滤前**按原始列表编号的——被滤掉的幽灵把其后所有
   兄弟的 index 顶高一位。全文件 305 个父节点共 384 个幽灵子记录。
3. 修复：`indexInParent` 改为按与发射一致的过滤后列表编号（mgPackage.js 发射
   段前的编号循环）。0711-2 校验 295→0 全通过;其余四个回归集比较器计数逐项
   持平（0 全零 / 1·2 / 45·32·157 / 7·9）,零触发零回归。
4. 遗留：同族幽灵里有一条 `2:30073` 带 rawType=LINE 被照常发射（宽 3.79 高 0、
   无填充无描边）,构成基准外的 1 条 extra record 及其两个兄弟的 index/child
   order 差异。这批 `2:30xxx` 记录疑似"已删除/注册表"类残留,尚未找到区分
   标记,见 MG_DECODER_UNKNOWN_FIELDS.md。

教训：**同一份子列表,编号和发射必须用同一个过滤器**。凡是"先建索引、后过滤
发射"的两段式代码,过滤条件一变就会静默产生自相矛盾的包——这次是校验器
（deep 不变量检查）先于肉眼把它拦下来的,证明 INDEX_MISMATCH 这类结构性
校验值得保留为硬错误。

## 2026-07-11 — 幽灵记录定性收口:非画布"注册表残留"记录族（测试集 0711-2）

前一条目的遗留：`2:30xxx` 幽灵记录里带 rawType=LINE 的 `2:30073` 构成 1 条
extra record + 兄弟 index/child-order 差异,当时"尚未找到区分标记"。本轮把整族
定性并在组装前统一剔除。字段规格见 MG_DECODER.md「Registry-residue records」。

### 方法论：先人口普查、再 hex 定形、五集交叉验证

1. **人口普查先于字节分析**。把"基准 zip 没有"的原生记录全量分桶
   （type × parent 指向 × id 段位）,而不是逐条追。2725 条非基准记录立刻拆成
   四族：432 条布尔叶操作数（已有剪枝处理,无害）、~155 条 paint 表记录
   （node-marker 正则的已知副产物,父 id 不是节点,无害）、**131 条高位 id
   （2:29891–2:30094）记录**、其余为 share 模板树节点（正常）。"384 个幽灵"
   瞬间聚焦成"131 条原生记录 + 模板树内若干条经实例展开的克隆"。
2. **hex dump 定形**。131 条 body 逐字节一致：
   `07 01 08 <模板节点id> 00 0b 01 ac 02 02 02 04 02 00 0d 01 13 00 00`。
   关键异常即判别式：标量 `08`（constrainProportions,合法值仅 0/1 单字节）后面
   跟的是 **id 字符串** —— 节点语法不可能出现;且全族无 04 名字、无 1b owner、
   无 1c 类型对象、无 1d 01 尾部 —— 根本不是节点记录,是引用模板节点的某种辅助
   对象（`0b` 首字段 varint=300,像 duration 类默认值;每父恰一条、恒 a0 首位;
   确切角色未知,疑标注/交互类）。
3. **五集交叉表确认零误伤**。判别式跑全五集全量记录：0711-2 命中 131（与高位
   id 族 100% 重合,一条不多不少）,其余四集命中 0;全五集基准内记录命中 0。
   顺带证得"真节点必有 1b owner"在五集基准内零例外 —— 残留族与真节点完全互补。
4. **2:30073 假 LINE 的根因**。它是族里唯一"块恰好延伸进大段非记录区"的：其
   marker 之后 143KB 才有下一个 marker（中间是字体名表、几何 blob 的 varint 序列
   `…19 1a 1b 1c 02…`）,`mgFindTypeTagPos` 的弱回退在垃圾里撞到 `1c 02` 判成
   LINE,宽 3.792/高 20.2 全是从垃圾读出的 twisted float。与"tag 正则害死
   case 4 子树"同源的教训：**弱扫描搜索窗越大越危险,非节点记录必须在类型判定
   之前出局**,而不是靠 type=null 事后过滤兜底。

### 修复与验证

`mgIsRegistryResidueRecord`（mgPackage.js）：body 起始 `07 00|01 08` + ID 形
cstring + `00 0b` → 在 `mgDecodeNativeNodes` 组装前直接 skip（与 [PROPS] 载体
同位置）。剔除发生在子列表构建/实例展开/类型判定之前,发射端的 384 个幽灵条目
（131 原生 + 模板克隆）一次性消失,前一条目"编号按过滤后列表"的修复继续兜住
其它 type=null 族（paint 伪记录等）。

验证：0711-2 extra 1→0、index 2→0、child-order 1→0,records 29008→29007 与基准
精确一致;geometry/transform/paint/deep 计数逐项持平（2965/2551/18/18516,
零附带影响）。四个回归集（0 全零 / 0711-1 1·0·2 / 1 45·32·157 / 2 7·0·9）
计数逐项持平。`npm run build` 通过。

## 2026-07-11 — "图层完全异常"大文件破解:第三种导出形态(测试集 0711-3,特斯拉 29.7MB)

用户报告大文件 .mg 导入后图层完全异常;zip 端 OOM 只导出了 cover 页(1388 条)做基准。
起点比对:paint 1120 错、type 279 错(GROUP/BOOLEAN 全退化成 FRAME)、font 43、
geometry 333、deep 9086 —— cover 页几乎每个带填充的节点都是坏的。字段规格见
MG_DECODER.md「Full-editor "explicit zero" export form」。

### 根因:显式零拼写 × 顺序解析器的"未知即停"

这个文件是**完整编辑器导出但实例仍存 share 式浅记录**的第三形态,且全文件用
"显式空值"拼写(`05 00 06 00 07 00 14 00 1a 00`、空图片路径、无 `1d 01` 引导的
尾部)。五个解析器在新拼写上提前中断:

1. 标量走读器:新 tag `06` + `14 00` 空 dash + `1a 00` 空引用 → **58014/70362 条
   记录**在标量区断裂,paintRef/owner/constraints 全丢 —— 模板节点自身残废,
   实例继承自然全空。这就是"图层完全异常"的主体。
2. paint 子记录带前导 `04 00` → `mgParsePaintRecord` 未知 tag 返回 null →
   13: 前缀样式库 paint 区整块丢失(4294 个引用悬空)。
3. 字体样式扫描 anchor 要求 `05` 紧跟 id → 样式库新拼写(`02 00 03 00 04 00`
   空前缀 + `02 <varint>` 时间戳)整段漏扫,10: 前缀的 per-node 计算条目全部不可见。
4. 容器对象 if 链被前置的显式零字段错位 → 显式零 itemSpacing/paddings 读不到,
   误入 默认10 通道;`06`/`07` 值位歧义把 2 万普通容器误判 INSTANCE/COMPONENT_SET
   的风险也在此修掉(值×后继交叉表:`06 01`+`0f/15/17/END`=INSTANCE,
   `07 00`=显式零、非零=COMPONENT_SET)。
5. 模板记录尾部无 `1d 01`(`…00 00 1e 00 27 00 28 00 00` 直排)→ trailer 全 null
   → sizing 丢失。修法:容器解析返回对象结束偏移,尾部**锚定解析**两种拼写,
   regex 扫描只作后备 —— 与"弱扫描窗口越大越危险"的教训一脉相承。

### 实例存根语义(已知答案交叉表逐条定案)

- **尺寸空间混合**:容器存根显式 w/h 是模板单位(基准=own×trailer-26,227/266
  精确),但**未修改的尺寸写的是终值副本**(own==模板×scale → 不再乘;
  pagination 反例 14 条定案)。叶子存根(VECTOR/TEXT)与实例根恒为终值。
- **容器种类是槽位属性**:bare 存根(`1c 07 0f 00 00`)从模板子节点承接
  GROUP/BOOLEAN 子类型(修 type 279→7)。
- **own 记录的圆角是终值**(存根存 5.04=6×scale,模板存 6;旧代码再乘一次
  变 4.24,180 节点×5 字段)。
- **可见性**:无 `07` 无 `19` 掩码的存根继承槽位可见性(27 个隐藏模板子被
  旧"默认可见"规则复活);share 行为不变(掩码缺省仍默认可见)。
- **文本自动命名**:有自身字符的 TEXT 存根按字符命名、换行折叠成空格。
- **INSTANCE clipsContent 完整导出默认 false**(53/53);share 保持 true。
- **四边描边宽**:存根显式 strokeWeight 0 + 模板字段缺失(默认1)→ 四边宽
  = 1×scale(48 个专辑封面矩形)。
- 计算型字体条目(带 `0f` 字体文件 hash 的 10: 条目)存的是**已缩放终值与
  已解析行盒**:无 `06 01` 旗标即 AUTO 行高。

### 收口数字与教训

cover 基准:paint 1120→7、type 279→7、geometry 333→115、font 43(持平)、
deep 9086→758;index/childOrder/missing 全 0。records 7167→66345 —— Page 1 此前
因走读器断裂静默丢掉 ~59k 节点(顶层 owner 读不到→不可达),修复后才是全量。
五个回归集全部逐项持平(0711-2 的全零结构基线保持)。

**新拼写踩坑三连**(实现时被回归网逮住):`06 01` 后继白名单最初漏 `17`(share
实例形态)→ 0711-2 missing 11511/set1 missing 484;`07` 判定用 >0x20 误杀
完整导出的 COMPONENT_SET(`07 04 <varint>` 拼写)→ set0 组件集变 FRAME。
教训:**同一 tag 在不同导出形态下有不同 payload 拼写,判别式必须同时对
新旧全集跑值×后继交叉表,任何单文件推出的白名单都要以全测试集回归为准绳。**

### 遗留残差(等 override 表破解)

- 字体 43 + 单位 13×3:嵌套实例的字体覆盖(同构存根指向相反真值,判别信息
  只能在容器 `06 01 15` override 表里);图片 58(实例换图同理)。
- ~~7 个 GROUP→FRAME"框架化"反转及其 clips/四边宽连带~~(第二轮已破,见下)。
- 位置族 x/y/relativeTransform ~200 行 + 文本 hug 尺寸族(live 度量)。

### 第二轮:Page 1 视觉验收暴露的三个系统性问题(2026-07-11)

用户导入后对照 MasterGo 截图报告:图层位置错、Component 没还原、大部分 Frame
变 Group、页背景色丢失。Page 1 没有基准 zip,全部用 .mg 字节 + cover 交叉表定案:

1. **`01` 旗标 + `03` 字段 = FRAME**(修 "Frame 变 Group")。顶层 1920×1200 屏幕
   帧的容器是 `01 00 03 01 …` —— 旧规则见 `01` 即 GROUP。交叉表:cover 516 个
   已验证容器**零例外**(GROUP 144 + BOOLEAN 135 全部无 03;仅有的 7 个 01+03
   容器恰是基准 FRAME —— 上一轮无解的 7 个"框架化"反转同时告破)。组不能裁剪、
   从不写 03,语义自洽。Page 1 类型分布 17k GROUP/2.5k FRAME 翻转为
   7k/12.4k;cover type 7→0、deep 758→622。"位置不正确"主要是此问题的连带
   (Group 还原时用 figma.group() 重算包围盒且不裁剪,内容溢出观感全乱)。
2. **完整导出的组件主档在画布上**(修 "Component 没还原")。share 模式"根级
   COMPONENT/COMPONENT_SET 是离画布注册表、从页根丢弃"的规则加 share 门控 ——
   此前把特斯拉 20 个组件(连同子树 2353 条记录)从 Page 1 静默删掉。
3. **页背景色**:页表记录 `03 <sortCode>` 后可选 `05 <a><r><g><b>`(零压缩
   浮点;不透明黑=`7f 00 00 00,00,00,00`)。`parseMgPages` 解出 → 转换端写进
   v2 页索引可选 `background` 字段(原生解码专属格式扩展,SendToFigma zip 无
   此字段)→ 导入端 `restoredPage.backgrounds` 应用。shared/types.ts 的
   `ImportPageIndex` 增加可选字段。

验证:cover 基准 type 0 / geometry 115 / transform 66 / font 43 / paint 7 /
deep 622,结构类全零;五个回归集逐项持平(0711-2 全零保持)。两端
`npm run build` 通过。教训:**没有基准的页面要靠"有基准页面的同族节点交叉表 +
宿主截图"双源定案;share 模式推出的每一条丢弃/默认规则,换导出形态前都要重问
一遍适用性。**

### 第三轮:Keyboard 组件 + cover 误涂背景(2026-07-11,肉眼验收二回合)

用户复检只剩两问题,都当场破案:

1. **Keyboard 变 Frame** → 容器 `01 01 03 00 05 01 06 00 07 00`:组件标志 `05 01`
   在,但 key 为空(`07 00`),旧判定要求 `05 01 07` 紧邻。全文件普查:`05=1`
   恰 95 处(20 个带 key + 75 个空 key 家族),其余 19309 处全是 `05 00` ——
   **`05 01` ⇒ COMPONENT 零碰撞**。修后 Page-1 组件 20→95 个。顺带把容器 `01`
   判别升级为**值语义**:`01 00`=组族(带 `02 <kind>`=布尔)、`01 01`=FRAME 族
   (全量 9897/9897 后随 `03`,与上一轮"01+03"规则在全部观测数据上等价,
   cover 516 交叉表零例外)。
2. **cover 被误涂 #000000** → 页记录的 `05 <argb>` 对默认画布也存值(浅色
   fixture 存的是 #F5F5F5 = MasterGo 默认画布色,特斯拉文件存黑),真正的
   判别是颜色后的单字节旗标 **`06 01` = 用户自定义背景**:六个 fixture 的页记录
   交叉表里,唯一带 `06 01` 的 Page 1 正是唯一真有背景的页;cover/浅色页都只有
   `07 01`(+08/09)无 06。转换端只在旗标存在时发射 background。

验证:cover 计数零漂移(type 0 / deep 622 保持),五回归集逐项持平,0711-2
全零保持,build 通过。教训:**"字段存在"不等于"属性生效"——MasterGo 会把默认值
原样写盘,生效与否另有旗标位;判别一律交叉表,不猜。**

### 第四轮:Component–Instance 关系还原(2026-07-11)

用户反馈:视觉已无明显差异,但实例被还原成普通 Frame,组件-实例关系丢失。
实现端到端实例重建链路(全部带 Frame 壳回退,不影响既有行为):

1. **转换端**(mgPackage.js):实例记录(sourceType=INSTANCE)携带记录级
   `mainComponentId` = tag-1a 模板引用,仅当组件记录本身在包内可达时发射
   (完整导出组件在画布上 ✓;share 导出主档不入包 → 不发射,自动回退)。
   0711-3 共 236 条(含嵌套实例)。记录级字段对比较器不可见,六集回归逐项
   持平(cover type 0 / deep 622 保持)。
2. **导入端**(code.ts):会话级 `restoredNodeById` 登记所有已还原节点;
   每页**组件/组件集根优先还原**(还原后按包内根序 insertChild 复位,
   z 序不变);命中 `mainComponentId` 且组件已还原时走
   `component.createInstance()` → 应用根属性 → **按位置递归匹配**记录树与
   实例子树(记录 childIds 序 == 组件子序,数量不合即跳过该子树)应用覆盖:
   可见性/不透明度/文本字符(缓存字体加载)。计数按"1+被跳过的后代记录数"
   入账,页级/会话级数量校验不破。任何一步失败 → safeRemove + 回退 Frame 壳。
3. 限制:嵌套实例在父实例成功时由组件结构自带;字体/换图级覆盖仍受
   override 表(`06 01 15`)未解码限制;实例引用**后置根组件**的场景靠
   组件优先还原解决,引用**深层嵌套组件**且顺序在后的场景回退 Frame 壳。

## 2026-07-12 — 0712-1 定向测试集:06 值语义定案 + 19 掩码三位破解(override 语义主线)

用户把 override 残差图层单独建档重导出(测试集/0712-1:Keyboard 组件 + 两个实例,
一个原样、一个改色改位),给了 override 语义第一个**可判别的最小基准对**。三步收口:

1. **容器 `06` 值语义定案**:0712-1 两个根级 Keyboard 实例拼写 `06 01 09 …`,被
   2026-07-11 的"后继白名单"规则(0f/15/17/END)误判成 FRAME → 模板展开不跑 →
   412 条子记录 missing。块边界修正后的交叉表(此前的 2000 字节窗口探针曾把邻居
   记录的容器读成 PEN/TEXT 的,先证伪了一次假矛盾):0711-3 cover 槽位 `06=1` ⟺
   INSTANCE 零反例(含 224 个 `06 01 09` 拼写)。**`06 01`=INSTANCE,与 `01`
   同为值语义**。副作用:0711-3 Page 1 的 1.1 万嵌套实例全部激活模板合成,发射
   65k→221k——0712-1 证明了完整导出的稀疏存储模型(未覆盖子节点不落盘),即
   Page 1 此前漏发 ~70% 内容;深度直方图最深 6 层,无递归爆炸。
2. **19 掩码 = 完整导出的 override 位图**(容器 `15` 表仍是 share 专属机制):
   `0x40000`=描边粗细已覆盖(存根显式 `10 00` 无此位=填充值,继承模板默认;
   0712-1 8 例 + 0711-3 49 例双向零违例)、`0x1`=字符已覆盖、`0x4000`=布尔叶
   (省略轴恒 0)。存根省略变换轴=继承模板 x/y(ENTER 案例),布尔叶除外。
3. **TEXT 命名规则第三版**:基准名恒=字符折叠("Remaining distance"→"90%"、
   mask 0x80 的 "Artist"→"Streaming"),唯 mask 带 0x10000 且无 0x1 的存根保留
   模板手动名(0712-1 "letter" 键)。autoRename 真位未定位,记入速查表。
   中途曾试"模板自动命名判别"(name≈chars)——0712-1/0711-3 各有反例,证伪。

**Component-Instance 还原链路验证**:0:1740 发射为 COMPONENT,两个实例记录带
`mainComponentId: "0:1740"`(第四轮实现的导入端 createInstance 路径就位)——
zip 通道(SendToFigma API 导出)不携带实例关系,.mg 通道自此补齐。

验证:0712-1 结构全零(1969/1969),残差=30 行 fontWeight(基准存 0,复制建档
丢失的元数据,无视觉)+ 9 行已知布尔/文本度量族;四个 share/full 老集逐项持平,
0711-2 全零保持;0711-3 cover 结构全零、deep 622→651(±29 全在既有布尔重排与
name 家族内波动,换取 Page-1 内容补齐与实例语义)。`npm run build` 通过。

教训:**(a) 探针必须块边界定位,跨记录窗口会制造假矛盾;(b) "位存在"与"位取值"
是两套语义,`01/05/06` 三个容器字段全部是值语义——白名单式后继判别是对值语义的
误建模;(c) 最小定向基准对(一个原样实例 + 一个单点修改实例)是破解 override
类语义的最高效 fixture,比大文件回归高一个数量级的信噪比。**

### 2026-07-12 追加 — 实例还原静默回退:UI 转发层的 id 前缀漏项

用户实测两个 Keyboard 仍是 Frame。Figma MCP 检查还原页:组件本体 COMPONENT ✓、
两实例 FRAME ✗ → 问题锁定导入端。逐段排查发现 `ui.template.html` 的
`prepareRecordForImport` 给 `id`/`parentId`/`childIds` 统一加防冲突前缀,**唯独漏了
记录级 `mainComponentId`** —— 插件端 `restoredNodeById` 按加前缀 id 注册组件,
实例拿未加前缀的引用查表,静默 miss → 全部回退 Frame 壳。一行修复(前缀补齐)。

顺手硬化实例还原策略:组件查找失败/createInstance 失败才回退(带 `[mg-instance]`
前缀的 console.warn 说明原因);applyProperties/子覆盖失败改为**保留实例**只告警
——实例关系是核心诉求,部分样式失败不应退化结构。

教训:**转换端验证(包里字段正确)≠端到端验证——中间还有 UI 转发层会改写记录;
凡是"id 引用"新字段,必须全链路检查每一处 id 重写点**(前缀、别名、去重)。静默
fallback 分支必须带日志,否则用户只能看见结果不对而无从定位。

## 2026-07-12 — 0712-2(改尺寸实例):镜像 override 树 + 标量 05=名字锁 + 缺席组件

用户报告"实例改尺寸后大量元素还原异常"。0712-2 基准双页全覆盖,结构差从
extra 302 / index 15 / childOrder 11 收到全零(652/652),deep 450→212。五个破解:

1. **组件树内嵌套 override 是"镜像树"**(完整导出):嵌套实例槽位(0:58430)的
   childIds 不是模板孩子,而是**裸 id 覆盖镜像记录**(0:58431…),逐层
   `parent=上级镜像、templateRef=被镜像的模板子`。share 形态的对等物是
   slash-id override 记录。展开时镜像按 (parentMirror, templateChild) 索引作
   override 源;误把镜像当模板孩子克隆正是 302 条 extra 的来源。
2. **组件本体可以缺席**:复制建档没带 nav row(0:761)的记录本体,但其子树
   记录都在(孤儿树)。展开经"虚拟组件根"(几何取槽位)继续;继承链 1a 指向
   缺席组件时回退槽位记录(槽位镜像组件的视觉字段)。
3. **标量 `05` = TEXT 名字手动锁**(顺带破掉远古"shape flag"):`05 01`=保留
   04 层名,`05 00`/缺失=autoRename(名=字符折叠)。三集交叉表零违例
   (05=1 → 基准名从不是字符;否则从不是记录名)。命名 pass 必须在继承**前**
   用记录自带字符跑(继承来的字符会误改镜像记录名),锁位对 stub 从槽位继承。
   此规则取代了 0x10000 掩码启发式,0711-3 deep 顺带 651→620。
4. **19 掩码语义修正**:0x10000 不是"保名"信号(那是 05 的职责),维持
   "paint/fill 覆盖"观察;嵌套实例判定看模板侧(stub 空壳容器不可信)。
5. **INSTANCE sizing 回退**:组件缺席时用实例自身尾部的 21/22(同语义)。

教训:**(a) 插桩要挂对对象——模块 IIFE 的 `global` 是形参 window,挂 sandbox
上的钩子三轮全是假阴性,先验证插桩自身再信其输出;(b) "复制建档"的测试集会
天然携带"引用缺席"形态(组件本体不在档),解码器必须容忍悬空引用并有语义
回退,而不是按"引用必在"建模。**

## 2026-07-12 — 0712-2:改尺寸实例 + "无根组件"文件形态,镜像树语义收口

新定向集(nav-row 组件 6 行实例、改过尺寸的 directions):cover 发射 614 vs 基准
312(extra 302,近乎翻倍),paint 35、VN 6、deep 450。六个根因逐一定位:

1. **嵌套实例误 walk 镜像树**:改尺寸实例给直接子留 raw stub(空壳容器 bareStub→
   FRAME),展开的嵌套判定只看 stub meta → 走 walk 而非 queue → 把模板槽的
   childIds(=覆盖镜像记录)当模板孩子克隆 → 288 条二段假 id。修:嵌套判定同时
   看模板侧节点(`tplChildIsInstance`)。
2. **完整导出的覆盖机制 = 裸 id 镜像树**(share 是 slash-id 记录):
   mirror.parent = 槽位或上级镜像、mirror.templateRef = 被镜像的模板子,逐层
   平行于组件子树。镜像携带 per-实例覆盖(隐藏/透明度 0.4/换色/显式零间距)。
   由 `mgAttachOverrideMirrors` 独立挂接(不依赖展开——见 3),继承链改为
   **stub → mirror → 1a 目标 → 路径段槽位**。
3. **文件可以只复制组件子树而不带组件根**(0:761/0:773/0:775 全缺,子树在)——
   展开 job 因 comp 缺失夭折(并行会话已加 virtualComp 兜底),继承链的槽位
   回退成为关键:实例根的隐形白底 fill、透明度、clips 都从槽位节点补齐
   (paint 35→0)。
4. **实例子层的身份铁律**:名字与"基态盒"永远跟随主组件对应子层(MasterGo 同
   Figma:实例内不可改名);chars 才是可覆盖的。`mgSyncMirrorIdentity` 最后统一
   把镜像记录与 slash 存根的 name 同步为组件侧最终名("road name"→"Exit 87",
   即便 chars 已覆盖为 "Highway 400")。曾试图同步 w/h——立即被基准打脸
   (hug 盒是 live 文本度量,镜像/组件/实况三个值互不相等),回退,记为残差族。
5. **镜像的 geomHash 可指向未复制的 blob**:VN 回退沿 mirror/1a/槽位链找第一个
   在 blob 表里的 hash(VN 6→0);钢笔改过的椭圆保 ELLIPSE 类型但携带 VN。
6. **clips 的无据角**:组件根缺失且槽位无 03 时包内无信号(6 行残差);
   "组件缺失→false"规则翻车 46 个健康实例,证伪回退。

结果:0712-2 结构全零(652/652),paint/VN/字体全零,deep 450→92(残差=hug
尺寸 71 + clips 6 + visible 5 + y/rt 10,全部记录在案)。七集回归:四小集逐项
持平、0711-2 全零保持、0712-1 保持(7/39)、0711-3 deep 653→581(镜像链同样
适用于特斯拉,顺带改善)。build 通过。

教训:**(a) "同一节点两套 id"(镜像 id vs 组件路径 id)是完整导出实例的核心
双身份,发射选组件路径、数据取镜像;(b) 结构性判定(是否嵌套实例)永远看模板
侧,不看存根侧的退化 meta;(c) 修复被基准打脸时立即回退并记录证伪——本轮两次
(w/h 同步、clips 默认 false),证伪记录与破解同等重要。**

## 2026-07-12 — 0712-2 收尾:双键镜像、07 省略、rescale 回放(deep 92→84)

上一轮收口后用户实测仍不对:实例内容未缩放(行高 100 vs 真值 84)、每行方向
图标可见性覆盖全灭。三个根因:

1. **镜像查找必须双键**:嵌套实例槽位(right-turn 槽 0:59042)的镜像记录,其
   `templateRef` 指向**组件本身**(0:795)而非槽位 id——单键索引查不中,每行
   "该亮的图标" visible=true 全丢。`mgAttachOverrideMirrors` 的 flatten 与展开
   端 `bareOverrideByParent` 都改为 `flat[seg] || flat[segNode.templateRef]`。
2. **镜像 `07` 省略 = 可见**(显式 `07 00`=隐藏 18/18、省略=显示 6/6),不是
   "继承槽位"。补掉最后 2 行 destination。
3. **实例整体缩放要用 `InstanceNode.rescale()` 回放**:Figma 实例子层几何锁定
   跟随组件(`set_y` → "cannot be overridden in an instance"),改子层尺寸复现
   MasterGo 缩放是死路。转换端发 `record.instanceScale`(trailer 26),导入端
   createInstance 后先 rescale 再精确 resize。

同轮功能:导入页名 `<原名>_mg MMDD-HHmm`(先剥旧后缀,不叠加)。
结果:0712-2 deep 92→84(visible 5→0),七集回归全平。

## 2026-07-12 — v8.1 亚像素偏移:Figma rescale hug 怪癖(导入端,比较器盲区)

用户报告缩放实例内 "v8.1 (2017.30 37cacf)" 仍有轻微位置偏差。包端数据与基准
逐位一致——问题只存在于 Figma 实况,全程用 Figma MCP 对拍 mg 页 vs zip 页定位:

- 实测:x 完全一致,y 偏 −0.769px(zip 776.112 vs mg 775.344)。实例内逐节点
  diff:矢量/矩形/组全部精确,唯独文本各漂各的(+0.37~0.49),v8.1 与
  Alpha Omega 恰好 **−1.000px**,CENTER 约束的 dragme Frame x +0.43。
- **受控实验**(关键手法):在 zip 版和 mg 版组件上各建裸实例只做 rescale——
  两边结果 bit 级相同,证明导入管线无错,−1px 是 Figma 自身行为。合成试件矩阵
  (y∈{592,592.25,592.5,592.75,593} × 字号行高组合)钉死规律:**hug 盒高 =
  ceil(S·lineHeight);当 fract(S·lineHeight) > 0.5 时盒顶恰好上移 1px**,与 y
  值/对齐无关(28×0.8406=23.537→−1;36×→30.26、50×→42.03→0)。toggle
  autoResize NONE→W&H 证明该锚定是确定性公式而非瞬态。
- **修复杠杆**:实例子层位置不可写,但 `textAutoResize` 可覆盖。设 NONE 后盒子
  回到纯缩放几何——而这正是 MasterGo 的字形真值(MasterGo 的实例 hug 保中心:
  字形中心=纯缩放中心)。实测残差从 −0.77px 收敛到 +0.23px,且逐节点残差精确
  等于 `(ceil(S·lh)−S·lh)/2`——即字形已 100% 对齐,剩余只是 MasterGo 整数取整
  包围盒 vs 精确缩放盒的半像素差(不可见,实例内无法再逼近)。
- 落地:`applyInstanceChildOverrides` 增加 rescaled 分支,对未被 characters
  覆盖的文本子层统一钉 NONE(chars 覆盖过的保留 hug,让盒子围新内容重排);
  当前已导入文件用 MCP 现场补钉(about 12 条 + directions 18 条)。

教训:**(a) 比较器只见包不见 Figma 实况,导入端疑难要靠"受控实验":同一组件
两来源各建裸实例做同一操作,结果相同即可把嫌疑从自家管线摘除;(b) 宿主引擎的
怪癖也能用合成试件矩阵钉成规律,和逆向二进制字段是同一套方法论;(c) 实例内
"盒位置"永远锁死,能动的只有可覆盖属性——修复要找的是"哪个可覆盖属性能把
几何逼回真值",本轮答案是 textAutoResize。**

## 2026-07-12 — 特斯拉 mg 导入触发 Figma 标签页崩溃:22 万条实例后代的内存悬崖

`06 01`=INSTANCE 修复找回漏发的 70% 内容后,0711-3 的 Page 1 发射从 6.5 万涨到
21.97 万条、转换产物 477MB JSON——用户导入时 Figma 整页崩溃("Something went
wrong")。本地量化(probe29/30):

- **零病态值**(无 NaN/Infinity,236 个 instanceScale 全部 0.8406)——排除几何炸弹;
- **221,119 条记录里 219,383 条(99.2%,455MB/458MB)是实例展开的后代**,其中
  vectorNetwork 一项 136.5MB、fills 65MB;
- 而导入端对这些记录**只读 5 个字段**(visible/opacity/characters/fills/strokes,
  `applyInstanceChildOverrides` 的位置配对),节点本体全部来自
  `createInstance()`,全量 props 是白扛的。

修复三件套:

1. **转换器瘦身模式**:`convertMgPackageToV2Entries` 第三参
   `options.slimInstanceDescendants`(仅插件 UI 传入)。以**发射出的
   `mainComponentId` 为门**(不是 slash id!share 导出无可达组件、实例走
   Frame 壳还原,那些记录就是还原源,不能瘦),对其后代把 props 换成白名单:
   type 族/visible/opacity/characters/fills/strokes/booleanOperation/瘦 layout。
   477MB→167MB(-65%),比较器与 pythonParser 不传参数、输出逐字节不变
   (0711-3 回归 deep 575/geometry 112、0712-2 全平 84 验证)。
2. **UI 端发完即弃**:import-page-chunk 发出后立刻置空
   `pageData.layerChunks[chunkIndex]`——主线程恰在此时构建自己的副本,20 万条
   的页两侧同时攥满副本是峰值元凶(UI 端每页惰性准备已是既有机制,主线程
   finishImportPage 的 finally 也已逐页释放)。
3. 校验兼容:layerCount 一致性检查不受影响(瘦身不减记录数);
   `prepareImportProps` 是通用递归,瘦身记录的 IMAGE imageRef 前缀照常。

教训:**(a) 修复"漏发内容"类 bug 时要顺手量化发射量的数量级变化——3.4× 的
记录膨胀在小测试集上无感,在 30MB 的真实文件上直接撞穿宿主内存;(b) "谁读这
份数据、读哪几个字段"是瘦身的唯一依据,门控要用还原路径的真实分支条件
(mainComponentId),不能用形态特征(slash id)替代;(c) 双端管线的内存峰值
看"同一份数据同时存在几份"——发完即弃把 UI 副本的生命周期错峰到主线程副本
之前结束。**

## 2026-07-12 — 特斯拉保真度:实例的第四形态"完全物化",一门修千错

OOM 修掉后用户报告 mg 版 cover 与 zip 版差异巨大。Figma MCP 全量对拍(逐路径):
mg 版 3372 节点 vs zip 版 1382,**extra 2001**、pos 677、size 204、vis 21。cover 的
包内记录与基准完全一致(extra=0)→ 差异全部来自 **Page 1 组件本体**(实例
createInstance 克隆组件内容),而 Page 1 无 zip 基准 = 比较器盲区。

**包内自洽性探针**(新方法):实例记录自己的 childIds 树(≈基准真值)vs 组件
记录树逐层配对——11,482 个顶层实例 **11,480 个结构失配**,实例侧 childIds 双份:
`[0:112/0:48(展开存根), 0:113(裸id), 0:112/0:89, 0:134]`。裸孩子带 templateRef
精确指向组件子、可见性是真值(Light=1/Dark=0,与 zip 一致;存根反而是错的)。

**第四种实例形态:完全物化**(编辑器原生完整导出,区别于浅存根/稀疏镜像/share
slash 覆盖)——实例把全部子树以裸 id 完整记录入档。0712-2 基准早已给出铁证:
组件内 dragme 实例的孩子在基准里就是 `0:77 Union`(裸 id!)——**物化子就是
API 画布节点本身**。正确处理=一条门:实例的 childIds 里存在**带类型的裸 id 子**
→ 整个跳过模板展开,直接发射裸子树(数据完整,无需继承)。

弯路记录(全部证伪回退):①"认领镜像+发射存根"方向——0712-2 立刻 Missing 302
(裸孩子本来就该发射);②认领标志被合成器整体克隆继承→嵌套子树整棵消失
(21.8k 记录假象);③tplRef 队列兜底复活死 job;④slash 前缀门把特斯拉自己
搞坏(组件树内合法 slash 覆盖记录误伤)。**set1 "回归"是幽灵**:45/32/157 本就
是当日起点值,拿错了旧世代存档(17/17/99)当基线——教训:回归锚点必须取
当日会话起点的实测,不能凭记忆翻旧档。

连锁解释:childIds 双份 → 导入端覆盖应用的数量一致性门静默跳过 → Light/Dark
与导航图标可见性全灭;嵌套组件依赖无拓扑序 → createInstance 查空回退 Frame 壳
→ 把(瘦身后的)双份记录实体化 → cover 实况 +2001 节点。导入端补拓扑排序
(mainComponentId 依赖图,环退回原序)。

终态:特斯拉发射 221,119 → **70,086**(zip 时代真值 ≈70.1k),自洽性失配
11,480 → **3**;八集回归对当日起点全平(0711-3 deep 577±2 在既有残差族内);
瘦身模式在新发射量下产物 167MB → 约 45MB 量级。

## 2026-07-12 — 0712-3 特性样本往返:一晚破解七字段族 + 样式库还原落地

用 Figma MCP 手搭特性样本(见 `TESTSET_0712-2_FIGMA_SPECIMEN.md`,落盘为测试集
0712-3)→ MasterGo 往返 → mg/zip 对比。初始 deep 153、Effect 5、Font 36、Paint 3,
一晚全清(终态 deep 5,余者皆 MasterGo 侧怪癖)。破解清单:

1. **effect kind 枚举修正**:0=INNER_SHADOW(零压缩→`05` 字段整体省略,旧解析器
   要求首字节必须 05,不是就跳过整条)、3=BACKGROUND_BLUR(旧映射 3=INNER 是错的);
   **新字段 `0f <float>` = spread**(spread 1/−2/−4 都走 0f,旧解析器遇 0f 弃整条
   ——drop+inner 组合因此全灭)。
2. **STAR/POLYGON**:`1c 06`/`1c 05` 字段 `01` = **zigzag varint pointCount**
   (3→06、5→0a、8→10;省略=星 5/多边形 3),星形字段 `02` = innerRadius 浮点
   (省略=0.5)。
3. **image scaleMode 4=TILE**(此文件形态;旧 2=TILE 保留),字段 `02`=ratio/
   scalingFactor 两侧语义一致。
4. **容器 0d/0e 对齐枚举 1=MAX**(`0e 01` 实测;旧表只有 2=CENTER/3=MAX/4=SPACE_BETWEEN)。
5. **decoration 字节 4=STRIKETHROUGH**(旧证据 2;取并集)。
6. **strokeWeight 填充规则扩展到裸 templateRef 记录**(变体 `10 00`+`1a` 引用+
   无 0x40000 → 沿链取默认 1;此前只对 slash 存根生效)。
7. **混排文本节点级 fill = 首段 fill**(zip 导出器语义;记录自带的黑色是无意义默认)。

**样式库破解 + 还原(用户点名的能力)**:样式定义 = **名字带 UTF-8 类别前缀、
放在 02 槽位的具名记录**(`01 <id> 00 02 文字/Heading/H1 00 03 <code> 00 05 …`),
类别前缀:`文字/`(text)、`填充/`(fill)、`特效/`(effect,**不是"效果"**)。
值早已在按 id 键控的注册表里:fill=paints[styleId]、effect=effectTable[styleId]、
text=fontStyles[styleId](给字体样式表扫描器加了第三拼写)。节点引用:fill/stroke
经 tag 15/16、effect 经 tag 17、文本经 run 级 `03 <styleId>` ——全部直指样式记录
id。发射:`styles.json`(mastergo2figma.styles.v1)+ 记录级 fillStyleRef/
strokeStyleRef/effectStyleRef/textStyleRef(比较器不可见,同 mainComponentId);
导入端 import-styles 消息 → createPaintStyle/createEffectStyle/createTextStyle
(字体先 loadFontCached,effect blendMode PASS_THROUGH→NORMAL)→ 还原后
setXxxStyleIdAsync 绑定(值已内联,绑定纯增量,失败只丢链接不丢视觉)。

**证伪记录**:变体名规范化(`Size[a2]=Large`→`Size=Large`)被基准打脸回退——
MasterGo 自己的 zip 导出对 12 个变体里 11 个保留括号原形,只洗了 1 个;归一化
把 1 行差异变 11 行。教训重申:**基准说什么就是什么,别替 MasterGo 做美化**。

已知残差(样本,5 行):变体名 12 选 1 被 MasterGo 洗(无信号)、Show icon=false
隐藏 icon 的清零变换 4 行(视觉无影响)。八集回归逐项全平。

陷阱新增:**probe 里用 TextDecoder("latin1") 搜中文是假阴性**——它实为
windows-1252,高字节被重映射;定位用 w1252 offset(1 字节=1 字符,offset 一致),
取名必须回 bytes 层 UTF-8 解码。

## 2026-07-12 — 0712-3 实测三问题:一个边界、两类导入端 bug、一次超越 zip

用户实测报三问题,比较器全绿(mg==基准)——即基准 zip 同样丢,分流结论:

1. **Title Case = "MasterGo 不产出"边界**:UPPER 的样式条目带 `0a 01`,TITLE 的
   条目**没有 `0a` 字段**——Figma→MasterGo 导入时 TITLE 就丢了,mg/zip 都无从还原。
2. **内阴影全灭 = 导入端 applier bug**(zip 路径同样中招):
   `normalizeEffectsForNode` 给 INNER_SHADOW 也塞 `showShadowBehindNode`(该属性仅
   DROP_SHADOW 合法)→ effects setter 抛错 → 无 spread 重试仍带毒 → **整条 effects
   数组静默丢弃**("inner shadow" 单卡和 "drop + inner" 组合卡全灭的共同根因)。
   修:只给 DROP_SHADOW 设默认、其余类型剥除该字段。
3. **TILE 比例 = 导入端映射缺失**:MasterGo 的 `ratio` 字段就是 Figma 的
   `scalingFactor`,paint 转换从未映射 → TILE 一律按默认比例渲染(zip 同病)。
   修:scaleMode TILE 且无 scalingFactor 时取 ratio。
4. **CROP 裁剪窗还原(超越 zip)**:zip 导出器整个丢掉裁剪窗,但 `.mg` 的图像
   对象 `04` 子对象完整保存——字段 01..04 = **图像显示矩形(节点本地坐标)**
   (150×96 节点中心 50% 裁剪存 x=-75 y=-48 w=300 h=192)。imageTransform =
   `[[nodeW/w, 0, -x/w], [0, nodeH/h, -y/h]]`,需节点尺寸,故 paint 带
   `__mgCropRect` 原始矩形、`mgNativeProps` 收口计算。0712-3 逐位还原授权真值
   `[[0.5,0,0.25],[0,0.5,0.25]]`。**恒等变换不发射**(老集 80 张"无裁剪的 CROP"
   解出 [[1,0,0],[0,1,0]],发射只添基准噪声)。代价:每张真裁剪图 +1 已声明
   deep 行(0712-3: deep 5→6)。

教训:**比较器全绿≠视觉正确——mg 与 zip 可以一起错**(共享 applier 的 bug、
MasterGo 导出端的共同丢失)。特性样本的 origin 页是第三真值源,zip 只是
"MasterGo 能导出什么"的真值。

## 2026-07-12 — 0712-3 三轮:TITLE=0a 03 + TILE 走错函数的教训

1. **textCase 3=TITLE**:用户在 MasterGo 里手动补设 Title Case 后重导出
   (`测试集 0712-3+Case.mg`),条目出现 `0a 03`(LOWER=`0a 02` 对照)——证实
   上一轮"TITLE 缺失"确为 MasterGo 的 Figma 导入丢字段,MasterGo 本体支持。
   枚举补全:1=UPPER 2=LOWER 3=TITLE。
2. **TILE 修在了错的函数上**:图像填充的真实路径是 `normalizeImagePaint`
   (**重建全新 paint 对象**,逐字段白名单透传)——上一轮把 ratio→scalingFactor
   映射加进了 `normalizePaintForFigma` 家族,而那条路径根本收不到源字段。
   imageTransform 恰好在白名单里所以 CROP 生效、TILE 不生效,形成了误导性的
   "半成功"。教训:**修 applier 先找到字段被重建/白名单化的那一层**,在源对象
   还在手里的地方做映射;"同一文件里改了个函数"不等于"改在了数据流上"。

## 2026-07-12 — 0711-2 导入"卡死 35%":发完即弃误伤超时公式

症状:UI 停在「页面完成:BIG_mg …  29007/0 个图层后处理 · 总进度 35%」。链路还原:

1. OOM 修复的"发完即弃"把 `pageData.layerChunks` 槽位置 null;
2. 页面还原超时公式 `getImportPageEndTimeoutMs` 从 layerChunks **现数** recordCount
   (`getLayerChunkRecordCount` 对 null 槽位安全返回 0——静默归零而非报错);
3. 超时从 `120s + 29007×35ms ≈ 19 分钟` 塌缩成 **120s 底值** → 29k 真实矢量节点
   的 share 页必然超时(特斯拉页以实例为主、真实创建节点少,侥幸不触发);
4. UI catch → `resetImportProgressMode()`(total 清零、百分比归零)→ 主线程仍在
   继续并发来「页面完成」→ `isCurrentImportMessage` 在 activeTransferId 为空时
   放行一切 → 迟到消息以 35%(restore 阶段 offset)+"29007/0" **盖掉错误提示**,
   外观= 永久卡死;主线程完成页后等不到 session-complete,双方互等。

修复:① `buildPageImportData` 在置空前捕获 `recordCount`,超时公式优先取它;
② `isCurrentImportMessage` 无活动 transfer 时丢弃带 id 的迟到消息(错误提示不再
被盖)。教训:**释放内存的"置空"会让所有晚于它的读数静默归零——凡是"稍后还要
读"的聚合量,必须在释放前捕获快照**;null 安全的 helper 恰恰是掩护这类 bug 的
帮凶(宁可让它抛错)。

## 2026-07-13 — 统一回归集首轮:十族问题、三个名字 hack 退役、径向三层规则定案

用户把近几轮问题图层合并进「插件测试」文件(回归 2026-07 section 九区 + 同页历史
问题图层),整页往返产出 `测试集/插件测试 0712 汇总/`(.mg + zip,344 记录)。首轮
mg 导入用户肉眼报六处;比较器 deep 54 / paint 3 / effect 1,三源定性(mg vs zip vs
origin)后拆成十族,终态 deep 14 / paint 1(CROP 故意超越)/ effect 0,九套旧集回归
全持平、0712-3 还净改善一行。

**解码端八刀:**
1. **对齐枚举拆轴**:`0d 03` 实为 **primary SPACE_BETWEEN**(al/space-between-3 交叉
   表),旧共享表 `3:"MAX"` 把三子 SPACE_BETWEEN 挤到行尾;counter(0e)保持 3=MAX。
   单子 SPACE_BETWEEN 两路都存 CENTER——是 MasterGo 自己洗的,边界不修。
2. **padding 逐槽省略=10**:BoolChip 存 L/R 16 丢 T/B 10、Badge 存 T/B 5 丢 L/R 10
   ——"任一边等于 10 即省略该槽",组件路径此前把缺槽当 0;R09 的 padding=10 陷阱帧
   (整对象空)一直是对的,坑在部分省略。
3. **trailer `2e 01` = layoutPositioning ABSOLUTE**:统一集交叉表 TP5/FP0/FN0。顺手
   处决了 set1 时代的"组子节点在 auto-layout 祖先下一律 ABSOLUTE"启发式(本轮把
   02_02 的普通组子节点误标)。set0 复验时发现 flag 被**内嵌 v2 副本的陈旧
   `AUTO` 盖掉**——嵌入合并路径对原生权威字段要重申(`2e` 优先)。
4. **效果 radius 省略=10 对全类型**:回归/Layer Blur 样式条目 radius 10 整字段省略,
   blur 族旧默认 0 → 样式和节点双双失模糊。
5. **径向 ratio 三层规则定案**(本轮最大坑,两次反转):裸 `06{03}` 直读(原生绘制,
   set0 的 03=0.3265 就是终值);**链谱写 `06{02,03,04}`**(Figma 导入来源)逐节点
   物化——同一条目(03=0.10662,04=0.3265)在 210×120 宿主上 v2=3.0625
   (=03×1.75²)、在共享它的 100×100 描边矩形上 v2=9.3789(=03 直读),证明 04 只是
   宿主节点缓存,真规则 = **x 主导手柄 ×(w/h)²,y 主导直读**(竖直参照系;y 支路
   曾试 ×(h/w)² 打爆旧集 368 个 paint);**角向/菱形永远直读**(菱形链条目在两种
   节点上 v2 都是 9.3789)。中途"优先读 04"的版本被 Strokes 共享 paint 当场反杀
   ——per-paint 缓存值对 per-node 语义无效。
6. **默认变体名 wash**:.mg 存 `Size[a0]=Small,Type[a0]=Primary`,API/v2 洗默认变体
   (全键尾 [a0] → 剥一层;剥净则 `", "` 规范连接,剥不净保持原逗号)。0712-3 的
   "12 选 1 被洗"残差同规则闭环(deep 9→8)。era 例外:set0 同形默认变体未被洗
   (+1 退役残差)。
7. **缩放实例 padding/itemSpacing 按 trailer-26 缩放**:记录存模板值 14,v2 物化
   11.62=14×0.83;几何路径早就缩了,布局字段漏了。
8. **三个名字 hack 退役**(Button_Secondary_Instance 居中位移 / Card_Instance 视觉
   覆盖 / 两帧投影注入):set1 时代把基线期望值抄进解码器,本轮按图层名**误伤新文件**
   (0:161 被强设 INSTANCE,zip 明说 FRAME)。删除后 set0 剩 3 行诚实缺口(名字 1 +
   图标位移 2),换来任意真实文件不再被同名图层污染。

**导入端两刀(比较器盲区,mg/zip 同错):**
9. **同根 use-before-def 延迟重链**:R08 实例在图层顺序上先于组件定义、且同在一个
   页面根内——根级拓扑排序无从重排,createInstance miss → frame 壳。修复:壳照建并
   登记,整页还原完(组件必然就位)原位 `insertChild` 换真实例
   (`retryDeferredInstanceRelinks`,置于延迟布局 pass 之前使其注册被消费;父先于子
   登记,外壳先换、内壳自动作废)。
10. **多轴变体名规范化**:`createFigmaVariantName` 只处理第一段,
    `Size[a0]=Small,Type[a1]=Secondary` 洗成 `Size=Small,Type[a1]=Secondary` → 各变体
    属性名集合不一致(`Type[a0]` vs `Type[a1]`)→ `combineAsVariants` 抛错整组降级
    frame。逐逗号段剥 `[aN]` 后 `", "` 连接,恰好同时对齐 Figma 规范名。

**误报与边界:** 用户报的 CROP 实为误报(fills 逐位与 origin 相同,截图确认);渐变
区的"角向异常"是 mg==zip 的 MasterGo 导入洗失(边界);origin 的径向/菱形本就是
压扁横条(历史产物),修复目标是等于它而非"好看"。

方法论沉淀:①**同一 fixture 的两个导出时代是最强判别器**——set0(0710)与统一集
(0712)同设计不同谱写,径向链形态、名字 wash、嵌入副本覆盖全靠对时代差定案;
②**共享 paint 是 per-node 语义的照妖镜**;③按名字注入期望值的 hack 迟早反噬,
诚实缺口好过隐性污染。

## 2026-07-24 — 线性渐变斜轴:归一化空间旋转 vs 像素空间垂直(mg==zip 同错)

fx/bg-blur-backdrop(280×150,蓝→品红→橙)导入后渐变轴被拉成硬对角线。mg 与 zip
两链路填充数据逐位一致 → 不是解码器问题,是两端共用的把手→矩阵公式
(`getResultArrayByTwoPoint` / `mgLinearGradientTransform`)在**归一化方形空间**做纯旋转,
只有正方形节点或轴对齐渐变才正确。MasterGo(和一切屏幕渲染器一样)让渐变条带在
**像素空间**垂直于把手连线。

**判据是矩阵内部的精度自证**:v2 里 row0=[0.7, 0.7](非单位)与 row1=[-0.7071, 0.7071]
(精确 √2/2)明显来自不同运算——反推出把手 p0=(0,0)、p1=(5/7, 5/7),0.7=cos45°/1.0102
是被 1/len 缩过的。像素空间公式对四角取值(右上 1.09 纯橙、左下 0.31 紫)与 MasterGo
截图吻合;归一化公式给出右上=左下=0.7 的对称错误,与 Figma 错误截图吻合。

修复:导出端 `getResultArrayByTwoPoint(points, dims?)` 有宽高时在像素空间建矩阵;解码端
线性 paint 挂 `__mgLinearMeta {p0,p1}`,复用 `mgFinalizeRadialPaints` 的逐节点收尾
(样式库无宿主节点,剥 meta 保归一化回退)。row1(垂直轴)除以 `w·h·|p1−p0|`——该标度在
旧公式本来就正确的所有情形(任意宽高比的轴对齐、正方形上任意角度)与旧矩阵逐位一致,
既有基准零扰动;第一版用 `w·h·len_px` 当场被比较器抓出 row1 尺度错(100 vs 1)。

验证:修复前后 compare 差异 = 恰好 +2 paint/+4 deep(两页 bg-blur-backdrop 的
row0[0][0]/[0][1]),其余 15 条为 0724 新导出集固有遗留。旧基准 zip 是旧公式产物,
重导出后应归零。

方法论:**矩阵两行精度不一致 = 两行来源不同的化石证据**;渐变类 bug 先用四角颜色值
做数值判据,再谈公式。

## 2026-08-05 — 带外部库导出("冒号 token 方言"):库内嵌 + 六处解析缺口一次收干

**症状**:引用了外部库的文档导出 .mg 后导入直接抛"没有可识别的页面图层";用户提供了
同内容手动复制到干净文件的对照组(手动复制会让 MasterGo 物化显示名/显示值,天然是
已知答案表)。原件 28MB 解出 195k 条记录,用户页面只占 997 条——库的整个文档
(Ant Design 组件库,62 个 owner token)被整体内嵌。

**六个根因,一条主线:这个方言把辅助记录的 id 全放进冒号 token 空间,而解码器到处
硬编码 `N:M` 数字 id。**

1. 页面表 id 是 `:7384`(色值页),`parseMgPages` 的 idRe 拒绝 → 0 页 → reachable 空
   → 抛错。放宽 idRe 后,**库移除自动成立**——库节点的 owner token 不在页面表里,
   现有的页根可达性门本来就会丢弃它们,一行删除逻辑都不用写。
2. 库带进来的 12 个 `01 <id> 00 04` component-root 标记误触发 share-mode,连锁反应:
   `mgApplyTextAutoNames` 被跳过(陈旧 name 直接出场:"#111d2c" vs 真值 "#1D2129")、
   缺省 spacing 语义翻转。判别改为:component-root 的 owner 是页面表 id 才算 share
   (share 导出的 master 共享页 owner;库副本的 owner 是页面表外的库页 token)。
3. paint/effect 子记录 id 也是冒号 token(`01 :396 00 02 0:2451 00 03 a0 <白色>`),
   数字 id 正则漏扫 → 文本 fills 全空。
4. font-run 的 sortId 字母表是含空格的可打印 ASCII(`b&n`、`b$ `),旧正则 `[0-9A-Za-z]`
   一票否决整个结构化解析 → chars 回退到陈旧 name。
5. 无字形表的 run 以显式 `00` 结尾,多 run 记录在第二个 run 处撞终止符 → 中英混排文本
   全部解析失败;颜色 run 边界是 LEB128 varint(218=`da 01`),旧代码按单字节读。
6. 单条全覆盖颜色 run(`09 01 …`)被 `count<2` 门槛整个拒绝;而这个方言里 scalar-15
   存的是模板旧 paint 引用,真值在颜色 run 里(标题:15→库的白,run→用户改的黑)。
   新规则:单 run 且 ref≠15 且可解析时 run 胜——**但限定无斜杠 id**:特斯拉的实例
   展开克隆(OPEN 标签)在此规则下翻错色,克隆的颜色真值在 override mirror,不在
   克隆自带的 run 表。另:浅拷贝容器可以完全没有 trailer,21/22 缺失仍应判 AUTO。

**方法论沉淀**:
- "手动复制对照组"是零成本已知答案表:MasterGo 复制时物化所有显示态,陈旧存储字段
  (name/15-ref)与显示真值(chars/run-paint)的分歧当场暴露。本轮 name≠chars、
  15-ref≠run-ref 两族 bug 都是这么定位的。
- 两文件 id 完全不同,比较用**位置配对**(根按 x,y 排序 1:1;子级按 type|name|round(x,y)
  键贪心 + 索引兜底),根级差全局画布偏移即可归零。
- 收敛轨迹:导入失败 → 5912 行 diff → 423 → 111 → 21 → 5 → **0 行**(997 节点全字段,
  0.015 容差)。回归:0712 字节一致、对照组字节一致、特斯拉仅 2 条 "20º" 已知
  live-font 残差闭合(猜测值 Inter/22 → 真值 Montserrat Light/50)、repo 测试套件
  23 过 2 挂与 HEAD 完全相同(存量)。

## 2026-08-05（下）— 大文件设计系统导出：share 判定被自家库文件反杀

**症状**:`测试集/大文件/测试集 0804.mg`(34.6MB,20 万条记录,69 页设计系统库)导入后
大量图层丢失——按钮页只剩 2 个根(空 FRAME + 标题 TEXT),`button`/`button-group`
两个 COMPONENT_SET 整树蒸发;全文件仅 7.2k/205k 层存活。HEAD 上该文件整体失败
(冒号 token 页面表),当日上午的修复让它"能转但转不全"。

**根因**:上午的 share-mode 判定规则——"comp-root 的 owner 是头部页面 ⇒ share 导出"——
被这个文件证伪。它是库文档自身的编辑器全量导出,画布上却有 12 个外来离画布 master
(粘贴进来的图标组件,`2129:*` comp-root,owner=自家页面 `:01695`),形状与 share 导出
完全相同 → 全文件误判 share → 页面根过滤把"share 模式下的 component master"全部丢弃,
而设计系统页面的内容**恰恰全是 master**。

**新判别信号:sort code。** 编辑器导出给每条画布记录发 sort code(`01 <id> 00 03 <code>`);
share 导出的页面级内容是无 code 的 comp-root。规则:任何**带 sort code 且 owner 是头部
页面**的记录 ⇒ 编辑器导出(share OFF);仅当不存在这种记录、或页面表不可解析时才 share ON。
页面根过滤同步改为按记录自身判:只丢**无 sort code**的 master(离画布注册表 master),
带 code 的 master 是真实画布内容必须保留(0804 的全部 button master、特斯拉的 20 个组件)。

**验证**:大文件 69 页逐页"发射数 ≥ 可达数"零缺口(按钮 1818/1818,表格 81k,全文件
205,005 层);带外部库 orig vs 对照组仍 0 diff(37 条已解释深残差不变);0712 与 HEAD
解码器输出**字节一致**;repo comparator exit 0(346/346);测试 23 过 2 挂与 HEAD 相同。
特斯拉 .mg 已被用户删除(不再作为基准,由新三组夹具替代);其安全性由构造保证:
0 comp-root 标记 → 判定分支不触发;master 带 code → 过滤器保留。

**教训**:owner 拓扑不是导出形态的可靠指纹——同一份"master 挂在页面下"的形状,share
导出与库文件编辑器导出都会产生。可靠信号要找**导出器自身的行为差异**(是否发 sort code),
而不是文档内容的结构差异。

## 2026-08-05（夜）— 可同步测试集 0806：样式族七连修 + 外部库 master "还原后删除"

**症状**（用户报的两条）：(1) `.mg` 导入的 0806 页与同一页的 zip 导入"样式差异过大"；
(2) 画布上多出一个被还原的外部组件 `标签栏`。

**方法**：先跑 `compare_mg_import.js` 得到 430 条 deep 残差，然后**按属性路径分桶再按页分桶**
——旧覆盖页只有 15 条（既有族），0806 页 415 条。分桶立刻把"样式全乱"拆成七个互不相关的
独立 bug，每个都用"已知答案交叉表"定位，没有一条是猜的：

1. **paint 不透明度被自己的默认值抹掉**。`08 <a><r><g><b>` 的 alpha 就是 paint opacity
   （红 10% 存成 `08 <0.1> <1> <0> <0>`，无 `09` 字段），但代码在 `mgMakeSolidPaint` 正确
   折进 opacity 之后，又无条件 `paint.opacity = opacity`（`09` 的默认 1）盖回去。51 个
   半透明填充/描边被压成 100% —— 这就是"样式差异过大"的主体。
2. **tag 17 的圆角 hack**。`17` 早已被证明是 effect style ref（见「Library styles」），
   但残留一条 "有 ref 且解析不出 effects ⇒ 圆角 10" 的旧规则。0806 有一半节点把 17 指向
   样式库根（一个没有子记录的 effect style），于是 29 个直角矩形/编组全被加了 10 的圆角。
   交叉表：本文件 168 个带 17 的节点里，该分支命中的 9 个基准全是 0，无一例外。
3. **blendMode 字节 `0xff` = NORMAL**（6/6），此前落到 PASS_THROUGH 默认。
4. **sort code 不是字母数字**。`a!`、`a `（尾随空格）都存在，而 paint / effect / font-style /
   style-def 四个注册表扫描器的 mark 正则都写死 `[0-9A-Za-z]+`（节点扫描器早就是 `[^\x00]+`），
   于是这些记录**整条被跳过**——两个文本节点因此完全没有样式条目，字号/字重/行高全靠猜。
5. **字体族取错字段**。样式条目 `03` 是显示名（`PingFang SC`）、`0c` 是 PostScript 名
   （`PingFangSC-Medium`），代码从 0c 拆出 family，于是 `PingFangSC` / `InstrumentSerif`
   在 Figma 里全部走 fallback 字体。**这一改在大文件夹具上把 38289 个 "Inter"（fallback）
   变成了 38816 个 "PingFang SC"** —— 一个只在 0806 上显形 13 条的 bug，实际影响是六位数。
   两个反例逼出了完整规则：`Roboto-Regular`（03 == 0c，必须继续按 PostScript 拆）与
   `Noto Sans SC-Medium`（03 自带风格后缀，必须剥掉）。
6. **slash id 本身就是模板链**。`mgInheritFromTemplate` 的入口守卫要求 `templateRef ||
   templateNode`，而外部库状态栏实例的存根两者都没有（它的 master 没有 1a 链），于是
   `24:706/24:665` 这类存根一个模板值都拿不到：strokeAlign 18 条、constraints 25 条、
   vectorNetwork 9 条、boolean 类型 2 条全错。守卫改成"有槽位（id 最后一段解析得到记录）
   也算"后，这一族一次归零（deep 213 → 116，type 2 → 0，paint 9 → 1）。
7. **容器 meta 要逐字段继承**。实例子级存根只写"实例改过的字段"：0806 tab bar 的存根写了
   自己的 itemSpacing 20 / padding 24，却没写 layoutMode / align / clipsContent；状态栏的
   编组存根连 padding 都不写——被"完整导出缺省即 10"规则凭空补成 10。按字段合并模板 meta
   后 deep 102 → 74。

**顺手破的两个字段**：容器 `1a <b>`（未破义的单字节旗标）不消费 ⇒ 对象终止符不可达 ⇒
锚定 trailer 解析失败 ⇒ 尾部字段全丢；trailer `20/21/22` 是**零压缩浮点**不是单字节，
`p += 2` 会落在浮点中间截断整个 walk。补上后 `20 <float>` 交叉表出 **layoutGrow**
（7/7 有 ⇒ 1，439/439 无 ⇒ 0）。

**外部库 master 的处置**。`标签栏` COMPONENT_SET 的 parent 就是页面 id，且带 sort code，
所以 2026-08-05（下）那条"无 code 才丢"的规则保留了它——但 MasterGo 自己的 plugin API
根本不把它当页面子节点（zip 基准里没有）。判别信号在容器字段 `07`：`07 03 <libraryFileId
+nodeId>` = 外部库 master，`07 04 <varint>` = 本地。本文件 22/22 零违例。
按用户要求**不改还原路径**（实例要靠它 `createInstance()` 重链）：记录打 `libraryMaster`
标记 → 导入端在 `completeImportSession` 收尾（所有页都重链完）时统一 `remove()`，
Figma 会保留已删除主组件的实例。结果计数同步扣掉这部分层数。

**验证**：0806 集 deep 430 → 75、paint 60 → 1、font 14 → 1、type 2 → 0；旧覆盖页 15 → 14
（逐条同一族，无新增）；带外部库两集与大文件集用 before/after 双跑对比，差异只有
"fallback 字体变真字体""圆角减少 1042""layoutGrow 从 0 变 5832""autoLayout 10708 → 32385
（实例子级现在继承模板的 layoutMode）"这些预期方向；`node --test` 23 过 2 挂，与 HEAD 完全相同。

**教训**：一次"样式全乱"的报告里往往叠着七个互不相关的 bug，硬看是看不出来的——**先按
属性路径分桶，再按页/子树分桶**，每个桶单独交叉制表。还有：一个只在新夹具上显形十几条的
字段（字体族），在别的夹具上可能是六位数的影响面，改完一定要回跑全部夹具的**汇总画像**
（族计数、字体族直方图），而不只是 diff 计数。

## 2026-08-05（夜二轮）— 用户在 Figma 上看到的差异：两个"看不见"的解析 bug

**方法变化**：上一轮靠比较器分桶。这轮用户直接给了新导入页的 Figma 链接，先 `get_screenshot`
看**渲染结果**，两个问题一眼可见：底部 tab bar 的"首页"那一格是空的；状态栏时间显示成 `1`
而不是 `9:41`。两个都能在比较器残差里对上号（`vectorNetwork presence 1` 和 `text 1`）——
**截图告诉你哪条残差是真问题**，比较器告诉你根因在哪条记录。

1. **看不见的图层**：`24:448 logo` 是 VECTOR 但 `geomHash` 为 null。hexdump 发现它的
   `1c 01` 对象是 `04 80 00 00 00 07 <32-hex>` —— geometry hash 前面多了一个 `04 <float>`
   （TEXT 对象里那个"未破义常量"同款），而 `mgReadVectorGeomHash` 第一句就是
   `if (bytes[off] !== 0x07) return null`。整条 vectorNetwork 丢掉 = 一个有填充、有尺寸、
   但什么都不画的图层。这类 bug **比较器只报一行 `vectorNetwork mg=null`，肉眼在 Figma 上
   才知道它是"整个图标不见了"**。

2. **多 run 文本被截成一段**：状态栏 `↳ Time` 的 `1c 08` 里有两个 run（`9:4` + `1`，按
   fractional index `a0` < `a1` 排序拼成 `9:41`）。run 1 的字体串拼写是 `06 00`（显式空），
   而解析器只认 `06 01 <string>`：不匹配就**既不消费也不报错**，`p` 停在 `06` 上，
   下一个 run 的 `01` 标签对不上 → 整个 `mgParseFontRuns` 返回 null → 回退到 legacy
   "第一个像样的 `02 <text> 00 03`" 路径 → 只剩 `1`。**"部分成功地失败"是最难查的一类：
   没有异常、没有空值，只是内容少了一半。** 修好后 styledTextSegments 也一并出来了。

3. **实例子级的 auto-layout 是覆盖值**：自证脚本（拿 zip 的 `24:696/X` 当组件记录 `X` 的
   基准）只剩 9 条差异，其中 `24:438` 的 fills/strokes/itemSpacing 是**真覆盖**——实例存
   gap 20 / padding 24，组件是 38 / 40。导入端 `applyInstanceChildOverrides` 只回放
   visible/opacity/characters/fills/strokes，于是 Figma 里 tab bar 用组件的 38/40 排版，
   五格宽 103.6 而不是基准的 124.4。Figma 允许覆盖实例子层的 auto-layout 间距，逐项
   try/catch 回放即可。

**新增的自证手法**：外部库组件树（235 条 EXTRA 记录）没有任何 zip 基准，但**实例子级记录
`24:696/X` 就是它的基准**——zip 里有，且内容等于组件子级经实例覆盖后的样子。拿两者对表，
差异要么是真 bug，要么是可解释的实例覆盖。9 条里 5 条是 auto-layout 重排宽度、3 条是覆盖、
1 条是已知的 POLYGON 圆角。

**结果**：text 1 → 0，vectorNetwork 1 → 0；deep 74 → 78（`↳ Time` 的字体名从 1 行变成
9 行——文本正确解析后多出两段 styledTextSegments，每段都带同一条 SFProText 拼写残差；
zip 报 `SFProText-Semibold`/Regular，我们报 `SFProText`/Semibold，按 zip 拼会把
`Roboto-Regular` 也整成 family，且两种拼法在 Figma 里都是缺失字体，视觉无差 —— 这笔交易
是"文本内容对了 + 分段出来了"换"同一节点的字体名多报 8 行"，明显划算）。
覆盖页 14 条不变；大文件/带外部库汇总画像只有预期方向的微移（Roboto 775→779）。

## 2026-08-05（夜三轮）— 组 370 的 auto-layout：一个 35 位守卫吃掉整条记录尾巴

**症状**：用户指出实例里的 `组 370` auto-layout 与 MasterGo 仍有差异。比较器上只剩一行
`24:696/24:438 .layout.primaryAxisSizingMode mg=AUTO zip=FIXED` —— 在 Figma 里就是那一行
tab bar 从"填满 750"变成"包裹内容"。

**根因链（三层，每层都是前一层的遮蔽）**：
1. hexdump 存根记录，看到 `19 80 c3 fc 87 b0 80 f4 80 06` —— override mask 是**九字节
   LEB128**（约 2^58）。`mgReadVarint` 的 `shift > 35` 守卫直接返回 NaN，标量 walk 一个
   `break` 走人，**后面的 `1a` templateRef、`1b` owner 全部静默消失**。存根因此从来没接上
   自己的模板。（顺带：大文件夹具修完多出 6 条记录 —— 那 6 条丢的是 `1b` owner，页可达性
   算不到它们。）float 累加还有个坑：即使放宽守卫，`result += (b&0x7f) * 2^shift` 在
   2^53 以上会把低位舍掉，而低位正是唯一被测试的部分 —— 改成低 32 位用整数位运算累加。
2. 接上模板后 `24:706` 的 clipsContent 对了，但 padding/itemSpacing 反而从 0 变成 10：
   实例壳那句 `meta = Object.assign({}, n.inheritedMeta, {...})` 是**整体采用组件 meta**，
   把实例自己写的显式零 padding 直接扔了。改成逐字段合并（复用 slash-id 存根那套
   `mgFillContainerMeta`）。
3. 合并之后缩放实例（`inst/scale-0.83x`）的 padding 和圆角又**被乘了两次** —— 因为原来
   走的是组件值（模板空间，需要乘缩放），现在走的是自己的值（已经是终值）。给合并加
   `__own*` 标记，只对借来的值乘 `layoutScale`。

**最后一步**：sizing 本身。交叉表显示存根 trailer 里 `21`/`22` 都不出现时，基准取的是
**模板的标记**（唯一一个这种状态的存根 = tab bar 那一行，基准 FIXED/AUTO = 模板的 `21-`；
两边都沉默的 20 条不受影响）。规则落地后该行归零。

**教训**：`break` 型的容错（"遇到不认识的就停"）在顺序解析器里是**静默截断**，不是安全网。
这条 mask 从 2026-07 就在，一直到用户指着一个 auto-layout 说"不对"才暴露 —— 因为它丢的是
**记录尾巴**，而尾巴上的字段（templateRef/owner）不产生错误值，只产生"少了点什么"。
下次加 varint 守卫，先问"这个上限是格式规定的还是我猜的"。

## 2026-08-05（夜四轮）— 圆形 865：不是解码问题，是两家渲染器对"蒙版"的定义不同

用户问"能不能顺便解决 圆形 865 的填充问题"。先查数据：mg 和 zip 两个包里这个节点的 fill
**逐字节相同**（同一个 GRADIENT_LINEAR、同一个 gradientTransform），effects 也都是空。
两边数据一样 ⇒ 差异不可能来自解码器。

翻它的 blend：`isMask: true` —— 两个包都这么说，而 zip 是 MasterGo 自家 API 出的，所以
MasterGo 确实把这个圆标成了蒙版。那么问题就变成：**同一份"带填充的蒙版"，MasterGo 画它，
Figma 不画。** Figma 的蒙版只贡献 alpha，蒙版图层本身不上色。

反证也很干净：本轮第一张截图（还没修 logo 的 vectorNetwork 时）里，首页那一格是**全白的**——
如果 Figma 会画蒙版填充，那儿应该是一个 76px 的蓝色圆。它不在。

修法只能在导入端，而且 Figma 里唯一忠实的构造是**复制**：给每个"有可见填充的蒙版"在它
**下方**插一个 `isMask=false` 的副本。蒙版继续裁上方兄弟，副本负责上色。放在
`completeImportSession` 收尾（所有实例都创建并按位匹配完覆盖之后）有三个好处：不影响还原
计数校验、不打乱 `applyInstanceChildOverrides` 的按位配对、给 COMPONENT 加的副本会自动
传播进实例（实例子级本身是锁的，加不进去）。夹具统计每次导入只有 2 个填充型蒙版，代价很小。

**教训**：用户报"某个图层不对"时，先问"两个包的数据一样吗"。一样 ⇒ 问题在导入端或渲染语义，
再怎么翻解码器都是白费；不一样 ⇒ 才轮到 hexdump。这次两分钟的数据比对省掉了一整轮逆向。

## 2026-08-05（夜五轮）— tab bar 还是 103.6：覆盖写进去了，只是写早了

上一轮加的"实例子级 gap/padding 覆盖回放"构建通过、代码路径也对，可 Figma 里五个 tab 依旧是
组件的 103.6 而不是实例的 124.4。从 Figma 读回实例子级坐标才看出来：x = 40 / 181.6 / 323.2…
正是组件的 padding 40 + gap 38，覆盖**一条都没生效**。

原因是顺序：`applyDeferredLayoutRestores()` 在**所有实例创建之后**才给组件侧补 auto-layout。
所以 `applyInstanceChildOverrides` 执行时，实例子级的 `layoutMode` 还是 `"NONE"`，我那句
`if (layoutMode !== "NONE")` 直接跳过；就算不加这个卫语句，给一个非 auto-layout 帧写
`itemSpacing` 也是静默无效。改成在覆盖阶段只**入队**，等 `applyDeferredLayoutRestores()` 跑完
再 `flushInstanceChildLayoutOverrides()` 统一写。

**教训**：这个导入器里"属性什么时候能写"和"属性该写什么"一样重要 —— auto-layout、字体、
实例重链接都各有各的延迟阶段。写了不报错 ≠ 写进去了；验证要看 Figma 里读回来的值，
不能只看比较器（比较器比的是包，包一直是对的）。

## 2026-08-05（夜五轮·附）— 两个 0.667px 的 y：已知残留，故意不修

`24:706/24:677 Border` y=0.667（zip 0）、`24:706/24:680 ↳ Time` y=0.7（zip 0）。根因：模板里
GROUP `Battery` 自己在 y=34、子级 Border 在 y=0.667（合计 34.667）；实例 stub 把 group 的 y
显式覆盖成**已归一化的** 34.667，子级却没写 y、于是从模板继承了 0.667 —— 两套坐标系混用，
多算 0.667。MasterGo 的 API 出的 zip 是归一化形态（group=children bbox、min 子偏移=0）。

要根治得在模板空间统一把 GROUP 归一化（group.y += minChildY，子级 -= minChildY）再做实例展开，
属于全局几何改动，而收益是 2 个节点上 0.667px / 0.7px 的偏移（画布上看不出来）。风险收益不成
比例，留作已知残留记录在此。

## 2026-08-05（夜六轮）— gap 还是 38：写进去 ≠ 留得住

上一轮把实例子级的 gap/padding 覆盖挪到延迟布局之后再写，用户重新导入，`组 370` 依然是
gap 38 / px 40（组件值）。代码确认已进 bundle，说明**写了但没留住**，或者写的时候还太早。

两个都说得通的原因：
1. 给**组件**写 `layoutMode` 会让 Figma 把组件的间距重新推给每一个实例，而这次推送发生在我
   那句同步赋值**之后** —— 覆盖被组件值悄悄盖回去；
2. `applyDeferredLayoutRestores` 对这个节点还没轮到（本次统计 registered 336 / applied 166），
   写的时候 `layoutMode` 还是 `NONE`，赋值本身就是空操作。

所以改成**跑两遍**：每页延迟布局之后跑一次（不清队列），会话收尾再跑一次（清队列）。两遍都只写
"和目标不等"的值，天然幂等。收尾那遍隔着一堆 await，Figma 的传播早就落定了。

同时把静默口子全堵上：赋值后**回读校验**，不等就打 `auto-layout override did not stick`；
抛异常打 `rejected`；还没轮到打 `deferred`。日志形如
`{"pass":"finalize","applied":5,"deferred":0,"rejected":0,"queued":37}`。

**教训**：Figma 插件 API 里"赋值成功"有三种失败形态 —— 抛异常、静默忽略、以及**先成功再被上游
传播盖掉**。只 try/catch 挡得住第一种。凡是写实例子级的属性，都要回读校验 + 在传播落定后重试。

## 2026-08-05（夜七轮）— 真凶：比较器测的包和插件跑的包不是同一个

诊断日志一次给出答案：`{"pass":"finalize","applied":0,"deferred":5,"rejected":0,"queued":10}`。
`rejected: 0` 排除了"Figma 不让写"；`applied: 0` 说明**根本没有值可写**。

根因在 `mgSlimInstanceDescendantProps`：插件 UI 用
`convertMgPackageToV2Entries(..., { slimInstanceDescendants: true })` 转换（不瘦身的话 Tesla
那种 455MB vectorNetwork 会把 Figma 标签页 OOM），而这个瘦身白名单的 `layout` 只留了
`x/y/width/height/relativeTransform/rotation` —— **itemSpacing/padding 全被扔掉**。于是覆盖匹配
器拿到的是 `undefined`，覆盖静默不发生。

**最毒的一点：`tools/compare_mg_import.js` 转换时不传 options，所以它测的是不瘦身的包。**
比较器 76 条残差里 auto-layout 参数是零差异 —— 包确实是对的，但插件跑的是另一个包。这个盲区
让我连着三轮在导入端找错地方（时序、传播、Figma 是否允许覆盖），全都不是。

修法：
- 白名单加回 5 个间距字段（每条记录 5 个数，OOM 风险为零），并抽成 `MG_SLIM_LAYOUT_KEYS`；
- code.ts 侧的 `INSTANCE_LAYOUT_OVERRIDE_KEYS` 与之互相注释指认；
- `tools/tests/mgPackage.test.js` 加一条单测：断言瘦身后**覆盖匹配器读的每个字段**都还在，
  同时断言 `vectorNetwork`/`strokeWeight` 仍被扔掉（瘦身没白瘦）。这是唯一能挡住这类回归的检查，
  因为比较器结构上就看不见。

**教训**：当"数据对、代码对、就是不生效"时，先确认**测试链路和生产链路用的是同一份数据**。这次
差异是一个 options 参数。另外，诊断日志要能区分"写失败"和"没值可写"——`applied/deferred/rejected`
三分法两分钟定位了三轮都没找到的问题。

## 2026-08-05（夜八轮）— 蒙版副本落错位：clone() 不在原地

标签栏的 auto-layout 全对了（24 / 168.4 / 312.8 / 457.2 / 601.6 × 124.4，与手调逐位一致），
但 `圆形 865` 比手调左了 14px。

`paintFilledMaskTwins` 里 `node.clone()` **默认把副本挂到 `figma.currentPage` 下**，随后
`parent.insertChild()` 把它搬进组时，x/y 这两个数不变、但重新按新父级解释；而且往 **GROUP** 里插
子节点还会连带重算整组的包围盒、把所有兄弟的相对坐标一起挪。两件事叠加，副本就落在别处。

修法一行：插入**之后**把副本的 `relativeTransform` 设成蒙版当前的 `relativeTransform` —— 那一刻
两者终于同父同坐标系，对齐是精确的；随后组包围盒收敛回去，两者一起平移，仍然重合。再加一句回读
校验（`twin did not land on its mask`），这一族静默失败以后不会再看不见。

**教训**：Figma 里"复制 + 换父级"从来不是原地操作。任何 clone→insertChild 之后都必须显式重设
坐标，并且要在**插入之后**读源节点的 transform（插入本身可能已经把源节点也挪了）。

## 2026-08-06（汇总集）— tag 26 不是"实例缩放"，是"环境缩放"

换了新回归集（`可同步测试集/插件测试 汇总.mg` + 同批 zip）后，deep-prop 残差从 76 炸到 **6067**。
不是回归——新文件里多了一个此前没有的场景：**整个 `首页普通版` 画板是从 750 宽缩到 404 的**
（404/750 = 0.538667）。

### 定位手法：先看比值，再看是谁的比值

`24:0441` 的 1331 条 vectorNetwork 残差里，`actual / expected` 是**恒定的 0.5386666655540466`。
恒定比值 = 乘错了一个系数，不是解码错了坐标。顺着这个系数回溯，`trailer.scaleFactor`（tag 26）
在这棵树的**每一个节点**上都是 0.538667——包括根框架自己，而根框架不是任何实例。

于是旧结论（"tag 26 = 实例缩放系数"）被证伪一半：它是**环境缩放**，只说"这条记录所在的坐标系
被缩过 S 倍"。节点自己写下的标量已经是最终值，乘它纯属自伤；它唯一的用途是给**借来的值**
（从另一个环境缩放的模板那里继承的值）换算。

三处连锁修正：
1. `mgNativeProps` 等 10 处的 `effScale || trailer.scaleFactor || 1` 兜底删掉，只认 `effScale`
   （6067 → 930）。
2. 合成实例子节点是把模板节点**整份键拷贝**过来的，trailer 也在内——它的 tag 26 是
   **组件内部**的环境缩放（`核心功能 2` 存 1.111），不是这个副本的。只有真实 override 记录的
   tag 26 才描述副本自己。加 `ownRecord` 闸门（930 → 639）。
3. `mgInheritFromTemplate` 是**就地填充** containerMeta 的，等 `mgNativeProps` 跑到时
   "自己的 corners" 和"从组件抄来的 corners" 已经无法分辨——而两者缩放规则相反。
   `mgFillContainerMeta` 现在给借来的字段盖 `cornersInherited` / `itemSpacingInherited` /
   `paddingsInherited` 戳（639 → 576）。

**教训**：一个恒定比值就是一个乘错的系数，值得单独当线索追。以及——**"就地修改"会销毁溯源信息**；
任何"自己的值 vs 继承的值"规则，都要求填充方留下戳记，不能靠事后从结果反推。

## 2026-08-06（汇总集）— 旋转要读矩阵的第一"列"

`预存电费送积分` 的矩阵是 `[[1,-0.141,x],[0,0.990,y]]`，我们报 −8.02°，基准报 0°；
`路径 1737` 的 `[[0.998,0,x],[-0.069,1,y]]`，我们报 0°，基准报 3.94°。两边正好相反。

`Math.atan2(m01, m00)` 读的是矩阵**第一行**。对纯旋转 `m01 == -m10`，两种读法同解，所以这个
错误藏了很久；**MasterGo 会存纯错切**（一个轴斜、另一个轴不动），错切一出现两种读法就分道扬镳。
Figma 的 rotation 是 x 轴像的方向，即**第一列**：`atan2(-m10, m00)`。抽成 `mgRotationFromMatrix`
一处定义，四处引用。transform 残差 69 → 33。

**教训**：矩阵分解的"约定等价"只在退化情形成立。验证一条矩阵公式时，必须找一个**非纯旋转**的
样本（错切/非等比缩放）才算验过。

## 2026-08-06（汇总集）— 又一次"未知 tag 吞掉整条记录"

同一个失败模式，一天之内撞见两次：

- **特效**：`11 01` 出现在 blur/shadow 记录尾部，字段走查判 `ok = false` → 整条特效被丢，
  40 个模糊（毛玻璃搜索框、背景光斑）在画布上直接消失。20/20 次出现都是 `11 01 18 …`，
  吃掉两字节正好落在循环本来就会 break 的 `18` 上——自洽性反过来证明了字段宽度。
- **图片填充**：paint 的 `0d` **不是单字节旗标，是"图像调整"子对象**（字段号是位掩码：
  1 对比度 / 2 曝光 / 4 饱和度 / 8 色相）。旗标读法能活一年，是因为没调整的图片写成 `0d 00`
  ——空对象，恰好也是两字节。第一张调过色的图片一来，游标就落进浮点载荷里，`return null`
  把**整个 paint** 扔了，三张照片导入后完全没有填充。

两次都靠同一套诊断：给解析器的失败分支挂日志，打印 `(记录 id, 触发 tag, 后续 16 字节)`，
再按 tag 直方图排序。哪条记录死在哪个字节上一目了然，比在十七万字节里翻要快两个数量级。

**教训**：`docs/MG_DECODER.md` 里 2026-07-12 已经写过"`0f` 的未知 tag 中断丢掉过整个特效表"，
这次同样的坑还是踩了两遍。**"未知 tag 就整条丢弃"是一个结构性缺陷，不是个别 bug**：
它把"解析器不认识"和"这不是一条这种记录"混成同一个动作。挂日志是廉价的常备手段，
每次接新回归集都值得先跑一遍失败分支直方图。

## 2026-08-06（汇总集，第二轮）— 38 个幽灵记录占住了 255 个真实节点的坑位

用户导入后反馈「还有些差异」。截图上四整块是空的/灰的：`容器 359`（找桩充电地图）、
`容器 537145`、`特色服务`、`容器 537143`。

### 定位：先问「包对不对」，再问「导入对不对」

把渲染出来的 Figma 树和**两个包**的记录逐节点比：`容器 359` 包里写 378.14 × **223.92**，
Figma 里是 378.14 × **60.17**。而 60.17 = 12.93 + 34.31 + 12.93 —— 正好是「只算 `容器 361`
一个子节点的 hug 高度」。所以不是尺寸解错了，是**内容少了**，框架 hug 到了残缺内容的高度。

回头看比较器一直报的 `Missing records: 255`。按实例根分组，255 条**全部**落在这四个实例下：
24:1830 ×103、24:1924 ×87、24:1802 ×36、24:1753 ×29。此前一直把 missing/extra 当成
「外部库 master 的预期差异」略过了——**extra 是预期的，missing 从来不是**。

### 根因：`03` 排序码的正则太松，撞出了幽灵记录

给实例展开的 walk 挂日志，看到它**确实**访问并要创建 `24:1924/24:1618`；但流水线各阶段探针
显示这个 id 在 `nodes` 里 `type=null, parent=24:1375`——它**早就存在**，walk 于是走了
"复用已有 override 记录"分支，而这条记录没有 type，发射阶段的 `subtreeOf` 一句
`if (!nodes[id].type) continue` 把它和整棵子树一起丢掉。

它的 `code` 字段是 `"\x03\x04\x01\x0524:1924/24:1618:6:3"`。十六进制一看就明白，文件里另有一张
**id 关联表**：

```
01 <id> 00  02 <id> 00  03 <01|03>  04 01  05 <id>:6:<n> 00  00
```

这里的 `03` 是**单字节枚举**，后面没有 `00`。节点记录扫描器的 `\x03([^\x00]+)\x00` 于是贪婪地
把 `01 04 01 05 24:1924/24:1618:6:1` 整串当成排序码吃了下去，凭空造出 38 条幽灵记录 ——
而每一条的"id"恰好就是某个实例子节点的克隆 id。

判别式很干净：**真排序码是可打印 ASCII**（base-95 键：`a0` / `a;` / `a P` / `a!`，长度 2–5），
幽灵码以控制字节 `01`/`03` 开头。把节点扫描器改成 `[\x20-\x7e]+`，`a!`/`a ` 仍然通过。
效果：missing 255 → **0**，index/child-order 也一并归零，记录数 1114 → 1369
（1369 − 242 外部库 master = 1127，与基准完全对齐）。

**教训**：
1. **`Missing records` 永远是硬缺陷**，不该和 `Extra records` 一起被"外部库 master 是预期的"
   这句话盖过去。这次它在报表里挂了整整一天。
2. **2026-08-05 把四个扫描器从 `[0-9A-Za-z]+` 放宽到 `[^\x00]+` 是过度放宽**。当时是为了收
   `a!`/`a ` 两个码，正确的放宽是"可打印 ASCII"而不是"除了 NUL 什么都行"。放宽一个正则时，
   要问的是**新语法的边界在哪**，不是"怎样最省事地让样本通过"。
3. 现象是"框架高度不对"，根因是"扫描器多认了 38 条记录"。**从渲染值反推到包，再从包反推到
   字节**，每一跳都要落到可验证的数字上（60.17 = 12.93+34.31+12.93 这一步是关键转折）。
