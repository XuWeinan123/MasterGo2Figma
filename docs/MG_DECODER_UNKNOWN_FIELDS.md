# MG_DECODER_UNKNOWN_FIELDS — `.mg` 未破解字段清单

对 `新文件.mg`(share/局部导出,2185 条记录)按语法区域统计每个 tag 的出现频次，
与 [`MG_DECODER.md`](MG_DECODER.md) 的已破解清单对照产生。已破解字段（约 60 个）见
`MG_DECODER.md` 正文；本文只收录**仍未破解或未利用**的部分，按出现频次排序，供下一轮
逆向按优先级挑选目标。统计方法与复现命令见文末。

## 节点标量区（名字与 `1c` 类型标签之间）

| tag | 出现频次 | 状态 | 备注 |
|---|---|---|---|
| `0x19` | ×1097 | 部分破解（2026-07-12 增补三位） | LEB128 字段存在/override 掩码。已破解位：`0x1`=文本字符已覆盖（名字跟随新字符）、`0x4`=share 浅记录可见性默认、`0x80`=share FRAME 布尔槽平移继承、`0x4000`=布尔叶（省略轴恒 0，不继承模板 x/y）、`0x40000`=描边粗细已覆盖（无此位时存根显式 `10 00` 是填充值，继承模板；0712-1 8 例 + 0711-3 49 例零违例）、`0x20000`=描边 paint 已覆盖（share 证据）。`0x10000` 疑 fill/paint 覆盖位（0712-1 换色实例全带），另兼作"保留模板手动名"信号（无 0x1 时）——autoRename 真位未定位。其余 bit 未解 |
| `0x05` | ×163 | **已破解（2026-07-12）：TEXT 名字手动锁** | `05 01`=保留 04 层名，`05 00`/缺失=autoRename（名=字符折叠）；三集交叉表零违例，stub 从槽位继承锁位。非 TEXT 记录上的取值 2/3 语义仍未明 |

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
| 样式条目 `06/0b` | — | **已破解（2026-07-11）** | `06 01`=行高单位 PIXELS 旗标、`0b 01`=字距单位 PIXELS 旗标（缺省=PERCENT/AUTO）；`08 <f>`=字距值。两组 142 项 unit-only 残差被 `0b` 消掉——"无区分位"旧结论作废 |
| 样式条目 `0e` | — | **证伪：不是 letterSpacing** | 插件测试.mg 的 `0e` 有 10–134 实值但基准 letterSpacing 全为 `{0,PERCENT}`；0710-2 恒 -1。真正的字距在 `08`（值）+ `0b`（单位） |
| 样式条目 `13` | — | 已定位未利用 | `{02 <varint> 06 <varint>}` 子对象,跨文件字节相同,疑时间戳类元数据 |
| 样式条目 `0f` | — | 已定位未利用 | 32-hex 字符串（字体文件 hash？share 完整条目专属,0710-2 条目无此字段） |
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
| `0x23`（样式 id 字符串） | ×1069 | 部分利用（2026-07-12） | 样式库已破解并还原（见 MG_DECODER.md「Library styles」：样式定义=02 槽位带类别前缀名的具名记录，fill/effect/text 引用经 tag 15/16/17 与 run 级 `03`）；trailer 0x23 本身的引用场景仍未接线 |
| `0x2a`（tokens JSON） | 若干 | 已识别未利用 | 明文设计 token 绑定 |
| `0x25`（双子对象） | ×9 | 未破解 | 结构已知，字段语义未破 |
| `0x28` | ×6 | 未破解 | — |
| `0x3a` | ×6 | 未破解 | — |
| `0x33` | ×5 | 未破解 | — |
| `0x32` / `0x34` / `0x36` | ×2 each | 未破解 | — |
| `0x37` / `0x35` | ×1 each | 未破解 | — |

## 0711-3(完整导出"显式零"形态)新增字段

| 位置 | 状态 | 备注 |
|---|---|---|
| 标量 `0x06` | 已消费未破义 | 单字节 0/1(×55k/9k),含义未明;不消费会断掉 58k 记录的标量区 |
| 容器 `0x0b` / `0x0c` | 已消费未破义 | 单字节,值多为 01;跳过以保证 0d/0e/17 可达 |
| 容器 `0x0f <cstring>` | 已消费未破义 | 指向 0: 前缀节点 id(×10885),实例存根上为空串;疑"同源/复制自"引用 |
| 容器 `0x10` | 已消费未破义 | 单字节 |
| 样式条目 `0x02 <varint>` | 已消费未破义 | 时间戳/版本类(同 `13` 子对象家族) |
| 样式条目 `0x07` | 已消费未破义 | 单字节 |
| 样式条目 `0x0f` | **已破解役割(2026-07-11)** | 32-hex 字体文件 hash;标记 per-node"计算型"条目(存已缩放终值+已解析行盒),无 `06 01` 旗标即行高 AUTO |
| paint 子记录前导 `0x04` | 已消费未破义 | 单字节;不消费整条 paint 被弃 |
| 尾部无 `1d 01` 直排拼写 | **已破解(2026-07-11)** | 尾部字段可直接跟在 `1c` 对象后;用容器结束偏移锚定解析,见 MG_DECODER.md |
| 实例 override 表(`06 01 15`) | 仍未破解,**权重上升** | 0711-3 的字体覆盖 43+39、图片覆盖 58、7 个框架化 GROUP 的判别信息都只能在这里;下一轮首选目标 |

## 其它零散未破解点

| 位置 | 状态 | 备注 |
|---|---|---|
| paint 记录字段 `07` / `0c` / `0d` | 未破解 | 尾部 flag，解析时跳过，无对应基准差异 |
| effect 记录字段 `0d` / `0e` | 未破解 | 尾部 flag，跳过无碍 |
| 几何 blob 顶点 flag `03` 的取值 1/2/3 | 未破解 | VN 主体已全解，边角语义未明 |
| 几何 blob `06` trailer | 未破解 | — |
| 容器对齐枚举 `0d/0e` 的 MAX/SPACE_BETWEEN 取值 | **已验证（2026-07-12，0712-3）** | 1=MAX 实测（`0e 01`）；3=MAX/4=SPACE_BETWEEN 旧猜保留并存 |
| 页记录尾巴 `09 01 00 04 80 10` | 未破解 | 跳过处理 |
| 文件头 magic（`document` 前 9 字节） | 未破解 | 跳过处理 |
| 原生 instance override 表（`1c 07` 子字段 `15`） | 已定位未解码 | 解开可替换旧版按钮/卡片名字规则 hack（同容器 `0x14/0x15`） |
| star/polygon 的 `pointCount` / `innerRadius` | **已破解（2026-07-12，0712-3）** | `1c 05`/`1c 06` 字段 `01`=zigzag varint pointCount（省略=多边形 3/星形 5），星形字段 `02`=innerRadius 浮点（省略=0.5） |
| exportSettings | 结构性缺口 | 节点记录里不存在，只能靠嵌入 JSON 孪生记录（完整导出才有） |
| 幽灵原生记录 `2:30xxx`（0711-2 样本） | **已破解（2026-07-11）：非画布注册表残留记录，组装前统一剔除** | body=`07 01 08 <模板节点id> 00 0b {01 varint300 …} 0d {01 13}`，无名字/owner/类型对象/尾部；判别式=标量 `08` 槽位携带 id 字符串（节点语法不可能），`mgIsRegistryResidueRecord` 在 `mgDecodeNativeNodes` 里先于类型判定 skip（含曾被弱扫描误判 LINE 的 `2:30073`）；五集交叉表 131/0/0/0/0 命中、与基准零交集。确切角色仍未知（疑标注/交互类辅助对象），但已无还原影响，见 `MG_DECODER.md`「Registry-residue records」 |

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
- Instance container field `0x15` is no longer the required override source for
  FULL exports: those deliver per-instance visibility/paint/characters overrides
  as bare-id mirror record trees (cracked 2026-07-12, see `MG_DECODER.md`
  「Mirror-tree overrides」; lookup is dual-key — templateRef may be the
  COMPONENT id for nested-instance slots, and an omitted mirror `07` byte means
  visible). `0x15` remains relevant for share-export typed overrides. Do not
  treat an omitted scalar visibility field as explicit false.
- Import-side (not a package field): rescaled-instance text boxes in Figma drift
  up to 1px from the scaled position when `fract(S·lineHeight) > 0.5` (Figma
  hug quirk); the importer pins instance text children to `textAutoResize=NONE`
  — remaining box-only residual `(ceil(S·lh)−S·lh)/2` < 0.5px is unreachable
  (instance-child geometry is API-locked).
- Gradient object subfield `0x0a/0x06/0x03` is solved: it is an axis-scale
  coefficient, with Figma ratio `2 × |p1 − p0| / scalar`. It is no longer an
  unknown-field candidate.
