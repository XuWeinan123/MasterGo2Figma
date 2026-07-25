# MasterGo2Figma 快速开始

## 普通用户：直接安装社区插件

使用已发布的 Figma 社区版不需要下载本仓库，也不需要安装 Node.js 或 Python。

**插件地址：[MasterGo Importer · Figma Community](https://www.figma.com/community/plugin/1662512589841230294)**

### 1. 准备 MasterGo 文件

在 MasterGo 中导出需要迁移的原生 `.mg` 文件。建议保留原始文件，并先用一个页面较少的文件熟悉流程。

### 2. 在 Figma 中运行插件

1. 打开上方插件地址，点击安装或运行。
2. 打开一个 Figma Design 文件。
3. 从 Actions / Plugins 中运行 **MasterGo Importer**。

### 3. 选择文件和页面

1. 将一个或多个 `.mg` 文件拖入插件，也可以点击「选择文件」。
2. 等待插件解析文件。
3. 在页面列表中勾选需要导入的页面；默认全选。
4. 点击「导入 N 个页面」。

插件会在当前 Figma 文件中创建新页面。导入期间请保持插件窗口和当前 Figma 文件打开。

### 4. 检查导入结果

完成页会显示导入的页面数和图层数。若出现以下情况，可展开「查看详情」：

- 图片资源缺失。
- 连接线无法恢复端点，已降级为普通折线。
- 部分缺失字体已替换，或仍未找到合适字体。

点击「完成」关闭插件，或点击「重新导入」继续处理其他文件。

## 常见问题

### 无法读取 `.mg`

- 确认扩展名为 `.mg`，文件没有损坏，并且是由 MasterGo 导出的文件。
- 重新从 MasterGo 导出后再试。
- 如果问题可以稳定复现，请在 [GitHub Issues](https://github.com/XuWeinan123/MasterGo2Figma/issues) 中附上错误详情；不要公开上传包含私密设计内容的文件。

### 导入后字体不同

先在系统中安装设计稿使用的字体，然后重新启动 Figma。若字体刚刚安装仍未被识别：

1. 打开插件底部的「实验室」。
2. 点击「刷新字体」。
3. 返回并重新导入。

MasterGo 与 Figma 的字体名称或可用字重不完全一致时，插件会尽量选择可用字体，但结果仍可能需要手动确认。

### 大文件导入失败或很慢

- 只勾选本次需要的页面，分批导入。
- 关闭不需要的 Figma 文件和其他占用内存的应用。
- 已成功导入的页面会保留；失败后可重新运行插件处理剩余页面。

### 少数图层和 MasterGo 有差异

MasterGo 可能在导出时省略属性，或在导入 / 保存过程中改写组件、字体、布尔运算、渐变等运行时数据。复杂布尔结果、连接线和文本尺寸也可能被 Figma 重新计算。建议优先检查：

- 字体是否已安装。
- 图片是否仍存在于 `.mg` 中。
- 组件实例、自动布局和隐藏图层是否符合预期。
- 渐变、裁剪图片和效果是否需要少量人工校正。

## 开发者：本地构建插件

只有参与开发、调试解码器或使用未发布代码时，才需要下面的步骤。

### 环境要求

- Git
- Node.js 和 npm
- Python 3（仅命令行转换或本地中继需要）
- MasterGo 客户端
- Figma Desktop

### 获取并构建

```bash
git clone https://github.com/XuWeinan123/MasterGo2Figma.git
cd MasterGo2Figma

cd SendToFigma
npm install
npm run build

cd ../ReceiveFromMasterGo
npm install
npm run build

cd ..
```

构建成功后应存在：

```text
SendToFigma/code.js
ReceiveFromMasterGo/code.js
ReceiveFromMasterGo/ui.html
```

### 在 Figma 中载入本地开发版

1. 打开 Figma Desktop 和一个 Figma Design 文件。
2. 进入 `Plugins / Development`。
3. 选择 `Import plugin from manifest...`。
4. 选择 `ReceiveFromMasterGo/manifest.json`。
5. 从开发插件列表运行 **MasterGo Importer**。

本地开发版与社区版使用同一个插件 ID。调试未发布改动时，请确认运行的是 `Development` 下的本地插件。

## 可选工具

### 将 `.mg` 转成 v2 ZIP

无需启动 Figma：

```bash
python3 pythonParser/mg_to_zip.py 输入.mg -o 输出.zip
```

CLI 复用插件内的原生 `.mg` 解码器，需要 Python 3 和 Node.js。生成的 ZIP 主要用于批处理、调试和 MG / ZIP 对照。

### 启用实验室 ZIP 导入

MasterGo Importer 默认只接受 `.mg`。如需导入 v2 ZIP：

1. 打开插件底部的「实验室」。
2. 开启「启用 ZIP 导入」。
3. 返回主界面并选择 `.zip`。

ZIP 应在根目录或单一顶层目录中包含 `manifest.json`。

### 使用 MasterGo 端 SendToFigma

1. 在 MasterGo 中以开发插件方式导入 `SendToFigma/manifest.json`。
2. 运行 SendToFigma，选择直接生成 ZIP；较大文件可使用本地流传输。
3. 本地流传输前，在仓库根目录启动：

   ```bash
   python3 tools/mastergo_relay_server.py
   ```

4. 默认服务地址为 `http://127.0.0.1:8765`，输出文件位于：

   ```text
   mastergo2figma-relay-output/<transferId>.zip
   ```

健康检查：

```bash
curl http://127.0.0.1:8765/health
```

本地中继可减少 UI 打包大 ZIP 的内存峰值，但无法完全避免 MasterGo 插件桥接大量数据时的宿主内存限制。

## 开发验证

重新构建 Figma 插件：

```bash
cd ReceiveFromMasterGo
npm run build
```

重新构建 MasterGo 插件：

```bash
cd SendToFigma
npm run build
```

运行解码器与渐变相关测试：

```bash
node --test tools/tests/*.test.js
```

将 `.mg` 与 SendToFigma 基准 ZIP 做递归对比：

```bash
node tools/compare_mg_import.js 输入.mg 基准.zip
```

更多实现细节与已知差异见 [README.md](README.md) 和 [docs/MG_DECODER.md](docs/MG_DECODER.md)。
