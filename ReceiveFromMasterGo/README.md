# ReceiveFromMasterGo

Figma 端还原插件。用于上传 `SendToFigma` 导出的 MasterGo2Figma JSON zip，并在当前 Figma 文件中还原页面和图层。

## 用法

1. 在 Figma 中安装并运行 `ReceiveFromMasterGo`。
2. 选择 `SendToFigma` 生成的 `.zip` 文件。
3. 点击开始还原，等待进度完成。

发送端无论使用 `直接生成 zip` 还是 `流传输到本地`，接收端都使用同一个 zip 上传入口。

## 支持的 zip 结构

- zip 根目录直接包含 `manifest.json`。
- zip 内有一个顶层目录，顶层目录内包含 `manifest.json`。

## 注意事项

- 本插件不读取旧版 Sketch 转移页。
- 转换规则已内置，不需要上传规则 JSON。
- 大文件还原可能耗时较长，插件会显示进度和预计剩余时间。

## 开发

```bash
npm install
npm run build
```
