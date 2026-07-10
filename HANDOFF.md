# HANDOFF — 会话交接说明

写给接手这个仓库的下一个 AI / 协作者。本文是**当前会话的状态快照**，不是长期文档——
项目本身的架构、构建、逆向格式规格分别在 `AGENTS.md`、`README.md`、`MG_DECODER.md` 里，
那些才是权威来源。本文只负责把「这一轮做了什么、现在卡在哪、下一步该看哪个文件」讲清楚。

## 项目一句话

MasterGo → Figma 图层迁移工具，两个插件（`SendToFigma` 导出 JSON zip，`ReceiveFromMasterGo`
导入还原）+ 一个可以直接解析 MasterGo 专有二进制 `.mg` 格式的原生解码器（`ReceiveFromMasterGo/src/ui/mgPackage.js`）。
后者是本次会话的全部工作内容。

## 这次会话做了什么（按时间顺序）

用户目标：让 AI 逆向解码 `.mg` 二进制格式，使原生解码器输出与 SendToFigma 导出的 v2 zip
（"标准答案"）逐字段一致，越来越多字段被正确还原。

1. **[37ea960]** 在旧测试集（`插件测试.mg`）上补齐 strokeAlign/strokeCap/textAutoResize/isMask
   等一族属性，把 `tools/compare_mg_import.js` 升级为**递归全字段 deep-diff**（不再只查具名
   属性），在旧测试集上打到全零 diff。
2. **[4983bac, 4aa4f76]** 补文档：README/QUICKSTART 加了「直接上传 `.mg` 导入」的已有能力说明；
   新建 `MG_DECODER_JOURNAL.md` 记录逆向的**方法论和起步过程**（容器剥离、tagged field stream
   识别、数字编码破解的已知答案攻击手法），含实证的十六进制对照。
3. **用户提供了新测试集**（`新文件.mg` + 对应 v2 zip，1388 条记录，真实 UI 设计），发现
   **旧解码器在这份新样本上只认出 14 条记录**——因为它是另一种导出形态。
4. **[7da89d1]** 识别并支持了 **share / 局部导出**结构：组件模板树（根记录无 parent/sortCode）
   + 实例浅覆盖记录（slash 复合 id，只存被覆盖的字段，未覆盖子节点要从模板按缩放系数合成）。
   新破解十余个字段（constraints 枚举修正、effect 表、文本样式表、opacity、visible 等）。
   deep-diff 从 11063 行收敛到约 935 行已知残差，**1388/1388 记录零缺失**。
5. **[8c9e0fd]** 修了一个真 bug：多行文本换行在图层名里被折叠成空格，share 导出应以 run
   内容为准，已修复。
6. **用户重新导入 Figma 做人工核对**，我做了一次数据侧的「可见 vs 隐藏子树」差异归类
   （Figma MCP 连接当时 403，无法截图核对，改用 deep-diff 数据模拟对比）。结论：可见差异只有
   253 行，94 个多余节点全部在隐藏子树里；三类可见差异——合成组包围盒偏移、字体回退降级
   （mg 版比 zip 版更接近设计原意）、换行 bug（已修复）。
7. **[7e496da]** 按用户要求，把「未破解字段清单」整理成表格文档
   `MG_DECODER_UNKNOWN_FIELDS.md`（新建，本次会话最后一个改动）。

## 当前解码器状态

- 权威规格：`MG_DECODER.md`（每次改 `mgPackage.js` 必须同步这个文件，这是仓库明文要求）。
- 验证命令：
  ```bash
  node tools/compare_mg_import.js 新文件.mg mastergo2figma-partial-pages-2026-07-09T14-27-10-967Z.zip
  ```
  当前结果：0 missing / 0 type mismatch / 0 parent mismatch，deep-prop 残差约 935 行，全部已知
  归类（见下）。旧测试集 `插件测试.mg` 曾在被替换前打到过真正全零。
- 已破解字段（约 60 个）：所有承载视觉属性的字段——几何/变换/约束/可见性/全部 paint 类型/
  描边四件套/圆角/自动布局/文本内容与样式/effects/vectorNetwork/实例展开与缩放。
- **未破解字段清单**：`MG_DECODER_UNKNOWN_FIELDS.md`（表格，按出现频次排序，标注哪些疑似
  无视觉意义的元数据、哪些是下一轮值得攻的目标）。

### 已知残差（不是 bug，是待研究项，见 MG_DECODER.md 的 TODO 节）

1. **实例内布尔的子树导出规则未知**——哪些操作数子树该保留、哪些该空 VN 叶子化，判别信号
   可能在标量 `0x19` 位集里（未破解，优先级最高）。
2. **隐藏变体状态（visible:false）的文本样式来源对不上**——零视觉影响，优先级低。
3. **合成 GROUP 的包围盒**用「模板标称值 × 缩放」，基准用子内容实际包围盒，±4px 级偏移，
   在 Figma 里可能表现为路线/分页点等元素的几像素位移。

## 下一步建议（如果继续逆向）

1. 先读 `MG_DECODER_JOURNAL.md` 的方法论（已知答案攻击、顺序步进解析、缺失即默认三条铁律），
   不要重新摸索。
2. 优先攻标量 `0x19`（LEB128 位集，出现 1097 次，未破）——很可能是实例 override 掩码，解开
   有机会同时解决「隐藏变体文本样式」和「实例内布尔子树规则」两个残差。
3. 容器 override 表 `0x14`/`0x15` 已定位未解码，解开可以把旧版按钮/卡片名字规则 hack 替换成
   真正的数据驱动逻辑。
4. 改完 `mgPackage.js` 必须跑一遍 `node tools/compare_mg_import.js` 并同步更新 `MG_DECODER.md`
   ——这是 AGENTS.md 里的明文要求，不是建议。

## 有一说一：本会话遗留的坑

- **Figma MCP 连接一直 403**（`get_metadata`/`get_screenshot`/`whoami` 全部失败），用户中途重新
  授权过一次仍未解决——这是非交互会话拿不到刷新后 OAuth 凭证的已知限制，**需要开新会话**才能
  验证是否已解决。如果下一个 AI 也遇到 403，不用反复重试，直接告诉用户去 claude.ai 连接器设置
  确认，或在交互会话里 `/mcp` 重新连接。
- 仓库根目录有个 `mg_decode_status.csv`（2026-06-12，早于本次会话全部工作），**内容已过时**，
  不要参考它，它没有被这次会话更新。
- `新文件.mg` 和对应基准 zip 是用户直接 `git add` 提交进仓库的测试样例（commit `054f49d`），
  不是我加的；`插件测试.mg` 曾是旧测试集但已被换掉/清出。

## Git 状态

- 当前分支 `main`，工作区干净。
- 本会话产生的提交：`37ea960` → `ea24d75`（这个是用户自己之前的）之后的
  `4983bac, 4aa4f76, 7da89d1, 8c9e0fd, 7e496da` 均已推送到 `origin/main`。
- 无未提交改动。

## 文档地图（避免重复造轮子）

| 文件 | 内容 |
|---|---|
| `AGENTS.md` | 项目结构、构建命令、编码规范、架构说明、`.mg` 逆向铁律 |
| `README.md` / `QUICKSTART.md` | 用户向使用说明，含直接上传 `.mg` 的能力 |
| `MG_DECODER.md` | **`.mg` 二进制格式权威规格**，改解码器前必读 |
| `MG_DECODER_JOURNAL.md` | 逆向的过程与方法论、踩坑史 |
| `MG_DECODER_UNKNOWN_FIELDS.md` | 未破解字段速查表 |
| `PERFORMANCE_OPTIMIZATIONS.md` | 大文件导出/导入的内存优化记录（与本次会话工作无关） |
| 本文件 `HANDOFF.md` | 会话快照，过时后可删除或覆盖重写 |
