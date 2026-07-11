# MG / ZIP 导入一致性状态

最后更新：2026-07-11（letterSpacing 破解 + 渐变 ratio 视觉真值 pass）

## 当前基准（四个测试集）

| 集 | MG 文件 | 记录数 | 导出形态 | 状态 |
|---|---|---|---|---|
| `测试集/0` | `插件测试.mg` | 191/191 | share（194 component-root 标记） | **全类别 0** |
| `测试集/1` | `测试集 0710-1.mg` | —/— | share（62 标记） | 45 geometry / 32 transform / 157 deep（既有运行时派生族） |
| `测试集/2` | `测试集 0710-2.mg` | 1357/1357 | **完整导出**（0 标记，无 share 模式） | 7 geometry / **9 deep**（同一运行时派生族，见下） |
| `测试集/0711-1` | `测试集 0711-1.mg` | 23/23 | share | 除 `0:50 Subtract` 宽高（1 geometry / 2 deep，布尔结果盒族）外全 0 |

比较命令（每集）：

```bash
node tools/compare_mg_import.js 测试集/<i>/<file>.mg 测试集/<i>/<baseline>.zip --json
```

任何解码改动必须四集全跑：目标集改善、其余集 diff **逐条 byte-identical**（不只是计数相同）。
本轮实测方法：worktree 取 HEAD 双跑 `--json`，按 JSON 行做集合差 —— added 必须为 0，
removed 必须全部属于本轮目标字段。

## 本轮（2026-07-11 letterSpacing + 渐变视觉真值 pass）修复

1. **letterSpacing 破解**（样式条目 `08`/`0b`，另 `06` = 行高单位旗标）：
   `08 <f>` = 字距值（负值=压缩字距）、`0b 01` = 单位 PIXELS（缺省=PERCENT）。
   测试集/1 与 /2 各消掉 142 条 unit-only 残差（上一轮"字节级无区分位"的结论被
   `0b` 推翻）；0711-1 的 4px 字距样本逐值命中。
2. **渐变 ratio 视觉真值翻案**：ZIP 基准对该字段**不是 ground truth** ——
   MasterGo 插件 API 的 transform 用折叠值 `min(r, 2|major|/r)` 构建，与自家渲染器在
   `r² > 2|major|` 时不一致且不可逆（Tesla 车身截图实锤，见 `MG_DECODER.md`）。
   - 裸 `03`：scalar 直存 ratio（不再 min()）。
   - 扩展 `06` 子对象：`{scalar, field06/scalar}` 分支对取**较大者**（同一设计两次
     导出存相反分支：0710-2 存 0.4117 除法得真值、0711-1 直存 3.5696）。
   - 比较器新增 `foldGradientTransform` 归一化：已知导出端折叠不再误报 decoder 回归。
   - SendToFigma：优先信运行时可能提供的真实第 3 个 handle（typings 只声明 2 个）。
   - **zip 侧径向渐变已修（当日晚，SVG 自证）**：导出端对含径向渐变的节点做
     `exportAsync(SVG)`，从渲染器输出的 `<radialGradient gradientTransform>` 反推真
     ratio（`enrichRadialGradientTruth` + `serializers/svgGradientTruth.ts`），绕开 API
     折叠；**需重新导出 zip 生效**。ratio 对 viewBox 平移/统一缩放不变；按 stops 匹配
     paint；门槛子树 ≤40 节点、SVG ≤2MB，失败静默回退。角向/菱形无 SVG 等价物，
     仍为折叠近似。测试 `svgGradientTruth.test.js` 4 项（合成 Tesla 用例 + 跨插件
     transform 一致性断言）。**第一次重导出实测翻车**：MasterGo 的 SVG 导出器把
     半径写反槽位（沿轴/垂直互换），产出第三个错误值 0.2006；已改为双候选读取 +
     「沿轴半径==|p1−p0|」不变量仲裁（两节点实测命中真值），需**再次重导出** zip。
3. **SECTION 恒 FIXED/FIXED**（trailer 21/22 对 SECTION 无意义）。

## 2026-07-11 大文件修复（特斯拉 Model 3 车载系统）

- 无斜杠 Boolean 槽位覆盖记录（VECTOR 仍带子）改判 BOOLEAN_OPERATION 走布尔树，
  修复 5779/5643 还原计数崩溃；四回归集零触发。
- `mgFindTemplateRoot` 名字门槛前置，转换从二次方降为线性（大文件分钟级→秒级）。

## 剩余项（有意不修，运行时派生族）

- 测试集/2 的 9 deep + 7 geometry 与 0711-1 的 Subtract 宽高同族：2 Group / 2 Subtract
  （布尔结果盒需路径求值，.mg 存 MasterGo 自身包围盒）、3 connector waypoints ±1px、
  文本派生尺寸。Figma 导入时 figma.subtract / 实时字体会自行重算。
- 测试集/1 的 45/32/157：文档已记录的 live-font / Boolean 运行时派生族。

## 历史

- 2026-07-10 测试集 2 全量导出 pass：几何 blob 零压缩浮点、MD5("") 空 blob、
  扩展渐变 `06` 解析（除法规则本轮已被 max() 取代）、absent-`0a` padding 缺省。
- 2026-07-10 文本/渐变 pass（插件测试.mg 全类别归零）：样式表 `0c/12`、decoration、
  lineHeight `-1=AUTO`、font-run 列表、渐变裸 `03` ratio min() 规则（本轮已改直存）、
  零宽细线、按钮实例居中平移。
- 更早（1388 记录旧 fixture,文件已删）：顺序标量解析、`_mg` 页名后缀、Boolean 叶裁剪、
  实例可见性/浅 transform、radial axis-scale、GROUP 重算、quarter-stroke Boolean、
  v2 包校验和回滚。

## 验证

- `node --test tools/tests/*.test.js`：25 项通过。
- `ReceiveFromMasterGo` / `SendToFigma` `npm run build`：均通过（`ui.html` 由构建生成）。
- 四集 comparator：集 0 全零；集 1/2 严格差集 added=0、removed 全为 letterSpacing；
  0711-1 仅剩 Subtract 族。
