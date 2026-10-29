# Codex 本地接续

## 项目不能丢失的目标

用户要的是云端维护网页执行状态、本地执行像素绘制，并借此减少服务端图形负担与传输开销。不要把任务改回 headless Chromium 截图/视频 viewer。绘图指令技术可行性优先于大量堆叠调度组件。

## 当前实现

**2026-10-30 原因诊断完成，见 [证据](docs/chromium-native-diagnosis-2026-10-30.json) 与 [说明](docs/NATIVE_RUNTIME.md)。** 当前主要障碍在资源封装和客户端字体重放。CERN 769,855-byte SKP 的 98.23% 是两份完整 Times 字体；29 个拉丁字符用小字体仅 22,085 bytes，系统 UI 字体已超限。CoreText 精确匹配测得 SFNS 完整表约 7.87 MB（Base64 10.50 MB）、苹方约 59.43 MB（Base64 79.24 MB），远超 8 MiB JSON 帧预算。默认 SKP `kDoIncludeData` 不按 glyph 裁剪，不能靠扩大上限解决。上轮 Example 的轻量英文分类不准确，实际为多语种；本轮改用本地合成字体对照，没有继续访问 Example 做探针。

图片是当前 C++ 的明确拒绝边界：2×2 PNG `<img>` / PNG background 均失败，无图和 inline SVG 可导出。像素问题已从源记录中隔离：同一 CERN SKP 交给 macOS Chromium 重放与普通参考逐像素误差为 0，CanvasKit 仍有 3/9 区域失败。CoreText/FreeType 行为不同，现有额外 CFF 校准未覆盖 TrueType Times；CSS smoothing 单开关仍未全部通过。macOS raster 只作独立诊断，未接生产截图回退。IANA bug 已修复：处理原先遗漏的标准 `ProcessReadyInBrowser`；歧义时补一份导航后 browser inventory，并要求 frame/URL/loader 稳定。真实复测在原 trace 中从 readiness 正确绑定新 renderer，随后仍因 frame-too-large 拒绝，不能说网站通过。浏览器 PID/category、精确主 frame 与 URL、歧义/伪 user timing 拒绝均保留。105 JS /16 Python /95 JS 语法及原生 smoke/pool 回归通过，无 C++ 重编。后续优先字体/字形外置与子集、图片资源、默认字体栅格匹配，再恢复通用网页验收；独立 GPU 问题保留。

**2026-10-29 网站测试更新：六站均没有取得严格画质/功能的完整资格，不能称为通用网页性能通过。** 最新证据 [网站与性能](docs/chromium-sites-2026-10-29.json)，解释与数表见 [NATIVE_RUNTIME.md](docs/NATIVE_RUNTIME.md)。普通模式在 Example、IANA、CERN、Python 文档、哔哩哔哩加载/操作通过，HN HTTP 503；原生 Example/Bili 超 8 MiB JSON 帧上限、Python 图片记录不支持、IANA 主 frame 来源未能证明。CERN 在修复主 widget 绑定后完成两轮 16 次操作与 4 次解码/ACK，但局部文字比较失败；JPEG80 对照本身也未过严格局部阈值，工具拒绝输出收益比值。原生直接生产端 p95 33.2/35.3 ms、普通 JPEG80 51.0/51.0 ms 只能作为非等画质探索性数据，不能冒充验收。

`page-route.js` 用当前 CDP frame id、URL/renderer commit、`SetLayerTreeId` 绑定主 widget，避免同 PID 的 about:blank 旧 widget 被误选；只忽略元数据证明退役的 widget，未知新增 widget 仍拒绝。没有 C++/二进制改变、截图替代或阈值放宽。测试入口 `test:native-acceptance -- --task site --site cern ...`，4–12 次、1–2 轮，单 browser、1.5 GiB；原生归档后关闭 producer，再单独重放。所有站点尝试峰值 1,411.7 MiB、最低 free 70%、新增 swapout 0，无安全停止；ToDesk 结束时存在，无遗留 headless/Ninja。100 JS、16 Python、91 JS 语法通过；原生 fixture 冒烟和双 context pool 回归通过。原有 worker fixture 对照 12 次点击 p95 原生68.4 / JPEG80 87.8 ms，RSS831.2 /772.1 MiB；这与公开网站直接生产端范围不同，也没有 JPEG 等画质结论。当前新增网站与 Example 都是 probe only；下一步优先字体/字形和原始图片资源、默认字体像素及 IANA 来源，之后再测等画质性能；独立 GPU 仍待修复。

**2026-10-29：lean monolithic 的同配置 C++、运行包、原生帧/视觉、人工接管与共享 host fixture 测试已完成。成功的浏览器测试均显式使用 macOS `--in-process-gpu`，默认独立 GPU 路径尚未通过，不替换现有服务。** 当前准确证据见 [lean 验收](docs/chromium-lean-acceptance-2026-10-29.json)，复现见 [CHROMIUM_SUBSET.md](docs/CHROMIUM_SUBSET.md)。通用关卡仍为 `engineSplitGate:not-passed` / `serverRasterBypassed:false`。

同一 `out/VirtualDesktopLeanNinja` / 原 args.gn 增编测试程序，17 cc + 4 Viz 全部实际执行通过，无跳过；主程序 SHA 未变。独立测试状态 `chromium/virtual-desktop-lean-tests-state.json`，主状态为 `lean-engine-tests-complete`，正向 XML/测试程序/配置/主程序指纹互相绑定。构建任务 `--task cpp-build` 和执行任务 `--task cpp-test` 复用构建锁及保护；不要把独立测试状态里的 `compiled:false` 当主引擎未编译。最新 detach 元数据指向已完成的 C++ 增编任务，不是仍在编译。

新包 `/Volumes/Extreme-APFS/Runtimes/virtual-desktop-lean-156-20261029`：13 个引擎文件、19 个 payload，共 519,027,509 bytes / 495.0 MiB，比旧 component 包小 27.7%。已复核 7 个 Mach-O 的 load commands 和原始/包内指纹；库自身的 LC_ID_DYLIB 不视为加载依赖，真正相对路径加载仍拒绝。这不是 RSS 收益。最终冒烟真实输入/点击/去重通过，4 个原生帧、3 个资源；四阶段整图/区域比较通过；三模式 raster/pixelDraw 计数依次为 285/16、0/16、0/0，记录一致、重放通过。

单执行会话完整 live 接管、直接键盘/粘贴、定时更新、离线/刷新/坏资源恢复、worker 崩溃清理及两次视觉比较通过。参考图在普通 browser 中预先生成并关闭该 browser，再开启 producer/viewer。联合进程树采样峰值 1,548.9 MiB，显式使用 2 GiB 测试预算；此前两次 1.5 GiB 停止记录保留。生产及其余原生测试默认仍为 1.5 GiB；free 35% / swap 64 MiB / 心跳 4 秒保护未变。成功轮最低 free 73%、新增 swapout 0；ToDesk 进程在结束检查时存在，没有前台交互时延保证。共享 host 的两个可信 context 状态/输入/原生帧、槽位复用及 renderer/browser 故障域测试也通过；未接公开池 API。live 的双独立 browser/冷恢复明确跳过；composition 为注入事件，未覆盖实体 OS 输入法。92 JS、16 Python、86 JS 语法通过。

**待解决：独立 GPU 子进程在本机启动时停于 dyld::open，CPU time 为 0，导致 rAF 不推进；旧 component 对照与原始构建路径也复现。** `--in-process-gpu` 恢复 rAF，但 GPU 故障现在会影响 browser，不能称为 GPU 进程隔离通过，也不能判定是 lean 回归或确定的 OS 问题。显式选项是 `VIRTUAL_DESKTOP_MAC_GPU_MODE=in-process` 或 `npm run test:native-acceptance -- --in-process-gpu ...`；仅这个经校验的环境选项可传给原生 worker，没有放开任意环境/凭据。下一步先修独立 GPU 启动，再做匹配的 RSS/物理内存归因与真实网站测试；不能拿下面历史的旧包/旧构建结果代替本轮缺失覆盖。

## 历史编译与实验记录

**2026-10-29 20:47（北京时间）：lean 候选编译完成，20:49 的版本启动检查通过。** 外置 `chromium/virtual-desktop-lean-ninja-build-state.json` 为 `lean-compiled-candidate` / `compiled:true`，主程序 `/Volumes/Extreme-APFS/Builds/chromium/src/out/VirtualDesktopLeanNinja/headless_shell` 是 arm64 Mach-O、425.8 MiB，SHA-256 `d016a91338184e4e14ecc98c7fe8dc24a24d275a89ccce32c6fe0ad0d7c86557`。`--version` 在低优先级、15 秒超时和默认浏览器守护下退出 0，输出 Chromium 156.0.8078.48。直接 Mach-O 依赖均为系统库；这不覆盖运行时动态加载资源。详见 [候选产物记录](docs/chromium-lean-compiled-2026-10-29.json)。

自适应任务原先于 17:40 停在最后链接：单任务也超过 6 GiB RSS，继续降并行无效。20:46 的 Ninja dry-run 确认只有 `[1/1] LINK ./headless_shell`，仅本次单任务链接临时使用 8 GiB RSS 上限，其余 free 35% / swapout 64 MiB / 心跳 / utility + nice 10 + I/O throttle 保护保留。31 秒后完成，采样 RSS 峰值 5.3 GiB、最低 free 68%、新增 swapout 0；该成功采样低于原上限，不能说 8 GiB 是实测需求。默认构建仍为 6 GiB。最新元数据 `test-results/cli-handoff-20261029/build-detach.json` 指向 `test-results/lean-final-link-20261029/guard-report.json`，完成后的服务不应再当运行中。**C++/原生帧/视觉/monolithic 运行包验收尚未通过，不能替换现有服务或沿用旧 component 的通过标记。**

以下 **2026-10-29 15:06 的四任务状态为历史快照**：先读 `test-results/cli-handoff-20261029/build-detach.json` 确认当前任务类型；旧自适应 supervisor 是 `test-results/lean-adaptive-20261029/supervisor-report.json`，其实际守护报告由 `guardReport` 动态给出。不能把历史 `running` 或本文时间戳当持续状态。KeepAlive=false，无定时任务或完成通知。CLI 默认入口已指向 npm 0.165.0，当前聊天已在 CLI 恢复；退出桌面端后其大部分内存已释放。

11:46 的两任务构建曾因 owned RSS 超过 6 GiB 停止，free 81%、没有新增 swapout。根因是 Blink 每个绑定生成动作默认另开 10 个 multiprocessing worker，两个 Ninja 任务产生约 20 个 worker。`lean-bindings-single-process.gn` 现在只在候选环境下给 GN 模板加入上游已有的 `--single_process`，让 Ninja 统一管理并发；不改生成算法或原生 C++。补丁只接受固定 BUILD.gn 原始哈希，幂等安装、记录指纹、拒绝覆盖自定义内容。真实 GN 查询确认候选有该选项，未设置候选环境时没有；4,732 份既有生成源码逐字节匹配。14:50 四任务续编稳定后，于 14:53 升至八任务；八任务进入大文件组后 RSS 6.006 GiB 触线，未新增换页。15:04 以六任务启动有界降档，六任务也触线后已实际自动恢复到四任务；观测、限制和源码指纹见 [构建预算记录](docs/chromium-build-budget-2026-10-29.json)。

用户要求最多使用 8 核，同时保证系统和 ToDesk 响应。仍只对编译子树使用 utility QoS、nice 10、I/O throttle；监控器和 ToDesk 保持正常优先级。**6 GiB RSS / 35% free / 最近 10 秒新增 swapout 64 MiB / 心跳 4 秒保护均保留**，浏览器默认 RSS 仍为 1.5 GiB。`build:native-lean:adaptive` 只在 owned RSS 超限时按 8→6→4→2→1 有界降档，要求连续 10 秒 free≥45% 且零新增换页，最长等 60 秒；一任务不再重试，不会自动升档。整机压力、换页、心跳、编译错误或用户中断均直接停止。短时八任务普通优先级探针最大唤醒延迟约 10 ms、ToDesk 持续获得 CPU；这不是远端交互时延测试或硬隔离。86 JS / 14 Python / 83 JS 语法及 GN 格式检查通过。没有 clean、没有更改 args.gn；没有新二进制或 C++/原生/视觉验收。

凌晨 V8 metagen 的 GN 根范围错误已由 `lean-root.gn` 修复；先执行真实 V8 GN 查询与 metagen，再进入主构建。生成头文件 86,849 bytes、SHA c5faa425... 与原 component 构建一致。此前 09:33 八任务、09:54 四任务分别因内存压力停止，其后两任务记录也均属历史；详见 [V8 恢复记录](docs/chromium-metagen-recovery-2026-10-29.json)。下文的旧报告路径和单任务策略均属此前阶段，接续以最上方的实际状态为准。

最新工作先读 [CHROMIUM_POOL.md](docs/CHROMIUM_POOL.md) 与 [2026-10-29 实测记录](docs/chromium-pool-2026-10-29.json)。已实现 `SharedChromiumHost`、有界 `NativeLeaseRouter` 和 `ChromiumSession` 的显式 shared-host 路径；同一 browser 的两个可信 fixture context 在 Cookie/localStorage/JS 标记、真实输入和原生帧方面独立。关闭 A 后 B 活跃，新建 C 无旧状态；故意 crash C renderer 后 B 继续，结束 browser 后 B/D 均 fatal。1/2 context 的 RSS 和为 841.6/1,041.4 MiB，增量 199.7 MiB；包含协调器，RSS 重复计算共享页，不能声称物理内存节省或容量。81 JS / 8 Python / 81 JS 语法通过；独立原生路径另跑输入/点击/去重及 5 帧/3 资源通过。无 C++ 改动。默认正式网关仍每会话独立 worker/browser；`experiment:pool` 只允许可信本地 fixture，未接公开 API，不能当公网多租户隔离。

深度 lean 构建前两轮保护停止，尚无新二进制。原 `out/VirtualDesktopLean` 的 Siso 图加载后 free 降到 34% 停止，旧记录 `virtual-desktop-lean-build-state.json` 保留；改用上游支持的 `use_siso=false`、新目录 `out/VirtualDesktopLeanNinja`，RSS 最新采样约 370 MiB，但整机 load 8.75 再次保护停止。第三轮曾采用 Darwin background + background QoS + nice 19、`-j 1`，报告为 `test-results/lean-background-build-20261029/guard-report.json`；现已被最新八任务配置取代。`build:native-lean` 使用同一构建锁，拒绝更改既有自定义参数/源码指纹。浏览器默认负载保护仍保留；不要并行跑浏览器压测或替换工作中的 8081/8082。没有定时自动重试或完成通知。

最新子集工作见 [CHROMIUM_SUBSET.md](docs/CHROMIUM_SUBSET.md) 和 [子集验收](docs/chromium-subset-2026-10-28.json)：提取包位于 `/Volumes/Extreme-APFS/Runtimes/virtual-desktop-native-156-20261028`，引擎 680.3 MiB + CanvasKit/配置约 4.2 MiB，总 payload 684.5 MiB，较 GN 依赖排除 91.3 MiB 开发辅助内容。仍是同一 component 构建，未降低页面内存。包内 464 个 Mach-O 依赖已核查，路径/指纹支持固定相对布局；`package:native` 和 `test:native-package` 可复现。本地真实输入、点击、去重、5 帧/3 资源通过，76 JS / 5 Python / 77 JS 语法通过。本轮未修改 C++。首次复制后有 dyld 冷启动超时及 rAF 停滞失败，后续生产端通过；启动超时现为 15 秒，先于 worker 的 30 秒上限，两个早期测试遗留进程已清理。额外 IAB viewer 验证因整机 free 34% 在新浏览器创建前被保护阻止，不能声明视觉通过。8082 改用该包并恢复空闲、保持原阈值，8081 用户会话保留。

`lean-mac-arm64.gn` 关闭 component/PDF/printing/headless CLI commands/Local State prefs，按体积优化，保留 DCHECK；当前实际参数含 `use_siso=false`，使用独立 `out/VirtualDesktopLeanNinja`。固定版本需要 `gn gen ... --root-target=//headless:headless_shell --root-pattern=//headless:headless_shell --fail-on-unused-args`，否则无关 Chrome 测试会触发打印断言。后续 monolithic 工件布局不符合当前 component 指纹要求，必须增加独立验证及同配置 C++/原生/视觉验收，不能直接把现有通过标记套上去。打包和内存优化分别处理，后续优先实际物理内存/进程角色与图片、字体、SKP 临时副本归因。

最新接续先读 [NATIVE_RUNTIME.md](docs/NATIVE_RUNTIME.md) 和 [2026-10-28 runtime 记录](docs/chromium-runtime-2026-10-28.json)：直接输入已替代独立文字栏；74 JS、5 Python、74 JS 语法、21 C++、3 普通 viewer E2E 通过。有界 96 请求为 64 成功/32 限流。原生 presentation 成功回调在失败反馈后累积到 61 的崩溃已修复，20 个源码文件与 manifest 匹配；没有关闭 DCHECK 或伪造服务端呈现。

本机资源预算优先：原生 CLI 默认一个活跃会话/一个启动任务、带独立长期 watchdog。测试低优先级，1.5 GiB 进程树 RSS 上限；两个测试浏览器、另开独立参考浏览器和真实 HTTPS 预览均实际触发安全停止，不能声称新构建严格视觉复测通过。直接输入有现有本机浏览器的实际画面证据。当前新入口用 8082，旧用户 8081 会话保留；两个服务的 profile 目录分开。

小红书未通过：普通无头对照到 IP 风险页 300012；原生首帧前超预算，交互选项禁用。持续 producer tracing buffer 从 32 MiB 改为 8 MiB，修复跨站启动触及上游共享内存 switch 的 8 MiB CHECK；画面仍走 socket。缺字会把整套系统字体嵌入 SKP，超过记录上限，不要放大内存上限绕过。后续优先字体/图片资源协议、最小 runtime 与长会话内存，再扩大真实网站/iframe/IME/DPR 和分布式调度。此前三模式及完整帧、双会话冷恢复记录保留为历史，不能当作本轮新构建全覆盖结果。

后续改测哔哩哔哩：普通 Chromium 首页 HTTP 200，55/55 图片加载、截图确认内容正常，未登录或播放视频；相同白名单另阻止两个 s1.hdslb.com 请求，完整跨域 iframe 未验收。原生探针以 RSS 1,615.5 MiB 触发 1.5 GiB 安全停止，含初始化和清理共约 7.1 秒，尚无可接受首帧，不能声称本地重放或交互通过。两轮新增 swapout 均为 0，受控测试进程已清理；原生网站选项保持禁用。`experiment:site` 新增 `--mode ordinary|native|both`，便于分别诊断，默认仍为 both；不要提升阈值反复冲击本机。记录在 `test-results/chromium-bilibili-{ordinary,native}-20261028/report.json` 及上述 runtime JSON。74 JS 和 5 Python 回归、74 JS 语法检查通过；本次没有变更或重编引擎。

v0 是 Node.js + LinkeDOM + Yoga 的可信应用协议 PoC。服务端没有 Chromium 和像素后端；本地 Canvas 绘制 JSON 指令。提供每 session 子进程、语义操作、控制 epoch、有界队列、增量帧、profile 保存恢复。任意网站/完整 CSS/网站 JS/CDP 兼容均未实现。详见框架与验证记录。

仓库已补齐早期下载源码包中的代码、测试、协议和验证记录。下载包保留用于溯源；后续开发以当前 Git 历史为准。

下一阶段工作位于 `experiments/chromium-paint/`：真实 Chromium trace/SKP 捕获、来源校验、本地 CanvasKit 重放与视觉验证、headless shell 帧控制能力探针。复现入口和资源要求见 [CHROMIUM_PAINT.md](docs/CHROMIUM_PAINT.md)。这些实验没有关闭 stock Chromium 的 raster，不能当作通用引擎关卡通过；先读最新验证记录再接续。

外置 APFS 准备完成后的接续入口为 `experiments/chromium-engine/`，见 [CHROMIUM_ENGINE.md](docs/CHROMIUM_ENGINE.md)。固定 Chromium 156 提交的 picture-layer 补丁、构建恢复工具、C++ 测试及 ordinary/remote-paint 成对实验均在此处。先读取 `/Volumes/Extreme-APFS/Builds/chromium/virtual-desktop-build-state.json` 和对应日志，核对实际进程后恢复阶段，避免重复构建。源码、缓存和 out 均在外置盘；不能仅凭工具测试、应用补丁或 GN 成功声称完成引擎编译/切分。

2026-10-28 已完成原生引擎增量构建、4 项 cc 与 4 项 Viz 测试。新增 `VirtualDesktopRemotePaintNoDisplay`，仅在 headless 且 RemotePaint 同时启用时使用上游 OutputSurfaceUnified/NullRenderer。匹配 Chromium Skia 的 CanvasKit 已在外置盘构建：`/Volumes/Extreme-APFS/Builds/canvaskit/out`，采用明确的 A8 线性覆盖和 CFF 默认 stem darkening，固定页面全部文字区域通过原有阈值。三模式实验已达到 **record-only-display-candidate**；看 [最新验证记录](docs/chromium-engine-2026-10-28.json)。`engineSplitGate` 仍为 `not-passed`，不能称为通用无服务端像素的浏览器。

2026-10-28 后续已实现 **native-frame-candidate**，见 [CHROMIUM_FRAMES.md](docs/CHROMIUM_FRAMES.md) 和 [完整验收](docs/chromium-frames-2026-10-28.json)。原生补丁现在覆盖 17 个文件；7 项 cc/paint 与 4 项 Viz 通过。`npm run experiment:frames` 验证 6→5 个真实内容层、2 个 surface、7° 旋转/层序/矩形 clip/组 opacity、180px 滚动和删层；四阶段整图与独立区域均通过未放宽的阈值。默认文字平滑反例失败，显式 A8 才通过，不可外推所有字体。客户端有资源哈希复用、2 个未 ACK 帧加 1 个最新合并帧、有界缓存、原子显示及旧帧/损坏资源保护。

最新已达到 **live-native-session-candidate**，见 [CHROMIUM_LIVE.md](docs/CHROMIUM_LIVE.md) 和 [实际验收记录](docs/chromium-live-2026-10-28.json)。持续 producer 通过私有、带 capability 的 Unix socket 导出完整原生帧，worker IPC 合并中间状态；`src/` 网关已接入原生 backend、agent/control epoch、ACK 画面坐标输入与资源缓存。短的启动元数据 trace 只用于精确 URL→renderer 绑定，画面不依赖 trace 传输。forced-JSON 与 Perfetto 子 writer 混用导致的 renderer 断言已经修复并重建，17 个源码指纹均匹配。

`npm run start:native -- --root /Volumes/Extreme-APFS/Builds --canvaskit /Volumes/Extreme-APFS/Builds/canvaskit/out --port 8081` 开启原生实验，入口 `/native`；默认 `npm start` 保留 v0。实测无 viewer 的 agent、人工点击/文字/滚动/键盘、定时器自主更新、离线/刷新恢复、坏资源重试、双原生会话状态和凭据分离、localStorage 冷恢复、动作去重、worker 崩溃后的 Chromium 进程组清理均通过。71 JS、5 Python、66 JS 语法、11 C++、6 本地 E2E 通过；CI 无本机原生输入时显式跳过 3 项，其余照常执行。

最新真实产物在 `test-results/chromium-live-20261028/` 和 `test-results/chromium-live-e2e/`；此前完整帧与三模式回归在 `test-results/chromium-frames-rotation-20261028/`、`test-results/chromium-engine-frame-regression-20261028/`。旧捕获记录的补丁指纹属于历史构建，不能当作新原生构建的验收状态。

下一步扩默认字体/图片/iframe/IME/DPR、多 widget/renderer 和导航，再测无调试 trace 的总 CPU/RSS/带宽并整理最小 runtime 包。当前只允许精确的可信 fixture GET，Chromium sandbox 关闭；cookies/localStorage 冷恢复不是 JS heap/DOM 快照。Canvas/WebGL/video/readback 未覆盖，通用关卡仍未通过。不要通过放宽视觉阈值、回传截图或把 v0 的性能数据套到 Chromium 来推进关卡。

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
