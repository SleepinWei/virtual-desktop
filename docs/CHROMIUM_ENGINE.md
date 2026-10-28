# Chromium 引擎构建与 record-only display 实验

此阶段把原生绘图实验推进到固定源码版本的引擎改动。`source.json` 固定 Chromium **156.0.8078.48 / d0c02bfad08ec92a6ffcf989e53cd995e6381a4c**、depot_tools 提交及补丁前后各文件的 SHA-256。仓库保存补丁和工具，不保存 Chromium 源码、编译器或构建输出。

**完整引擎切分关卡仍未通过。** `VirtualDesktopRemotePaint` 控制 Blink compositor 的 picture-layer tile 与 picture quad；另一个需同时启用的 `VirtualDesktopRemotePaintNoDisplay` 仅在 headless output provider 内选用 NullRenderer，跳过 Viz 像素绘制。Canvas、WebGL、视频、图片解码及通用资源/图层传输仍需独立处理。这是可信本地 fixture 实验，通过显式选项接入原生 worker。

2026-10-28 已达到 **record-only-display-candidate**：三种模式的原生 SKP 一致、严格本地视觉比较通过；无绘制模式记录到明确的 native skip 标记，且真实输入、滚动、刷新和会话存储检查通过。完整记录见 [chromium-engine-2026-10-28.json](chromium-engine-2026-10-28.json)。

同日后续已完成 **native-frame-candidate**：完整活跃树导出、原生层序/变换/裁剪/透明度分组、滚动、删层及本地 ACK 通道均通过固定页面验收，见 [CHROMIUM_FRAMES.md](CHROMIUM_FRAMES.md)。最新 **live-native-session-candidate** 已用原生 Unix socket 持续输出，接入会话 worker、agent/control epoch、人工输入、断线和资源失败恢复，见 [CHROMIUM_LIVE.md](CHROMIUM_LIVE.md) 与 [最新验收](chromium-live-2026-10-28.json)。

之后的持续输入/并发测试修复了无显示模式的成功呈现回调累积：仅当两个实验 feature 同时开启时，Blink/cc 取消已失败帧的成功回调，保留普通模式语义与 DCHECK，不伪造物理呈现。当前补丁覆盖 20 个文件，过滤 C++ 共 21 项通过；新构建完成 64 个同页操作。有限压测与未通过的真实站点范围见 [NATIVE_RUNTIME.md](NATIVE_RUNTIME.md)。

## 构建

本次构建根目录为 `/Volumes/Extreme-APFS/Builds`，位于外置 APFS SSD。路径不能含空格。工具先核对外置卷及 UUID，磁盘断开时拒绝向同名内置目录写入。源码、depot_tools、CIPD/vpython 缓存、临时目录、日志和输出均置于该根目录；Xcode/SDK 继续使用本机安装。

```bash
export CHROMIUM_BUILD_ROOT=/Volumes/Extreme-APFS/Builds
python3 experiments/chromium-engine/build.py preflight
python3 experiments/chromium-engine/build.py sync
python3 experiments/chromium-engine/build.py hooks
python3 experiments/chromium-engine/build.py apply
python3 experiments/chromium-engine/build.py configure
python3 experiments/chromium-engine/build.py objects --jobs 2
python3 experiments/chromium-engine/build.py build --jobs 2
python3 experiments/chromium-engine/build.py test
npm run experiment:engine
```

严格视觉复测需要下面的匹配 CanvasKit；不指定时保留 npm CanvasKit 0.42.0 的反例对照，可能因文字差异返回非零状态。

`sync` 使用 shallow checkout，固定 revision，禁用自动 depot_tools 更新和工具指标上报。它也执行官方 `ensure_bootstrap`；单独运行过 gclient 的目录可能还没有 GN/autoninja 需要的 Python shim，可用 `build.py bootstrap` 补齐。后续同步遇到本地修改会拒绝覆盖；补丁输入哈希不符、已有不同 `args.gn` 或 `.gclient` 也会停止。

默认构建使用 macOS arm64、release/component、`symbol_level=0`、保留 DCHECK、关闭 PGO 和远程执行。当前注意本机负载，建议 `nice -n 10`、`--jobs 1`。构建目标包含 `headless_shell`、`cc_unittests` 和 `viz_unittests`。`objects` 只编译变动源文件和 C++ 测试对象；它成功不等于完整目标已链接或测试已运行。`test` 当前执行 17 项 cc/paint/callback、4 项 Viz 测试，全部成功后状态为 `engine-tests-complete`，并不代表整个 Chromium 测试集已跑完。

运行状态位于 `chromium/virtual-desktop-build-state.json`，日志位于 `logs/chromium-*.log`，输出位于 `chromium/src/out/VirtualDesktop`。失败保留增量构建；修复后重跑对应阶段。运行前检查状态和实际进程，不能同时启动两个写入同一 checkout 的作业。`status` 只读检查当前空间、SDK、版本及记录阶段。

## 引擎改动

启动参数 `--enable-features=VirtualDesktopRemotePaint` 将实验设置传入 Blink 创建的 `cc::LayerTreeSettings`，默认关闭。

1. `PictureLayerImpl::UpdateRasterSourceInternal` 在新的 recording 提交时输出 `VirtualDesktop.RemotePaintRecord`，携带真实 layer id、source frame number 和 SKP。使用 recording canvas 序列化，不创建页面像素 surface。
2. `CanHaveTilings` 在实验设置下返回 false，沿已有无 tiling 分支清理/阻止 tile 创建。保留 `TileManager::PrepareTiles` 和正常 commit/activation 调用，让空任务队列继续执行既有就绪通知。
3. `WillDraw` 拒绝 picture-layer 绘制；`AppendQuads` 同时防止直接调用进入 checkerboard 或 resourceless software 分支。其他 layer 类型及 Viz 显示工作不在此补丁范围内。
4. `RemotePaintPictureLayerImplTest` 检查 recording 保留、无 tiling/显存、连续激活新 recording，以及 hardware/software/resourceless 三种模式均不产生 picture quad。普通模式的既有 tiling 创建测试作为对照。
5. 两个 feature 同时开启且 provider 为 headless 时，`OutputSurfaceProviderImpl` 不创建 display GPU dependency，沿已有 `OutputSurfaceUnified` / `NullRenderer` 路径完成 aggregation 和 draw callbacks，再在 `skips_draw` 分支返回，发出 `VirtualDesktop.RemotePaintDisplaySkipped`。单独开启 NoDisplay 不切换后台。新增 Viz 测试验证连续三帧回调、无 swap/缓冲分配，以及两种开关对照；既有正常绘制测试也运行。

以上为最初 picture-layer/无显示改动。后续原生完整帧导出保留 layer 坐标并使用实际 scroll offsets，支持既定二维合成与成员移除；持续 socket producer 不依赖 trace 传递画面。当前补丁覆盖 17 个文件，新的 forced-JSON 与 Perfetto 导出共用调用方 writer，避免嵌套不同 writer 类型导致 renderer 断言退出。协议和资源生命周期见完整帧/持续会话说明；旧 debug serializer 继续使用原来的零偏移策略。

## 匹配 CanvasKit

```bash
python3 -B experiments/chromium-engine/canvaskit-build.py sync --root /Volumes/Extreme-APFS/Builds
python3 -B experiments/chromium-engine/canvaskit-build.py configure --root /Volumes/Extreme-APFS/Builds
python3 -B experiments/chromium-engine/canvaskit-build.py build --root /Volumes/Extreme-APFS/Builds --jobs 4
npm run experiment:engine -- --root /Volumes/Extreme-APFS/Builds \
  --canvaskit /Volumes/Extreme-APFS/Builds/canvaskit/out \
  --output test-results/chromium-engine-20261028
```

使用 Chromium 已固定的 Skia **886e42fda11610a56dd1b22e8697e27f9d1e34f2**，依赖从该 revision 的 DEPS 读取精确提交，Emscripten 固定为 Skia 要求的 **4.0.7**。工具不覆盖既有依赖 revision、本地源码改动或不同 GN 配置，不修改用户 shell 配置。源码子仓库中的独立构建依赖、输出、SDK/cache 和日志都在外置盘；不可在同一目录并行构建两个 CanvasKit。

构建只提供 CPU SKP replay、字体及图像编解码，关闭 WebGL、paragraph shaping 和 Skottie。使用官方 profiling build 保留 WASM 函数名，并绕过本机无法直接执行的旧版 x86 Closure 工具；这不是生产体积或性能基准。

文字策略针对 macOS 的 unhinted A8 对照：`SK_GAMMA_APPLY_TO_A8`、`SK_GAMMA_EXPONENT=1.0`、contrast 0，配合 `canvaskit-cff.patch` 开启 FreeType 默认 CFF stem darkening 曲线。没有改写 SKP、字体字节或放宽视觉阈值。单独开启 sRGB gamma 会增大误差；sRGB 加 CFF darkening 也未通过全部区域。只有当前匹配版本和覆盖策略在此 fixture 通过。不能外推到 TrueType、可变/彩色字体或任意系统字体。

源码依据：[Blink macOS CreateSkFont](https://chromium.googlesource.com/chromium/src/+/d0c02bfad08ec92a6ffcf989e53cd995e6381a4c/third_party/blink/renderer/platform/fonts/mac/font_platform_data_mac.mm)、[固定 Skia FreeType 路径](https://skia.googlesource.com/skia/+/886e42fda11610a56dd1b22e8697e27f9d1e34f2/src/ports/SkFontHost_FreeType.cpp)、[FreeType CFF 属性](https://freetype.org/freetype2/docs/reference/ft2-properties.html#no-stem-darkening)。

## 三模式运行与证据

`experiment:engine` 要求成功构建并通过上述 C++ 测试的精确二进制。它校验版本、补丁、二进制、component dylib（包括 Viz）和输出资源哈希，不使用已安装 Chrome 代替。自定义 CanvasKit 还必须具有成功构建状态、相同 Skia revision、匹配配置/补丁和 JS/WASM 指纹。随后串行运行同一构建的 ordinary / remote-paint / record-only-display 三组捕获，各自保留原始 trace、SKP、来源、前后阶段和独立本地视觉对照。

本地 replay/reference 浏览器始终不启用 remote-paint，让画面在独立本地端正常生成。生产 `src/` 不接入截图或浏览器像素后端。

证据分析要求：

- SKP 来自由准确 fixture URL 识别的 renderer；`RemotePaintRecord` 与 `RemotePaintNoTiles` 具有相同 PID、layer id、source frame number，且时间顺序正确。
- 至少一个同一 renderer 的两个不同 source frame 具有配对记录；不能把不同 renderer 的帧号拼接成进展。
- trace 显式无丢数；任何观测到的 raster 记录均阻止 picture-layer candidate。
- ordinary 对照实际观测到 raster，三组均完成客户端重放并通过既有严格视觉阈值。
- record-only-display 要求原生 skip 标记在 recording 之后持续出现，且没有观测到 renderer DrawFrame；`Display::DrawAndSwap` 包含 aggregation，不应直接当作像素绘制。
- 三模式的两个可视阶段 SKP 哈希一致；每组在可视阶段之外继续检查真实点击、键盘激活、缩小视口后的滚动、刷新、sessionStorage 及刷新后再点击。这只验证执行/调度活性，不验证滚动画面或复杂合成。

即使这些条件成立，报告也只标记 `record-only-display-candidate`，保持 `engineSplitGate: not-passed` 和 `serverRasterBypassed: false`。没有 trace 事件不是未执行的证明。该候选结合编译代码、原生正向标记、普通绘制对照及活性/视觉验证，范围仍限定在无图片/Canvas/WebGL/video 的固定页面。其他像素路径、完整帧状态机及 CPU/RSS/线程成本仍需实测；不得据此推导生产兼容性或容量收益。

## 后续任务

1. **扩大持续会话覆盖**：固定二维 fixture 的完整帧、持续 producer、ACK、接管、断线和资源失败恢复已完成；继续处理导航、多 renderer/widget、嵌套滚动和 DPR/zoom。旧 `experiment:paint` 仍是 debug 单 picture 路线。
2. **真实页面视觉与输入**：覆盖 transform/clip/opacity、多个图层、iframe、文本输入/IME、滚动和缩放，逐区域比较重放与本地原页面；扩展字体和图片资源版本/生命周期协议。
3. **能力边界**：明确 Canvas/WebGL/video/readback 的拒绝或协作方案，避免这些路径静默恢复服务端像素生成。当前无显示模式不提供 screenshot/copy-output。
4. **运行时与成本**：从 component 开发构建整理最小分发包；在无调试 trace 的对照下测 CPU、RSS、线程、网络字节及本地绘制成本。WASM heap 固定大小不等于进程 RSS，记录条数不等于 CPU 节省。
5. **会话恢复与扩容**：当前已有 worker/control epoch、动作队列、同页 agent/人工输入及 cookies/localStorage 冷恢复；继续研究完整执行状态恢复。收益成立后再做跨节点调度及容量测试。

## 本地工具验证

```bash
npm test
npm run check
npm run test:engine-build
CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:e2e
```

本地已有真实 capture 时启用额外的 64 次重放内存检查：

```bash
CHROMIUM_CAPTURE_DIRECTORY=test-results/chromium-engine-20261028/record-only-display \
CANVASKIT_DIRECTORY=/Volumes/Extreme-APFS/Builds/canvaskit/out \
CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:e2e
```

此检查对比正常 surface dispose 与故意遗漏像素分配释放的对照，确认测试能发现持续增长。它只检查 WASM heap，不测总浏览器内存。CI 没有本机原生捕获时跳过这一项，不用合成 SKP 冒充验收。

Python 测试在临时 Git 仓库检查补丁可重复应用、未提交工作受保护和自定义构建参数不被覆盖；这些工具测试不会假装已编译 Chromium。实际构建与运行进度以构建状态和后续验证记录为准。

资料：[官方 macOS 构建说明](https://chromium.googlesource.com/chromium/src/+/main/docs/mac_build_instructions.md)、[固定版本源码](https://chromium.googlesource.com/chromium/src/+/d0c02bfad08ec92a6ffcf989e53cd995e6381a4c/)、[原生绘图实验](CHROMIUM_PAINT.md)。
