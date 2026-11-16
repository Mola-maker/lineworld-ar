# LineWorld AR

手机 / 电脑浏览器里的 AR 交互平台原型：摄像头拍到的现实被**实时重绘成线条世界**，一个 3D 人物**站在真实地面上**，点地面它会走过去，点它会挥手。所有视觉与行为参数都能在后台调整。

- 免安装：一个网页，Android / iPhone / 电脑通用
- 摄像头画面只在本机处理，不上传
- 调研结论：[`docs/RESEARCH.md`](docs/RESEARCH.md)
- **给 3D 人物制作团队的需求规格**：[`docs/CHARACTER_SPEC.md`](docs/CHARACTER_SPEC.md)

## 快速开始

```bash
npm install
npm run dev          # http://localhost:5173 ，电脑上直接用摄像头或演示场景
npm test             # 纯函数单测（FOV 对齐、贴地计算、配置合并）
npm run build        # 产物在 dist/，任意静态 HTTPS 主机即可部署
```

手机上测试必须是 **HTTPS**（摄像头和 WebXR 的硬性要求）：部署 `dist/` 到任意 HTTPS 静态托管，或用隧道（如 `cloudflared tunnel --url http://localhost:5173`）。

## 两种运行模式

| 模式 | 设备 | 跟踪 | 地面来源 | 线条化 |
|---|---|---|---|---|
| **AR（tracked）** | Android Chrome（ARCore）、Quest 浏览器 | 6DoF：人可以绕着角色走 | WebXR hit-test 检测到的真实平面 | 需要 `camera-access`；不支持时显示真实画面 + 人物 |
| **Camera view（魔法窗口）** | iPhone Safari、所有电脑、任何浏览器 | 3DoF：陀螺仪转动视角（电脑用鼠标拖动） | 假设眼睛离地 `camera.heightMeters` | ✓ |

启动页会根据设备自动显示可用的按钮（`mode: auto`）。iPhone 上做到 6DoF 的路线见 `docs/RESEARCH.md`。

## 后台自定义

**一切参数都在配置里**，并按以下顺序叠加（后者覆盖前者）：

1. `src/config.js` 中的 `DEFAULTS`（每一项都有注释）
2. `public/config.json` —— 运营/部署时修改，无需重新打包
3. URL 参数 `?config=https://.../xxx.json` —— 同一个部署跑不同活动/角色
4. 管理面板里的本地修改（存在浏览器里，可导出）

**管理面板**：URL 加 `?admin=1`，或在左上角快速点三下。面板由配置对象自动生成，新增参数无需改界面代码。可以：

- 实时调线条颜色、粗细、阈值、手绘抖动、填色、纸纹、混入原画面比例
- 换人物模型 URL、身高、贴地微调、描边、卡通着色、动画片段映射、行走速度
- 调阴影/接触阴影/光照方向，摄像头 FOV、离地高度
- **“Load local .glb…” 或直接把 .glb 拖进页面** —— 外包团队交付后立即自检
- **Model check (spec)** 面板：自动检查原点、单位、动画名、根运动、面数，警告对应规格书章节
- 导出 / 导入配置 JSON，复制给线上 `config.json` 即生效
- `?clean` 忽略本地修改，`window.lineworld` 可在控制台调试

## 人物为什么不会“悬空”

| 手段 | 状态 | 位置 |
|---|---|---|
| 按真实米制缩放到设定身高 | ✓ | `character.js` `applyConfig` |
| 取绑定姿态最低点（含蒙皮顶点）自动对齐地面，可手动微调 | ✓ | `character.js` + `math.js groundOffset` |
| 真实平面检测（WebXR hit-test），地面高度跟随 | ✓ AR 模式 | `modes/webxr.js` |
| 实时投影到透明“阴影接收面” | ✓ | `grounding.js` |
| 脚下接触阴影（最关键的“接地”视觉线索） | ✓ | `grounding.js` |
| 环境光方向估计 → 投影方向与现实一致 | ✓ AR 模式（设备支持时） | `modes/webxr.js` |
| 3D 相机 FOV 与摄像头画面裁剪严格对齐（透视一致） | ✓ | `math.js coverFit` |
| 人物风格（卡通着色 + 描边）与线条世界统一，避免“贴图感” | ✓ | `character.js setStyle` |
| 原地动画 + 程序移动，待机不抬脚 | ✓（规格书 §5 约束美术） | `character.js` |
| 脚部 IK 贴地、深度遮挡、无 WebXR 时用深度模型估计地面 | 第二期 | 见路线图 |

## 目录

```
src/
  main.js          启动、模式选择、渲染循环
  config.js        默认配置 + 分层加载 / 合并 / 差异保存
  admin.js         自动生成的管理面板
  lineart.js       相机纹理 → 线条画（两遍着色器，WebXR 下逐眼可用）
  character.js     GLB 加载、尺寸/贴地归一化、卡通描边、动画状态、模型自检
  placeholder.js   程序化占位人物（满足规格书的原点/朝向/尺寸约定）
  grounding.js     阴影接收面、接触阴影、跟随光源、准星
  math.js          纯函数（可在 Node 中测试）
  modes/window.js  摄像头 + 陀螺仪模式（iOS / 桌面）
  modes/webxr.js   WebXR 跟踪模式（Android）
public/config.json 线上配置
public/models/     测试模型（RobotExpressive，CC0）
docs/              调研、人物规格书
```

## 路线图

1. **iPhone 6DoF**：评估 8th Wall 开源框架 + SLAM 二进制，或原生壳（Capacitor + ARKit）
2. **深度**：Depth Anything V2（WebGPU）→ 深度线条、遮挡、魔法窗口模式的地面估计
3. **脚部 IK**：按检测到的地面锁定双脚（需规格书 §5.1 的标准骨骼）
4. **服务端后台**：把 `config.json` 换成 CMS/API，支持多角色、多活动、灰度
5. **交互**：语音/对话（角色说话 + 口型）、多人共享锚点

## 已知限制

- 魔法窗口模式没有位移跟踪：拿着手机走动时人物会跟着“滑”。需要真正的空间锚定请用 AR 模式。
- AR 模式的线条化依赖 WebXR Raw Camera Access（Chrome Android）；不支持的设备显示真实画面。若某设备相机图像上下颠倒，后台打开 `camera.xrFlipY`。
- 本仓库在无头浏览器（SwiftShader）中验证了摄像头模式、线条化、贴地阴影、点地行走与管理面板；**WebXR 模式需要在 ARCore 手机上实机验证**。

## 许可证

代码 MIT。`public/models/RobotExpressive.glb` 为 CC0（作者 Tomás Laulhé，见 `public/models/README.robot.md`）。
