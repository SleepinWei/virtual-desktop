# 持续 Chromium 会话接入

2026-10-28 达到 **live-native-session-candidate**。真实 Chromium 页面持续运行，agent 与人工操作使用同一页面；原生完整帧经私有 Unix socket、worker IPC 和 HTTP 流送到本地 CanvasKit。viewer 断开或刷新不重建浏览器。验收及实际构建指纹见 [chromium-live-2026-10-28.json](chromium-live-2026-10-28.json)。

默认 `npm start` 继续运行 LinkeDOM/Yoga v0；原生后端显式开启。当前仅开放仓库内固定 A8 字体的可信页面，`engineSplitGate: not-passed`、`serverRasterBypassed: false` 保留。

## 启动与验证

先按 [引擎构建说明](CHROMIUM_ENGINE.md) 完成当前补丁的构建、11 项过滤 C++ 测试和匹配 CanvasKit。旧补丁的成功状态不能用于启动新服务。

```bash
npm run start:native -- --root /Volumes/Extreme-APFS/Builds \
  --canvaskit /Volumes/Extreme-APFS/Builds/canvaskit/out --port 8081
```

打开 <http://127.0.0.1:8081/native>，管理 token 默认 `dev-local`。创建会话后接管即可点击、滚动；先点击远端输入框，再用下方文本框发送文字。Tab、Enter、Backspace 按钮发送原生键盘输入；本地 Tab 键保留正常焦点导航。归还后 agent 重新 observe 获取控制 epoch。

```bash
npm run experiment:live -- --root /Volumes/Extreme-APFS/Builds \
  --canvaskit /Volumes/Extreme-APFS/Builds/canvaskit/out \
  --output test-results/chromium-live-20261028
```

独立本地验证浏览器负责 PNG 和参考页面绘制；执行 worker 不调用 screenshot、readback 或 DOM 几何提取来生成画面。输出包括 `live-report.json`、两组原图/重放 PNG、桌面/窄屏 UI 和诊断 trace。CLI 仅在全部验收通过时成功退出。

## 数据与会话边界

`PrepareToDraw` 在更新原生 draw properties 后直接导出当前活跃树。renderer 的后台顺序任务负责 socket 写入，最多一个正在写的消息和一个最新待发消息，阻塞写有期限；单条消息最多 8 MiB。传输失败关闭连接并重发完整消息，不拼接不同连接的半条记录。序列化仍输出完整 SKP，此阶段没有优化原生导出的 CPU 或 base64 成本。

worker 在启动浏览器前创建 0700 私有目录、0600 socket 和随机 256-bit capability；通过继承环境传给专属浏览器。只读一次短的、仅包含进程元数据的启动 trace，把精确 fixture URL 绑定到一个 renderer PID。后续画面来自 socket，不依赖启动或诊断 trace。当前只接受该 renderer 的一个主 widget/tree；同 renderer 的额外 widget 会使帧失效。

socket JSON 必须完整、身份有效且大小有界；原生帧再经既有严格 normalizer 校验。worker IPC 合并中间更新；gateway 仅保留最新完整帧及未确认帧引用的资源。同一视觉内容不重复发送。完整帧权威成员、合成规则和逐字节 SKP 来源沿用 [完整帧协议](CHROMIUM_FRAMES.md)。

每会话最多 4 个 viewer。每个通道最多 2 个未 ACK 帧和 1 个最新合并帧；未连接的握手 15 秒过期。资源缓存按序列化字节计上限 128 MiB，并非解码后 WASM 或进程 RSS 上限。浏览器生命周期独立于 viewer；worker 异常退出时父进程清理该 worker 专属的 Chromium 进程组并释放准入容量。

控制转移和动作使用已有会话串行队列及 control epoch。只读 viewer 无法操作；失效的 agent/human epoch 被拒绝；重复 actionId 不执行两次。坐标输入绑定已 ACK 的完整画面，并在 gateway 与 worker 再次检查当前视觉签名。键盘/文字要求有效 ACK 和控制权，但不因光标闪烁而要求画面签名完全相同。

viewer 用带 Authorization header 的 fetch 读取 NDJSON，凭据不进入 URL。资源必须通过长度、SHA-256、解码和本地绘制才 ACK。出错保留旧像素、停用输入，最多自动恢复两次；新连接 epoch 清空资源状态并请求当前完整快照。页面刷新使用该 tab 的 sessionStorage 恢复能力凭据并重新核对控制权，保持原来的执行页面。

## API

`POST /api/sessions` 的原生选项为 `{"backend":"chromium","fixture":"live"}`；`fixture: "frames"` 可运行此前多层页面。会话管理、observe、actions、control、release、metrics 路径复用原 API，但原生会话不能通过 v0 `/frame` 获取画面。

| 原生路径后缀 `/api/sessions/:id/frames/` | 用途 |
| --- | --- |
| `POST connect` | 创建新的传输 epoch，返回当前控制权 |
| `GET stream?epoch=…` | 持续 NDJSON 帧、控制变化和心跳 |
| `GET resources/:sha256?epoch=…` | 获取该通道未确认帧引用的原始 SKP |
| `POST ack` | 确认完整帧已显示及资源缓存清单 |
| `POST disconnect` | 关闭 viewer 通道，保留执行会话 |

原生 action 支持语义 `click` / `fill`、坐标 `pointer` / `wheel`、`text` 和受限 `key`。坐标/键盘/文字 action 还携带 `connectionEpoch`、`seq`、`frameId`；控制 epoch 与传输 epoch 含义不同。语义 observe 返回真实 DOM 文本和输入目标，不提供用来重建画面的 DOM 几何。

`release: {"save":true}` 保存 cookies/localStorage，后续以相同 profileId 启动新浏览器；这不是 JS heap、DOM 或 sessionStorage 快照。不同 backend 的 profile 拒绝混用。

## 验收范围与后续

实测覆盖无 viewer 的 agent 操作、人工接管/归还、真实坐标焦点/文字/滚动、页面定时器自主更新、离线与刷新恢复、坏资源重试、双会话状态/凭据分离、冷存储恢复、动作去重及 worker 崩溃清理。固定页面两组整图和每组 7 个独立区域沿用平均 RGB 误差 ≤3、超 32 差值像素 ≤2% 的阈值。

短的完整诊断 trace 另检查 recording/no-tiles 正向标记与 display skipped 标记，要求显式未丢数、未观测到匹配 raster/renderer DrawFrame；停止该 trace 后仍执行动作并收到 socket 新帧。零记录不能独立证明所有像素路径均已绕过，先前 ordinary/remote/record-only 的对照保留为历史证据。

该本地实验以 `chromiumSandbox: false` 启动，只允许精确本地 fixture 路径的 GET；不开放任意网站。尚需覆盖默认/多种字体、图片、iframe/OOPIF、IME、缩放/DPR、导航及复杂合成；Canvas/WebGL/video/readback 的支持或拒绝策略也未完成。worker 指标中的 RSS 仅含 Node worker，不包含 Chromium；尚无总 CPU/RSS/带宽、最小 runtime 包、跨节点调度或生产多租户隔离结论。
