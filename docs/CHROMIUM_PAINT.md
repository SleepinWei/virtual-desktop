# Chromium 原生绘图实验

这个实验开始验证真实 Blink 绘图记录能否在客户端重放。入口位于 `experiments/chromium-paint/`，独立于 v0 网关；`npm start` 仍运行 LinkeDOM + Yoga 协议 PoC。

## 运行

```bash
npm ci
npx playwright install chromium
npm run experiment:paint
```

可指定已经安装的 Chromium，并在验证完成后保留本地重放页面：

```bash
CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run experiment:paint -- --serve
```

输出目录默认为 `test-results/chromium-paint/`，可用 `--output <directory>` 更改。`--capture-only` 只采集，不启动本地重放验证浏览器。任何阶段缺少目标页面原生 SKP、trace 不完整或视觉验证失败，进程都以非零状态退出；`--serve` 保留页面供检查，按 Ctrl+C 关闭。

CLI 为 trace 使用 128 MiB central buffer，并请求 32 MiB producer shared memory；`--producer-buffer-bytes <bytes>` 可改为 4–32 MiB、32 KiB 倍数的诊断值。只有这个有源码依据的参数可以传入，实际启动参数会用 CDP 留存；它只改变采集容量，不关闭浏览器 raster，也没有测得实际内存分配量。

## 数据链路和验收边界

1. 独立 Chromium 进程运行仓库内真实 HTML、CSS Grid、中英文字体及页面 JavaScript。固定视口 960×720；按钮改变计数、文字和面板颜色。fixture 使用随仓库分发的 [OFL 字体子集](../experiments/chromium-paint/fonts/README.md)，避免直接序列化整套大型系统中文字体；这不等于通用网站的字体资源协议已实现。
2. 通过 tracing 捕获 `DisplayItemList::EmitTraceSnapshot` 导出的 `skp64`，按原始字节保存 `.skp`，计算 SHA-256，保留浏览器版本和 trace 来源。导出模块不请求截图，不解码或重建绘图命令。
3. 本地实验页面校验 SKP 大小和哈希，由 `canvaskit-wasm@0.42.0` 的 full 构建调用 `MakePicture` 与 `drawPicture`。像素在客户端软件 surface 生成。无法解码时明确返回 `unsupported`，没有 DOM 或截图回退。
4. 捕获浏览器关闭后，再启动独立的本地验证浏览器，对比重放和本地原页面的像素。整图以及标题、中文段落、计数、状态和按钮各自检查；每区域平均 RGB 误差不超过 3，任一 RGBA 通道差大于 32 的像素比例不超过 2%。这只是固定 fixture 的抗锯齿容差，不能推广到网站兼容性。

**普通 Chromium 仍会执行自己的 raster 和合成路径。** 原生 SKP 导出不等于禁用服务端像素生成，报告始终包含 `serverRasterBypassed: false` 和未通过的引擎关卡。trace 中 raster/draw 指标计数的是匹配记录；嵌套记录可能描述同一工作，不能当作执行次数、CPU 节省或负载结论。没有观察到事件也不构成绕过证明。

`nativePicturesCaptured`、`clientReplayRendered`、`fixtureReplayPassed` 分别表示来源正确的原生记录存在、两阶段在客户端解码并绘制、严格视觉比较通过；三者不能互换。`traceComplete` 要求 CDP 显式报告未丢数，未知状态保守记为不完整。

实验页面只重放选中的单个原生 picture。当前没有图层/property tree 合成、移除图层对账、增量资源协议、字体/图像兼容保证，亦未覆盖 iframe、Canvas、WebGL、视频或像素读取。SKP 是 Skia 内部序列化格式，浏览器与 CanvasKit 的版本兼容必须实测。

`snapshotCommandLog` 不适合作为完整协议：Chromium 的 LoggingCanvas 对 text blob 只记录位置和 paint，图像只记录部分元数据。实验使用原生序列化字节，不能用 DOM 文本或图片补全调试日志来声称无损重放。

## 产物

| 文件 | 含义 |
| --- | --- |
| `trace.json` | 原始 trace，包括原生 base64 记录；可能较大 |
| `capture.json` | 浏览器版本、每阶段 SKP 哈希、来源和观测到的 raster/draw 记录 |
| `pictures/*.skp` | 未重写的 Chromium 原生绘图记录 |
| `replay.json` | 客户端解码与固定页面视觉比较结果 |
| `client-*.png`、`reference-*.png` | 独立本地验证浏览器生成的图像 |
| `replay-lab.png` | 本地重放实验页面截图 |
| `experiment.json` | 本次实验摘要与仍未通过的引擎关卡 |

这些运行产物被 Git 忽略。实验 HTTP 服务仅监听 loopback，只开放固定静态资源和 manifest 列出的 SKP，不提供原始 trace 文件；不应把实验目录与服务当作生产浏览器隔离系统。

## 当前实测边界

2026-10-27，macOS arm64 / Apple M4，Chrome 156.0.8078.48、CanvasKit 0.42.0/full。已捕获并在本地解码真实页面按钮操作前后的 960×720 SKP，含中文、文字、圆角、CSS Grid 和颜色/计数变化。默认 producer 对照出现 trace 丢数；相同 central buffer 下请求 32 MiB producer 的采集显式返回无丢数，仍观察到常规 raster/draw 工作。

严格视觉关卡仍有字形平滑差异。fixture 显式指定灰度字体平滑后，整图误差较小，但部分文字区域仍超过固定容差；保留失败状态和原始指标，不放宽门槛。现成 CanvasKit FreeType A8 路径与 macOS CoreText 的平滑不同，公开 JS API 没有可直接覆盖已记录 TextBlob 的 gamma/contrast 选项。[CanvasKit 绑定](https://raw.githubusercontent.com/google/skia/canvaskit/0.42.0/modules/canvaskit/canvaskit_bindings.cpp)、[FreeType 字形路径](https://raw.githubusercontent.com/google/skia/canvaskit/0.42.0/src/ports/SkFontHost_FreeType.cpp)。后续应以定制 CanvasKit 构建和同一区域比较验证，不能以更换后台或颜色空间声称已修复。

2026-10-28 已用与 Chromium 完全相同的 Skia revision 构建定制 CanvasKit。单独开启 A8 sRGB 预混合仍失败；按 macOS 未 hint 字形的 A8 线性覆盖策略，配合 FreeType 默认 CFF stem darkening 后，同一批未修改 SKP 的前后阶段、整图和全部文字区域均通过既有阈值。该结果限定于仓库的 CFF 字体 fixture，不代表任意系统字体或其他平台已兼容。构建、反例与完整三模式验证见 [引擎实验](CHROMIUM_ENGINE.md)。

可以复用既有原生捕获，独立验证其他客户端构建，不重新采集网页：

```bash
npm run experiment:replay -- --input test-results/chromium-engine-20261028/record-only-display \
  --canvaskit /Volumes/Extreme-APFS/Builds/canvaskit/out \
  --output test-results/saved-replay
```

自定义目录必须包含 `runtime.json`、`canvaskit.js` 和 `canvaskit.wasm`。实验服务校验两个资源的 SHA-256 并保留所验证的字节，防止构建期间新文件替换旧指纹对应的内容。客户端报告实际运行时身份和指纹；软件 surface 切换时释放 WASM 像素分配。

## headless 帧控制探针

另一个候选是 headless shell 的 `enableBeginFrameControl` 与 `HeadlessExperimental.beginFrame({noDisplayUpdates:true})`。统一 Chrome headless 与 headless shell 具有不同能力，探针要求明确提供后者的二进制路径：

```bash
HEADLESS_SHELL_EXECUTABLE_PATH=/absolute/path/to/chrome-headless-shell npm run experiment:headless
```

它保存 API 能力错误、原始 trace 和独立诊断，不在不支持时创建不受控 target 作为回退。标记区间之外的 LayerTree 检查不会算成该区间的 SKP 证据。即使出现“无观测 raster + 有 SKP”，仍只标为待验证候选，不自动通过引擎关卡。macOS 上协议明确不支持 BeginFrameControl；实际运行结果见验证记录。

## 真正的下一关

外置 APFS 构建环境和固定版本引擎补丁入口现位于 [Chromium 引擎构建与 picture-layer 实验](CHROMIUM_ENGINE.md)。这一步新增可关闭的 picture-layer 无 tile/quad 模式、正向 trace 证据和成对实验，完整引擎切分关卡仍未通过。

需要匹配版本的 Chromium 源码构建，并实现显式 remote-paint 模式：在 Blink 完成真实 paint 记录后导出帧和资源；在 `LayerTreeHostImpl::PrepareTiles` / `TileManager::PrepareTiles` 调度像素工作之前切断常规 tile raster，同时维持 BeginFrame、提交/激活和 ACK 生命周期。直接跳过 `RasterTaskImpl::RunOnWorkerThread` 中的 Playback 会留下未初始化 tile 及状态机问题，不能作为可用实现。

该改动必须同时提交引擎代码、构建版本、正常模式对照和 remote-paint 模式的 CPU/内存/线程 trace、本地视觉证据及不支持能力报告，才能更新 [技术框架中的关卡](../TECHNICAL_FRAMEWORK.md#8-通用浏览器路线与关卡)。本机磁盘资源不足时，应先准备可用构建机或大容量目录，不能把未编译的示意补丁当作完成。

## 一手资料

- [DisplayItemList 原生 trace snapshot](https://raw.githubusercontent.com/chromium/chromium/main/cc/paint/display_item_list.cc)
- [Chromium PictureDebugUtil 序列化](https://raw.githubusercontent.com/chromium/chromium/main/cc/debug/picture_debug_util.cc)
- [LoggingCanvas 的调试日志实现](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/graphics/logging_canvas.cc)
- [CanvasKit 文档](https://skia.org/docs/user/modules/canvaskit/) 与 [SKP 解码实现](https://raw.githubusercontent.com/google/skia/main/modules/canvaskit/skp.js)
- [Target 协议](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Target.pdl) 与 [HeadlessExperimental 协议](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/HeadlessExperimental.pdl)
- [TileManager 的 raster 调度](https://raw.githubusercontent.com/chromium/chromium/main/cc/tiles/tile_manager.cc)
- [Chromium macOS 构建要求](https://chromium.googlesource.com/chromium/src/+/main/docs/mac_build_instructions.md)

这些源码链接支持切分点研究；实际安装浏览器的版本和本项目运行证据以每次 manifest 为准。
