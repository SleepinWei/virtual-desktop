# 测试与本地复现

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

当前优先读取 [NATIVE_RUNTIME.md](NATIVE_RUNTIME.md)。本机 16 GiB，默认只测一个原生执行浏览器，使用 `nice -n 10 npm run bench:native -- ... --max-active 1`；96 请求突发不等于 96 个浏览器。看门狗触发即停止，不提高预算补跑。加 `--single-session --guard` 的 `experiment:live` 会明确跳过双会话恢复；额外参考浏览器仍可能超预算，不能把安全停止写成视觉通过。原生 GUI 可复用现有本机浏览器验证，避免额外起完整参考进程。

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

运行 `npm run experiment:paint` 验证本机浏览器的原生 SKP 捕获和客户端 CanvasKit 重放；`npm run experiment:headless` 配合显式 headless shell 二进制路径检测受控帧能力。版本耦合、输出和失败状态见 [CHROMIUM_PAINT.md](CHROMIUM_PAINT.md)。实验未作为当前 v0 CI 的兼容性保证，实际结果应记录浏览器版本和能力限制。

## 当前受限云端环境的结果

实测结果见 [VALIDATION.md](VALIDATION.md)。浏览器 UI 测试如果无法运行，必须记录具体阻塞，不能将其改成 skip 并宣称端到端通过。

## 转到 Codex 本地

1. 在本地 checkout 仓库，或解压本次交付源码包。
2. 用 Codex 打开项目目录，读取 `TECHNICAL_FRAMEWORK.md` 和 `CODEX_HANDOFF.md`。
3. 执行以上检查与浏览器测试；修复客户端可见问题后更新验证记录。
4. 只有真实 Chromium/Skia 拆分实现通过对应 trace、视觉与兼容测试，才能把项目称为通用的云端无像素浏览器。
