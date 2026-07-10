# MG_DECODER_UNKNOWN_FIELDS — `.mg` 未破解字段清单

对 `新文件.mg`(share/局部导出,2185 条记录)按语法区域统计每个 tag 的出现频次，
与 [`MG_DECODER.md`](MG_DECODER.md) 的已破解清单对照产生。已破解字段（约 60 个）见
`MG_DECODER.md` 正文；本文只收录**仍未破解或未利用**的部分，按出现频次排序，供下一轮
逆向按优先级挑选目标。统计方法与复现命令见文末。

## 节点标量区（名字与 `1c` 类型标签之间）

| tag | 出现频次 | 状态 | 备注 |
|---|---|---|---|
| `0x19` | ×1097 | 部分破解 | LEB128 字段存在/override 掩码；已顺序解析并用于一致性断言，剩余 bit 语义未全解 |
| `0x05` | ×163 | 部分 | 存在性已兼容跳过，取值 1/2/3 的语义未明（"形状 flag"） |

## 容器对象（`1c 07`，FRAME/COMPONENT/GROUP/BOOLEAN 等）

| tag | 出现频次 | 状态 | 备注 |
|---|---|---|---|
| `0x0f` | ×362 | 未破解 | 高频，解析时跳过 |
| `0x14` / `0x15` | ~50 | 已定位未解码 | component override 定义表；解开可替换旧 fixture 的按钮/卡片名字规则 hack |
| `0x04`（varint 版本戳） | ×12 | 未破解 | 组件对象的版本戳，义未明，跳过处理 |

## TEXT 对象（`1c 08`）头部

| tag | 出现频次 | 状态 | 备注 |
|---|---|---|---|
| `0x04` | — | 未破解 | 头部字段，义未明 |
| `0x05` | — | 未破解 | 头部字段，义未明 |
| `0x08 <b>` | — | 未破解 | run 列表与颜色 run 表之间的单字节字段 |
| 样式条目 `06/0b/13` | — | 未破解 | 2026-07-10 已破：`01`=decoration、`0c`=psName、`12`=styleName、`05` lineHeight `-1`=AUTO；`0e` 疑 letterSpacing 值（样本恒 -1=默认） |
| run 字形表（`05`/`07` 段） | — | 已定位未利用 | 每字形 x/y 零压缩浮点对 + `00`+LEB128 字形 id；仅顺序跳过，未参与还原 |

## VECTOR 对象（`1c 01`）

| tag | 出现频次 | 状态 | 备注 |
|---|---|---|---|
| `0x04`（浮点） | ×431 | 未破解 | 值恒为实例缩放系数（0.8406…），疑矢量级缩放系数副本，未利用但不缺属性 |

## 记录尾部（`1d 01` 之后）

| tag | 出现频次 | 状态 | 备注 |
|---|---|---|---|
| `0x1e` | ×1069 | 未破解 | 值恒为 `01`；与基准无任何属性差异对应，疑版本/脏标记类元数据，无还原价值 |
| `0x27` | ×1003 | 未破解 | 值恒为 `00`；同 `0x1e`，疑元数据 |
| `0x23`（样式 id 字符串） | ×1069 | 已识别未利用 | 指向样式库条目，做样式链接时才需要 |
| `0x2a`（tokens JSON） | 若干 | 已识别未利用 | 明文设计 token 绑定 |
| `0x25`（双子对象） | ×9 | 未破解 | 结构已知，字段语义未破 |
| `0x28` | ×6 | 未破解 | — |
| `0x3a` | ×6 | 未破解 | — |
| `0x33` | ×5 | 未破解 | — |
| `0x32` / `0x34` / `0x36` | ×2 each | 未破解 | — |
| `0x37` / `0x35` | ×1 each | 未破解 | — |

## 其它零散未破解点

| 位置 | 状态 | 备注 |
|---|---|---|
| paint 记录字段 `07` / `0c` / `0d` | 未破解 | 尾部 flag，解析时跳过，无对应基准差异 |
| effect 记录字段 `0d` / `0e` | 未破解 | 尾部 flag，跳过无碍 |
| 几何 blob 顶点 flag `03` 的取值 1/2/3 | 未破解 | VN 主体已全解，边角语义未明 |
| 几何 blob `06` trailer | 未破解 | — |
| 容器对齐枚举 `0d/0e` 的 MAX/SPACE_BETWEEN 取值 | 猜测未验证 | 当前猜 3/4，无样本验证 |
| 页记录尾巴 `09 01 00 04 80 10` | 未破解 | 跳过处理 |
| 文件头 magic（`document` 前 9 字节） | 未破解 | 跳过处理 |
| 原生 instance override 表（`1c 07` 子字段 `15`） | 已定位未解码 | 解开可替换旧版按钮/卡片名字规则 hack（同容器 `0x14/0x15`） |
| star/polygon 的 `pointCount` / `innerRadius` | 未破解 | 仍用类型默认值兜底 |
| exportSettings | 结构性缺口 | 节点记录里不存在，只能靠嵌入 JSON 孪生记录（完整导出才有） |

## 已知残差对应的字段线索（来自实测 deep-diff，非纯字节统计）

以下不是单个 tag，而是**已知有还原差异、但尚未定位具体字节**的功能点，记录方便对照：

- 空 Boolean 叶在嵌套 UNION 中的 1×1 fallback 原点仍与 Figma 基准不同；现有标量、模板 slot
  与 operand bounds 都不足以推导，可能来自容器 `0x15` typed override 或宿主 Boolean 引擎。
- `WIDTH_AND_HEIGHT` 文本的最终盒尺寸由 Figma 的 Montserrat 字体 shaping 决定，Node 包对比器不应
  伪造字体度量；需要继续以 Figma 运行时复核其派生 GROUP/FRAME bounds。

## 统计口径与复现

- 统计对象：`新文件.mg`（2026-07-09 share/局部导出样本，2185 条记录，无嵌入 JSON）。
- 方法：按 `mgWalkScalarFields` / `mgParseContainerMeta` / `mgParseTrailer` 同款语法顺序步进，
  统计每个 tag 出现次数；93.7% 的记录标量区能从头走到尾（137 次中断多为空记录或浮点载荷撞
  tag，非真实未知字段）。
- 复现：临时脚本已清出仓库，思路是 vm sandbox 加载 `ReceiveFromMasterGo/src/ui/mgPackage.js`
  内部函数、逐 tag 计数，可参照 `MG_DECODER_JOURNAL.md` 「已知答案攻击」一节的脚手架重建。
- 结论摘要：结构、可见性、paint/effect、文本内容/字体、vectorNetwork、实例叶裁剪和绝大部分
  几何/变换已对齐。未破解的 ~20 类字段里，高频 `0x1e`/`0x27` 基本确定是无视觉意义的元数据；
  真正可能继续影响视觉的是 `0x19` 剩余 bit、容器 override 表 `0x14/0x15`，以及宿主运行时的
  字体/Boolean 派生布局。

## Mirror

字段规格权威见 [`MG_DECODER.md`](MG_DECODER.md)；逆向方法论与踩坑史见
[`MG_DECODER_JOURNAL.md`](MG_DECODER_JOURNAL.md)。本文只是前两者「未破解部分」的速查表，
有新突破时把对应行从本文划掉、挪进 `MG_DECODER.md` 正文。
# Newly constrained by the 2026-07 parity fixture

- `0x19` is a scalar field-presence/override mask. Its Boolean-leaf bit is a
  useful format consistency check, but semantic detection remains based on the
  raw VECTOR record and BOOLEAN_OPERATION template slot.
- Instance container field `0x15` remains the next required source for typed
  visibility and paint overrides. Do not treat an omitted scalar visibility
  field as explicit false; template inheritance alone loses variant state.
- Gradient object subfield `0x0a/0x06/0x03` is solved: it is an axis-scale
  coefficient, with Figma ratio `2 × |p1 − p0| / scalar`. It is no longer an
  unknown-field candidate.
