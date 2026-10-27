# virtual-desktop

面向 agent 的云端网页执行与本地图形绘制实验。

**v0 是受限 HTML/表单场景的协议 PoC，不是通用 Chromium 云浏览器。** 服务端用 LinkeDOM 维护 DOM、Yoga 计算布局，输出 JSON 绘图指令；客户端 Canvas 2D 负责生成像素。v0 服务端不启动 Chromium，不生成截图或编码视频。另有独立的 Chromium 原生绘图实验，研究真实浏览器输出切分；它仍会执行常规栅格化。

- [技术框架与边界](TECHNICAL_FRAMEWORK.md)
- [协议与 API](docs/PROTOCOL.md)
- [测试与后续 Codex 开发](docs/TESTING.md)
- [实测结果与未验证项](docs/VALIDATION.md)
- [Chromium 原生 SKP 与客户端重放实验](docs/CHROMIUM_PAINT.md)

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

实验运行真实 HTML/CSS/JavaScript，导出原生 SKP，并尝试用本地 CanvasKit 重放按钮操作前后的状态，保存 trace、来源及逐区域视觉比较。`-- --serve` 保留实验页面。详情与能力边界见 [实验说明](docs/CHROMIUM_PAINT.md)；SKP 导出不代表已绕过服务端像素生成，引擎关卡仍未通过。
