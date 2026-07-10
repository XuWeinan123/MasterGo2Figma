# Repository Guidelines

## Project Structure & Module Organization

本仓库用于在 MasterGo 与 Figma 之间迁移设计图层。`SendToFigma/` 是 MasterGo 端插件，负责读取页面、序列化图层并导出 MasterGo2Figma JSON zip（v2 格式）；核心代码在 `SendToFigma/src/`，打包产物为 `SendToFigma/code.js`。`ReceiveFromMasterGo/` 是 Figma 端插件，负责上传 zip 并还原为可编辑图层；核心代码在 `ReceiveFromMasterGo/src/`，UI 模板在 `ReceiveFromMasterGo/ui.template.html`，生成后的 UI 在 `ReceiveFromMasterGo/ui.html`（**不要手动改 `ui.html`**，见下文构建说明）。

共享类型与工具函数放在 `shared/`（`shared/types.ts` 定义跨端类型，其余为矩阵/矢量/connector 辅助函数与图层规则配置），两端通过相对路径 `../../shared/...` 引用。本地大文件中继服务在 `tools/mastergo_relay_server.py`；`tools/compare_mg_import.js` 用于比对 `.mg` 解码结果与基准 zip；`pythonParser/mg_to_zip.py` 是独立的 Python CLI，复用 `ReceiveFromMasterGo/src/ui/mgPackage.js` 的解码逻辑，可在不启动任何插件的情况下把 `.mg` 直接转成 v2 zip。说明文档包括 `README.md`、`QUICKSTART.md`、`MG_DECODER.md`（`.mg` 二进制格式规格）、`MG_DECODER_JOURNAL.md`（逆向过程与方法论）、`MG_DECODER_UNKNOWN_FIELDS.md`（未破解字段清单速查表）、`PERFORMANCE_OPTIMIZATIONS.md`；截图与示例资源放在 `assets/`。不要手动修改第三方依赖目录或构建缓存。

## Build, Test, and Development Commands

两个插件分别安装依赖和构建：

```bash
cd SendToFigma && npm install && npm run build
cd ReceiveFromMasterGo && npm install && npm run build
```

`npm run build` 会先执行 `tsc --noEmit` 类型检查，再用 `esbuild` 把 `src/code.ts` bundle 成 `code.js`（`manifest.json` 里 `main` 指向的插件入口）。接收端还会先运行 `node tools/build-ui.js`：它把 `src/ui/mgPackage.js`（原生 `.mg` 二进制解码器）内联进 `ui.template.html` 的 `%%MASTERGO_MG_PACKAGE_JS%%` 占位符，生成 `ui.html`。修改 UI 逻辑或解码器时应编辑 `ui.template.html` / `src/ui/mgPackage.js` 后重新构建（或用 `npm run watch`），`ui.html` 是生成产物，Figma 直接读取它、无需额外构建步骤。

开发时可使用：

```bash
cd SendToFigma && npm run watch
cd ReceiveFromMasterGo && npm run watch
python3 tools/mastergo_relay_server.py
```

Python 中继服务默认监听 `http://127.0.0.1:8765`，用于大文件流式写入本地 zip。

## Coding Style & Naming Conventions

主要代码使用 TypeScript，保持 2 空格缩进、显式类型、早返回和小函数。文件名沿用现有 camelCase 风格，例如 `nodeSerializer.ts`、`matrixUtils.ts`。序列化逻辑放在 `serializers/`，还原逻辑放在 `appliers/`；跨端复用逻辑优先放入 `shared/`。避免在业务代码中散落 magic number，应集中到配置或命名常量。

## Testing Guidelines

当前仓库没有独立测试框架或 `__tests__` 目录。提交前至少运行两个插件的 `npm run build`，并按变更方向手动验证：MasterGo 端导出 zip、Figma 端导入 zip、大文件场景使用本地中继服务。涉及原生 `.mg` 解码逻辑的改动，优先用 `node tools/compare_mg_import.js [file.mg] [baseline.zip]`（不传参时默认取仓库根目录最新的 `.mg` 和 `mastergo2figma-*.zip`）与已知基准 zip 比对，而不是仅凭肉眼检查。新增可自动化测试时，建议按模块命名为 `*.test.ts`，并优先覆盖矩阵、矢量、文本、容器和 connector 转换逻辑。

### `.mg` 解码逆向经验（血泪教训，务必遵守）

- **看 `Deep prop mismatches`，不要只看那一排具名计数。** `compare_mg_import.js` 里的 `deepDiffProps` 会递归比对每个节点的**全部** `props` 字段（0.015 数值容差）并计入退出码。历史上曾把具名计数全打到零就判定“完成”，结果 `strokeAlign` / `strokeCap` / `textAutoResize` / `isMask` 等一整族未被具名检查的属性全错、只有在 Figma 里肉眼才发现——基准里有、工具没显式比的字段等于没测。加新解码时如果引入了工具没覆盖的新属性，先确认 deep-diff 能看到它。
- **逆向新字段用“已知答案交叉表”，别盲猜。** 基准 zip 给出每个节点的精确期望值：把节点按期望值分组，再把原生记录里的候选字节交叉制表，看哪个 tag 的取值与分组完全对齐。`strokeAlign` 就是这样从被误读为“paint 引用计数”的 `13` 上定位出来的。
- **顺序步进解析，别用正则找 tag。** `.mg` 的 twisted-float 载荷里会自然出现 tag 样字节（`0x1c` 曾害得 `case 4` 整个子树丢失）。标量区/尾部/容器对象都改成从固定锚点顺序消费字段（见 `mgWalkScalarFields` / `mgParseTrailer` / `mgParseContainerMeta`）。
- **区分“字段缺失”和“字段值为 0”。** MasterGo 大量“省略即默认”：padding/itemSpacing 字段缺失=默认 10、strokeWeight 缺失=1、sizing 字段缺失=AUTO、blendMode 缺失=PASS_THROUGH。语义完全不同，不能一律当 0。
- 改 `mgPackage.js` 前先读 `MG_DECODER.md`（字段规格），破解手法与踩坑史见 `MG_DECODER_JOURNAL.md`；有进展时两者都要同步。

## Architecture Notes

### SendToFigma（导出链路）

`src/code.ts` 是插件入口，通过 `mg.ui.onmessage` 处理 `start-export`、`resize`、传输 ack 等消息。`nodeTraverser.ts` 遍历 MasterGo 文档树；`nodeSerializer.ts` 按 `SendStrategy`（见 `shared/types.ts`）把节点分发到 `serializers/{universal,container,shapes,text,vector,connector}.ts`。`transferStream.ts` 实现两种传输模式：`direct-zip`（在插件 UI 内存里直接打包）和 `local-json-stream`（流式发给本地中继）——之所以需要中继，是因为 MasterGo 插件主线程没有 `fetch`，数据必须先通过 `mg.ui.postMessage` 传给 `ui.html` 再转发给本地 Python 服务。`exportConfig.ts` / `imageExporter.ts` 处理导出选项与图片资源；`layerRules.ts` 加载 `shared/layerRulesConfig.ts` 中的图层规则；`state.ts` 保存导出进行中的状态。

### ReceiveFromMasterGo（导入/还原链路）

`src/code.ts` 是插件入口（`figma.showUI` + `figma.ui.onmessage`）。还原按阶段推进，以支持大包的分块导入：

1. `startImportSession()` 校验 v2 manifest，初始化运行时状态（图片/页面缓存、进度统计）。
2. 分块的 `import-asset-*` / `import-page-*` 消息累积图片字节和每页的 layer record。
3. `restoreImportPageData()` 为每个导入页面创建 Figma Page，并从 `rootNodeIds` 开始递归还原。
4. `restoreImportedNode()`（`code.ts`，配合 `appliers/container.ts`、`nodeCreator.ts`）按节点类型分流：Boolean tree、native Group、ComponentSet，或通过 `createNodeFromData()` 创建普通节点。
5. `propertyApplier.ts` 的 `applyProperties()` 应用通用属性（名称、可见性、blend、fills/strokes/effects、constraints、layout），再委派给 `appliers/{vector,text,connector}.ts` 处理类型专属属性。
6. 容器类节点在子节点还原完成后 finalize：Group 用临时 Frame + `figma.group()`；Boolean 执行组合或 fallback；ComponentSet 调用 `combineAsVariants()`。
7. 所有页面创建完后，`deferredLayout.ts` 的 `applyDeferredLayoutRestores()` 分三步补齐 auto-layout：节点自身、作为 auto-layout 子项、固定尺寸/transform 收尾；其中 native Group 子节点会把局部坐标转换为 Figma Group 所需的父级坐标。
8. 最后清理：删除导入 shell、修正单子节点 `SPACE_BETWEEN`、执行 `appliers/connector.ts` 的 deferred connector 恢复、尝试用 `fontLoader.ts` / `appliers/text.ts` 恢复缺失字体、定位视口、发送完成通知。

`src/ui/mgPackage.js` 是原生 `.mg` 二进制解码器（不仅是 v2-JSON 透传），能直接解码 MasterGo 专有的二进制 node/paint/text record，让没有内嵌 v2-JSON 的页面也能正确导入；它通过 `build-ui.js` 内联进 `ui.html`（见上文构建说明），也被 `pythonParser/mg_to_zip.py` 复用。**改动原生格式解码逻辑前必须先读 `MG_DECODER.md`**——它是逆向出的 `.mg` 二进制格式的活文档（数值/tag 编解码、node record 语法、paint/text/instance 解码细节、已知缺口），修改 `mgPackage.js` 时要同步更新它。

### 已知限制

MasterGo 插件桥（`mg.ui.postMessage`）没有零拷贝/流式 API，即使用了本地中继，超大或多页连续导出仍可能在宿主侧 OOM——中继只避免了"打包 zip"这一步的内存峰值，无法避免"大量 chunk 传输"阶段的桥接开销。缩小导出范围只是权宜之计，不是根本修复；动手"根治"大文件 OOM 前，先读 `README.md` 里的「OOM 和 MasterGo 限制说明」一节。

## Commit & Pull Request Guidelines

Git 历史使用简短动词短语，允许中文或英文，例如 `Improve large MG import streaming`、`修复 bug，抽象 ui 中的逻辑`。提交信息应说明用户可见行为或修复点，避免只写 `update`。Pull Request 需包含变更摘要、构建结果、手动验证步骤；涉及 UI 或图层还原效果时附截图或示例 zip。若修复已知问题，请关联 issue 或在描述中列出复现路径。

## Security & Configuration Tips

不要提交包含私有设计内容的大型 `.mg`、导出 zip 或本地 relay 输出，除非它们是明确脱敏的测试样例。修改 `manifest.json`、插件权限或本地服务端口时，在 PR 中说明原因和兼容影响。
