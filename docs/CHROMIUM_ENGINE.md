# Chromium 引擎构建与 picture-layer 实验

此阶段把原生绘图实验推进到固定源码版本的引擎改动。`source.json` 固定 Chromium **156.0.8078.48 / d0c02bfad08ec92a6ffcf989e53cd995e6381a4c**、depot_tools 提交及补丁前后各文件的 SHA-256。仓库保存补丁和工具，不保存 Chromium 源码、编译器或构建输出。

**完整引擎切分关卡仍未通过。** `VirtualDesktopRemotePaint` 只控制 Blink compositor 的 picture-layer tile 与 picture quad；Viz 显示和背景绘制、Canvas、WebGL、视频以及其他资源图层仍需独立处理。该模式仅供可信本地 fixture 实验，不能替换当前 worker 后端。

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

`sync` 使用 shallow checkout，固定 revision，禁用自动 depot_tools 更新和工具指标上报。它也执行官方 `ensure_bootstrap`；单独运行过 gclient 的目录可能还没有 GN/autoninja 需要的 Python shim，可用 `build.py bootstrap` 补齐。后续同步遇到本地修改会拒绝覆盖；补丁输入哈希不符、已有不同 `args.gn` 或 `.gclient` 也会停止。

默认构建使用 macOS arm64、release/component、`symbol_level=0`、保留 DCHECK、关闭 PGO 和远程执行，先采用 2 个本地编译任务。`objects` 编译变动源文件和 C++ 测试对象，仍需生成/编译其依赖。它成功不等于 `headless_shell` 已链接或测试已运行。

运行状态位于 `chromium/virtual-desktop-build-state.json`，日志位于 `logs/chromium-*.log`，输出位于 `chromium/src/out/VirtualDesktop`。失败保留增量构建；修复后重跑对应阶段。运行前检查状态和实际进程，不能同时启动两个写入同一 checkout 的作业。`status` 只读检查当前空间、SDK、版本及记录阶段。

## 引擎改动

启动参数 `--enable-features=VirtualDesktopRemotePaint` 将实验设置传入 Blink 创建的 `cc::LayerTreeSettings`，默认关闭。

1. `PictureLayerImpl::UpdateRasterSourceInternal` 在新的 recording 提交时输出 `VirtualDesktop.RemotePaintRecord`，携带真实 layer id、source frame number 和 SKP。使用 recording canvas 序列化，不创建页面像素 surface。
2. `CanHaveTilings` 在实验设置下返回 false，沿已有无 tiling 分支清理/阻止 tile 创建。保留 `TileManager::PrepareTiles` 和正常 commit/activation 调用，让空任务队列继续执行既有就绪通知。
3. `WillDraw` 拒绝 picture-layer 绘制；`AppendQuads` 同时防止直接调用进入 checkerboard 或 resourceless software 分支。其他 layer 类型及 Viz 显示工作不在此补丁范围内。
4. `RemotePaintPictureLayerImplTest` 检查 recording 保留、无 tiling/显存、连续激活新 recording，以及 hardware/software/resourceless 三种模式均不产生 picture quad。普通模式的既有 tiling 创建测试作为对照。

这没有增加完整帧、property tree、资源生命周期、层移除或跨网络 ACK 协议。现有 debug serializer 对 raster-inducing scroll 使用零偏移；滚动和复杂合成不能由固定 fixture 的结果推断。

## 成对运行与证据

`experiment:engine` 要求成功构建并通过上述 C++ 测试的精确二进制。它校验版本、补丁、二进制、component dylib 和输出资源哈希，不使用已安装 Chrome 代替。补丁位于 component dylib，只有 shell 可执行文件的哈希不足以确认它。随后串行运行同一构建的 ordinary / remote-paint 两组捕获，各自保留原始 trace、SKP、来源、前后阶段和独立本地视觉对照。

本地 replay/reference 浏览器始终不启用 remote-paint，让画面在独立本地端正常生成。生产 `src/` 不接入截图或浏览器像素后端。

证据分析要求：

- SKP 来自由准确 fixture URL 识别的 renderer；`RemotePaintRecord` 与 `RemotePaintNoTiles` 具有相同 PID、layer id、source frame number，且时间顺序正确。
- 至少一个同一 renderer 的两个不同 source frame 具有配对记录；不能把不同 renderer 的帧号拼接成进展。
- trace 显式无丢数；任何观测到的 raster 记录均阻止 picture-layer candidate。
- ordinary 对照实际观测到 raster，两组均完成客户端重放并通过既有严格视觉阈值。

即使这些条件成立，报告也只标记 `picture-layer-candidate`，保持 `engineSplitGate: not-passed` 和 `serverRasterBypassed: false`。没有 trace 事件不是未执行的证明。Viz/background、其他图形能力、完整帧状态机及 CPU/RSS/线程成本仍需实测；不得从这一步推导生产兼容性或容量收益。

## 本地工具验证

```bash
npm test
npm run check
npm run test:engine-build
CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:e2e
```

Python 测试在临时 Git 仓库检查补丁可重复应用、未提交工作受保护和自定义构建参数不被覆盖；这些工具测试不会假装已编译 Chromium。实际构建与运行进度以构建状态和后续验证记录为准。

资料：[官方 macOS 构建说明](https://chromium.googlesource.com/chromium/src/+/main/docs/mac_build_instructions.md)、[固定版本源码](https://chromium.googlesource.com/chromium/src/+/d0c02bfad08ec92a6ffcf989e53cd995e6381a4c/)、[原生绘图实验](CHROMIUM_PAINT.md)。
