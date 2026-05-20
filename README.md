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

## OOM 和 MasterGo 限制说明

本项目已经用本地 Python 中继规避了 UI 侧拼接大 zip / Blob 下载带来的内存峰值，但它不能完全解决 MasterGo 插件主线程的 OOM。

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

实际测试中，MasterGo 插件主线程没有 `fetch` API，无法直接请求本地 Python 服务。因此数据必须经过 `mg.ui.postMessage` 从主线程传到 UI。这个桥接层由 MasterGo 宿主管理，插件 API 没有提供主动释放、零拷贝传输、可写文件句柄或真正的 streaming channel。

因此在超大文件或多页面连续导出时，仍可能在下面阶段 OOM：

- 读取复杂图层对象。
- 构造或 stringify 大量 JSON record。
- 通过 `mg.ui.postMessage` 连续发送大量 JSON / 图片 chunk。

如果遇到 OOM，可以尝试：

- 优先使用 `流传输到本地`，不要用直接 zip。
- 减少单次导出的页面数量。
- 避免一次导出包含大量复杂矢量、布尔运算、超深层级或大量图片的页面。
- OOM 后重新打开插件，从较小范围继续导出。

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
