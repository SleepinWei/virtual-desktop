# Codex 本地接续

## 项目不能丢失的目标

用户要的是云端维护网页执行状态、本地执行像素绘制，并借此减少服务端图形负担与传输开销。不要把任务改回 headless Chromium 截图/视频 viewer。绘图指令技术可行性优先于大量堆叠调度组件。

## 当前实现

v0 是 Node.js + LinkeDOM + Yoga 的可信应用协议 PoC。服务端没有 Chromium 和像素后端；本地 Canvas 绘制 JSON 指令。提供每 session 子进程、语义操作、控制 epoch、有界队列、增量帧、profile 保存恢复。任意网站/完整 CSS/网站 JS/CDP 兼容均未实现。详见框架与验证记录。

仓库已补齐早期下载源码包中的代码、测试、协议和验证记录。下载包保留用于溯源；后续开发以当前 Git 历史为准。

下一阶段工作位于 `experiments/chromium-paint/`：真实 Chromium trace/SKP 捕获、来源校验、本地 CanvasKit 重放与视觉验证、headless shell 帧控制能力探针。复现入口和资源要求见 [CHROMIUM_PAINT.md](docs/CHROMIUM_PAINT.md)。这些实验没有关闭 stock Chromium 的 raster，不能当作通用引擎关卡通过；先读最新验证记录再接续。

外置 APFS 准备完成后的接续入口为 `experiments/chromium-engine/`，见 [CHROMIUM_ENGINE.md](docs/CHROMIUM_ENGINE.md)。固定 Chromium 156 提交的 picture-layer 补丁、构建恢复工具、C++ 测试及 ordinary/remote-paint 成对实验均在此处。先读取 `/Volumes/Extreme-APFS/Builds/chromium/virtual-desktop-build-state.json` 和对应日志，核对实际进程后恢复阶段，避免重复构建。源码、缓存和 out 均在外置盘；不能仅凭工具测试、应用补丁或 GN 成功声称完成引擎编译/切分。

## 立即执行

```bash
npm ci
npm test
npm run check
npx playwright install chromium
npm run test:e2e
npm run bench
npm start
```

浏览器测试生成 `test-results/viewer.png`，应同时检查实际像素与交互回归结果。历史云端环境中浏览器启动以 SIGTRAP 退出；各环境的验收结果见 `docs/VALIDATION.md`，不能把一个环境的结论当成所有环境的保证。

## 下一阶段关卡

1. 定位并验证 Chromium/Blink/Skia 输出切分点，先在一个真实页面证明云端主要像素生成路径被绕过。
2. 明确 display list、图层、字体、图像与增量资源协议；评估 CanvasKit 适配和浏览器版本耦合。
3. 用真实页面测视觉一致性与 API 语义，优先处理 iframe、输入法、页面缩放、Canvas 像素读取和 WebGL 能力边界。
4. 再与 headless + 截图对照，测同任务成功率下的 CPU、内存、带宽和客户端负担。
5. 收益成立后做 100 活跃/1,000 冷状态目标和生产隔离；本地 demo 子进程不能当作恶意多租户隔离。

## 仓库同步

目标仓库是 `https://github.com/SleepinWei/virtual-desktop`，private；早期工作分支为 `poc/split-rendering-v0`，完整交付同步到 `main`。交付内容与提交历史以远端分支为准，本地离线提交的 SHA 不等于网页提交产生的 SHA。**不要创建同名公开仓库作为替代。**

从源码包导入或继续开发时，先 clone 并检查远端现有内容和 AGENTS.md，再提交需要的变化，保留远端历史，不 force push。不要复制 `.cache`、`node_modules`、`.data`、测试临时 profile、SSH 私钥或会话 token。初始环境的接口与 SSH 限制见验证记录；网页登录状态不代表终端已经拥有 Git 凭据。
