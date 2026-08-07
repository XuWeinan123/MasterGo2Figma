# MG / ZIP 导入一致性状态

最后更新：2026-08-06（汇总集换代：环境缩放 tag 26 语义翻案 + 旋转矩阵列 + 特效/图片填充的未知 tag 吞记录）

## 2026-08-06 可同步测试集「插件测试 汇总」（当前主回归集）

用户更新了测试集与同批基准 zip。新文件带来一个此前没有的场景：**整个 `首页普通版` 画板从
750 宽缩到 404**（404/750 = 0.538667），把 tag 26 的旧解读打穿。

| 集 | MG 文件 | 记录数 | 导出形态 | 状态 |
|---|---|---|---|---|
| `可同步测试集` | `插件测试 汇总.mg` | 1369（= 基准 1127 + 242 条外部库 master） | 编辑器全量导出 + 内嵌外部库组件集 | **missing 255 → 0**、index/child-order → 0、effect **40 → 0**；deep-prop 6067 → 1440（记录集补齐后 255 条新记录带进约 900 行既有可接受族） |

**记录集已完全对齐**：`Actual 1369 − Extra 242（外部库 master，预期）= 1127 = Expected`。
`Missing` 归零意味着不再有整棵子树丢失——这是本轮最重要的一项，见下面第 6 条。

```bash
node tools/compare_mg_import.js "可同步测试集/插件测试 汇总.mg" \
  "可同步测试集/mastergo2figma-partial-pages-2026-08-06T10-27-59-527Z.zip"
```

本轮五处修复（规格见 `MG_DECODER.md`，破解过程见 `MG_DECODER_JOURNAL.md` 2026-08-06 三节）：

1. **trailer tag 26 是"环境缩放"不是"实例缩放"**（6067 → 930）。它出现在普通节点上，只说明
   "这条记录所在坐标系被缩过 S 倍"；节点自己写的标量已是终值，乘它等于自伤。`mgNativeProps`
   等 10 处的 `effScale || trailer.scaleFactor || 1` 兜底删掉，只认 `effScale`。此前整棵树的
   vectorNetwork、默认 strokeWeight、模糊半径都被额外乘了 0.539。
2. **合成实例子节点的 trailer 是模板的**（930 → 639）。整份键拷贝把模板的 tag 26（组件内部
   环境，`核心功能 2` 存 1.111）也带了过来。只有真实 override 记录的 tag 26 描述副本自己。
3. **`mgFillContainerMeta` 现在给借来的字段盖戳**（639 → 576）。`mgInheritFromTemplate` 是就地
   填充的，到 `mgNativeProps` 时"自己的 corners"和"抄来的 corners"已不可分辨，而两者缩放规则相反。
4. **旋转读矩阵第一列**：`atan2(-m10, m00)`（transform 69 → 33）。第一行读法只对纯旋转成立，
   MasterGo 会存纯错切。
5. **两处"未知 tag 吞掉整条记录"**：特效的 `11 01`（40 个模糊消失，effect 40 → 0）、
   paint 的 `0d` 其实是图像调整子对象（三张调过色的照片完全没有填充）。

6. **38 条幽灵记录占住了 255 个真实节点的坑位**（missing 255 → 0）。节点扫描器的
   `\x03([^\x00]+)\x00` 把另一张 **id 关联表**（其 `03` 是单字节枚举，后面没有 `00`）的
   `…:6:1` 尾串当成了排序码，凭空造出 38 条无 type 的记录，而每条的 id 恰好是某个实例子节点
   的克隆 id；展开时复用了幽灵，发射时 `subtreeOf` 的 `!type` 闸门把它和整棵子树一起丢弃。
   排序码收紧为 `[\x20-\x7e]+`（可打印 ASCII，`a!`/`a ` 仍通过）。**画布表现**：
   `容器 359`（找桩充电地图）、`容器 537145`、`特色服务`、`容器 537143` 四整块此前是空的，
   框架 hug 到了残缺内容的高度（223.92 → 60.17 等）。

**剩余 1440 条 deep 残差的分布**（均为已归类的可接受差异或已知缺口；补齐 255 条记录后
既有族按比例放大）：

- **585 条几何**（x/y/width/height/relativeTransform）：多数是实例子级——Figma 端是真
  InstanceNode，几何由 Figma 的 auto-layout 自己解，比较器可见、画布不可见；其余是文字盒的
  亚像素差（基准的盒子来自实时字体排版，取整成 8/17/27，我们按模板 × 缩放算）。
- **479 条字体**：大部分是基准侧 artifact——实例内未被覆盖的文字，MasterGo API 返回 Figma
  默认样式（12 / Source Han Sans / Regular / PERCENT / AUTO），我们给的是真实模板值；
  少量是显示名拼写（`AlibabaPuHuiTi` vs `Alibaba PuHuiTi`、`Bold` vs `粗体`）——
  **显示名不在 `.mg` 里**，只存 PostScript 名，无法推导。导入端 `fontLoader` 的归一化匹配
  已经把空格/连字符抹平，所以 family 一侧不影响加载。
- **248 条 = 62 个节点 × 4 个 SVG-fallback 字段**（`svgMarkup` / `svgFallback` /
  `receiveCreateOverride` / `vectorFallback`）。zip 导出器判定这些矢量的 region 无法回放，
  改发 SVG；`.mg` 侧没有这个信息，我们发真 vectorNetwork。**唯一可能真的更差的一块**——
  若某个矢量确实靠 region fallback 才对，我们会渲染错，需要在 Figma 里逐个核对。
- **53 条 VECTOR 节点级 cornerRadius**（顶点半径逐条正确，渲染不受影响）。
- **34 条 `layoutAlign = STRETCH`**：来源字节未定位，见
  `MG_DECODER_UNKNOWN_FIELDS.md`（trailer / 显式尺寸 / layoutGrow / 父 layoutMode 四维交叉表
  均无分离度）。
- 13 条 paint `blendMode` PASS_THROUGH vs NORMAL（Figma 对 paint 两者同义）、28 条零散。

## 2026-08-05 可同步测试集（上一代基准对）

| 集 | MG 文件 | 记录数 | 导出形态 | 状态 |
|---|---|---|---|---|
| `可同步测试集` | `插件测试 汇总.mg` | 681（2 页：覆盖集 344 + 真实页 0806） | 编辑器全量导出 + 内嵌外部库组件集 | deep-prop **430 → 76**（0806 页 415 → 62，覆盖页 15 → 14 既有）；type/parent/index/child-order/effect/text/vectorNetwork 全 0；paint 60 → 1；font 14 → 1 |

```bash
node tools/compare_mg_import.js "可同步测试集/插件测试 汇总.mg" \
  "可同步测试集/mastergo2figma-partial-pages-2026-08-06T02-34-51-120Z.zip"
```

本轮修的字段族（规格见 `MG_DECODER.md`「Library-master copies & instance-child inheritance」）：
paint 的 `08` alpha 被默认 1 的 `09` 覆盖（51 个半透明填充/描边被压成不透明）、tag 17
"无 effects ⇒ 圆角 10" 的历史 hack（29 个直角节点被凭空加圆角）、blendMode `0xff`=NORMAL、
sort code 非字母数字导致注册表记录整条丢失、字体族取 PostScript 名而非显示名、外部库 master
识别（容器 `07 03`）、slash-id 即模板链、容器 meta 逐字段继承、trailer `20`=layoutGrow。

**第二轮（按用户在 Figma 上看到的实际差异）**：VECTOR 的 geometry hash 可以躲在 `04 <float>`
后面（`1c 01 04 <f> 07 <hash>`）——不跳过就整条 vectorNetwork 丢失，画布上是一个**看不见的图层**
（tab bar 的 `logo`，也就是首页那一格空白）；font run 的空字体串拼写 `06 00` 未消费，导致多 run
解析整体回退到 legacy 单串路径——状态栏 `9:4` + `1` 两个 run 只剩 `1`（时间显示成 "1"）；
实例子级的 auto-layout gap/padding 是**覆盖值**不是组件值（tab bar 存 20/24 vs 组件 38/40），
`applyInstanceChildOverrides` 现在逐项回放。

**第三轮（组 370 的 auto-layout）**：标量 `19` override mask 在带库导出里是**九字节 LEB128**，
`mgReadVarint` 的 35 位守卫返回 NaN → 标量 walk 在那里断掉 → 后面的 `1a` templateRef、
`1b` owner 全部静默丢失（大文件夹具因此少了 6 条记录的页可达性）；实例壳对组件 meta 是
**逐字段合并**不是整体采用（整体采用会把实例自己的显式零 padding 吃掉，变回默认 10），
且要记住哪边来的——自己的值是终值，借来的才乘实例缩放（否则缩放实例的 padding 会被乘两次）；
存根的 trailer 若 `21`/`22` 都不提，就是"没覆盖 sizing"，用组件的标记（tab bar 那一行
因此从 hug 变回 FIXED 750）。

**填充型蒙版（导入端语义差，非解码差）**：MasterGo 会**画出**蒙版图层自身的填充，Figma 的
蒙版只提供 alpha —— tab bar 那个渐变圆 `圆形 865` 在 mg 和 zip 两个包里都是 `isMask: true`，
所以两边导入都看不到它。`paintFilledMaskTwins` 在会话收尾时给每个"有可见填充的蒙版"在**它下方**
插一个非蒙版副本：蒙版继续裁剪上方兄弟，副本负责上色。跑在所有实例创建并按位匹配完覆盖之后，
所以给 COMPONENT 加的副本会自动传播进实例。本集统计：每次导入 2 个填充型蒙版。

**剩余 76 条 deep 残差的分布**：14 条属旧覆盖页的既有族（与本轮无关，改动前后逐条相同）；
约 36 条是 `24:696/*` 实例子级的 x/width —— MasterGo 侧 auto-layout 重排后的物化值，
Figma 端该实例是**真 InstanceNode**（`mainComponentId` 重链），子级几何由 Figma 自己解，
比较器可见但画布不可见（gap/padding 覆盖回放后结果一致）；12 条是 zip 导出器独有的 SVG
fallback 字段（`svgMarkup` / `vectorFallback`，`.mg` 侧无来源）；9 条是 `↳ Time` 的
SFProText 字体名拼写（zip 报 `SFProText-Semibold`/Regular，我们报 `SFProText`/Semibold ——
按 zip 拼会把 `Roboto-Regular` 也整成 family，且两种拼法在 Figma 里都是缺失字体，视觉无差）；
4 条 VECTOR/POLYGON 节点级 cornerRadius（顶点半径已正确，渲染不受影响）；
2 条亚像素 y。

**外部库 master**：`标签栏` COMPONENT_SET（235 条记录）在 `Extra records` 里是**预期的** ——
它必须被还原，实例才能 `createInstance()` 重链；导入端在 `completeImportSession` 收尾时
调用 `removeLibraryMasterNodes()` 删除，Figma 画布上看不到它（Figma 会保留已删除主组件的实例）。

## 2026-08-05 大文件设计系统（新增基准）

| 集 | MG 文件 | 记录数 | 导出形态 | 状态 |
|---|---|---|---|---|
| `测试集/大文件` | `测试集 0804.mg` | 205,005 层/69 页 | **库文档自身的编辑器全量导出**（34.6MB，200,903 条原生记录，冒号 token 页面表，含 12 个外来离画布 master） | 69 页逐页「发射 ≥ 可达」零缺口；按钮页 1818/1818（button/button-group COMPONENT_SET 完整） |

该集没有 zip 基准（只提供了 .mg），验证方式为解码侧自证：逐页对比
「页可达节点数」（parent 链上溯到页 id 的 typed 记录数）与实际发射数，再抽查关键组件树。
share 判定规则见 `docs/MG_DECODER.md`「Share-mode discriminator」（sort-code 信号）与
JOURNAL 2026-08-05（下）条。**特斯拉夹具已由用户删除退役**，回归矩阵改为本表三组。

## 2026-08-05 带外部库测试集（基准对）

| 集 | MG 文件 | 记录数 | 导出形态 | 状态 |
|---|---|---|---|---|
| `测试集/带外部库测试` | `测试集 0804_1_32.mg` | 997/997 | **编辑器导出 + 内嵌外部库**（28MB，195k 条原生记录，冒号 token 方言） | 对照组逐字段 **0 diff**（0.015 容差） |

基准不是 SendToFigma zip，而是 `测试集 0804_1_32 手动复制对照组.mg`（同内容手动复制进
干净文件，MasterGo 物化显示名/值）——两文件 id 空间不同，用位置配对树比较
（根按 x,y 排序、子级按 type|name|round(x,y) 键配对，根级差全局画布偏移）。可接受残差：
9 条源文件本身的 0.5px 坐标差（复制取整）、18 条 orig 比对照组多解析出的中英混排
styledTextSegments（更优）、1 条被 segments 覆盖的节点级 fontName。修复明细见
`docs/MG_DECODER.md`「Library-bearing editor export form」与 JOURNAL 2026-08-05 条。
回归：0712 转换字节一致；特斯拉仅 2 条 "20º" live-font 残差闭合（Inter/22 猜测值 →
Montserrat Light/50 真值）；`node --test` 23 过 2 挂与 HEAD 相同（存量失败）。

## 当前基准（四个测试集）

| 集 | MG 文件 | 记录数 | 导出形态 | 状态 |
|---|---|---|---|---|
| `测试集/0` | `插件测试.mg` | 191/191 | share（194 component-root 标记） | **全类别 0** |
| `测试集/1` | `测试集 0710-1.mg` | —/— | share（62 标记） | 45 geometry / 32 transform / 157 deep（既有运行时派生族） |
| `测试集/2` | `测试集 0710-2.mg` | 1357/1357 | **完整导出**（0 标记，无 share 模式） | 7 geometry / **9 deep**（同一运行时派生族，见下） |
| `测试集/0711-1` | `测试集 0711-1.mg` | 23/23 | share | 除 `0:50 Subtract` 宽高（1 geometry / 2 deep，布尔结果盒族）外全 0 |

比较命令（每集）：

```bash
node tools/compare_mg_import.js 测试集/<i>/<file>.mg 测试集/<i>/<baseline>.zip --json
```

任何解码改动必须四集全跑：目标集改善、其余集 diff **逐条 byte-identical**（不只是计数相同）。
本轮实测方法：worktree 取 HEAD 双跑 `--json`，按 JSON 行做集合差 —— added 必须为 0，
removed 必须全部属于本轮目标字段。

## 本轮（2026-07-11 letterSpacing + 渐变视觉真值 pass）修复

1. **letterSpacing 破解**（样式条目 `08`/`0b`，另 `06` = 行高单位旗标）：
   `08 <f>` = 字距值（负值=压缩字距）、`0b 01` = 单位 PIXELS（缺省=PERCENT）。
   测试集/1 与 /2 各消掉 142 条 unit-only 残差（上一轮"字节级无区分位"的结论被
   `0b` 推翻）；0711-1 的 4px 字距样本逐值命中。
2. **渐变 ratio 视觉真值翻案**：ZIP 基准对该字段**不是 ground truth** ——
   MasterGo 插件 API 的 transform 用折叠值 `min(r, 2|major|/r)` 构建，与自家渲染器在
   `r² > 2|major|` 时不一致且不可逆（Tesla 车身截图实锤，见 `MG_DECODER.md`）。
   - 裸 `03`：scalar 直存 ratio（不再 min()）。
   - 扩展 `06` 子对象：`{scalar, field06/scalar}` 分支对取**较大者**（同一设计两次
     导出存相反分支：0710-2 存 0.4117 除法得真值、0711-1 直存 3.5696）。
   - 比较器新增 `foldGradientTransform` 归一化：已知导出端折叠不再误报 decoder 回归。
   - SendToFigma：优先信运行时可能提供的真实第 3 个 handle（typings 只声明 2 个）。
   - **zip 侧径向渐变已修（当日晚，SVG 自证）**：导出端对含径向渐变的节点做
     `exportAsync(SVG)`，从渲染器输出的 `<radialGradient gradientTransform>` 反推真
     ratio（`enrichRadialGradientTruth` + `serializers/svgGradientTruth.ts`），绕开 API
     折叠；**需重新导出 zip 生效**。ratio 对 viewBox 平移/统一缩放不变；按 stops 匹配
     paint；门槛子树 ≤40 节点、SVG ≤2MB，失败静默回退。角向/菱形无 SVG 等价物，
     仍为折叠近似。测试 `svgGradientTruth.test.js` 4 项（合成 Tesla 用例 + 跨插件
     transform 一致性断言）。**第一次重导出实测翻车**：MasterGo 的 SVG 导出器把
     半径写反槽位（沿轴/垂直互换），产出第三个错误值 0.2006；已改为双候选读取 +
     「沿轴半径==|p1−p0|」不变量仲裁（两节点实测命中真值），需**再次重导出** zip。
3. **SECTION 恒 FIXED/FIXED**（trailer 21/22 对 SECTION 无意义）。

## 2026-07-11 大文件修复（特斯拉 Model 3 车载系统）

- 无斜杠 Boolean 槽位覆盖记录（VECTOR 仍带子）改判 BOOLEAN_OPERATION 走布尔树，
  修复 5779/5643 还原计数崩溃；四回归集零触发。
- `mgFindTemplateRoot` 名字门槛前置，转换从二次方降为线性（大文件分钟级→秒级）。

## 剩余项（有意不修，运行时派生族）

- 测试集/2 的 9 deep + 7 geometry 与 0711-1 的 Subtract 宽高同族：2 Group / 2 Subtract
  （布尔结果盒需路径求值，.mg 存 MasterGo 自身包围盒）、3 connector waypoints ±1px、
  文本派生尺寸。Figma 导入时 figma.subtract / 实时字体会自行重算。
- 测试集/1 的 45/32/157：文档已记录的 live-font / Boolean 运行时派生族。

## 历史

- 2026-07-10 测试集 2 全量导出 pass：几何 blob 零压缩浮点、MD5("") 空 blob、
  扩展渐变 `06` 解析（除法规则本轮已被 max() 取代）、absent-`0a` padding 缺省。
- 2026-07-10 文本/渐变 pass（插件测试.mg 全类别归零）：样式表 `0c/12`、decoration、
  lineHeight `-1=AUTO`、font-run 列表、渐变裸 `03` ratio min() 规则（本轮已改直存）、
  零宽细线、按钮实例居中平移。
- 更早（1388 记录旧 fixture,文件已删）：顺序标量解析、`_mg` 页名后缀、Boolean 叶裁剪、
  实例可见性/浅 transform、radial axis-scale、GROUP 重算、quarter-stroke Boolean、
  v2 包校验和回滚。

## 验证

- `node --test tools/tests/*.test.js`：25 项通过。
- `ReceiveFromMasterGo` / `SendToFigma` `npm run build`：均通过（`ui.html` 由构建生成）。
- 四集 comparator：集 0 全零；集 1/2 严格差集 added=0、removed 全为 letterSpacing；
  0711-1 仅剩 Subtract 族。

## 比较器盲区（务必知道）

`tools/compare_mg_import.js` 调 `convertMgPackageToV2Entries(entries, name)` **不传 options**，
而插件 UI 传 `{ slimInstanceDescendants: true }`。所以比较器测的是**不瘦身**的包，
`mgSlimInstanceDescendantProps` 的白名单回归它一条都看不见 —— 2026-08-05 就是这样让实例子级的
auto-layout 覆盖静默失效了三轮。白名单必须覆盖 `applyInstanceChildOverrides` 读的每个字段
（visible / opacity / characters / fills / strokes / itemSpacing / padding*），
由 `tools/tests/mgPackage.test.js` 的单测把关。
