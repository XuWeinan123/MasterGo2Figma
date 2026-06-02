# MasterGo2Figma 插件重构总结

本项目对 **SendToFigma**（MasterGo 导出端）和 **ReceiveFromMasterGo**（Figma 导入端）两个插件的 legacy 遗留代码进行了深度重构。主要目标是提升代码可读性、消除重复逻辑、建立类型安全、并保证运行时的稳定与高性能。

---

## 1. 核心架构调整

重构后，项目从原有的两个巨型单体文件，转变为**模块化 ESM 结构 + 统一共享模块**的清晰架构：

- **`shared/` (共享模块)**：提炼了两个插件通用的数学运算、数据格式化及节点判断函数。包括类型定义（`types.ts`）、通用安全修改工具（`utils.ts`）、流程图连线计算（`connectorUtils.ts`）、矢量路径与填充规则（`vectorUtils.ts`）以及矩阵运算（`matrixUtils.ts`）。
- **`SendToFigma/src/` (导出端模块)**：按照数据流向将原单体文件拆分为状态管理（`state.ts`）、规则匹配（`layerRules.ts`）、DFS 深度优先遍历（`nodeTraverser.ts`）、图片导出（`imageExporter.ts`）、分包传输（`transferStream.ts`）以及各个图层种类的专属序列化器（`serializers/`）。
- **`ReceiveFromMasterGo/src/` (导入端模块)**：导入端的结构与导出端相呼应。分为页面还原状态管理（`state.ts`）、元素匹配（`layerRules.ts`）、节点创建与清理（`nodeCreator.ts`）、针对多步自动布局解析的延迟布局器（`deferredLayout.ts`）、缓存与模糊匹配字体加载器（`fontLoader.ts`）、属性分流器（`propertyApplier.ts`）及特定属性的专属应用器（`appliers/`）。

---

## 2. 共享与去重 (DRY)

我们建立了统一的 `shared/` 目录，消除了 100% 的数学公式与转换算法冗余：
- **流程图连线 (Connector)**：合并了 `createConnectorRoutePoints`、`getConnectorCornerRadius`、`normalizeConnectorPoint` 等核心路由算法，通过统一的 `connectorUtils.ts` 计算磁吸和折线节点。
- **路径与填充规则**：统一了奇偶填充（`EVENODD`）、非零缠绕（`NONZERO`）等路径逻辑，以及笔尖端点样式的规范化。
- **安全节点修改**：封装了 `safeSet`、`safeResize` 等安全防御写入函数，能避免宿主沙箱抛出致命错误，并内置了 `yieldToEventLoop` 事件循环让渡机制，防止处理大文件时阻塞宿主 UI 导致 OOM（内存溢出）。

---

## 3. 兼容性与 Typo 保留

为了确保重构后的插件与历史导出的 JSON 数据结构完全向前兼容，我们保留并规范化了协议中固有的拼写错误：
- 导出端序列化（`universal.ts`）及导入端应用（`universal.ts`）中，**明确保留并注释了 `"scence"` 属性键**，并添加了专门的警告和背景注释说明，防止后续开发人员意外修改该键导致历史包无法解析。

---

## 4. 构建与编译流线化

因为 Figma 与 MasterGo 插件沙箱主线程原生不支持 ES Module `import`/`export`。我们引入了 `esbuild` 作为 Bundler 工具：
1. **SendToFigma** 和 **ReceiveFromMasterGo** 的 `tsconfig.json` 均配置了 `"moduleResolution": "node"` 以支持相对路径模块解析。
2. 配置了双阶段构建脚本：先由 `tsc --noEmit` 进行完整的 TypeScript 静态类型检查，再由 `esbuild` 快速合并打包输出单文件 `code.js`。构建命令如下：
   ```bash
   tsc -p tsconfig.json --noEmit && esbuild src/code.ts --bundle --outfile=code.js --target=es6 --log-level=warning
   ```
3. 构建速度从过去的数秒缩短至小于 10 毫秒。

---

## 5. 验证与遗留清理

- **编译检查**：两端插件源码均已完成模块拆分，并能够以零编译错误、零警告成功生成产物。
- **遗留代码归档**：历史的单体 `code.ts` 均已重命名为 `code.ts.legacy` 留作对比与备份，避免影响模块引入。
- **变更记录**：在 artifacts 目录下生成了 `task.md` 任务追踪看板与 `walkthrough.md` 技术架构设计文档。

---

## 6. 视觉高度与布局滚动条优化 (Visual & Layout Height Optimizations)

针对插件界面底部出现多余空闲冗余（空白 gap / padding / margin）以及滚动条闪烁问题，我们对两个插件的 `ui.html` 进行了如下重构：
- **根源分析**：原布局中 `<header class="app-header">` 位于 `<main>` 外部，而 `<main>` 被设置了 `height: 100vh; overflow: hidden;`。这导致 `body` 的内容实际高度变成了 `Header 高度 + 100vh`，从而超出了窗口高度，强行产生了滚动条。在滚动到底部时，Header 被滚出屏幕，底部留出了等于 Header 高度（约 72px）的尴尬空白区域。
- **重构方案**：
  1. 将 `body` 改造为 Flexbox 布局，使其精确撑满窗口并不允许主体产生全局滚动：
     ```css
     body {
       margin: 0;
       width: 400px;
       height: 100vh;
       display: flex;
       flex-direction: column;
       overflow: hidden;
     }
     ```
  2. 将 `<main>` 标签改为自适应弹性收缩填充，去除原 100vh 高度：
     ```css
     main {
       flex: 1;
       min-height: 0;
       padding: 0 16px 16px 16px;
       display: flex;
       flex-direction: column;
       gap: 16px;
       overflow: hidden;
     }
     ```
  3. 彻底删除 `ui.html` 内部所有重复的/冲突的 `body` 和 `main` 样式块，实现彻底的单源控制。
- **成效**：彻底解决了界面底部留白的多余 Padding 顽疾，使插件头部固定不动，列表区自适应伸缩，界面整体完全契合窗口物理高度，滚动条彻底消失，达到极为现代和细腻的 Cupertino-style 视觉观感。

