# 开源方案调研（2026-11）

目标：手机 / 电脑浏览器里，摄像头画面 → 线条化的虚拟世界，并放一个**自然站在地上**的 3D 人物，后台高度可配置。

## 结论

**没有一个开源仓库能直接满足“线条化实景 + 贴地 3D 人物 + 跨 iOS/Android/PC”**，所以本仓库采用
“**用成熟开源库拼装 + 自己写胶水层**”的方式：

| 能力 | 选用 | 理由 |
|---|---|---|
| 3D 渲染 | **three.js** (MIT) | 生态最大，GLTF/蒙皮/阴影/WebXR 全有；`WebXRManager.getCameraTexture()` 已支持 raw camera access |
| 6DoF 跟踪 + 平面检测 | **WebXR `immersive-ar` + `hit-test`** | Android Chrome（ARCore）原生支持，免费、无 SDK |
| 线条化 | 自写 GLSL（下采样 + Sobel + 抖动 + 纸纹） | 现有 Canny/Sobel 示例都是图片滤镜，不处理 WebXR 相机纹理和裁剪对齐；自写不到 100 行 |
| iOS / 桌面 | 自写“魔法窗口”模式：`getUserMedia` + 陀螺仪 | iOS Safari 至今**不支持 WebXR**，只能 3DoF |
| 后台配置 | lil-gui (MIT) 自动生成面板 + JSON 配置分层 | 配置结构即面板，新增参数零代码 |
| 测试人物 | three.js 仓库里的 RobotExpressive（**CC0**）+ 内置程序化占位人物 | 见下文“小王子模型” |

## 逐项调研

### WebAR 框架
- **8th Wall**：2026-02 起转为开源，框架部分 MIT（[github.com/8thwall/8thwall](https://8thwall.org/docs/open-source)），
  但 **SLAM（平面/世界跟踪）仍是闭源二进制**，以二进制许可证免费提供。
  → 是 iOS 浏览器上获得 6DoF 贴地的**唯一现实路线**，列为第二期候选（需评估二进制许可条款）。
  来源：[8thwall.org 博客](https://8thwall.org/blog/8th-wall-open-source)、[Road to VR](https://roadtovr.com/niantic-webar-platform-8th-wall-open-source/)
- **AR.js**（MIT）：主要是 Marker / 图片识别 / 地理位置 AR，**没有无标记平面检测**，不适合“人物站在地上”。
- **MindAR**：图片/人脸跟踪，同样没有平面检测。
- **boehm-e/webxr_threejs_AR**、**codemaker2015/web-ar-boilerplate**：three.js + WebXR hit-test 起步模板，思路与本项目 XR 模式一致，但无线条化、无 iOS 兜底、维护不活跃，未直接引入。
  来源：[webxr_threejs_AR](https://github.com/boehm-e/webxr_threejs_AR)
- **enva-xr**（tentone）：three.js AR 封装，有光照探针；体量较大，未验证活跃度，作为参考。
- **Google three.ar.js / WebARonARCore**：已废弃的实验浏览器方案，不用。

### 平台支持（决定了架构）
- **Android Chrome**：`immersive-ar`、`hit-test`、`light-estimation`、`depth-sensing`、`camera-access` 均可用 → 完整体验。
- **iOS Safari**：WebXR 设备 API 不可用（无 hit-test、无 depth）。visionOS Safari 支持 WebXR，但 iPhone 不支持。
  来源：[web-features: hit-test](https://web-platform-dx.github.io/web-features-explorer/features/webxr-hit-test)、[web-features: depth-sensing](https://web-platform-dx.github.io/web-features-explorer/features/webxr-depth-sensing)
  → iPhone 上的可选路线：① 浏览器 3DoF 魔法窗口（已实现）② 8th Wall SLAM 二进制 ③ 原生壳（Capacitor/Swift + ARKit）④ 用 `.usdz` 走 AR Quick Look（真贴地，但不能线条化）。

### 线条化 / 风格化
- three.js 自带 `SobelOperatorShader`、`FreiChenShader`；[DCtheTall/webgl-edge-detection](https://github.com/DCtheTall/webgl-edge-detection)（实时 Canny）；
  [Codrops 素描效果](https://tympanus.net/codrops/2022/11/29/sketchy-pencil-effect-with-three-js-post-processing/)、
  [Moebius 风格后处理](https://blog.maximeheckel.com/posts/moebius-style-post-processing)。
  → 借鉴了“先降采样再 Sobel”“低频抖动模拟手绘”的做法，代码为重写。
- 进阶（第二期）：在浏览器里跑单目深度 **Depth Anything V2**（transformers.js + WebGPU，
  [Xenova 实时示例](https://huggingface.co/spaces/Xenova/webgpu-realtime-depth-estimation)）——
  用深度图画线条会比颜色 Sobel 干净得多，还能做**遮挡**（人物走到桌子后面）和**无 WebXR 时估计地面**。

### “小王子”测试模型
- `littleprince.dev` 是开发者 Sac 用 Claude + Tripo + Blender 做的浏览器 3D 游戏
  （[Korben 报道](https://korben.info/en/the-little-prince-becomes-a-3d-game-in-your-browser-thanks-ai.html)）。
  调研环境无法访问该站，**未找到其源码或模型的开源许可**，不能直接拿来用；如需使用请联系作者获取授权。
- Sketchfab 上有一个 CC-BY 的体素“小王子星球”，[链接](https://sketchfab.com/3d-models/voxel-planet-of-the-little-prince-magicavoxel-8a7cf90ac42c4ef693342404826c06ae)（是星球场景，不是带骨骼的人物）；
  RenderHub / Blender Market 有付费小王子模型（约 $12，需看许可）；其余多为 3D 打印 STL，无骨骼。
- 版权提醒：《小王子》形象在美国等地仍受版权保护，且角色名称/形象有商标授权管理，正式产品需授权或改为原创角色（详见 `CHARACTER_SPEC.md §9`）。
- 因此测试期用：**RobotExpressive（CC0，带 Idle/Walking/Wave 等 14 个动画）** 测骨骼动画流程；
  **内置程序化“围巾旅行者”** 测风格与贴地。拿到授权模型或外包模型后，**后台改一个 URL 或直接拖入 .glb** 即可替换。
