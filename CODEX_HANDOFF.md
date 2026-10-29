# Codex 本地接续

## 项目不能丢失的目标

用户要的是云端维护网页执行状态、本地执行像素绘制，并借此减少服务端图形负担与传输开销。不要把任务改回 headless Chromium 截图/视频 viewer。绘图指令技术可行性优先于大量堆叠调度组件。

## 当前实现

最新检查发现八任务构建曾于 **2026-10-29 01:01:56（北京时间）**因 V8 metagen 失败停止，非资源保护；不能把历史 `running` 快照当当前状态。已修复并于约 **09:31** 恢复，见 [恢复记录](docs/chromium-metagen-recovery-2026-10-29.json)。根因是 V8 子进程 `gn desc` 未带初始 headless 根范围，加载完整 Chrome 测试图后遇到已关闭打印功能的断言。`lean-root.gn` 通过 `.gn` 的 `VIRTUAL_DESKTOP_LEAN_ROOT=headless` 条件只给候选子进程保留相同 root/root_patterns；只接受固定原始 `.gn` 哈希、幂等追加、记录前后哈希，拒绝覆盖自定义内容。未修改 V8 生成器或原生 C++、未改变 args.gn、未 clean。现在先执行无 root CLI 开关的 V8 GN 查询，再单独运行真实 metagen，均通过后才进主构建；输出头文件 86,849 bytes、SHA c5faa425... 与原 component 构建一致。12 Python / 81 JS 语法通过，这不等于新二进制或 C++ 验收。

修复后八任务进入 V8 大文件阶段又于 **09:33** 触发资源保护：free 33%、该次守护记录新增 swapout 89.5 MiB，采样进程树全部退出。已按用户优先保证其他进程响应的要求于约 **09:37 改成四任务续编**，最高八任务配置保留。**最新守护报告是 `test-results/lean-metagen-four-jobs-20261029/guard-report.json`**；外置同一个 lean state 记录 `gnRootPatch`、`v8MetagenPassed`、jobs/PID，接续先核对它。仍保留 6 GiB RSS / 35% free / 换页 / 心跳保护；不要为坚持八并行而提高阈值。`lean-metagen-resume-20261029` 是这次八任务的保护停止记录，`lean-eight-jobs-20261029` 是凌晨代码生成失败记录，两者原因不同。没有自动升并发、失败重试或后续通知。

**最新编译配置以用户“最大化用 8 核、内存保证不影响其他进程、可关闭无用任务”的要求为准。** `build:native-lean` 当前默认 `--jobs 8 --max-rss-mib 6144`，只对编译子树设置 utility QoS、nice 10 和 I/O throttle；free 35%、最近 10 秒新增 swapout 64 MiB、心跳 4 秒和监控失效终止保持，浏览器默认 RSS 1.5 GiB 不变。旧 j1 Ninja 已主动 SIGINT、验证旧归属树全部退出，复用同一 `out/VirtualDesktopLeanNinja`，没有 clean/GN 参数变更。最新守护报告为 `test-results/lean-eight-jobs-20261029/guard-report.json`，外置 `virtual-desktop-lean-ninja-build-state.json` 保存 jobs/PID/阶段；先核对它再恢复，避免两份构建。详见 [八任务记录](docs/chromium-build-8jobs-2026-10-29.json)。已退出闲置 Epic Games Launcher 和 UnrealEditorServices，当前 Codex、Chrome、ToDesk、8081/8082 保留。83 JS / 10 Python / 81 JS 语法通过；无新 C++ 或二进制验收。下面的单任务/nice 19 描述属于上一阶段历史。

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
