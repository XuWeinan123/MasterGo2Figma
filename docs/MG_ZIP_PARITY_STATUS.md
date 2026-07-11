# MG / ZIP 导入一致性状态

最后更新：2026-07-10（测试集 0/1/2 三集回归 harness + 全量导出矢量/渐变/padding pass）

## 当前基准（三个测试集）

| 集 | MG 文件 | 记录数 | 导出形态 | 状态 |
|---|---|---|---|---|
| `测试集/0` | `插件测试.mg` | 191/191 | share（194 component-root 标记） | **全类别 0** |
| `测试集/1` | `测试集 0710-1.mg` | —/— | share（62 标记） | 45 geometry / 32 transform / 299 deep（既有运行时派生族，本轮未变） |
| `测试集/2` | `测试集 0710-2.mg` | 1357/1357 | **完整导出**（0 标记，无 share 模式） | deep 3572 → **151**，其余类别 0 |

比较命令（每集）：

```bash
node tools/compare_mg_import.js 测试集/<i>/<file>.mg 测试集/<i>/<baseline>.zip --json
```

任何解码改动必须三集全跑：目标集改善、另两集 diff **逐条 byte-identical**（不只是计数相同）。

## 本轮（2026-07-10 测试集 2 全量导出 pass）修复

1. **几何 blob 点记录零压缩浮点**（`mgDecodeGeometryBlob`）：`float4()` 定长读法在
   x/y/cornerRadius 为 0（单字节 `00`）时多吞 3 字节导致整个 blob 崩溃。修复后 0710-2 的
   blob 解码 7/133 → 132/133，vectorNetwork 缺失 420 → 0、错值 11 → 0。集 0/1 的导出器
   对零值走"省略字段"路线，两种读法逐字节等价（A/B 实证 468+94 个 blob 全一致）。
2. **MD5("") 空 blob = 空 vectorNetwork**：`D41D8CD9…` 四区段全空、止于 `06` trailer,
   是 43 个拍平布尔叶的真实几何（基准即空 VN），不再判为解码失败。
3. **径向渐变扩展 `06` 子对象**（字段 01–06）：ratio = `field06 / field03` 精确除法
   （16 个已知答案全中，min() 启发式只用于裸 `03` 旧形式）。此前解析器遇到未知字段 01
   直接丢掉整条 paint——0710-2 的径向渐变填充全部消失而线性渐变幸存的根因。
4. **完全缺失的 `0a` padding 对象**并入 `paddingsMissing` 缺省规则（完整导出=10、
   share 模板节点=0）：1076 项 padding diff → 0，集 1 的 194 个 absent-`0a` 模板子节点
   走 md=0 分支不受影响。

新增回归测试 4 个（`tools/tests/mgPackage.test.js`，共 18 个全过）：零压缩点浮点、
空 blob、扩展渐变 `06`、padding 三种拼写。

## 测试集 2 剩余 151 项（有意不修）

- **142 × letterSpacing.unit**（`{0,PERCENT}` vs `{0,PIXELS}`）：视觉完全等价。
  样式条目字节级无区分位（0e 假说已证伪，见 `MG_DECODER.md`），仅剩文件级版本猜测,
  不值得引入脆弱启发式。
- **9 × 亚像素宽高**（2 Group、2 Subtract、3 connector waypoints ±1px、文本派生）：
  文档已记录的 live-font / Boolean 运行时派生族,Figma 导入时自行重算。

## 历史

- 2026-07-10 文本/渐变 pass（插件测试.mg 全类别归零）：样式表 `0c/12`、decoration、
  lineHeight `-1=AUTO`、font-run 列表、渐变裸 `03` ratio `min()` 规则、零宽细线、
  按钮实例居中平移。
- 更早（1388 记录旧 fixture,文件已删）：顺序标量解析、`_mg` 页名后缀、Boolean 叶裁剪、
  实例可见性/浅 transform、radial axis-scale、GROUP 重算、quarter-stroke Boolean、
  v2 包校验和回滚。

## 验证

- `node --test tools/tests/*.test.js`：18 项通过。
- `ReceiveFromMasterGo` / `SendToFigma` `npm run build`：均通过（`ui.html` 由构建生成）。
- 三集 comparator：集 0 全零、集 1 diff 逐条与修前 byte-identical、集 2 如上。
