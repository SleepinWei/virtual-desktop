# 验证记录

## 持续 Chromium 会话验收：2026-10-28

原生后端已达到 **live-native-session-candidate**，复现见 [CHROMIUM_LIVE.md](CHROMIUM_LIVE.md)，完整构建/fixture/runtime 指纹和实际结果见 [chromium-live-2026-10-28.json](chromium-live-2026-10-28.json)。原生 C++ 源码 17 个文件与 manifest 一致；增量构建和 7 项 cc/paint、4 项 Viz 测试通过。

| 验证项 | 本机结果 |
| --- | --- |
| 持续来源 | 私有 Unix socket → 原生 worker → 会话网关 → 本地 CanvasKit；画面不使用 trace 传输 |
| Agent 与人工输入 | 无 viewer 操作；接管、归还、真实坐标焦点/文字/滚动、Tab/Enter、动作重试去重通过 |
| 权限与画面时序 | 只读 mutation、旧控制 epoch、过期画面坐标及跨会话 capability 被拒绝 |
| 页面自主更新 | trace 停止期间定时器持续改变真实原生帧和本地像素，无逐次捕获请求 |
| 恢复 | viewer 离线、刷新、单次 SKP 损坏后恢复最新快照，执行 browser PID 保持相同 |
| 会话与存储 | 双原生浏览器状态分离；新 browser 恢复 localStorage，临时 DOM 输入清空 |
| 生命周期 | 强杀执行 worker 后专属 browser/renderer 退出，会话 FAILED 且准入槽释放 |
| 严格视觉 | 两组整图及每组 7 个独立区域通过原阈值；主对照浏览器为同构建普通模式 |
| 回归 | 71 JS、5 Python、66 JS 语法、11 过滤 C++、6 本地浏览器 E2E 通过 |

短的诊断 trace 显式未丢数，并有配对 recording/no-tiles 和正向 display skipped 标记；匹配 raster 与 renderer DrawFrame 记录均为 0，结束诊断后动作仍经 socket 送来新帧。此前 ordinary 对照保留为历史记录；零 trace 记录不能单独证明所有像素路径已被消除。

启动仍用一次短的纯元数据 trace 绑定 renderer 来源。当前限定固定 A8 字体/960×720/DPR 1 的可信 fixture，Chromium sandbox 关闭；不开放任意网站。保持 `engineSplitGate: not-passed` 和 `serverRasterBypassed: false`；未验证多 renderer、通用字体/图片/IME、Canvas/WebGL/video/readback，也没有测完整 Chromium CPU/RSS/网络成本或生产隔离。CI 缺少本机原生输入时跳过三项原生 E2E，继续执行其余协议、HTTP/socket 与三项 v0 浏览器测试。以下保留此前里程碑。

## Chromium 完整帧验收：2026-10-28 后续

同一固定版本 Chromium 和匹配 Skia 的 CanvasKit，新增完整活跃树导出及本地合成，达到 **native-frame-candidate**。详细约定见 [CHROMIUM_FRAMES.md](CHROMIUM_FRAMES.md)，构建/资源指纹、各区域指标、反例与同构建旧模式回归见 [chromium-frames-2026-10-28.json](chromium-frames-2026-10-28.json)。

| 验证项 | 本机结果 |
| --- | --- |
| 原生层与分组 | 6→5 个内容层、2 个 surface；实际删层已反映到完整成员列表 |
| 合成变化 | 层序、平移及 7° 旋转、矩形 clip、重叠子层的组 opacity、180px wheel 滚动 |
| 四阶段整图平均 RGB 误差 | 0.261 / 0.288 / 0.286 / 0.272；每阶段 7 个独立区域也全部通过 |
| 被删层原位置 | 最终平均误差 0、异常像素 0，无旧层残留 |
| 服务端 trace | 显式未丢数；raster 0、renderer DrawFrame 0、7 个正向 display skipped 标记 |
| 客户端传输 | 4 帧 ACK 完整；迟到帧不覆盖新画面；损坏 SKP 保持旧画面且不 ACK |
| SKP 复用 | 正向客户端 9 份唯一资源、207,309 bytes；逐帧全部引用合计 23 份、529,015 bytes，未计 HTTP/JSON/runtime/trace |
| 回归测试 | 60 JS、5 Python 构建保护、50 个 JS 语法、11 C++、5 本地浏览器 E2E 通过 |

旧单层三模式在当前构建重新通过：ordinary raster/draw 为 315/17，remote-paint 为 0/15，record-only-display 为 0/0，后者 16 个 skip 标记；全部视觉和交互/刷新/存储活性通过。这些是匹配记录的条数，不能当作执行次数或 CPU 收益。

默认文字平滑反例的整图通过，但标题区域平均误差 5.070、异常像素 5.97%，仍判失败。显式 A8、固定字体后通过，原阈值保持 ≤3 / ≤2%，不代表任意默认文字策略兼容。

此阶段通过 trace 批量捕获后重放，没有接入持续运行的 Chromium 会话；没有证明一般图片、iframe、IME、缩放/DPR、Canvas/WebGL/video/readback 或生产成本。`engineSplitGate: not-passed`、`serverRasterBypassed: false` 保留。CI 中两个依赖本机原生捕获的 E2E 在缺少输入时显式跳过；本机本轮 5 项全部实际执行。以下记录保留为此前里程碑。

## Chromium 引擎验收进展：2026-10-28

macOS arm64 / Apple M4 / 16 GiB，外置 APFS 构建 Chromium 156.0.8078.48 固定提交。原生 `headless_shell`、`cc_unittests` 和 `viz_unittests` 构建成功；4 项 picture-layer 与 4 项 Viz 生命周期/普通绘制对照测试全部通过。匹配 Skia 的 CanvasKit CPU 构建完成，沿用原有逐区域阈值，三种模式的 before/after 画面和全部文字区域均通过。完整指纹、反例和指标见 [chromium-engine-2026-10-28.json](chromium-engine-2026-10-28.json)，复现及后续任务见 [CHROMIUM_ENGINE.md](CHROMIUM_ENGINE.md)。

| 同一工作负载 | ordinary | remote-paint | record-only-display |
| --- | ---: | ---: | ---: |
| 观测到的 raster 记录 | 285 | 0 | 0 |
| renderer DrawFrame 记录 | 15 | 15 | 0 |
| 原生 display skipped 标记 | 0 | 0 | 17 |
| trace 显式未丢数 | 通过 | 通过 | 通过 |
| 两阶段严格视觉比较 | 通过 | 通过 | 通过 |
| 点击、键盘、滚动、刷新与 sessionStorage 活性 | 通过 | 通过 | 通过 |

三模式的两个可视阶段 SKP 哈希一致。`Display::DrawAndSwap` 还包围 aggregation，不能把该函数出现直接当成像素绘制。记录条数也不能当作 raster 执行次数或 CPU 节省。

项目回归：47 项 JS 测试、5 项 Python 构建保护、37 个 JS 文件语法检查及 4 项本地浏览器端到端测试通过。最后一项端到端测试使用真实捕获，在 64 次前后帧切换后，正常 replay 的 WASM heap 保持 128 MiB；故意遗漏像素分配释放的对照增长 97,779,712 bytes，证实该检查能发现泄漏。此数值不等于浏览器 RSS 或每 session 运行内存。

目前仅达到 **record-only-display-candidate**，`engineSplitGate: not-passed`、`serverRasterBypassed: false` 保留。没有验证完整图层/滚动/资源协议、Canvas/WebGL/video/图片解码或通用网站，也没有把此实验接入 v0 worker。以下 2026-10-27 与云端记录保留为历史，不代表最新引擎状态。

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
