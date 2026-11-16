# LineWorld AR

[![Deploy to GitHub Pages](https://github.com/Mola-maker/lineworld-ar/actions/workflows/pages.yml/badge.svg)](https://github.com/Mola-maker/lineworld-ar/actions/workflows/pages.yml)

手机 / 电脑浏览器里的 AR 交互平台原型：摄像头拍到的现实被**实时重绘成线条世界**，一个 3D 人物**站在真实地面上**，点地面它会走过去，点它会挥手。所有视觉与行为参数都能在后台调整。

- 在线体验（GitHub Pages）：https://mola-maker.github.io/lineworld-ar/ （管理后台：加 `?admin=1`）
- 免安装：一个网页，Android / iPhone / 电脑通用
- 摄像头画面只在本机处理，不上传
- 调研结论：[`docs/RESEARCH.md`](docs/RESEARCH.md)
- **给 3D 人物制作团队的需求规格**：[`docs/CHARACTER_SPEC.md`](docs/CHARACTER_SPEC.md)

## 快速开始

```bash
npm install
npm run assets       # 下载深度模型 + 拷贝 ONNX Runtime 到 public/（只需一次，约 90 MB）
npm run dev          # http://localhost:5173 ，电脑上直接用摄像头或演示场景
npm run dev:https    # https://<电脑IP>:5173 ，同一 Wi-Fi 下手机可直接测试摄像头
npm test             # 纯函数单测（FOV 对齐、贴地计算、配置合并）
npm run build        # 产物在 dist/，任意静态 HTTPS 主机即可部署
```

国内网络下载模型可用镜像：`HF_ENDPOINT=https://hf-mirror.com npm run assets`。

### 看不到线条世界？

| 现象 | 原因 / 解决 |
|---|---|
| 顶部橙色提示“当前显示的是内置演示房间” | 摄像头没打开。最常见：用 `http://192.168.x.x` 在手机上打开 —— 浏览器只在 HTTPS 下开放摄像头。用 GitHub Pages 地址，或 `npm run dev:https` 后打开 `https://电脑IP:5173`（首次接受证书警告） |
| Android 上点“AR 跟踪模式”看到的是原始画面 | 旧版本问题：现在 AR 模式要求浏览器提供原始摄像头画面，不支持时自动切回摄像头模式 |
| 线条太多/太少 | `?admin=1` → lineArt：`threshold` 越小线越多，`lineWidth` 越大只保留大轮廓；`method` 可切换 `canny / sobel / dog` |

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

## 深度估计（纯 Web）

摄像头模式下，浏览器里实时运行 **Depth Anything V2 Small**（transformers.js，WebGPU 优先，不支持时 WASM），在 Web Worker 中运行，不卡界面。
模型与 ONNX Runtime 都**自托管**在本站（不依赖 huggingface.co / jsdelivr，国内可用）。

| 用途 | 做法 |
|---|---|
| **线条更干净（深度）** | 深度不连续处画线（物体轮廓），与颜色边缘线叠加；权重可调 |
| **遮挡** | 估计的真实深度写入深度缓冲：人物走到箱子/沙发后面会被挡住；地面像素不参与，脚不会被“切掉” |
| **地面估计** | 单目深度只有相对尺度；结合陀螺仪姿态与“眼睛离地高度”，用 RANSAC 拟合出**米制尺度**并标出**哪些像素是地面** |
| **只能走在地面上** | 点到家具/墙上会提示“不是地面”；首次放置若落在家具后，自动走到最近的可见地面 |
| **延迟补偿** | 深度帧比画面慢几帧，着色器按手机转动把深度图重投影到当前视角（摄像头模式只有旋转，补偿是精确的） |

Android AR 模式下改用设备自带的 WebXR depth-sensing（ARCore）做遮挡。
后台 `depth.debugView` 可切换 `disparity / floor / meters` 调试视图；`Model check` 面板显示设备、帧率、地面占比。

## 脚部 IK

| 功能 | 说明 |
|---|---|
| 动态贴地 | 每帧把身体移到“最低的支撑脚正好接触地面”，修正动画/建模误差（上限 `maxCorrection`，跳跃不受影响） |
| 脚步锁定 | 支撑脚落地后钉在世界坐标上，用两段骨骼 IK 弯腿够到它 → 消除“滑步” |
| 防穿地 | 任何低于地面的脚被抬回地面 |
| 自动步速 | 从 Walking 动画测出步幅速度，程序移动速度与之匹配（`walkSpeed: 0` = 自动） |

自动识别 Mixamo / VRM / Blender / `FootL` 等骨骼命名；无膝盖的机器人类骨骼会直接移动脚骨。

## 后台：配置发布（无服务器）

部署在 GitHub Pages 上，“后台”就是管理面板 + GitHub 仓库：

- **多套配置（profile）**：`public/configs/<名字>.json`，用 `?profile=<名字>` 访问，例如 `?profile=night`（夜间配色示例）。
  不同活动/渠道/角色各用一套，互不影响；面板里的本地修改也按 profile 分开保存。
- **一键发布**：面板 → `Publish (GitHub)`，填仓库 `owner/name`、分支、profile、令牌 →
  `Publish config` 把当前配置提交到仓库；`Publish loaded .glb + config` 连同拖进来的模型一起上传。
  提交后 Actions 自动重新部署，约 1–2 分钟生效；每次发布都是一次 git 提交，可审查、可回滚。
- **令牌**：GitHub → Settings → Developer settings → Fine-grained tokens，只授权本仓库的 **Contents: Read and write**。
  令牌只存在当前浏览器（默认仅本次会话），不会写进配置。
- 也可以把 `?config=https://你的接口/xxx.json` 指向任意 CMS / 接口返回的 JSON。

## 部署（GitHub Pages）

`.github/workflows/pages.yml`：推送到 `main` 即自动 测试 → 下载并缓存深度模型 → 构建 → 部署。
构建产物推送到 `gh-pages` 分支（每次覆盖，只保留一个提交）。
若首次部署后网站仍 404：仓库 **Settings → Pages → Source** 选 **Deploy from a branch**，分支 `gh-pages`，目录 `/ (root)`，保存。

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
| 动态贴地 + 脚步锁定 IK + 防穿地 | ✓ | `footik.js` |
| 深度遮挡（真实物体挡住人物） | ✓ | `depth/occluder.js` |
| 摄像头模式用深度模型识别真实地面 | ✓ | `depth/floor.js` |

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
  footik.js        动态贴地、脚步锁定、两段骨骼 IK
  publish.js       通过 GitHub API 发布配置 / 模型
  demoRoom.js      无摄像头时渲染的 3D 演示房间（用于测试深度/遮挡）
  depth/           深度估计：worker（模型推理）、floor（米制拟合+地面分割）、occluder（遮挡）
  modes/window.js  摄像头 + 陀螺仪模式（iOS / 桌面）
  modes/webxr.js   WebXR 跟踪模式（Android）
public/config.json 线上默认配置
public/configs/    多套配置（profile）+ index.json
scripts/           fetch-assets.mjs：自托管深度模型与 ONNX Runtime
.github/workflows/ GitHub Pages 自动部署
public/models/     测试模型（RobotExpressive，CC0）
docs/              调研、人物规格书
```

## 路线图

- [x] 深度估计：深度线条、遮挡、摄像头模式地面识别
- [x] 脚部 IK：动态贴地、脚步锁定、自动步速
- [x] 无服务器后台：多 profile、GitHub 一键发布
- [ ] iPhone 6DoF（纯 Web 下只能靠 8th Wall SLAM 二进制，需评估许可）
- [ ] 跨域隔离（COOP/COEP service worker）以启用 WASM 多线程，提升无 WebGPU 设备的深度帧率
- [ ] 交互：语音/对话（角色说话 + 口型）、多人共享锚点

## 已知限制

- 魔法窗口模式没有位移跟踪：拿着手机走动时人物会跟着“滑”。需要真正的空间锚定请用 AR 模式。
- AR 模式的线条化依赖 WebXR Raw Camera Access（Chrome Android）；不支持的设备显示真实画面。若某设备相机图像上下颠倒，后台打开 `camera.xrFlipY`。
- 深度模型的地面估计依赖“眼睛离地高度”假设（米制尺度由它决定）；坐着/站着差别大时请在后台调 `camera.heightMeters`。
- 首次加载深度模型约 19 MB（WebGPU）或 27 MB（WASM），之后由浏览器缓存。无 WebGPU 的手机上深度约 1–3 帧/秒，遮挡边缘会滞后。
- 本仓库在无头浏览器（SwiftShader、无 GPU）中验证了：线条化、深度推理（WASM）、地面分割、遮挡、脚步锁定、profile、管理面板；
  **WebGPU 速度与 WebXR 模式需要实机验证**。

## 许可证

代码 MIT。`public/models/RobotExpressive.glb` 为 CC0（作者 Tomás Laulhé，见 `public/models/README.robot.md`）。
