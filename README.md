# MasterGo2Figma

将 MasterGo 设计稿导入 Figma，并尽可能还原为可继续编辑的页面、图层与本地样式。

**推荐直接安装已发布的 Figma 社区插件：
[MasterGo Importer · Figma Community](https://www.figma.com/community/plugin/1662512589841230294)**

普通用户不需要克隆仓库、安装 Node.js，也不需要运行 MasterGo 端插件：从 MasterGo 导出 `.mg` 文件后，直接在 Figma 中用 MasterGo Importer 打开即可。

## 快速使用

1. 在 MasterGo 中导出需要迁移的 `.mg` 文件。
2. 在 Figma 中安装并运行 [MasterGo Importer](https://www.figma.com/community/plugin/1662512589841230294)。
3. 将一个或多个 `.mg` 文件拖入插件，或点击「选择文件」。
4. 查看解析出的页面和图层数量，勾选需要导入的页面。
5. 点击「导入」，等待进度完成。

插件会在当前 Figma 文件中创建新页面。导入完成后可以直接编辑图层；如有图片缺失、连接线降级或字体未完全恢复，结果页会显示详情。

更完整的安装、使用与排错说明见 [QUICKSTART.md](QUICKSTART.md)。

## 当前能力

- 直接解析 MasterGo 原生 `.mg`，包括完整文件以及 share / 局部导出形成的不同记录结构。
- 一次选择多个文件，并在导入前按页面勾选。
- 还原常见图形、矢量网络、布尔运算、Group、Section、自动布局与绝对定位。
- 还原组件、组件集、变体和实例；对定义顺序晚于实例的文件进行依赖排序和延迟重连。
- 还原文本及混合样式，包括字号、字重、行高、字距、大小写和装饰等属性。
- 重建并绑定本地 Paint / Text / Effect Style。
- 还原图片填充及 FILL、FIT、CROP、TILE 等模式。
- 还原描边、圆角、透明度、混合模式、阴影、模糊和线性 / 径向 / 角向 / 菱形渐变。
- 还原连接线；无法恢复原端点时会降级为普通折线并在结果中提示。
- 按页准备和分块传输数据，页面完成后及时释放缓存，降低大文件导入的内存峰值。

原生 `.mg` 解码器已通过多组 MG / ZIP 对照样例和统一回归集验证。格式细节、已知差异与验证状态见：

- [`.mg` 解码格式说明](docs/MG_DECODER.md)
- [MG / ZIP 一致性状态](docs/MG_ZIP_PARITY_STATUS.md)
- [统一回归测试集](docs/TESTSET_UNIFIED_REGRESSION.md)
- [逆向过程与方法论](docs/MG_DECODER_JOURNAL.md)

## 项目结构

- `ReceiveFromMasterGo/`：Figma 端插件，发布名称为 **MasterGo Importer**。负责解析 `.mg`、选择页面并在 Figma 中还原图层。
- `ReceiveFromMasterGo/ui-src/`：React 18 + Tailwind + shadcn/ui 插件界面源码。
- `ReceiveFromMasterGo/src/ui/mgPackage.js`：MasterGo 原生 `.mg` 二进制解码器。
- `SendToFigma/`：MasterGo 端导出工具，用于生成 MasterGo2Figma v2 ZIP；目前作为高级兼容与对照路径保留。
- `pythonParser/mg_to_zip.py`：无需启动 Figma 插件，将 `.mg` 转为 v2 ZIP 的命令行工具。
- `tools/mastergo_relay_server.py`：SendToFigma 大文件导出时使用的本地中继服务。
- `shared/`：两端共用的类型、矩阵、矢量、连接线与图层规则。

## 高级用法

### 在命令行将 `.mg` 转成 v2 ZIP

适合批处理、调试或在没有 Figma 的环境中预处理文件：

```bash
python3 pythonParser/mg_to_zip.py 输入.mg -o 输出.zip
```

该工具复用 MasterGo Importer 的同一份解码器。生成的 ZIP 可用于调试、对照，也可在插件「实验室」中启用 ZIP 导入后打开。

### 使用 SendToFigma 导出 v2 ZIP

仓库仍保留 MasterGo 端的 `SendToFigma`。它通过 MasterGo 插件 API 读取实时图层树，主要用于开发对照以及原生 `.mg` 暂未覆盖的特殊情况：

1. 在 MasterGo 中以开发插件方式载入 `SendToFigma/manifest.json`。
2. 小文件可选择直接生成 ZIP。
3. 较大文件可先在仓库根目录运行：

   ```bash
   python3 tools/mastergo_relay_server.py
   ```

4. 在 SendToFigma 中选择流传输到 `http://127.0.0.1:8765`。
5. 生成的文件位于 `mastergo2figma-relay-output/<transferId>.zip`。

ZIP 导入目前位于 MasterGo Importer 的「实验室」中，默认关闭。

## 已知边界

- MasterGo 在导入、保存或导出过程中可能不写出某些属性，或将它们转换为运行时派生值；源文件没有保留的数据无法在 Figma 端重建。
- 布尔结果包围盒、连接线拐点和文本尺寸可能由 Figma 重新计算，因此会出现少量像素级差异。
- 缺少的本机字体需要先安装到系统。新安装字体未被识别时，可在插件「实验室」中使用「刷新字体」。
- 特别大的 `.mg` 仍可能受 Figma 插件运行时内存限制影响，建议只勾选本次需要的页面并分批导入。
- SendToFigma 的本地中继只能降低 UI 打包 ZIP 的内存峰值，不能消除 MasterGo `mg.ui.postMessage` 桥接大量数据时的宿主内存开销。

## 本地开发

要求 Node.js、npm 和 Python 3。分别安装依赖并构建两个插件：

```bash
cd SendToFigma
npm install
npm run build

cd ../ReceiveFromMasterGo
npm install
npm run build
```

接收端构建会从 `ReceiveFromMasterGo/ui-src/` 生成单文件 `ReceiveFromMasterGo/ui.html`，请勿手动修改生成文件。

涉及 `.mg` 解码逻辑时，可运行：

```bash
node tools/compare_mg_import.js 输入.mg 基准.zip
node --test tools/tests/*.test.js
```

提交前至少确认两个插件的 `npm run build` 都能通过。详细开发约定见 [AGENTS.md](AGENTS.md)。

## 开源协议

本项目采用 [知识共享 署名-非商业性使用-相同方式共享 4.0 国际许可协议（CC BY-NC-SA 4.0）](LICENSE)。
