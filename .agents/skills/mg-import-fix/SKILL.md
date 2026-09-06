---
name: mg-import-fix
description: MasterGo2Figma 仓库的 `.mg` 导入还原修复流程（以截图为渲染基准、zip 为结构辅助、修 mg）。用户发来新的 `.mg` 与基准 zip 路径，外加一个含 `_mg` / `_zip` / `_image` 后缀页面的 Figma 链接时使用。只要在本仓库里提到"新测试集""导入效果不对""还原有问题""贴近截图/图片""mg 导入 case""这个位置差异大""某某没还原"并附上 `.mg`/zip 路径或 figma.com 链接，即使没点名本 SKILL 也要触发。覆盖分诊、compare_mg_import 结构比对、mgPackage.js 二进制逆向、importer 视觉缺陷取证、双 fixture 回归与文档同步。
---

# MG 导入还原修复

三个证据源各司其职，混用必误诊：

- **`_image` 页（截图导入）= 渲染基准**。MasterGo 自己导出的 PNG，是"屏幕上应该长什么样"的唯一真相。
- **`_zip` 页 = 结构基准**。SendToFigma 导出的 v2 包，只代表"插件 API 说了什么"——它对 importer 的 bug 全盲，且个别字段（径向渐变比例、crop 窗口、蒙版渲染位）本身就拿不到。
- **`_mg` 页 = 修复对象**。目标：先追平 zip（结构），再追平截图（渲染）。zip 拿不到的位上，mg 可以也应该反超 zip。

## 阶段 0 · 定位输入

1. `.mg` 与基准 zip 通常在 `测试集/<名称>/` 下成对；主回归集见 `docs/MG_ZIP_PARITY_STATUS.md`。
2. **每轮开头都要重新列页面 id，不要复用上一轮的**——用户每次重导入都会生成新页面，id 全变
   （本仓库踩过：zip 页 `5:1094` 一次重导入后变成 `26:6137`，直接用旧 id 会报 `cannot read property 'id' of undefined`）：
   ```js
   return figma.root.children.map(p => ({ id: p.id, name: p.name }));
   ```
3. 取证一律用 `use_figma`。`get_metadata` 不带 nodeId 的页列表可能不全，XML 还会**静默截断深层子树**——
   本仓库曾因此把"boolean 丢了填充"误判成"整棵子树没还原"。
4. 动手前先读仓库根 `AGENTS.md` 的「`.mg` 解码逆向经验」与 `docs/MG_DECODER.md`（改 `mgPackage.js` 前必读是硬规矩）。

## 阶段 1 · 分诊（最省时间的一步，别跳）

先跑结构比对拿全局盘面：

```bash
node tools/compare_mg_import.js "<file.mg>" "<baseline.zip>"        # --json 可导出全量
```

- **Missing records 永远不可接受**；**Extra** 全是库 master 才是预期噪音。
- **deep prop 要看全量**，`--json` 后按 prop path 分桶再抽样——具名计数全零时仍可能有一整族属性全错。
- **record 级字段比较器根本不比**：`libraryMaster` / `maskRendersFill` / `instanceScale` / `mainComponentId` /
  各 styleRef。改这些时 diff 数字纹丝不动 ≠ 没生效，必须去画布验证。

然后按现象查表，直接决定去哪个阶段：

| 现象 | 判定 | 下一步 |
|---|---|---|
| 只有 mg 错、zip 对 | 解码器 | 阶段 2 |
| **mg 与 zip 同错** | importer 或渲染语义 | 先 diff 两侧 record；**字节一致就立刻停止 hexdump** → 阶段 3 |
| **同一族里部分对、部分错**（某几个字重正常，只有一档挂） | 匹配/归一化层，不是数据 | 去找匹配函数，别怀疑记录 |
| 记录齐全但画布少块／多块 | importer 删除或增补类逻辑 | 比较器全盲 → 数画布顶层块数 |
| 用户说"zip 导入也有问题" | **当真**，这是 bug 在两个解码器下游的强信号 | 阶段 3 |

## 阶段 2 · 解码器破解（`ReceiveFromMasterGo/src/ui/mgPackage.js`）

- `scripts/hexdump_record.js <file.mg> <recordId> [bytes]` 按 `\x01<id>\x00` 锚点 dump 原始字节；
  `scripts/dump_records.js <file.mg> <baseline.zip> <outDir>` 把 mg 解码与 zip 基准各导成 JSON 逐节点对照。
  两个脚本都 vm 加载仓库当前的 `mgPackage.js`，不缓存旧版本。
- **已知答案交叉表**：把节点按基准期望值分组，与候选字节交叉制表，取值与分组完全对齐的 tag 才算破解。单例最值钱。
- **顺序步进解析，永不在 twisted-float 载荷里用 tag 正则**；`break`-on-unknown 是静默截断不是保险。
- **区分"字段缺失"与"值为 0"**：MasterGo 大量"省略即默认"（padding 缺失=10、strokeWeight 缺失=1、sizing 缺失=AUTO）。
- **放宽正则前先定义新语法的边界**：一个不允许点号的 family 正则曾丢掉 22/27 个字体条目，是"mg 明显比 zip 差"的最大单一根因。
- **两个 fixture 各持一半真相时，答案几乎一定是还没破解的格式位**——去 hexdump 差字节，别选边站。
  trailer `1e`（蒙版是否自渲染填充）就是这么破的：0806 说"要补漆"、临时测试说"不能补漆"，差的就是这一个字节。

## 阶段 3 · importer 取证（`src/code.ts`、`src/appliers/`、`src/fontLoader.ts`）

- **"看不见" ≠ "没还原"**。先用 `use_figma` dump 真实节点树（type / visible / fills / 子节点数）再定性。
- **补漆、补孪生、提升填充这类"加东西"的修复，先排查兄弟画纸层**：MasterGo 惯用"蒙版 + 同款画纸兄弟层"结构，
  补出来的东西和兄弟层撞色时看着是对的，会把错误规则伪装成正确。
- **删除类改动（`libraryMaster`、residue skip…）必须重导入或数画布顶层块数**——比较器对 importer 的删除全盲。
- 在用户文件里做的任何复现实验，结束后删干净。

## 阶段 4 · 回归（每次改动后）

1. 两个主 fixture 都跑 compare，逐类计数只能变好；基线数字以 `docs/MG_ZIP_PARITY_STATUS.md` 为准。
2. 其余 fixture A/B：`git worktree add --detach` 对 HEAD 双跑，`--json` 集合差集里 **added 必须为 0**。
   **不要用 `git stash`**——用户的 GitHub Desktop 会撞 stash。
3. 无 zip 基准的 fixture（大文件、带外部库）跑结构摘要（页数/记录数/id digest）A/B 不变。
4. `node --test tools/tests/*.test.js`，记住 HEAD 上已有的既有失败数，别归罪自己。
5. 两端 `npm run build`（接收端会重新生成内联了 `mgPackage.js` 的 `ui.html`；动了 `shared/types.ts` 要连 SendToFigma 一起构建）。

## 阶段 5 · 画布验证与交付

- **别急着让用户重导入**。用 `use_figma` 在 `_mg` 页上直接把新构建的效果做出来（删掉错误节点／改属性），
  截图后逐点取样比色确认，再交付——这一步能把"改完等下一轮"压缩成同一轮闭环：
  ```python
  from PIL import Image
  a, b = Image.open("ref.png").convert("RGB"), Image.open("mg.png").convert("RGB")
  for x, y in pts: print((x,y), a.getpixel((x,y)), b.getpixel((x,y)))
  ```
  最大通道差 ≤ 1/255 才算贴合；缺失字体的文本从宽（字号/字重/盒子微差、fontWeight 基准 0 都豁免，用户已明确）。
- 交付报告固定给出：根因、修复清单（解码器 / importer 分列）、修复前后计数表、保留残差及理由。
- **明确告诉用户哪些改动需要重导入、哪些不用**：字体匹配类改动点插件 UI 的「刷新字体」按钮
  （`refreshMissingFontsInDocument`）就能对现有文档就地恢复。
- 同步 `docs/MG_DECODER.md`（字段规格 + 交叉表证据）、`docs/MG_DECODER_JOURNAL.md`（按日期追加过程与教训）、
  `docs/MG_ZIP_PARITY_STATUS.md`（数字表），并更新记忆 `mg-binary-format`。

## 已知 case 速查

先查这张表，命中就直接去对应位置，别从头逆向：

| 症状 | 根因 | 位置 |
|---|---|---|
| 整屏字号/行高/字距回退默认值 | 字体条目 family 正则不认某字符（如点号） | `mgScanFontStyles` |
| 字体明明装了仍回退 Inter，且只有某一档字重挂 | 样式名带字符集版后缀（`55 Regular L3` vs `55 Regular`） | `normalizeFontStyleForMatch` |
| 画布整块消失 | 库同步来的**画布**组件被误标 `libraryMaster` 删掉 | `mgPackage.js` 页面根门控 `!nodes[n.parent]` |
| 色块过饱和 / 多出一层底色 | 给"仅形状"蒙版补了漆 | trailer `1e` → `maskRendersFill` → `paintFilledMaskTwins` |
| 多出一条灰条 | 默认 #D8D8D8 占位蒙版被补漆 | `isDefaultMaskFill` |
| 图标完全透明但子树完好 | 外层 boolean 的填充没提升 | `applyOuterBooleanPaint` |
| 文本框被撑到全长、后面元素被挤飞 | `textAutoResize = "TRUNCATE"` 是 Figma 已废弃拼写 | `appliers/text.ts` |

## 附带脚本

| 脚本 | 用途 |
|---|---|
| `scripts/dump_records.js <file.mg> <baseline.zip> <outDir>` | mg 解码与 zip 基准各导出为 `actual_records.json` / `expected_records.json` |
| `scripts/hexdump_record.js <file.mg> <recordId> [bytes]` | 按 id 锚点在 `.mg` document 里 hexdump 原始记录字节 |

路径相对仓库根即可，脚本自己从所在位置推导仓库根。
