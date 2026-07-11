# Figma diff 与 diff_mg 严格一致性对比报告

- 文件：`x47WqG3ioIDVd2P5mvRAEU`（测试集 0710 2）
- 对比页面：`diff`（`9:2`）与 `diff_mg`（`9:1629`）
- 扫描日期：2026-07-11
- 规则：严格精确相等，不使用数值容差。图片填充按图片字节内容比较，不按页面内局部图片哈希别名比较。

## 覆盖范围与结果

两个页面均恰好包含 **1357 个图层**。已遍历全部 1357 个图层，包括不可见的实例后代图层。图层层级、同级顺序、节点类型和子节点数量完全一致；不存在缺失或额外图层。

严格属性对比发现 **150 个存在差异的图层**：

- 138 个文本图层：ZIP 的 `letterSpacing.unit` 为 `PIXELS`，MG 为 `PERCENT`；两者数值均严格为 `0`。富文本分段的差异完全由同一个字距单位差异引起，不存在其他富文本分段字段差异。
- 12 个矢量/形状图层：渐变变换矩阵的浮点数值不同。
- 上述 12 个图层中的 8 个还存在精确的 `vectorNetwork` 值差异，但顶点、线段和区域数量仍完全相同。

其余已扫描属性均严格一致，包括位置、尺寸、相对/绝对变换、绝对/渲染边界、可见性、不透明度、混合模式、蒙版、裁剪、描边、效果、圆角/弧形数据、约束、自动布局、内边距/间距、文本内容/字体/行高/大小写/装饰，以及矢量拓扑数量。

## 非文本视觉差异（12 个图层）

### `Sidebar/Dark/driving/Dark/Group/Model 3/Car/Group[1]/Rectangle 5`

- 差异属性：`fills`
- `fills.0.gradientTransform.0.0`：ZIP `-9.891201102618652e-8` → MG `-1.418689237198123e-7`
- `fills.0.gradientTransform.0.2`：ZIP `-0.09090908616781235` → MG `-0.09090906381607056`

### `Sidebar/Dark/driving/Dark/Group/Model 3/Car/Group[1]/Subtract/Vector 3[1]`

- 差异属性：`fills, vectorNetwork`
- `fills.1.gradientTransform.1.0`：ZIP `-0.19061395525932312` → MG `-0.19061394035816193`
- `vectorNetwork`：ZIP 哈希 `35736c2f` → MG 哈希 `82deffa6`；拓扑为 ZIP `8 个顶点 / 9 条线段 / 1 个区域`，MG `8 / 9 / 1`。

### `Sidebar/Dark/driving/Dark/Group/Model 3/Car/Group[1]/Subtract/Vector 3[2]`

- 差异属性：`fills, vectorNetwork`
- `fills.1.gradientTransform.1.0`：ZIP `-0.19061395525932312` → MG `-0.19061394035816193`
- `vectorNetwork`：ZIP 哈希 `35736c2f` → MG 哈希 `82deffa6`；拓扑为 ZIP `8 个顶点 / 9 条线段 / 1 个区域`，MG `8 / 9 / 1`。

### `Sidebar/Dark/driving/Dark/Group/Model 3/Car/Group[1]/Vector 3`

- 差异属性：`fills, vectorNetwork`
- `fills.1.gradientTransform.1.0`：ZIP `-0.19061395525932312` → MG `-0.19061394035816193`
- `vectorNetwork`：ZIP 哈希 `35736c2f` → MG 哈希 `82deffa6`；拓扑为 ZIP `8 个顶点 / 9 条线段 / 1 个区域`，MG `8 / 9 / 1`。

### `Sidebar/Dark/driving/Light/Group/Model 3/Car/Group[1]/Rectangle 5`

- 差异属性：`fills`
- `fills.0.gradientTransform.0.0`：ZIP `-9.891201102618652e-8` → MG `-1.418689237198123e-7`
- `fills.0.gradientTransform.0.2`：ZIP `-0.09090908616781235` → MG `-0.09090906381607056`

### `Sidebar/Dark/driving/Light/Group/Model 3/Car/Group[1]/Subtract/Vector 3[1]`

- 差异属性：`fills, vectorNetwork`
- `fills.1.gradientTransform.1.0`：ZIP `-0.19061395525932312` → MG `-0.19061394035816193`
- `vectorNetwork`：ZIP 哈希 `35736c2f` → MG 哈希 `82deffa6`；拓扑为 ZIP `8 个顶点 / 9 条线段 / 1 个区域`，MG `8 / 9 / 1`。

### `Sidebar/Dark/driving/Light/Group/Model 3/Car/Group[1]/Subtract/Vector 3[2]`

- 差异属性：`fills, vectorNetwork`
- `fills.1.gradientTransform.1.0`：ZIP `-0.19061395525932312` → MG `-0.19061394035816193`
- `vectorNetwork`：ZIP 哈希 `35736c2f` → MG 哈希 `82deffa6`；拓扑为 ZIP `8 个顶点 / 9 条线段 / 1 个区域`，MG `8 / 9 / 1`。

### `Sidebar/Dark/driving/Light/Group/Model 3/Car/Group[1]/Vector 3`

- 差异属性：`fills, vectorNetwork`
- `fills.1.gradientTransform.1.0`：ZIP `-0.19061395525932312` → MG `-0.19061394035816193`
- `vectorNetwork`：ZIP 哈希 `35736c2f` → MG 哈希 `82deffa6`；拓扑为 ZIP `8 个顶点 / 9 条线段 / 1 个区域`，MG `8 / 9 / 1`。

### `Sidebar/Light/driving/Dark/Group/Model 3/Car/Group[1]/Rectangle 5`

- 差异属性：`fills`
- `fills.0.gradientTransform.0.0`：ZIP `-9.891201102618652e-8` → MG `-1.418689237198123e-7`
- `fills.0.gradientTransform.0.2`：ZIP `-0.09090908616781235` → MG `-0.09090906381607056`

### `Sidebar/Light/driving/Dark/Group/Model 3/Car/Group[1]/Vector 3`

- 差异属性：`fills, vectorNetwork`
- `fills.1.gradientTransform.1.0`：ZIP `-0.19061395525932312` → MG `-0.19061394035816193`
- `vectorNetwork`：ZIP 哈希 `1dbc083c` → MG 哈希 `efe92f55`；拓扑为 ZIP `8 个顶点 / 9 条线段 / 1 个区域`，MG `8 / 9 / 1`。

### `Sidebar/Light/driving/Light/Group/Model 3/Car/Group[1]/Rectangle 5`

- 差异属性：`fills`
- `fills.0.gradientTransform.0.0`：ZIP `-9.891201102618652e-8` → MG `-1.418689237198123e-7`
- `fills.0.gradientTransform.0.2`：ZIP `-0.09090908616781235` → MG `-0.09090906381607056`

### `Sidebar/Light/driving/Light/Group/Model 3/Car/Group[1]/Vector 3`

- 差异属性：`fills, vectorNetwork`
- `fills.1.gradientTransform.1.0`：ZIP `-0.19061395525932312` → MG `-0.19061394035816193`
- `vectorNetwork`：ZIP 哈希 `1dbc083c` → MG 哈希 `efe92f55`；拓扑为 ZIP `8 个顶点 / 9 条线段 / 1 个区域`，MG `8 / 9 / 1`。

## 文本字距差异（138 个图层）

以下每个图层均为：`letterSpacing` 从 ZIP `{"unit":"PIXELS","value":0}` → MG `{"unit":"PERCENT","value":0}`。对应的 `styledTextSegments` 仅在同一个单位字段上存在差异。

- `about/Dark/About Your Tesla`
- `about/Dark/Alpha Omega`
- `about/Dark/Group/172`
- `about/Dark/Group/mi`
- `about/Dark/Group/v8.1 (2017.30 37cacf)`
- `about/Dark/Group/VIN #YJ3B8E38GF1496679`
- `about/Light/About Your Tesla`
- `about/Light/Alpha Omega`
- `about/Light/Group/172`
- `about/Light/Group/mi`
- `about/Light/Group/v8.1 (2017.30 37cacf)`
- `about/Light/Group/VIN #YJ3B8E38GF1496679`
- `compass/N`
- `directions/nav row[1]/button/CANCEL TRIP`
- `directions/nav row[1]/summary/10:58 AM`
- `directions/nav row[1]/summary/22.8 mi`
- `directions/nav row[1]/summary/37 min`
- `directions/nav row[1]/waypoints/0.5 mi`
- `directions/nav row[1]/waypoints/battery/78%`
- `directions/nav row[1]/waypoints/Exit 87`
- `directions/nav row[2]/button/CANCEL TRIP`
- `directions/nav row[2]/summary/10:58 AM`
- `directions/nav row[2]/summary/22.8 mi`
- `directions/nav row[2]/summary/37 min`
- `directions/nav row[2]/waypoints/0.5 mi`
- `directions/nav row[2]/waypoints/battery/78%`
- `directions/nav row[2]/waypoints/Exit 87`
- `directions/nav row[3]/button/CANCEL TRIP`
- `directions/nav row[3]/summary/10:58 AM`
- `directions/nav row[3]/summary/22.8 mi`
- `directions/nav row[3]/summary/37 min`
- `directions/nav row[3]/waypoints/0.5 mi`
- `directions/nav row[3]/waypoints/battery/78%`
- `directions/nav row[3]/waypoints/Exit 87`
- `directions/nav row[4]/button/CANCEL TRIP`
- `directions/nav row[4]/summary/10:58 AM`
- `directions/nav row[4]/summary/22.8 mi`
- `directions/nav row[4]/summary/37 min`
- `directions/nav row[4]/waypoints/0.5 mi`
- `directions/nav row[4]/waypoints/battery/78%`
- `directions/nav row[4]/waypoints/Exit 87`
- `directions/nav row[5]/button/CANCEL TRIP`
- `directions/nav row[5]/summary/10:58 AM`
- `directions/nav row[5]/summary/22.8 mi`
- `directions/nav row[5]/summary/37 min`
- `directions/nav row[5]/waypoints/0.5 mi`
- `directions/nav row[5]/waypoints/battery/78%`
- `directions/nav row[5]/waypoints/Exit 87`
- `directions/nav row[6]/button/CANCEL TRIP`
- `directions/nav row[6]/summary/10:58 AM`
- `directions/nav row[6]/summary/22.8 mi`
- `directions/nav row[6]/summary/37 min`
- `directions/nav row[6]/waypoints/0.5 mi`
- `directions/nav row[6]/waypoints/battery/78%`
- `directions/nav row[6]/waypoints/Exit 87`
- `main control bar/Driver Temp/20º`
- `main control bar/Fan Level/MANUAL`
- `main control bar/Passenger Temp/20º`
- `map/road label[1]/75`
- `map/road label[2]/20`
- `map/road label[3]/75`
- `map/road label[4]/85`
- `map/road label[5]/400`
- `music/Dark/Category Bar/Group/Radio`
- `music/Dark/Category Bar/Group/Streaming`
- `music/Dark/Category Bar/Group/USB`
- `music/Dark/Category Bar/search field/Anything`
- `music/Dark/Favorites/Favorites`
- `music/Dark/Now Playing/Song Info/-1:23`
- `music/Dark/Now Playing/Song Info/Justin Hurwitz`
- `music/Dark/Now Playing/Song Info/La La Land (Original Motion Pi...`
- `music/Dark/Now Playing/Song Info/Mia & Sebastian's Theme`
- `music/Dark/Top Stations/Top Stations`
- `music/Light/Category Bar/Group/Radio`
- `music/Light/Category Bar/Group/Streaming`
- `music/Light/Category Bar/Group/USB`
- `music/Light/Category Bar/search field/Anything`
- `music/Light/Favorites/Favorites`
- `music/Light/Now Playing/Song Info/-1:23`
- `music/Light/Now Playing/Song Info/Justin Hurwitz`
- `music/Light/Now Playing/Song Info/La La Land (Original Motion Pi...`
- `music/Light/Now Playing/Song Info/Mia & Sebastian's Theme`
- `music/Light/Top Stations/Top Stations`
- `navigate button/Navigate`
- `Sidebar/Dark/Battery Level/90%`
- `Sidebar/Dark/driving/Dark/Cruise Control/30`
- `Sidebar/Dark/driving/Dark/Speed Limit/Dark/80`
- `Sidebar/Dark/driving/Dark/Speed Limit/Dark/SPEED LIMIT`
- `Sidebar/Dark/driving/Dark/Speed Limit/Light/80`
- `Sidebar/Dark/driving/Dark/Speed Limit/Light/SPEED LIMIT`
- `Sidebar/Dark/driving/Light/Component/65`
- `Sidebar/Dark/driving/Light/Speed Limit/Dark/80`
- `Sidebar/Dark/driving/Light/Speed Limit/Dark/SPEED LIMIT`
- `Sidebar/Dark/driving/Light/Speed Limit/Light/80`
- `Sidebar/Dark/driving/Light/Speed Limit/Light/SPEED LIMIT`
- `Sidebar/Dark/gear/D`
- `Sidebar/Dark/gear/N`
- `Sidebar/Dark/gear/P`
- `Sidebar/Dark/gear/R`
- `Sidebar/Dark/parked/Dark/button[1]/OPEN`
- `Sidebar/Dark/parked/Dark/button[2]/OPEN`
- `Sidebar/Dark/parked/Dark/button[3]/OPEN`
- `Sidebar/Dark/parked/Dark/MODEL 3`
- `Sidebar/Dark/parked/Light/button[1]/OPEN`
- `Sidebar/Dark/parked/Light/button[2]/OPEN`
- `Sidebar/Dark/parked/Light/button[3]/OPEN`
- `Sidebar/Dark/parked/Light/MODEL 3`
- `Sidebar/Dark/Speedometer/63`
- `Sidebar/Dark/Speedometer/MPH`
- `Sidebar/Light/Battery Level/90%`
- `Sidebar/Light/driving/Dark/Cruise Control/30`
- `Sidebar/Light/driving/Dark/Speed Limit/Dark/80`
- `Sidebar/Light/driving/Dark/Speed Limit/Dark/SPEED LIMIT`
- `Sidebar/Light/driving/Dark/Speed Limit/Light/80`
- `Sidebar/Light/driving/Dark/Speed Limit/Light/SPEED LIMIT`
- `Sidebar/Light/driving/Light/Component/65`
- `Sidebar/Light/driving/Light/Speed Limit/Dark/80`
- `Sidebar/Light/driving/Light/Speed Limit/Dark/SPEED LIMIT`
- `Sidebar/Light/driving/Light/Speed Limit/Light/80`
- `Sidebar/Light/driving/Light/Speed Limit/Light/SPEED LIMIT`
- `Sidebar/Light/gear/D`
- `Sidebar/Light/gear/N`
- `Sidebar/Light/gear/P`
- `Sidebar/Light/gear/R`
- `Sidebar/Light/parked/Dark/button[1]/OPEN`
- `Sidebar/Light/parked/Dark/button[2]/OPEN`
- `Sidebar/Light/parked/Dark/button[3]/OPEN`
- `Sidebar/Light/parked/Dark/MODEL 3`
- `Sidebar/Light/parked/Light/button[1]/OPEN`
- `Sidebar/Light/parked/Light/button[2]/OPEN`
- `Sidebar/Light/parked/Light/button[3]/OPEN`
- `Sidebar/Light/parked/Light/MODEL 3`
- `Sidebar/Light/Speedometer/63`
- `Sidebar/Light/Speedometer/MPH`
- `status bar/Dark/10:21 AM`
- `status bar/Dark/17 ºC`
- `status bar/Light/10:21 AM`
- `status bar/Light/17 ºC`

## 已审计的属性范围

本次扫描严格比较了名称/类型与层级；可见性/不透明度/混合/蒙版/裁剪；x/y/宽/高/旋转；相对与绝对变换；绝对与渲染边界；填充、描边、样式及详细描边字段；效果；圆角、弧形与 Boolean 数据；约束及所有已暴露的自动布局尺寸/对齐/内边距/间距字段；文本内容、字体、尺寸、对齐、大小写、装饰、截断与富文本分段；以及矢量网络/路径。图片引用已按字节内容规范化。
