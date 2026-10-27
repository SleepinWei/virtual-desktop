# 验证记录

## 当前本地验收

2026-10-27，macOS arm64 / Apple M4，Node.js v24.21.0，Chrome 156.0.8078.48，Playwright 1.64.1。

- `npm test`：36 项通过，0 失败、0 skip，包含 20 项新增绘图实验分析与边界检查。
- `npm run check`：29 个 JS 文件语法通过；v0 服务端像素后端源码检查通过。
- `CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:e2e`：3 项通过，0 失败、0 skip，约 5.7 秒。
- 已人工检查生成的 `test-results/viewer.png`：示例 agent 与人工添加的任务、恢复后的计数器和两个会话可见。

浏览器主流程验证真实 Canvas 像素变化、单步 delta、快速动作的合法 snapshot 回退、接管与归还、热切换和保存恢复后的持久区域像素一致性。另两项回归固定延迟响应次序，验证保存 A 期间切到 B 不会中断 B，以及迟到旧帧不会降低控制权 epoch。

测试通过浏览器导出 PNG，并在测试进程中解码比较像素；不反复读取被测 Canvas 的像素，避免读回操作改变其后续绘制方式。严格像素一致性断言仍保留。测试中的客户端 PNG 与服务端执行路径分离。

本轮同时修复了迟到 pointer 响应污染新会话输入选择、恢复结果抢占当前会话，以及示例 agent 跨接管继续使用新 epoch 的问题。示例 agent 的同批动作固定使用启动时 epoch。

本地验收覆盖受限应用 PoC；真实网站与 Chromium/Skia 服务端输出拆分仍未实现。CI 在 main 推送或 PR 时重复执行语法、协议/集成和浏览器测试，具体运行结果以 GitHub Actions 为准。

## Chromium 下一阶段实验

同日、同机，Chrome 156.0.8078.48，CanvasKit 0.42.0/full。运行 `npm run experiment:paint -- --serve`，捕获浏览器与本地验证浏览器为独立进程，使用临时 profile；复现及边界见 [CHROMIUM_PAINT.md](CHROMIUM_PAINT.md)。结果摘要保存在 [chromium-paint-2026-10-27.json](chromium-paint-2026-10-27.json)。

| 项目 | 结果 |
| --- | --- |
| 真实页面原生绘图记录 | 前后各 1 份最终 960×720 SKP，24,621 / 24,709 bytes，哈希不同 |
| 来源 | 精确 fixture URL 的 renderer PID；同线程 UpdateLayer 将记录关联到 layer 8；排除 browser UI 小图 |
| 本地重放 | CanvasKit 从原生字节解码并绘制，含中文和 JS 操作后的计数、颜色与状态变化 |
| 完整 trace | 12,088 条记录，CDP 显式 `dataLossOccurred: false`；32 MiB producer 参数由实际 argv 确认 |
| 常规像素路径 | 仍观察到 620 条匹配 raster、42 条匹配 draw 记录；它们不是唯一执行次数或 CPU 指标 |
| 整图像素误差 | before / after 平均 RGB 绝对误差 0.3064 / 0.3356（0–255）；超 32 差值像素约 0.514% / 0.547% |
| 严格视觉验收 | **未通过**：部分文字区域平滑差异超过独立区域容差；未放宽断言 |
| 服务端 raster 绕过 | **未实现**，`serverRasterBypassed: false`，引擎关卡未通过 |

系统字体对照出现 SKP 与阶段标记丢失。改用有许可的 21,232-byte 字体子集后，捕获到完整页面记录。进一步以相同 128 MiB central buffer 和相同自动化配置对照：默认 producer 仍报告丢数；请求 32 MiB producer 返回未丢数。实际分配量未测，不能据此推导运行内存成本或性能收益。

默认系统字体平滑下，整图通过而中文等区域失败；显式灰度字体平滑减小差异，仍没有通过全部文字区域。客户端仅报告解码/绘制完成，视觉 gate 独立保留失败。后续需定制 CanvasKit 字体平滑构建并重新实测，不能把页面能看见当作完整视觉一致。

headless shell 153.0.8010.12 的受控帧探针在 `Target.createTarget` 返回 `BeginFrameControl is not supported on MacOS yet`，保存 `unsupported` 报告并以状态 1 退出，没有创建非受控 target 回退。此时零 raster 记录来自未创建测量 target，不能当作绕过证据。

下一步需要适配客户端字体栅格化，并在有足够空间的构建环境实现和验证 Chromium remote-paint 引擎改动。本机本轮起始可用磁盘约 29 GiB，未下载或编译完整 Chromium；没有提交未验证的 C++ 示意补丁。

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
