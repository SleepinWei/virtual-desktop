# 测试与本地复现

## 图片及真实输入（2026-10-30）

[验收证据](chromium-native-images-2026-10-30.json)：135 JS、16 Python、29 C++ 通过。图片、圆角、渐变遮罩及明确首帧模式的两帧 GIF，共 7 组图片区域通过；密集文字与公开网站严格视觉仍失败，不据此接受性能比值。

```bash
node experiments/chromium-engine/guarded-native-tests.js --root /Volumes/Extreme-APFS/Runtimes/virtual-desktop-web-156-20261030 --canvaskit /Volumes/Extreme-APFS/Runtimes/virtual-desktop-web-156-20261030/canvaskit/out --task images --in-process-gpu --output test-results/native-images

VIRTUAL_DESKTOP_MAC_GPU_MODE=in-process node experiments/chromium-engine/probe-site.js --root /Volumes/Extreme-APFS/Runtimes/virtual-desktop-web-156-20261030 --canvaskit /Volumes/Extreme-APFS/Runtimes/virtual-desktop-web-156-20261030/canvaskit/out --site bilibili --mode both --viewer --interact --max-rss-mib 2048 --output test-results/bilibili-input
```

Bilibili 预览显式固定图片首帧，普通对照也使用同一浏览器设置。测试检查坐标请求确实被接受、远端真实 input 收到 8 个字符、URL 不变、提示没有遗留错误；不能仅靠之前 agent 的焦点把文字送入就算坐标通过。坐标签名测试覆盖目标内外变化、遮挡、移动、嵌套裁剪、2 px 保守边缘、滚动和两份元数据保留上限。当前动画图片默认拒绝，只有明确的首帧标记允许；GIF 故障注入会移除标记并确认实际 WASM 拒绝。

最终原始结果存放在 `test-results/images-runtime-20261030/`，成功网站轮为 `bilibili-region-input`；之前的风控、动画、内存与坐标失败保留，不能当最新通过轮。构建和短时联合测试分别沿用既有 6 GiB / 2 GiB 例外，单浏览器及默认服务仍为 1.5 GiB。

## 字体 runtime（2026-10-30）

[字体验收记录](chromium-font-runtime-2026-10-30.json) 覆盖 117 JS、16 Python、23 C++、9 组真实字体、动态与预置字体 live 流程和共享 host 回归。字体探针收集/解码成功不等于严格画质通过；密集文字比较及 CERN 网站比较的失败明确保留。

```bash
# CanvasKit 与原生引擎使用同一固定 Skia；常规编译保留资源 watchdog。
node experiments/chromium-engine/guarded-lean-build.js --root /Volumes/Extreme-APFS/Builds --task canvaskit --jobs 1

# 在已完成 C++ gate 的独立包上收集字体二进制及原生重放证据。
node experiments/chromium-engine/guarded-native-tests.js --root <候选包> --canvaskit <候选包>/canvaskit/out --task fonts --output test-results/font-runtime --in-process-gpu

# 预置 fonts/catalog.json 指定的字体/字形资源，必须使用新输出目录。
node experiments/chromium-engine/package-runtime.js --root /Volumes/Extreme-APFS/Builds --canvaskit /Volumes/Extreme-APFS/Builds/canvaskit/out --layout lean --font-assets test-results/font-runtime --output <新运行包目录>

# 完整 viewer/执行浏览器组合：显式 2 GiB，其余 native 测试仍 1.5 GiB。
node experiments/chromium-engine/guarded-native-tests.js --root <新运行包目录> --canvaskit <新运行包目录>/canvaskit/out --task live --max-rss-mib 2048 --output test-results/font-live --in-process-gpu
```

字体探针等待 font-ready 原生时间标记之后、正确 renderer/tree 的完整非空字体帧。中文 hvgl 使用独立矢量子集；缺字形故障注入会重新计算正确哈希，确保验证的是解码覆盖，而非仅在哈希阶段失败。HTTP 字体流测试覆盖完成、取消、重连与缓存淘汰后的独立句柄生命周期。


## 环境

Node.js >=22；本项目使用 ESM。`npm ci` 根据 lockfile 安装依赖。

```bash
npm ci
npm test
npm run check
npm run bench
```

协议/集成测试真实启动 HTTP 服务与每会话子进程，测试后关闭服务并删除临时 profile。它们不需要浏览器。

客户端绘制器测试使用测试进程中的原生 Canvas 实现执行 `public/renderer.js`，检查实际像素与更新。它不会成为服务端 worker 的依赖。它能验证绘制代码，但不能替代浏览器 UI 验证。

## 浏览器端到端

```bash
npx playwright install chromium
npm run test:e2e
```

Linux 缺少浏览器系统依赖时，可在自己控制的开发机按 Playwright 官方方法安装：

```bash
npx playwright install --with-deps chromium
```

默认测试启动 v0 本地服务和一个客户端 Chromium，验证 Canvas 实际像素、增量更新、人工点击输入、热会话切换及保存恢复，并写入 `test-results/viewer.png`。v0 执行路径不启动浏览器；显式启用的原生后端有独立执行浏览器。

可以通过 `CHROMIUM_EXECUTABLE_PATH` 指定已有浏览器，例如 macOS 上使用独立的 Chrome 测试进程：

```bash
CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:e2e
```

测试使用默认的无头客户端配置，不附加云端实验中的 SwiftShader 或其他启动补丁；不会使用你的日常 Chrome profile。

E2E 对快速连续动作接受协议允许的 snapshot 回退，并在单步操作中单独确认 delta。画面更新、热切换、冷恢复都检查实际 Canvas 像素；延迟响应回归验证保存 A 期间切到 B，以及旧帧抵达时控制权 epoch 不倒退。

像素采样从浏览器导出 PNG，在测试进程中解码并做严格比较，以免反复 `getImageData` 改变被测 Canvas 的绘制方式。失败的像素一致性断言会保存前后图像及差异图，便于定位内容或栅格化差异。

## 持续验证

`.github/workflows/ci.yml` 在推送 `main` 或向 `main` 提交 PR 时执行语法检查、协议/集成测试和浏览器 E2E。CI 按 [Playwright 官方说明](https://playwright.dev/docs/ci) 安装 Chromium 与系统依赖，并将 `test-results/` 中的截图保留 7 天。浏览器启动或断言失败会令工作流失败，不标记 skip。

## benchmark

```bash
BENCH_SESSIONS=8 BENCH_ITERATIONS=20 npm run bench
```

样本限制为 1–32 个 session、每 session 1–200 次动作。每次运行保存 `test-results/benchmark.json`，包含环境、样本数、创建/操作延迟分布、帧 JSON 字节数、每个 worker 的峰值 RSS 和可读取的当前 RSS。

这只衡量内置小应用的 HTTP/IPC、布局与指令生成路径，没有测真实网站、网络资源、完整浏览器或安全隔离成本。首次创建 p95 包含并发启动节流造成的排队；样本很少，不能当作 SLO。

## Chromium 原生绘图实验

当前优先读取 [NATIVE_RUNTIME.md](NATIVE_RUNTIME.md) 和 [lean 验收](chromium-lean-acceptance-2026-10-29.json)。本机 16 GiB，默认只测一个原生执行浏览器，使用 `nice -n 10 npm run bench:native -- ... --max-active 1`；96 请求突发不等于 96 个浏览器。看门狗触发即停止，保留失败报告；不能把安全停止写成视觉通过。加 `--single-session --guard` 的 `experiment:live` 会明确跳过双会话恢复。

`npm run test:native-acceptance -- --task smoke|frames|engine|pool --root ... --output ...` 为原生后续测试提供外层进程树保护、低 CPU 优先级、180 秒上限和结果状态检查。macOS 的 `--in-process-gpu` 是显式启动 workaround，默认保持独立 GPU；当前默认路径在本机未通过。每次只运行一个 task，使用不同输出目录保存结果。具体命令见 [CHROMIUM_SUBSET.md](CHROMIUM_SUBSET.md)。

该入口默认固定 1.5 GiB，只有 `--task live --max-rss-mib 2048` 接受显式 2 GiB 联合预算，覆盖执行 browser、本地 viewer 与协调进程；其他任务或任意更高数值会在启动前拒绝。live 先生成独立普通渲染参考图并关闭参考 browser，再打开执行 browser/viewer，保持原像素/区域阈值。该联合预算不改变正式会话、单生产端及公共 load guard 默认值，整机 free 35% / 换页 64 MiB / 心跳 4 秒保护保留。2026-10-29 联合测试实际峰值 1,548.9 MiB、无新增 swapout；此前 1.5 GiB 两次停止独立记录。双独立 browser/冷恢复和实体 OS 输入法本轮未验收。

持续会话入口为 `npm run experiment:live`，复现和完整验收见 [CHROMIUM_LIVE.md](CHROMIUM_LIVE.md)。额外 E2E 的 `CHROMIUM_LIVE_BUILD_ROOT` 必须指向当前成功构建/测试的固定引擎，`CANVASKIT_DIRECTORY` 指向匹配 runtime。它实际启动持续执行 worker 和独立本地验证浏览器，检查接管、输入、自动更新、断线/刷新/坏资源恢复、双会话和冷存储恢复及崩溃清理。

```bash
CHROMIUM_LIVE_BUILD_ROOT=/Volumes/Extreme-APFS/Builds \
CHROMIUM_FRAME_CAPTURE_DIRECTORY=test-results/chromium-frames-rotation-20261028 \
CHROMIUM_CAPTURE_DIRECTORY=test-results/chromium-engine-frame-regression-20261028/record-only-display \
CANVASKIT_DIRECTORY=/Volumes/Extreme-APFS/Builds/canvaskit/out \
CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:e2e
```

批量完整帧入口仍为 `npm run experiment:frames`，说明见 [CHROMIUM_FRAMES.md](CHROMIUM_FRAMES.md)。`CHROMIUM_FRAME_CAPTURE_DIRECTORY` 启用真实多层捕获的 E2E，`CHROMIUM_CAPTURE_DIRECTORY` 启用旧单 picture 内存检查。无原生输入的 CI 显式跳过这三项，不跳过普通 viewer E2E 或协议/HTTP 测试；本机提供全部输入时 6 项均实际执行。

`npm test` 另外覆盖 trace 原生字节提取、来源和阶段分类、损坏记录拒绝、空数据/错误像素拒绝、实验服务资源白名单及 headless 能力失败报告。这些纯分析测试不启动 Chromium，不能代替实际 SKP 解码与视觉验证。

真实站点对照通过同一守护入口执行：

```bash
# 可选 example、iana、cern、python、bilibili、hackernews，每次一个站点。
npm run test:native-acceptance -- --task site --site cern --in-process-gpu \
  --root /Volumes/Extreme-APFS/Runtimes/virtual-desktop-lean-156-20261029 \
  --iterations 8 --rounds 2 --output test-results/sites-cern
```

新入口固定默认 1.5 GiB，限制 4–12 次操作、1–2 轮，不接受没有对应 workload 的站点；CERN 两轮用 AB/BA 运行顺序。只做本地输入/焦点，不导航或提交表单。普通模式每动作产生 JPEG80，原生模式只产生真实 SKP 与元数据。生产端全部关闭后，用独立本地 browser 重放保存的资源，检查 ACK 与原始帧，再将原生结果和 JPEG80 各自与普通无损 PNG 对照：整图和 9 个固定区域均使用原阈值。两者功能、状态、原生新帧及两种画质均通过才输出比值；失败返回非零并写入 `site-report.json` 与 `guard-report.json`。原生无帧、网站 HTTP 失败、来源缺失、像素不一致或资源保护停止不能成为性能成功。当前六站均未获得完整资格，见 [网站实测](chromium-sites-2026-10-29.json)。

原因诊断也使用同一外层保护，顺序运行，各任务使用新输出目录：

```bash
# fonts：本地字体对照；images：无图/PNG/背景/inline SVG 对照。
npm run test:native-acceptance -- --task fonts --in-process-gpu \
  --root /Volumes/Extreme-APFS/Runtimes/virtual-desktop-lean-156-20261029 \
  --output test-results/diagnose-fonts

# raster-diagnostic：独立 macOS raster 控制与 CanvasKit 的同字节 SKP 对照；
# 使用保留的 test-results/public-sites-20261029/cern-final 捕获文件。
# startup-diagnostic：IANA 的完整启动来源/readiness 证据。
```

字体分析器只读识别 SKP 内的 SFNT 元数据；`font-table-sizes.py` 通过 CoreText 读取系统字体表大小，不导出字体文件，私有 UI 字体使用正式 UI/fallback API，替换字体的尺寸不被接受。raster 诊断的 PNG 是独立普通模式控制，CSS 字体平滑修改也是消歧对照，不能替换原参考或进入生产帧。所有诊断中的 `native-diagnostics-complete` 仅表示完成观测；字体导出或图片不支持的结果仍可被成功记录。完整原因与范围见 [诊断记录](chromium-native-diagnosis-2026-10-30.json)。

运行 `npm run experiment:paint` 验证本机浏览器的原生 SKP 捕获和客户端 CanvasKit 重放；`npm run experiment:headless` 配合显式 headless shell 二进制路径检测受控帧能力。版本耦合、输出和失败状态见 [CHROMIUM_PAINT.md](CHROMIUM_PAINT.md)。实验未作为当前 v0 CI 的兼容性保证，实际结果应记录浏览器版本和能力限制。

## 当前受限云端环境的结果

实测结果见 [VALIDATION.md](VALIDATION.md)。浏览器 UI 测试如果无法运行，必须记录具体阻塞，不能将其改成 skip 并宣称端到端通过。

## 转到 Codex 本地

1. 在本地 checkout 仓库，或解压本次交付源码包。
2. 用 Codex 打开项目目录，读取 `TECHNICAL_FRAMEWORK.md` 和 `CODEX_HANDOFF.md`。
3. 执行以上检查与浏览器测试；修复客户端可见问题后更新验证记录。
4. 只有真实 Chromium/Skia 拆分实现通过对应 trace、视觉与兼容测试，才能把项目称为通用的云端无像素浏览器。
