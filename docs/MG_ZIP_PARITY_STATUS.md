# MG / ZIP 导入一致性状态

最后更新：2026-07-10（文本/渐变全对齐 pass）

## 当前基准

- MG 文件：`插件测试.mg`（share/局部导出，191 条记录）
- ZIP 基准：`mastergo2figma-partial-pages-2026-07-10T10-06-04-636Z.zip`
- MG / ZIP 记录数：`191 / 191`
- **所有比较类别全部为 0**：Missing、Extra、Type、Parent、Index、Child Order、
  Geometry、Transform、Effect、Text、Font、Paint、Vector Network、Deep Property。
- comparator 退出码 0；`ReceiveFromMasterGo` `npm run build` 通过。

MG 解码 canonical digest：`fnv1a32:a7bb1237`（ZIP 基准 `fnv1a32:a66b7422`；
digest 含页名 `_mg` 后缀等预期差异，不要求相等）。

## 本轮（2026-07-10 文本/渐变 pass）修复

- 样式表条目 `0c`/`12`（psName/styleName）与 decoration 字节：Bold/SemiBold
  不再退化为 Regular；下划线条目不再被 scanner 正则漏掉。
- `lineHeight -1` = AUTO 哨兵；letterSpacing 单位改为 `{0, PERCENT}`。
- font-run 列表破解：characters 按 sortId 拼接；styledTextSegments 由
  font-run × color-run 边界并集生成，`mgFidelityStyledTextSegments`
  名字硬编码删除。
- 渐变 `06/03` ratio 统一为 `min(scalar, 2×|p1−p0|/scalar)`，覆盖直存与倒数两种编码。
- 显式零宽细线不再被 vn-bounds 推导抬成 1（`hasExplicitW/H` 门）。
- 按钮实例居中平移只作用于仍在模板 x 的子节点，浅记录坐标不再双重平移。

## 历史（1388 记录旧 fixture，文件已删，仅存档）

## 已完成的修复

- 顺序解析标量 `0x05..0x1b`，保留字段存在性、LEB128 override mask 和 transform 子字段。
- MG 页面统一添加一个 `_mg` 后缀，普通 ZIP 页面名称不变。
- 精确识别 43 个 childless Boolean VECTOR 叶并删除 94 个 operand 后代。
- 修复实例可见性、浅层 transform/matrix 继承和 `+180 → -180` 规范化。
- 修复径向渐变 `06/03` axis-scale 转换、paint replace/clear/merge、effect、arc、text case 和 styled runs。
- 按可见子节点、mask 和已验证约束重算合成 GROUP；隐藏子节点同步反向平移。
- 修复 quarter-stroke Boolean、`UNION(EXCLUDE, VECTOR)` 和双 EXCLUDE 等结构族的原点与尺寸。
- 为 v2 包增加共享校验和 canonical digest；无效包在创建页面前终止，关键还原失败触发回滚。
- 文本核心属性与可选格式分离，单个不支持的格式不再删除整个文本节点。

## 剩余差异分类

- 23 个 TEXT：`WIDTH_AND_HEIGHT` Montserrat 的实时字体度量与 Node 侧模板缩放盒不同。
- 9 个 GROUP/FRAME：位置或 bounds 由上述实时文本尺寸派生。
- 1 个 GROUP：小幅文本派生尺寸差异。
- 7 个 BOOLEAN_OPERATION：同一个空 vector / 1×1 Boolean fallback 原点族。

这些残差没有使用图层名或节点 ID 硬编码。下一轮以 Figma 手动导入后的运行时页面为准，因为 Figma 会重新计算原生文本和 Boolean 容器，包级 layout 差异不一定会成为最终视觉差异。

## 历史审计结论

修复前的 Figma ZIP/MG 扫描曾识别以下问题族：

- 几何与局部 transform；
- 13 个 instance visibility override；
- paint precedence 与 gradient transform；
- blur/shadow effect 参数；
- text case、rich text runs 与 Montserrat 字体；
- arc sweep；
- runtime vector 表示差异；
- GROUP/Boolean 派生 bounds。

旧的逐层 Markdown/JSON 明细对应已删除的 Figma 页面和修复前代码，已不再作为当前测试依据。当前权威机器结果来自：

```bash
node tools/compare_mg_import.js \
  新文件.mg \
  mastergo2figma-partial-pages-2026-07-10T02-21-12-362Z.zip \
  --json
```

## 验证

- `node --test tools/tests/*.test.js`：14 项通过。
- `ReceiveFromMasterGo npm run build`：通过，`ui.html` 由构建脚本生成。
- `SendToFigma npm run build`：通过。
- Python CLI v2 包校验与 canonical digest：通过。
- 文档中提到的旧版 MG/ZIP 回归对当前不在工作区，未执行该组回归。

