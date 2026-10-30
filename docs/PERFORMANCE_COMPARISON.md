# 原生记录与完整 Chromium 截图的性能实测

2026-10-30，[机器可读证据](chromium-performance-2026-10-30.json)。用户指定的对照是完整 Chromium＋截图/视频传输；本轮实测正式版 Chrome 156.0.8078.76 的无损 PNG/JPEG80，并补相同定制 headless_shell 二进制的普通 raster 对照，用于区分运行时精简和绘图切分的影响。不含完整操作系统 VM、H264/WebRTC 或优化后的连续视频流。

**相对正式版 Chrome，当前优势是减少执行端 CPU、RSS 和预热后的传输数据，代价是客户端 CPU 增加、端到端延迟较高。** 同二进制对照没有获得 RSS 收益，不能将正式版对照中的全部内存差异归因于本地 raster。两组固定页面与无损 PNG 的严格画质关卡均通过；JPEG80 和 Bilibili 的严格局部画质未通过，相应收益比值不采纳。

## 已实测的优势

以下收益均来自**本机固定页面、两轮各20次操作、正式版 Chrome＋无损 PNG 对照**，两边都通过整图与7个区域的画质检查。

| 优势 | 本次证据 | 结论边界 |
| --- | --- | --- |
| 执行端 CPU 较低 | 0.46–0.47 vs 0.80–0.95 core-seconds，少约43–51%；含网关后少约29–37% | 是服务端计算负担下降，客户端及两端总 CPU 的代价另列 |
| 当前精简运行时的执行端 RSS 较低 | 576 vs 1,027–1,041 MiB，少约44% | 包含运行时精简及后台服务差异；RSS求和会重复计算共享页，不能直接换算独占内存或并发密度 |
| 预热后的下行数据较少 | 20次操作109 vs 1,115 KiB，少约90% | 包含实际HTTP body；不含首次runtime下载、HTTP headers、TCP/TLS，也没有实测公网带宽收益 |

## 已实测的代价与局限

下表性能数值仍以正式版Chrome＋无损PNG为对照，其他测试和未覆盖范围另行标明。

| 局限 | 本次证据及影响 |
| --- | --- |
| 端到端延迟更高 | 操作到本地画面ACK的p95为122–124 ms，PNG对照106–115 ms，慢约8–16%；生产端较快没有变成用户可见的整体提速 |
| 更多 CPU 移到客户端 | 客户端0.93–0.95 vs 0.34–0.35 core-seconds，约2.7倍；含网关及两端的总CPU高约14–27%，尚未证明总体计算量或能耗更低 |
| 冷启动下载较大 | 全新viewer首次下行4.26 MiB，PNG约59.9 KiB；短会话可能传得更多，预热后的90%减少不能代表全程流量收益 |
| 内存收益不能全部归因于 raster 外移 | 同一精简headless_shell二进制对照中，原生执行端RSS反而高约8–10%；正式版对照的44%不能用于证明单独关闭服务端raster能省44%内存 |
| 画质与网页覆盖有限 | 固定页面的原生/PNG合格；JPEG80局部及Bilibili的4个严格视觉阶段未合格。Bilibili首页、搜索页可原生预览和交互，仍不等于严格文字画质或所有子页通过 |
| 对照范围有限 | 未测优化后的H264/WebRTC/连续视频流、完整OS VM、完整图片动画或视频播放，不能声称优于这些方案 |
| 容量与成本尚无结论 | 显示测试每次仅1个执行会话；96个API请求是同会话排队，不是96个浏览器并行。未实测生产多租户、跨节点负载均衡、可承载用户数或单位云成本 |
| 样本及测量有边界 | 本机回环HTTP、小样本且有其他应用；ACK不代表物理显示器扫描输出。正式版Chrome和定制引擎版本不同，另用同二进制组控制这一因素 |

## 适用判断：作为后续验证方向

由以上数据推断，值得优先验证的是长会话、多次交互、服务端CPU或传输预算受限、客户端有绘制余量的网页任务。若主要目标是最低交互延迟、最小客户端负担或短会话首开体验，当前实现尚未显示优势。这是依据本次测量提出的工程判断，尚未在公网、移动端或真实业务负载上验证。

当前能够确认的是资源负担发生了转移，并在这组负载下降低了服务端CPU和预热后下行数据。不能据此宣称总体更快、总成本更低、已实现更高生产并发，或通用网站已经兼容。后续应分别补客户端绘制/协议开销、严格文字画质、冷启动缓存、公网网络及多会话容量验证。

## 固定页面：包含本地 viewer 的完整链路

Apple M4 / 16 GiB，原生固定 Chromium 156 与匹配 CanvasKit，截图对照使用本机正式版 Chrome 156.0.8078.76 的独立临时 profile。两者960×720、相同字体/页面/操作，所有本地 viewer 都使用同一固定 browser。每种模式独立新建执行浏览器及 viewer，先预热 2 次，再以至少 150 ms 间隔递增计数 20 次；正序 PNG→JPEG80→原生、反序原生→JPEG80→PNG 各一轮。最终计数均为 22，每次操作都产生新画面并收到本地呈现 ACK。冷启动指新 browser/context，不清空操作系统文件缓存。正式版与定制内核版本并非完全相同，另有同二进制对照。

下表范围是两轮各自的结果，延迟是每轮 p95。CPU 为 20 次操作采样窗口内的累计 core-seconds；执行端包含 worker/browser 子树，网关另列。RSS 是进程 RSS 求和，会重复计算共享页，不能当作独占物理内存。

| 指标 | 原生记录＋本地 CanvasKit | 正式版 Chrome→无损 PNG | 正式版 Chrome→JPEG80 |
| --- | ---: | ---: | ---: |
| 整图＋7 个区域严格画质 | 通过 | 通过 | 5/7 区域通过，未合格 |
| 新会话到首幅本地画面及 ACK | 1.08 s | 1.06–2.51 s | 1.03–1.07 s |
| 操作到本地画面 ACK，p95 | 122–124 ms | 106–115 ms | 104–107 ms |
| 操作生产端，p95 | 57 ms | 87–90 ms | 81–83 ms |
| 执行端 CPU，20 次动作 | 0.46–0.47 s | 0.80–0.95 s | 0.80–0.81 s |
| 网关 CPU，同一窗口 | 0.19–0.20 s | 0.10–0.13 s | 0.11–0.12 s |
| 客户端 CPU，同一窗口 | 0.93–0.95 s | 0.34–0.35 s | 0.33–0.34 s |
| 执行端采样峰值 RSS | 576 MiB | 1,027–1,041 MiB | 1,036–1,039 MiB |
| 客户端采样峰值 RSS | 429 MiB | 355 MiB | 353–354 MiB |
| 20 次预热后动作的 HTTP 下行 body | 109 KiB | 1,115 KiB | 891 KiB |
| 首次打开的 HTTP 下行 body | 4.26 MiB | 59.9 KiB | 48.6 KiB |

与画质合格的正式版 PNG 对照相比，执行端 CPU 减少约 43–51%，算上网关后约减少 29–37%；执行端 RSS 低约44%，预热后的 HTTP 下行减少约 90%。客户端 CPU 则约为 2.7 倍，端到端 p95 高约8–16%。完整进程树（含网关和客户端）在动作窗口内 CPU 约1.59–1.61 s，对照1.27–1.40 s，合计反而高约14–27%。两次 PNG 首开时间波动很大，不能仅按第一轮2.51 s宣称稳定启动优势。

原生本地 CanvasKit 当前使用软件 surface，每次动作 paint p95 约20–21 ms；PNG 客户端图片解码约3.2 ms、drawImage约0.2 ms。原生的更短生产端等待，被本地重放、资源协议和呈现调度抵消。原生 paint 时间不含异步资源解码，客户端整个进程树 CPU 则包含这些工作。

首次下行主要包含 CanvasKit/字体 runtime，不能只比较预热后的 SKP。全新 viewer 的短会话可能传得更多；当前固定负载估算约86次动作后才摊平首次额外下载，属于由本次字节数推算，并非独立实测。产品同一 viewer 内切换网址会复用已加载的 CanvasKit。上述数据包含实际 HTTP body，不含 HTTP headers、TCP/TLS，也没有模拟公网 RTT、带宽、丢包或物理显示器扫描输出。

## 控制变量：同一 headless_shell 的两种绘图路径

另用完全相同的定制精简二进制、相同默认开关配置，比较普通完整 raster＋截图与原生记录，客户端和测试方法保持相同。此组排除了完整 Chrome 发行版及其后台服务差异，两个 PNG 质量关卡同样通过。

| 指标 | 原生记录 | 同二进制普通 raster→PNG |
| --- | ---: | ---: |
| 操作到本地画面 ACK，p95 | 114–117 ms | 105–113 ms |
| 执行端 CPU，20 次动作 | 0.39–0.40 s | 1.06–1.07 s |
| 客户端 CPU，同一窗口 | 0.83–0.85 s | 0.26 s |
| 执行端采样峰值 RSS | 575 MiB | 524–531 MiB |
| 客户端采样峰值 RSS | 429 MiB | 355–356 MiB |

在这一控制组，执行端 CPU 少约62–64%（含网关约54%），执行端 RSS 却高约8–10%，客户端 CPU约3.2倍，端到端p95高约1–11%。因此正式版对照的44%内存差异包含运行时精简及进程/服务差异，不能全部归因于 raster 外移。两组在不同时间运行，机器有其他应用，不能跨组直接相减推出某个 Chrome 后台组件的独立成本。

## Bilibili：真实网站生产端对照

两轮 AB/BA，每轮8次真实搜索框编辑，同一 headless_shell 引擎的普通 raster/JPEG80 和原生路径、960×720、相同域名规则，并明确将图片动画固定首帧。这里测直接生产端，**不包含正式版 Chrome 的后台服务、viewer、客户端绘制或完整网络延迟**。

| 指标 | 原生记录 | 同二进制普通 raster→JPEG80 |
| --- | ---: | ---: |
| 生产端操作 p95 | 43–49 ms | 约 98 ms |
| 生产端 ready | 1.79–1.86 s | 1.53–1.64 s |
| 8 次操作累计 CPU | 0.38–0.41 s | 0.64–0.74 s |
| 采样进程树峰值 RSS | 1,018–1,039 MiB | 1,108–1,196 MiB |

两种生产端都完成动作，4 个归档阶段都解码并收到 ACK，但严格局部画质全部未合格；其中最后阶段还发生实时内容漂移。两个对照资格均为 false，性能收益比值为 null。这些数值是诊断数据，不能外推成 Bilibili 等画质、端到端或通用网站的性能胜出；资源描述符反复引用的字体/图片大小也不能当作实际传输量。

## 有界压力与资源保护

单会话生产端 fixture 对照另做 12 次动作；96 个同时提交的 API 动作中，64 个进入串行有界队列、32 个收到明确 429，最终计数证明已接受动作没有丢失或重复。已接收请求 p95 约 4.09 s，反映排队等待，不能当作交互延迟或吞吐扩容成功。额外 16 次建会话请求均被容量限制拒绝。

正式版 Chrome 显示对照35.4 s，采样峰值1,674.5 MiB；同二进制显示对照32.4 s、1,299.6 MiB；Bilibili1,276.6 MiB；单浏览器fixture748.1 MiB。四组均零新增swapout、最低memory-pressure free57%，未触发安全停止。默认服务、单浏览器测试仍为1.5 GiB；显式执行端＋viewer的 `display` 测试可用2 GiB，35% free、64 MiB新换页、4秒心跳和时限保护保留。测试不操作ToDesk或其他任务。

Create session 的失败来自上一轮手动 Bilibili 预览占用唯一槽位；已先保存 Cookie/localStorage，再释放。真实页面已再次点击 Create session 并呈现原生 fixture，复测会话随后关闭，避免继续占用用户名额。

141 JS、106 JS 语法、16 Python 通过。没有重新编译或更换引擎包。`engineSplitGate:not-passed`、`serverRasterBypassed:false` 保留；完整视频流、生产隔离、大规模并发与通用网站关卡未完成。

## 复现

```bash
# 完整链路：正式版 Chrome 截图对照，独立临时 profile。
node experiments/chromium-engine/guarded-native-tests.js --task display --iterations 20 --control-binary '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --root /Volumes/Extreme-APFS/Runtimes/virtual-desktop-web-156-20261030 --canvaskit /Volumes/Extreme-APFS/Runtimes/virtual-desktop-web-156-20261030/canvaskit/out --max-rss-mib 2048 --in-process-gpu --output test-results/stock-chrome-comparison

# 同二进制的完整链路控制组：一台执行 browser + 一台本地 viewer。
node experiments/chromium-engine/guarded-native-tests.js --task display --iterations 20 --root /Volumes/Extreme-APFS/Runtimes/virtual-desktop-web-156-20261030 --canvaskit /Volumes/Extreme-APFS/Runtimes/virtual-desktop-web-156-20261030/canvaskit/out --max-rss-mib 2048 --in-process-gpu --output test-results/display-comparison

# 真实网站：画质不合格会返回非零，保留诊断数据和失败资格。
node experiments/chromium-engine/guarded-native-tests.js --task site --site bilibili --iterations 8 --rounds 2 --root /Volumes/Extreme-APFS/Runtimes/virtual-desktop-web-156-20261030 --canvaskit /Volumes/Extreme-APFS/Runtimes/virtual-desktop-web-156-20261030/canvaskit/out --in-process-gpu --output test-results/bilibili-comparison

# 单浏览器生产端和队列压力，不包含本地 viewer。
nice -n 10 env VIRTUAL_DESKTOP_MAC_GPU_MODE=in-process node experiments/chromium-engine/benchmark.js --root /Volumes/Extreme-APFS/Runtimes/virtual-desktop-web-156-20261030 --canvaskit /Volumes/Extreme-APFS/Runtimes/virtual-desktop-web-156-20261030/canvaskit/out --max-active 1 --iterations 12 --output test-results/bounded-comparison
```

本机原始结果位于 `test-results/performance-20261030/{stock-chrome,display,bilibili,fixture}`，含画面、每步耗时、HTTP字节计数、进程采样及质量失败记录。
