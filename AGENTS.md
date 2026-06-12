# Repository Guidelines

## Project Structure & Module Organization

本仓库用于在 MasterGo 与 Figma 之间迁移设计图层。`SendToFigma/` 是 MasterGo 端插件，负责读取页面、序列化图层并导出 MasterGo2Figma JSON zip；核心代码在 `SendToFigma/src/`，打包产物为 `SendToFigma/code.js`。`ReceiveFromMasterGo/` 是 Figma 端插件，负责上传 zip 并还原为可编辑图层；核心代码在 `ReceiveFromMasterGo/src/`，UI 模板在 `ReceiveFromMasterGo/ui.template.html`，生成后的 UI 在 `ReceiveFromMasterGo/ui.html`。

共享类型与工具函数放在 `shared/`，本地大文件中继服务在 `tools/mastergo_relay_server.py`。说明文档包括 `README.md`、`QUICKSTART.md`、`MG_DECODER.md`；截图与示例资源放在 `assets/`。不要手动修改第三方依赖目录或构建缓存。

## Build, Test, and Development Commands

两个插件分别安装依赖和构建：

```bash
cd SendToFigma && npm install && npm run build
cd ReceiveFromMasterGo && npm install && npm run build
```

`npm run build` 会先执行 TypeScript 类型检查，再用 `esbuild` 输出 `code.js`；接收端还会先运行 `node tools/build-ui.js` 生成 UI。开发时可使用：

```bash
cd SendToFigma && npm run watch
cd ReceiveFromMasterGo && npm run watch
python3 tools/mastergo_relay_server.py
```

Python 中继服务默认监听 `http://127.0.0.1:8765`，用于大文件流式写入本地 zip。

## Coding Style & Naming Conventions

主要代码使用 TypeScript，保持 2 空格缩进、显式类型、早返回和小函数。文件名沿用现有 camelCase 风格，例如 `nodeSerializer.ts`、`matrixUtils.ts`。序列化逻辑放在 `serializers/`，还原逻辑放在 `appliers/`；跨端复用逻辑优先放入 `shared/`。避免在业务代码中散落 magic number，应集中到配置或命名常量。

## Testing Guidelines

当前仓库没有独立测试框架或 `__tests__` 目录。提交前至少运行两个插件的 `npm run build`，并按变更方向手动验证：MasterGo 端导出 zip、Figma 端导入 zip、大文件场景使用本地中继服务。新增可自动化测试时，建议按模块命名为 `*.test.ts`，并优先覆盖矩阵、矢量、文本、容器和 connector 转换逻辑。

## Commit & Pull Request Guidelines

Git 历史使用简短动词短语，允许中文或英文，例如 `Improve large MG import streaming`、`修复 bug，抽象 ui 中的逻辑`。提交信息应说明用户可见行为或修复点，避免只写 `update`。Pull Request 需包含变更摘要、构建结果、手动验证步骤；涉及 UI 或图层还原效果时附截图或示例 zip。若修复已知问题，请关联 issue 或在描述中列出复现路径。

## Security & Configuration Tips

不要提交包含私有设计内容的大型 `.mg`、导出 zip 或本地 relay 输出，除非它们是明确脱敏的测试样例。修改 `manifest.json`、插件权限或本地服务端口时，在 PR 中说明原因和兼容影响。
