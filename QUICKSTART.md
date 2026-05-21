# MasterGo2Figma Quickstart

把 MasterGo 文件中的图层导出为 MasterGo2Figma JSON zip，并在 Figma 中还原为可编辑图层。

## Environment Requirements

- Git
- Node.js 和 npm
- Python 3
- MasterGo 客户端
- Figma Desktop

检查本机环境：

```bash
git --version
node --version
npm --version
python3 --version
```

如果缺少 Node.js 或 npm，先安装 Node.js LTS。Python 本地中继服务只使用标准库，不需要额外安装 Python 依赖。

## Get The Repository

如果当前目录还没有项目，先 clone：

```bash
git clone https://github.com/XuWeinan123/MasterGo2Figma.git
cd MasterGo2Figma
```

如果已经在仓库根目录，继续下一步。

## Install And Build

本项目有两个本地插件：

- `SendToFigma`：MasterGo 发送端插件。
- `ReceiveFromMasterGo`：Figma 接收端插件。

分别安装依赖并构建：

```bash
cd SendToFigma
npm install
npm run build

cd ../ReceiveFromMasterGo
npm install
npm run build

cd ..
```

构建成功后，确认这两个文件存在：

```text
SendToFigma/code.js
ReceiveFromMasterGo/code.js
```

插件通过各自目录里的 `manifest.json` 启用：

```text
SendToFigma/manifest.json
ReceiveFromMasterGo/manifest.json
```

本仓库已经包含 `package.json`，不需要重新执行 `npm init`。

## Enable In MasterGo

MasterGo 端用于导出 zip，启用 `SendToFigma`：

1. 打开 MasterGo 客户端，并打开一个设计文件。
2. 点击画布上方「插件」。
3. 进入「开发插件」或「开发者模式」。
4. 选择「创建/开发插件」或「创建/添加插件」。
5. 选择上传或导入 `manifest.json`。
6. 选择：

```text
SendToFigma/manifest.json
```

7. 导入后，在「插件」菜单或画布右键菜单里运行 `SendToFigma`。

如果 MasterGo 提示无法读取 main 文件，重新构建发送端：

```bash
cd SendToFigma
npm run build
cd ..
```

## Enable In Figma

Figma 端用于上传 zip 并还原图层，启用 `ReceiveFromMasterGo`：

1. 打开 Figma Desktop，并打开一个 Figma Design 文件。
2. 在画布中右键，选择 `Plugins` 或 `Select plugins`。
3. 进入 `Development`。
4. 选择 `Import plugin from manifest...`。
5. 选择：

```text
ReceiveFromMasterGo/manifest.json
```

6. 导入后，在 Actions 菜单或 `Plugins > Development` 中运行 `ReceiveFromMasterGo`。

如果 Figma 找不到插件或无法运行，重新构建接收端：

```bash
cd ReceiveFromMasterGo
npm run build
cd ..
```

## Start The Python Relay

小文件可以在 MasterGo 插件里选择「直接生成 zip」，不需要 Python 服务。

大文件建议使用「流传输到本地」。在仓库根目录启动本地中继：

```bash
python3 tools/mastergo_relay_server.py
```

默认服务地址：

```text
http://127.0.0.1:8765
```

启动成功后，终端会显示类似：

```text
[relay] listening on http://127.0.0.1:8765
[relay] output root: /path/to/MasterGo2Figma/mastergo2figma-relay-output
```

服务运行时，在 MasterGo 的 `SendToFigma` 插件里：

1. 选择「流传输到本地」。
2. 确认地址是 `http://127.0.0.1:8765`。
3. 点击「测试」或直接开始导出。
4. 导出完成后，在下面目录找到 zip：

```text
mastergo2figma-relay-output/<transferId>.zip
```

保持终端窗口开启。导出结束后，可以按 `Control + C` 停止服务。

## Full Workflow

1. `git clone` 仓库并进入 `MasterGo2Figma`。
2. 在 `SendToFigma` 和 `ReceiveFromMasterGo` 中分别执行 `npm install` 和 `npm run build`。
3. 在 MasterGo 中导入 `SendToFigma/manifest.json`。
4. 在 Figma Desktop 中导入 `ReceiveFromMasterGo/manifest.json`。
5. 如果导出页面较大，启动 `python3 tools/mastergo_relay_server.py`。
6. 在 MasterGo 运行 `SendToFigma`，导出 zip。
7. 在 Figma 运行 `ReceiveFromMasterGo`，上传 zip 并还原图层。

## What To Report Back

完成初始化后，告知使用者：

- 两个插件是否都已构建成功。
- MasterGo 应导入 `SendToFigma/manifest.json`。
- Figma 应导入 `ReceiveFromMasterGo/manifest.json`。
- 大文件导出前需要在仓库根目录运行 `python3 tools/mastergo_relay_server.py`。
- Python 服务地址是 `http://127.0.0.1:8765`。
- 本地流传输生成的 zip 位于 `mastergo2figma-relay-output/<transferId>.zip`。

## Common Commands

重新构建 MasterGo 发送端：

```bash
cd SendToFigma
npm run build
cd ..
```

重新构建 Figma 接收端：

```bash
cd ReceiveFromMasterGo
npm run build
cd ..
```

启动 Python 中继：

```bash
python3 tools/mastergo_relay_server.py
```

检查 Python 中继是否可访问：

```bash
curl http://127.0.0.1:8765/health
```

## Troubleshooting

### MasterGo 导入后无法运行

确认 `SendToFigma/code.js` 存在，且 `SendToFigma/manifest.json` 里的 `main` 指向 `code.js`。如果不存在，执行：

```bash
cd SendToFigma
npm run build
cd ..
```

### Figma 导入后无法运行

确认 `ReceiveFromMasterGo/code.js` 存在，且 `ReceiveFromMasterGo/manifest.json` 里的 `main` 指向 `code.js`。如果不存在，执行：

```bash
cd ReceiveFromMasterGo
npm run build
cd ..
```

### MasterGo 无法连接 Python 服务

确认服务还在运行，并检查：

```bash
curl http://127.0.0.1:8765/health
```

正常时会返回包含 `ok: true` 的 JSON。

### 大文件仍然导出失败

优先使用「流传输到本地」，并减少单次导出的页面或图层范围。Python 中继能降低插件 UI 打包 zip 的内存压力，但不能完全规避 MasterGo 插件桥接大量数据时的宿主内存限制。

## References

- MasterGo 插件开发：在 MasterGo 客户端中，通过「插件」进入「开发插件」并上传 `manifest.json`。
- Figma 本地插件导入：在 Figma Desktop 中通过 `Plugins / Select plugins > Development > Import plugin from manifest...` 导入 `manifest.json`。
