# 性能优化记录（SendToFigma / ReceiveFromMasterGo）

记录 2026-07 一次针对两个插件运行稳定性与流畅度的优化：内存峰值、卡顿、大文件/多页导入导出的可靠性。

**硬约束（本次改动全程遵守）**：
- 不改变导出 zip 的 v2 格式、图层还原结果、消息协议（`mg.ui.onmessage` / `figma.ui.onmessage` 的消息类型和字段）。所有优化均为行为等价。
- 未手改 `ReceiveFromMasterGo/ui.html`（构建产物），UI 逻辑改动都在 `ui.template.html` 里，随 `npm run build`（内部调用 `tools/build-ui.js`）重新生成。
- 未涉及 `.mg` 原生解码逻辑（`src/ui/mgPackage.js`），因此未改动 `MG_DECODER.md`。
- 每项改动都是小步、单一关注点、可独立回滚（对应一个 git commit）。

工作方式：先做全链路瓶颈分析（不改代码），列出清单并按「收益 / 风险 / 改动量」排序，用户确认「全量修改，按顺序来，每项一个 commit」后逐项实现。每项完成后跑两端 `npm run build`（tsc 类型检查 + esbuild 打包）确认通过。

## 涉及的核心链路

- **SendToFigma（导出）**：`nodeTraverser.ts`（遍历）→ `nodeSerializer.ts` / `serializers/*.ts`（序列化）→ `transferStream.ts`（分块 + `mg.ui.postMessage` 传输）→ `ui.html`（direct-zip 打包 或 转发本地中继）。
- **ReceiveFromMasterGo（导入）**：`ui.template.html`（解压 zip / 准备分块）→ `code.ts`（`import-session-*` / `import-page-*` / `import-asset-*` 消息处理）→ `nodeCreator.ts` + `appliers/*.ts`（节点创建与属性还原）→ `deferredLayout.ts`（三段式 auto-layout 补齐）。

---

## 变更清单

按实施顺序排列，编号对应最初瓶颈分析清单的分组（A = 导出端，B = 导入端）。

### A1 — 导出文本 chunk 大小 4KiB → 16K 字符
**Commit**: `ab9d885` · **文件**: `SendToFigma/src/exportConfig.ts`

`EXPORT_TEXT_CHUNK_CHAR_LIMIT` 从 `4 * 1024` 提到 `16 * 1024`。layer JSON 走文本 chunk 路径，此前每条消息上限只有二进制 chunk（64KiB）的 1/16；大导出要发上万条 `postMessage`，每条在 MasterGo bridge 都有固定开销，中继模式下每条 chunk 还是一次独立 HTTP POST。提到 16K 字符后，UTF-8 最坏情况（全 CJK，3 字节/字符）编码后 ≈48KiB，仍在已验证安全的 64KiB 二进制包络内。

**为什么行为不变**：UI 两条接收路径（direct-zip 的 `appendExportFileChunk`、relay 的 `appendLocalRelayFileChunk`）都只做字节级顺序 append，不依赖 chunk 边界；chunk 按字符切分不会切断 UTF-8 多字节字符。最终 zip 字节完全一致，仅消息/POST 条数减少。

### B1 — 缺失字体解析记忆化
**Commit**: `66c9f9b` · **文件**: `ReceiveFromMasterGo/src/fontLoader.ts`

`resolveAvailableFontName()` 在请求字体未安装时（MasterGo→Figma 场景下的 CJK 字体几乎必然命中）会对 `figma.listAvailableFontsAsync()` 返回的全部字体做线性扫描，且每次都重新对 family/style 做正则归一化——此前是**每个文本节点**都跑一遍，几千文本节点 × 上万字体 ≈ 上亿次正则调用。

改动：
- 按 `(family, style)` 请求 key 缓存解析结果（`fontResolutionCache`），随 `rebuildAvailableFontIndex()` 一起失效重建。
- 可用字体列表的 family/style 归一化结果在 `rebuildAvailableFontIndex()` 时预计算一次（`normalizedFontEntries`），不再每次匹配都重算。
- `normalizeFontStyleForMatch` 里内联的别名表 (`aliases`) 提升为模块常量 `FONT_STYLE_ALIASES`，避免每次调用都重建对象字面量。

**为什么行为不变**：纯函数记忆化，输入（`documentFonts` + 请求字体）不变则输出不变；缓存与字体索引重建严格同步。

### B2 — 导入 UI 准备阶段去掉整包深拷贝与重复遍历
**Commit**: `44aa071` · **文件**: `ReceiveFromMasterGo/ui.template.html`（`ui.html` 随之重新生成）

`buildPageImportData()` 此前对每页数据做了三次多余的全量处理：
1. `cloneJson(record)`：record 本就是从 zip 字节每次 `JSON.parse` 出来的单一引用对象，深拷贝（`JSON.stringify` + `JSON.parse`）纯属多余。
2. `prefixImageRefs` / `prefixConnectorEndpointNodeIds` / `collectImageRefs` 三次独立的全 props 树递归，合并为一次 `prepareImportProps`。
3. `chunkLayerRecords()` 对每条 record 重新 `JSON.stringify` 只为估算分块大小；导出端的 layer chunk 文件已经保证 ≤16 条/≈64KiB，改为直接复用来源分组，去掉这次估算。

**为什么行为不变**：用合成数据写了新旧实现对照脚本，验证了输出 record 集合、内容（含重复 id 去重规则）、`assetKeys` 完全一致；`import-page-chunk` 消息字段不变，仅分组条数可能不同（接收端按字典累积 record、从 `rootNodeIds`/`childIds` 还原，不依赖分组边界）。

### A2 — 导出节点诊断快照惰性化
**Commit**: `3b144b4` · **文件**: `SendToFigma/src/nodeSerializer.ts`

`createNodeComplexitySnapshot()`（约 10 次宿主桥接读取：id/name/type/width/height/childCount 等）此前每个导出节点都无条件执行，仅用于诊断日志。改为惰性：
- 只在「大记录 warn」（`recordBytes >= STRINGIFY_RECORD_WARN_BYTES`）或「stringify 失败」两个异常路径按需计算；子节点数在节点仍可读时以纯数字提前捕获，不保留节点引用。
- `getNodeDebugLabel()` 改为直接复用已经读取过的 `nodeId`/`nodeName`/`nodeType` 拼接字符串，不再重复调用宿主 getter。
- `pageName` 复用每页已捕获一次的 `pageIndex.name`，不再每节点重复读取 `page.name`。

每节点省约 13 次桥接读取，是导出遍历阶段单节点成本的主要来源之一。

**为什么行为不变**：zip 输出不包含这些字段，仅影响 console 诊断日志；正常路径完全不受影响，异常路径的诊断信息内容不变（只是计算时机推迟）。

### A3 + A4 + A5 — 导出端三处小优化
**Commit**: `cf2541c` · **文件**: `SendToFigma/src/exportConfig.ts`、`nodeSerializer.ts`、`transferStream.ts`

1. **去掉 `sanitizeExportNodeJson` 二次深拷贝**：`constraints`/`exportSettings`/`arcData`/`fontName`/`letterSpacing`/`lineHeight`/`styledTextSegments` 在各序列化器读取宿主属性时已经用 `cloneJsonCompatible` 克隆过一次（所有 `trans*` 函数都基于 `getUniversalProperty`），此前又对整个 nodeJson 做了第二次 JSON 往返克隆这些字段，属于纯冗余，文本密集页面上开销明显。已在 `analyseNodes()` 处加注释固化这个不变量，供后续新增序列化器遵循。
2. **图片资源循环 yield 频率**：新增 `EXPORT_ASSET_YIELD_EVERY_ASSETS = 8`，`streamImageAssetsToTransfer()` 从「每个 asset 一次 `setTimeout(0)`」改为「每 8 个一次」。大图在 `streamExportFileToUI` 内部已按 chunk yield，小图场景下逐个 yield 是纯粹的空转。
3. **`flushLayerChunk` 用 `join(",")` 替代逐条模板拼接**：原来 `contentParts.push(index > 0 ? \`,${json}\` : json)` 会为每条记录生成一个新字符串，改为 `chunk.recordJsons.join(",")` 一次成串。已用脚本验证多条/单条场景下输出字节与旧实现完全一致（且确认不能把 `,` 拆成独立 contentPart，否则会变成 1 字节的独立消息）。

### B4 — 导入后处理去掉两次整页树遍历的冗余开销
**Commit**: `9d5b6cd` · **文件**: `ReceiveFromMasterGo/src/state.ts`、`deferredLayout.ts`、`nodeCreator.ts`、`code.ts`

1. **SPACE_BETWEEN 单子节点修正**（`applyDeferredSingleChildAutoSpaceAlignmentFixes`）：不再在页面还原完成后对整棵树做一次遍历去找候选节点，改为在 `deferLayoutRestore()` 记录布局时顺手判断并推入 `state.singleChildAutoSpaceCandidates`（新状态字段），按页 drain。apply 时仍重新从 `restoredLayoutByNodeId` 取最新布局并复用原有条件判断（含 `removed` 检查），命中集合与旧的整树遍历完全一致。
2. **`collectCleanupNodes` 去掉每节点祖先链爬取**：该 DFS 本身不会进入 `INSTANCE` 子树，因此某节点「是否位于实例内」只取决于遍历的根节点，之前却对每个节点都做一次 `isInsideInstance()` 祖先链爬取（每层一次桥接读取）。改为只对 root 判断一次（`rootInsideInstance`）。
3. 去掉 `[...node.children]` 冗余 spread 复制——Figma 的 `children` getter 每次访问本身就返回新数组快照。

### B5 — 矢量网络还原去掉 segments 的无变换复制
**Commit**: `81c622d` · **文件**: `ReceiveFromMasterGo/src/appliers/vector.ts`

`normalizeVectorNetworkForFigma()` 对 `segments` 数组做了逐条浅拷贝，但没有任何字段变换（不像 `vertices` 需要归一化 `strokeCap`、`regions` 需要归一化 `windingRule`/`loops`）。输入本就是 zip 解析出的纯 JSON 对象，且 `node.vectorNetwork =` 赋值时 Figma 内部还会再拷贝一次，fallback 路径 `stripVectorNetworkVertexExtras` 本身也是拷贝式的——直接透传引用即可，矢量密集导入省一整遍数组复制。

### B3 — 导入 UI 改为逐页惰性准备
**Commit**: `9b78877` · **文件**: `ReceiveFromMasterGo/ui.template.html`（`ui.html` 随之重新生成）

`streamImportPayload()` 此前会把**全部**选中页面的 records 一次性准备好（存入 `preparedPages`）才开始发送，多页大包时 UI 内存峰值 = 全部页面数据总和。改为每页「准备 → 发资源 → 发数据 → 等还原完成」后立即释放，内存峰值降为单页。

线上消息顺序完全不变：`import-session-start` → 每页 `assets 相关` → `import-page-start` → `import-page-chunk*` → `import-page-end`。

为保住「损坏的导入包在建立会话前就应该报错」这一旧语义（旧实现是先把所有页面全部解析一遍，任何一页格式错误都会在发送任何消息前抛出），新增 `verifyPageEntriesExist()` 预检：在 `import-session-start` 之前对全部选中页面做一次「index 文件存在 + schema 合法 + 每个 layer chunk 文件存在」的轻量校验（只读文件是否存在和顶层 schema 字段，不做重量级的 record 解析/前缀/整理），避免插件侧留下半开的导入会话。

进度条本身单调递增（`setDisplayedProgress` 有 `Math.max(lastDisplayedPercent, percent)` 钳制），因此只有进度标签的节奏会略有变化，不影响最终状态。

### B6 — 每页还原完成后释放布局映射
**Commit**: `70ed0c6` · **文件**: `ReceiveFromMasterGo/src/code.ts`

`state.restoredLayoutByNodeId` 与 `state.nativeGroupOffsetByNodeId` 此前跨整个导入会话累积，但提交前 grep 复核了全部读取点：
- `nativeGroupOffsetByNodeId`：写入于本页 Group finalize（`appliers/container.ts`），唯一读取点在 `deferredLayout.ts` 的本页 deferred layout 处理中。
- `restoredLayoutByNodeId`：写入于 `applyUniversalProperties`（本页节点属性应用时），读取点分布在矢量布局盒判断（`code.ts`）、group 子节点偏移归一化（`appliers/universal.ts`）、ComponentSet 子节点布局 finalize（`appliers/container.ts`）、SPACE_BETWEEN 修正（B4）——全部发生在本页 restore/postprocess 生命周期内。
- 会话收尾（`completeImportSession`）的 connector 恢复只依赖另一个映射 `restoredNodeIdBySourceId`，不受影响。

在 `restoreImportPageData()` 每页 postprocess 完成后清空这两个映射，多页导入时内存不再随页数线性累积。Figma node id 不跨页复用，清空后不会有跨页误读风险。

### A7 — 导出逐文件 ack 停等改为单槽流水线
**Commit**: `3e286c4` · **文件**: `shared/types.ts`、`SendToFigma/src/transferStream.ts`

导出端此前每个 layer chunk 文件（64KiB 一个）在 `export-file-end` 之后都要原地 `await` UI 的 ack（`主线程 → UI → zip 写入/relay HTTP → 主线程` 一次完整往返）才继续序列化下一个文件。大导出是千次级的纯等待。

改为单槽流水线：`ExportTransferState` 新增 `pendingFileAck` 字段，`streamExportFileToUI()` 不再原地等待，而是把 ack promise 存入该字段；下一次调用 `streamExportFileToUI()` 时，或 transfer complete 前，先 `drainPendingExportFileAck()` 排空上一个文件的 ack。序列化与 ack 往返因此重叠。

**为什么行为不变**：
- 文件消息本身仍严格按 start/chunks/end 顺序发送，UI 两条接收路径按消息到达顺序处理，zip 内部布局与 relay 落盘顺序不变。
- ack 失败（超时/UI 报错）仍然抛出同样的 `uiTransferError` 并终止导出，只是从「同文件立即失败」变成「下一个文件开始前才浮现」——语义上等同于把失败检测点后移一步，最终结果一致（都会终止整个导出）。
- 为避免 promise 在被 drain 前 reject 触发 unhandled rejection 警告，ack promise 预先挂了一个 no-op `.catch()`；真正的错误处理仍在 `drainPendingExportFileAck()` 里 `await` 原 promise 时抛出。
- 传输统计计数（`state.noteExportFileTransfer`）从「ack 到达时」移到「drain 时」执行，总数不变。

---

## 评估后未做的项

**C1（relay 模式 UI 合批 POST）**：A1 落地后每个 layer chunk 文件已经只剩 1 个 chunk，可合批的空间很小；真正占比高的是每文件 2 个协议性请求（`/files/start`、`/files/end`），合批 chunk 无法减少这两个请求，要收窄它们只能改 relay 的文件级协议本身（即改变 v2 包「一个 zip entry 一个文件」的传输结构）。收益（每 MB 省几毫秒）配不上改动的复杂度（缓冲、重编号、abort 冲刷），且 A7 已经让主线程不再阻塞等待这些 POST 的往返。故不做，如实测后仍有必要可单独立项。

**未纳入本次分析/改动的**：
- `SendToFigma/src/nodeTraverser.ts` 的索引式子节点访问、`transferStream.ts` 的 `countNodes()` 预扫描——均为刻意的 Wasm OOM 防护设计（详见代码内注释），未触碰。
- `ReceiveFromMasterGo/src/ui/mgPackage.js`（`.mg` 原生解码器）——按仓库规则改动前需先读 `MG_DECODER.md` 并同步更新，本次未涉及。

---

## 验证情况

- **构建**：每个 commit 落地后都执行过对应插件的 `npm run build`（`tsc --noEmit` 类型检查 + `esbuild` 打包），全部通过；接收端的 `ui.template.html` 改动都经过 `node tools/build-ui.js` 重新生成 `ui.html`（未手改生成产物）。
- **等价性验证**：
  - B2、A5 涉及数据变换的改动，用合成数据编写了新旧实现对照脚本，逐条比对输出（record 内容、去重结果、assetKeys、zip chunk 字节）。
  - B4、B6 通过逐条推理 + 全仓库 grep 复核读写点覆盖来源证明。
- **未跑 `compare_mg_import.js`**：仓库根目录当前没有 `.mg` 样例文件和基准 zip 可供比对；且本次改动均未涉及 `.mg` 原生解码逻辑，该工具校验的路径不受影响。

**建议在发布前手动验证的场景**（覆盖本次改动的关键路径）：
1. 小文件 direct-zip 导出 → 导入（基础回归）。
2. 多页大文件走本地中继导出 → 导入（重点覆盖 A1 chunk 大小、A7 ack 流水线、B3 逐页准备）。
3. 含缺失字体 + 多样式文本的页面（覆盖 B1 字体记忆化）。
4. 含 Group / Boolean Operation / SPACE_BETWEEN 自动布局的页面（覆盖 B4、B6）。
5. 若有 `.mg` 样例，跑一次 `node tools/compare_mg_import.js` 做兜底比对。
