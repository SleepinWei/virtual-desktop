# v0 验证记录

## 当前本地验收

2026-10-27，macOS arm64 / Apple M4，Node.js v24.21.0，Chrome 156.0.8078.48，Playwright 1.64.1。

- `npm test`：16 项通过，0 失败、0 skip。
- `npm run check`：18 个 JS 文件语法通过；服务端像素后端源码检查通过。
- `CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:e2e`：3 项通过，0 失败、0 skip，约 7.1 秒。
- 已人工检查生成的 `test-results/viewer.png`：示例 agent 与人工添加的任务、恢复后的计数器和两个会话可见。

浏览器主流程验证真实 Canvas 像素变化、单步 delta、快速动作的合法 snapshot 回退、接管与归还、热切换和保存恢复后的持久区域像素一致性。另两项回归固定延迟响应次序，验证保存 A 期间切到 B 不会中断 B，以及迟到旧帧不会降低控制权 epoch。

测试通过浏览器导出 PNG，并在测试进程中解码比较像素；不反复读取被测 Canvas 的像素，避免读回操作改变其后续绘制方式。严格像素一致性断言仍保留。测试中的客户端 PNG 与服务端执行路径分离。

本轮同时修复了迟到 pointer 响应污染新会话输入选择、恢复结果抢占当前会话，以及示例 agent 跨接管继续使用新 epoch 的问题。示例 agent 的同批动作固定使用启动时 epoch。

本地验收覆盖受限应用 PoC；真实网站与 Chromium/Skia 服务端输出拆分仍未实现。CI 在 main 推送或 PR 时重复执行语法、协议/集成和浏览器测试，具体运行结果以 GitHub Actions 为准。

## 历史云端环境

以下保留首次云端实现与打包时的结果，不能替代上面的本地验收记录。

日期：2026-10-27（Asia/Shanghai）。运行环境：受限 Linux x64，Node.js v24.22.1。CPU 型号不可读取，当前 RSS 查询也受环境限制，因此没有填入假定硬件规格。

## 已完成

`npm test`：**16 项通过，0 失败，0 skip**。覆盖：

- 无 viewer 的 agent 填写、点击和读取结果。
- snapshot/delta 精确重建、过期基线处理、真实像素绘制与 DPR。
- 多 session 状态与凭据分离、只读能力、管理权限。
- 人工接管撤销旧 epoch，交还后 agent 重新观察。
- 动作去重、同 id 不同负载拒绝、过期画面坐标拒绝。
- profile 单写、保存与新进程恢复、保存失败保留旧状态。
- 有界创建队列、等待超时、worker 强杀后的资源释放。
- 本地 Host 和跨源请求限制、无效输入及损坏 profile。

`npm run check`：18 个 JS 文件语法检查通过。服务端源码未出现列入检查范围的浏览器/像素生成 import 或调用。此检查是有限源码检查，不能作为未来 Chromium 路线无栅格化的独立证明。

客户端绘制代码在测试进程中的原生 Canvas 后端上生成实际像素：蓝色按钮像素为 `[36,99,235,255]`，背景为 `[240,244,250,255]`；计数器更新改变输出像素；DPR=2 时坐标映射正确。生成图像已做视觉检查，文字、按钮、表单和折线图可见。**这不是浏览器 UI 端到端验证。**

## 小规模基准

8 个同时保留的受限示例 session；每个 20 次计数器点击；共 160 个动作；最多同时启动 2 个 worker；无 viewer。

| 指标 | 结果 |
| --- | --- |
| 创建 p95，含排队 | 1,065.92 ms；仅 8 个样本 |
| 动作 p50 / p95 | 10.92 / 21.16 ms；160 个样本 |
| 初始完整帧 JSON | 3,630 bytes |
| 点击增量 JSON | 平均 1,023.7 bytes，最大 1,025 bytes |
| 每 worker 生命周期峰值 RSS | 63,620–65,176 KiB |
| 当前 RSS | 无法读取，结果为 null |

原始数据见 [benchmark-2026-10-27.json](benchmark-2026-10-27.json)。传输指标仅包含 JSON 响应体，排除 HTTP/TLS、压缩、网站资源和客户端绘制成本。该应用不执行真实网站 JS，也没有完整浏览器或生产隔离，**不能据此声称真实网页达到相同延迟、资源占用或容量**。

## 历史云端浏览器阻塞（本地已通过）

`npm run test:e2e` 已实现但本环境**未通过**。Playwright 浏览器下载地址返回 HTML，标准安装失败；尝试备用 Chromium 二进制后，启动立即以 `SIGTRAP`（exit 133）退出。简化启动参数后仍退出。未将该测试标记 skip，也未伪造 browser screenshot。

应在有正常浏览器执行能力的 Codex 本地环境运行 `npm ci`、`npx playwright install chromium`、`npm run test:e2e`，并检查 `test-results/viewer.png`。重点复核真实浏览器输入事件、轮询时序、session 切换和保存恢复。

初始测试阶段，目标 private repo 的 GitHub API 访问返回 404，可访问的 GitHub App installation 未包含该仓库，普通 HTTPS Git 没有可用凭据。随后 SSH 连接也在公钥认证前被中断。用户授权改用网页后，已从原 main 建立 `poc/split-rendering-v0` 分支；源码同步与提交状态以远端分支内容为准。发布源码不代表之前受阻的浏览器 UI 测试已经通过。

首次打包时，用户选择直接下载完整源码，网页同步随之停止，当时 GitHub 分支只有部分文件；下载包包含完整的 30 个项目文件。后续本地已将缺失测试与文档补入仓库，并在此基础上完成上述修复与验收。

## 仍待研发

Chromium/Skia 真实网页执行与图形输出切分、字体/图像资源协议、完整 CSS 与 iframe、Canvas/WebGL 及像素读取、CDP/Playwright 控制兼容、生产隔离、跨节点调度，均未实现。当前交付验证的是受限应用的执行/绘制分离协议，不是通用浏览器目标已经完成。
