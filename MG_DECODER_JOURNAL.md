# MG_DECODER_JOURNAL — `.mg` 原生二进制逆向工作日志

本文记录逆向 MasterGo `.mg` 原生格式的**过程与方法论**——为什么这么做、踩了什么坑、用什么手段破解。
字段级的二进制规格是 [`MG_DECODER.md`](MG_DECODER.md)(活文档,权威);本文是它的“怎么得到的”背面。
未来继续逆向剩余缺口(effects / instance override / TEXT 分段)时,先读本文的方法论再动手。

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
