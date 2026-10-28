# virtual-desktop

面向 agent 的云端网页执行与本地图形绘制实验。

**v0 是受限 HTML/表单场景的协议 PoC，不是通用 Chromium 云浏览器。** 服务端用 LinkeDOM 维护 DOM、Yoga 计算布局，输出 JSON 绘图指令；客户端 Canvas 2D 负责生成像素。v0 服务端不启动 Chromium，不生成截图或编码视频。另有独立的 Chromium 引擎实验，已在固定 fixture 验证 picture-layer 与 Viz 无绘制候选；通用引擎关卡尚未通过。

- [技术框架与边界](TECHNICAL_FRAMEWORK.md)
- [协议与 API](docs/PROTOCOL.md)
- [测试与后续 Codex 开发](docs/TESTING.md)
- [实测结果与未验证项](docs/VALIDATION.md)
- [Chromium 原生 SKP 与客户端重放实验](docs/CHROMIUM_PAINT.md)
- [固定版本 Chromium 引擎构建与 picture-layer 补丁](docs/CHROMIUM_ENGINE.md)
- [原生完整帧、图层合成与 ACK 实验](docs/CHROMIUM_FRAMES.md)
- [持续 Chromium 会话、实时画面与人工接管](docs/CHROMIUM_LIVE.md)
- [直接输入、后端调度与有限并发对照](docs/NATIVE_RUNTIME.md)

## 运行

需要 Node.js 22 或更新版本。

```bash
npm ci
npm start
```

打开 <http://127.0.0.1:8080>。本地开发管理 token 默认为 `dev-local`，界面已经预填。创建一个会话后，运行示例 agent 或手动接管，观察本地 Canvas 的更新。

```bash
npm test
npm run check
npx playwright install chromium
npm run test:e2e
npm run bench
```

`main` 推送和 PR 会自动执行语法、协议/集成和浏览器测试。E2E 截图与当前环境的验收结论见 [验证记录](docs/VALIDATION.md)。

示例 agent 可以在没有打开 viewer 时完成填表、点击和读取结果：

```bash
npm run demo:agent
```

默认绑定 `127.0.0.1`。当前实现仅用于本地可信实验；进程分离不是针对恶意租户的生产安全隔离。不要将开发 API 直接暴露到公网。

## 已实现与未实现

已实现：每会话独立 Node 子进程、受限 HTML/inline CSS 布局、语义观察、填写和点击、纯指令帧、增量更新、客户端绘制、控制权 epoch、热会话切换、profile 保存与冷恢复、有界准入和启动队列。

未实现：通用网站执行后端、完整 CSS/浏览器语义、绕过常规栅格化的 Chromium 后端、CDP/Playwright 控制兼容、Canvas/WebGL 像素读取、生产多租户隔离、跨节点调度。v0 性能数据不能外推到通用网页。

## Chromium 技术实验

```bash
npm run experiment:paint
```

实验运行真实 HTML/CSS/JavaScript，导出原生 SKP，用本地 CanvasKit 重放按钮操作前后的状态，保存 trace、来源及逐区域视觉比较。`-- --serve` 保留实验页面。此入口使用普通浏览器，仍执行常规 raster，详情见 [实验说明](docs/CHROMIUM_PAINT.md)。

2026-10-28 的[固定版本引擎实验](docs/CHROMIUM_ENGINE.md)增加 headless NullRenderer 和匹配 Skia 的 CanvasKit 文本覆盖策略，三种模式均通过固定页面严格视觉比较。[完整帧实验](docs/CHROMIUM_FRAMES.md)验证了真实多层画面、7° 旋转、透明度分组、裁剪、滚动和删层。

目前已接入[持续 Chromium 会话](docs/CHROMIUM_LIVE.md)：原生 socket 实时输出完整帧、本地 CanvasKit 绘制、agent/人工共用页面，具备 ACK、资源复用、恢复与接管后直接键盘输入。独立文字栏已移除。显式启动命令如下；默认 `npm start` 保持 v0。原生 CLI 默认一个活跃会话并有资源 watchdog；通用网站及完整引擎关卡仍未通过。

```bash
npm run start:native -- --root /Volumes/Extreme-APFS/Builds \
  --canvaskit /Volumes/Extreme-APFS/Builds/canvaskit/out --port 8081
```

打开 <http://127.0.0.1:8081/native>。需要当前已通过原生测试的自编译引擎和匹配 CanvasKit；不会自动使用已安装 Chrome 代替。

最新[有限压测](docs/NATIVE_RUNTIME.md)比较同构建原生记录和每动作 JPEG，验证 96 请求中的 64 个执行与 32 个限流，并修复原生呈现回调累积崩溃。小红书未通过：普通对照遇到 IP 风险页，原生尝试超出本机预算；没有开放可用的 XHS 交互入口。固定字形之外的中文、字体/图片资源协议和长期内存仍需继续处理。
