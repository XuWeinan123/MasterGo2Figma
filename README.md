# MasterGo2Figma

把 MasterGo 文件中的图层导出为 MasterGo2Figma JSON zip，并在 Figma 中用插件还原为可编辑图层。

当前版本不再使用“转移页 + Sketch 导出”的旧方案。发送端统一生成 JSON 包；接收端统一上传 zip 还原。

## 插件组成

- `SendToFigma`：运行在 MasterGo 中，读取页面/图层并导出 MasterGo2Figma JSON 包。
- `ReceiveFromMasterGo`：运行在 Figma 中，上传导出的 zip 并还原图层。
- `tools/mastergo_relay_server.py`：本地 Python 中继服务，用于大文件流式写入本地并自动打包 zip。

## SendToFigma 用法

1. 在 MasterGo 中安装并运行 `SendToFigma` 插件。
2. 选择要导出的页面。
3. 选择传输方式：
   - `直接生成 zip`：适合小文件，插件 UI 会直接生成并下载 zip。
   - `流传输到本地`：适合较大的页面，插件 UI 会把 JSON 和图片分块发送到本地 Python 服务，完成后生成 zip。
4. 点击 `开始`。

### 直接生成 zip

这个模式最方便，不需要启动本地服务。导出完成后会直接下载一个 `.zip` 文件。

注意：直接 zip 会在插件 UI 内存中打包，页面较大时更容易触发内存问题。大文件优先使用本地流式传输。

### 流传输到本地

先在仓库根目录启动本地服务：

```bash
python3 tools/mastergo_relay_server.py
```

默认服务地址是：

```text
http://127.0.0.1:8765
```

然后在 `SendToFigma` 中选择 `流传输到本地`，确认地址后点击 `开始`。导出完成后，服务会在下面目录生成 zip：

```text
mastergo2figma-relay-output/<transferId>.zip
```

中继服务会在完成后删除展开的临时文件夹，只保留最终 zip。

## ReceiveFromMasterGo 用法

1. 在 Figma 中安装并运行 `ReceiveFromMasterGo` 插件。
2. 上传 `SendToFigma` 生成的 `.zip` 文件。
3. 点击开始还原。

无论发送端使用 `直接生成 zip` 还是 `流传输到本地`，接收端都只需要上传最终 zip。

接收端支持两种 zip 结构：

- zip 根目录直接包含 `manifest.json`。
- zip 内有一个顶层目录，顶层目录内包含 `manifest.json`。

### 接收端还原阶段

接收端导入 zip 后，会按下面阶段还原页面和图层：

1. `startImportSession()` 校验 v2 package manifest，初始化运行时状态、图片/页面缓存和进度统计。
2. 通过 `import-asset-*` 接收图片资源分块，通过 `import-page-*` 接收页面 layer 分块，并把每个 layer record 累积到当前页面的导入缓存中。
3. `restoreImportPageData()` 为每个导入页面创建新的 Figma Page，再按 `rootNodeIds` 从根节点开始递归还原。
4. `restoreImportedNode()` 根据图层类型选择还原路径：Boolean tree、native Group、ComponentSet 或普通节点创建；普通节点由 `createNodeFromData()` 创建后 append 到父级。
5. `applyProperties()` 应用名称、可见性、blend、fills/strokes/effects、constraints、layout 等通用属性，并按节点类型继续应用 vector network、文本属性或 connector 属性。
6. 特殊容器在子节点递归完成后 finalize：Group 使用临时 Frame 承载子节点后调用 `figma.group()`，Boolean 执行组合或 fallback，ComponentSet 执行 `combineAsVariants()`。
7. 页面节点创建完成后执行 `applyDeferredLayoutRestores()`，分三步补齐 auto-layout：节点自身 auto-layout、作为父级 auto-layout 子项的属性、固定尺寸和 transform 收尾。native Group 子节点会在这里把局部坐标转换为 Figma Group 所需的父级坐标。
8. 最后执行清理和后处理：删除导入 shell、修正单子节点 `SPACE_BETWEEN`、恢复 deferred connector、尝试恢复缺失字体、定位视口并发送完成通知。

## OOM（Out of Memory 内存溢出） 和 MasterGo 限制说明

这是 MasterGo 插件架构下的共性问题，不是单纯的本项目打包逻辑问题。

本项目已经用本地 Python 中继规避了 UI 侧拼接大 zip / Blob 下载带来的内存峰值，但它只能避免“打包 zip 时”把所有文件聚合到 UI 内存中，不能避免“大量 JSON / 图片 chunk 传输时”造成的 OOM。

当前导出链路是：

```text
MasterGo 插件主线程 code.ts
  -> 读取图层
  -> 转换为 JS record
  -> JSON.stringify
  -> mg.ui.postMessage 发送给 ui.html
  -> ui.html fetch 到本地 Python
  -> Python 写文件并打 zip
```

实际测试中，MasterGo 插件主线程没有 `fetch` API，无法直接请求本地 Python 服务。因此数据必须经过 `mg.ui.postMessage` 从主线程传到 UI。

当插件连续通过 `mg.ui.postMessage` 发送大量 JSON / 图片 chunk 时，MasterGo 宿主需要在主线程、UI bridge 和 UI 之间做序列化、复制或排队。这个桥接层开销由 MasterGo 宿主管理，插件 API 没有提供主动释放、零拷贝传输、可写文件句柄或真正的 streaming channel。因此即使 UI 已经把 chunk 发给 Python 并写盘，插件也无法保证 bridge 内部开销已经被释放。

因此对于特别大的页面或多页面连续导出，当前版本无法保证稳定完成。缩小单次导出范围只能作为临时规避方式，不是根本解决方案。

`流传输到本地` 仍然建议用于较大文件，因为它能避免 UI 打包 zip 的额外内存峰值；但如果 OOM 发生在 `mg.ui.postMessage` 大量传输 JSON / 图片 chunk 的阶段，流式传输本身无法解决。

如果 MasterGo 后续提供插件主线程网络请求、Transferable / zero-copy postMessage、文件系统写入或官方大文件导出 API，才有机会从架构上彻底解决这个问题。

## 开发

两个插件分别编译：

```bash
cd SendToFigma
npm install
npm run build
```

```bash
cd ReceiveFromMasterGo
npm install
npm run build
```

本地中继服务只使用 Python 标准库，不需要额外依赖。

## 开源协议

本项目采用 [知识共享 署名-非商业性使用-相同方式共享 4.0 国际许可协议 (CC BY-NC-SA 4.0)](LICENSE) 进行许可。
