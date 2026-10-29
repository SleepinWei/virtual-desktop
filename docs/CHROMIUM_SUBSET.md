# Chromium 最小运行子集

2026-10-28：已提取并验证一版独立 **native runtime 包**，阶段为 `packaged-native-runtime-candidate`。它复用已通过 C++ 验证的 component 构建，完成运行文件提取，实际记录见 [chromium-subset-2026-10-28.json](chromium-subset-2026-10-28.json)。2026-10-29 的深度裁剪受控构建已启动，尚无新二进制；最新策略与状态见下文及 [chromium-pool-2026-10-29.json](chromium-pool-2026-10-29.json)。

## 需要保留的边界

当前已经使用 `headless_shell`，没有完整 Chrome 产品外壳。为了保持真实网站语义、agent 操作与人工接管，核心边界仍包含：

| 部分 | 原因与处理 |
| --- | --- |
| V8、Blink DOM/CSS/布局和字体度量 | 网页脚本、响应式布局、输入事件与实际几何依赖它们，保留 |
| content、进程通信、net/TLS、cookies、存储 | 导航、跨进程网页、登录状态和资源加载依赖它们，保留 |
| CDP、可访问性树、焦点和输入 | 保留 agent 的真实页面观察/操作和人工输入能力 |
| cc 属性树、绘图记录与相关 Skia 能力 | 本地画面还原依赖记录、字体和图片数据，不能整体删除 Skia |
| PDF、打印、命令行截图/PDF/DOM 命令、Local State prefs | 独立 lean 候选配置关闭；不能把配置成功当成删除了所有相关代码 |
| 音视频、WebRTC、Canvas/WebGL | 本轮不额外移除这些依赖；删除会影响对应网站能力，尤其需考虑哔哩哔哩。当前原生重放仍未覆盖这些画面路径 |

这不是把 Blink/V8 的几个源码目录单独复制出来：`headless_shell` 通过 content 及大量共享接口连接网页、进程、网络和系统服务。只保留 JS/DOM/布局，需要持续维护相应服务接口与失去的 Web 能力。

## 已完成的运行包

位置：`/Volumes/Extreme-APFS/Runtimes/virtual-desktop-native-156-20261028`。包内 `runtime-package.json` 保存每个 payload 文件的大小和 SHA-256；Chromium 和 CanvasKit 构建状态使用固定的相对路径，保持现有版本、补丁和构建验证约束。原始构建与 8081 用户会话保留。

| 范围 | 未压缩 payload |
| --- | ---: |
| 引擎运行文件，470 个 | 680.3 MiB |
| 匹配的 CanvasKit 和配置 | 4.2 MiB |
| 合计，含 Chromium LICENSE | 684.5 MiB |
| 从 GN 运行依赖中排除的文件，4,545 个 | 91.3 MiB |

475 个 payload 文件之外另有构建状态与包清单，体积很小。排除项是生成的 DevTools 前端、Python 辅助文件和 ANGLE 验证元数据；没有把源代码、编译器、测试程序或构建日志带进包。464 个 Mach-O 文件的 load commands 已检查：库依赖指向包内或 macOS 系统路径，没有回指原构建目录。动态插件与资源查找仍需运行验证。

这个数字不包括 Node.js、本仓库应用及 Playwright、操作系统框架和系统字体。它是本机 macOS arm64 的实验运行包，不能据此声称得到独立跨平台产品、最小功能引擎或更低 RSS。仍有 463 个动态库，主要 Blink/V8/网页模块代码没有被重新链接裁剪。

## 实际验证与限制

提取包启动本地原生会话，真实 DOM 输入、点击和 actionId 去重通过；收到 5 个原生帧、3 个资源，无帧故障。校验和、相对路径迁移和篡改拒绝有自动测试。76 项 JS、5 项 Python 和 77 个 JS 文件语法检查通过；本次没有修改 C++ 源码或重跑原有 21 项 C++ 测试。

首次启动有两个失败记录：一次在 BrowserServer 就绪前超时；采样版本进程位于 dyld 的依赖加载/映射/fcntl 路径，磁盘签名核验有效。之后基础版本命令成功，第二次原生初始化仍遇到 animation frames stalled；第三次本地原生生产端验证通过。保留全部报告，没有关闭系统安全保护或扩大内存预算。将原生 `launchServer` 超时限定为 15 秒，早于 worker 的 30 秒初始化上限，让 Playwright 有机会清理仍在启动的进程组；首次失败遗留的两个本轮进程已明确清理。

独立包的短 fixture 测试进程树 RSS 峰值约 818.2 MiB，原构建对照约 809.0 MiB，两者均未观测到新增 swapout。冷启动和 trace 初始化时序不同，不能把这两个短测试当成性能基准，也没有内存下降结论。

额外的现有 IAB viewer 验证被整机内存压力保护阻止：free percentage 34%，当时服务进程树仅约 151.1 MiB，保护在新浏览器启动前已锁定。截图为 `test-results/native-runtime-viewer-resource-stop.png`。本轮没有提取包的画面一致性或人工输入通过结论；原生生产端通过与 viewer 阻止是两项不同结果。服务后来恢复为空闲，继续使用 1.5 GiB RSS / 35% free / 换页和 heartbeat 保护，不继续启动测试页面。

```bash
# 从已验证构建提取到一个新目录，拒绝覆盖已有目录。
nice -n 10 npm run package:native -- --root /Volumes/Extreme-APFS/Builds \
  --canvaskit /Volumes/Extreme-APFS/Builds/canvaskit/out \
  --output /Volumes/Extreme-APFS/Runtimes/new-native-runtime

nice -n 10 npm run test:native-package -- \
  --root /Volumes/Extreme-APFS/Runtimes/new-native-runtime

DATA_DIR=.data/native-subset nice -n 10 npm run start:native -- \
  --root /Volumes/Extreme-APFS/Runtimes/virtual-desktop-native-156-20261028 \
  --canvaskit /Volumes/Extreme-APFS/Runtimes/virtual-desktop-native-156-20261028/canvaskit/out \
  --port 8082 --max-active 1
```

## 深度裁剪候选

仓库的 `experiments/chromium-engine/lean-mac-arm64.gn` 使用非 component 构建、按体积优化，关闭 PDF、打印、headless CLI 命令和 Local State prefs。保留 DCHECK，不使用 ThinLTO，以控制本机构建成本。候选输出为 `out/VirtualDesktopLeanNinja`，没有修改已验证的 `out/VirtualDesktop`。

固定 Chromium 版本的初版 GN 图为 12,186 targets / 2,204 build files，`--fail-on-unused-args` 通过。配置需要限定 root target 和 root pattern，否则该版本的无关完整 Chrome 测试会因关闭打印而触发断言。`lean-build.py` 已自动设置两项参数，并在编译前后检查固定提交和 20 个补丁文件指纹。

第一轮 Siso 在读取图和启动辅助工具时触发整机 free 34% 的内存保护。改用上游 `autoninja.py` 支持的 `use_siso=false`，另建 Ninja 输出，避免混用两种构建工具的数据；旧的 Siso 目录与停止记录保留。第二轮 Ninja 已开始 C++ 编译，最新 RSS 采样约 370 MiB，但整机 load 8.75 触发原有 CPU 总负载门限。两轮都没有生成可用新引擎，原始二进制及 8081/8082 未替换。

用户先要求优先避免影响其他任务，采用单任务后台构建；随后明确要求尽量使用 8 核，并允许关闭无用任务。当前按这个最新要求设置：

| 保护 | 当前编译策略 |
| --- | --- |
| 并发 | 一个 `headless_shell` 目标，上限 `-j 8`；八/六任务在大文件组触及 RSS 保护后，当前自适应构建已降为四任务。Blink 绑定生成动作使用上游单进程模式，避免每个动作另开整机核数的进程池。由 macOS 分配核心，不是固定 CPU affinity；关闭远程执行和 ThinLTO |
| CPU / I/O | 只对编译子树使用 utility QoS clamp、nice 10 和磁盘 I/O throttle，子进程继承；监控器保持正常优先级 |
| 整机 CPU load | 编译专用不按 load >8 直接停止；通过优先级给前台让路。浏览器测试和交互服务的默认 load 保护保留 |
| 内存 | 整机内存压力 free percentage ≥35%，编译 owned RSS 之和 ≤6 GiB；浏览器默认仍为 1.5 GiB |
| 换页 | 最近 10 秒新增系统 swapout ≤64 MiB |
| 监控 | 独立 watchdog，心跳 4 秒；监控器在编译的 QoS clamp 之外；监控失效也终止编译 |

这依赖系统调度和秒级采样，并非硬 CPU/内存隔离，也不能保证其他应用绝对零卡顿。全局 load 不能直接当成前台响应时间。最新改动只提高编译并发和编译 RSS 预算；整机 free、换页、心跳及默认浏览器策略保留。`guardLimits` 将编译 RSS 覆盖限制在独立配置，不修改公共 `SAFE_LIMITS`，回归测试确认这些边界。

先用 SIGINT 中断旧单任务 Ninja，并验证采集到的旧编译进程全部退出，再以八任务恢复相同输出目录；没有 clean 或改变 GN 参数，完成的对象继续复用。旧单任务报告中的 `build-failed` 是这次主动中断，不代表源码编译报错。Ninja 的编译子进程可处于独立进程组，停止逻辑因此按 PPID 捕获整个归属树，先结束后代再结束根进程，避免只停止主进程组而遗留编译器。

最新加速记录见 [chromium-build-budget-2026-10-29.json](chromium-build-budget-2026-10-29.json)。持续状态先读本机 `test-results/cli-handoff-20261029/build-detach.json` 指向的报告和 launchd 服务，以及外置盘 `chromium/virtual-desktop-lean-ninja-build-state.json`、`logs/chromium-lean-build.log`。当前 supervisor 为 `test-results/lean-adaptive-20261029/supervisor-report.json`，实际守护报告由其 `guardReport` 字段动态给出。构建独立于桌面应用，KeepAlive=false，没有定时任务；允许的有界 RSS 降档规则见下文。后面的旧恢复报告仅作为历史证据。

### Blink 生成任务的并发预算修复

2026-10-29 11:46，两任务构建也触发了 6 GiB RSS 保护。当时 free percentage 81%、没有新增 swapout；实际是两个 Blink 绑定生成动作各使用 `multiprocessing.cpu_count()` 创建 10 个 worker，绕过了 Ninja 的两任务预算，系统 load 约 25。

`lean-build.py` 现在只在 `VIRTUAL_DESKTOP_LEAN_ROOT=headless` 环境下，为固定版本的 `third_party/blink/renderer/bindings/BUILD.gn` 模板启用已有的 `--single_process`。每个生成动作只使用一个进程，再由 Ninja 分配最多八个动作；原生 C++ 与生成算法保持原实现。安装过程验证固定原始 SHA-256，幂等更新并记录新指纹，拒绝覆盖未知修改。真实 GN 查询验证启用和未启用环境标记的两种行为；4,732 份既有生成源码哈希全部匹配，14 项 Python 测试与 GN 格式检查通过。

14:50 先用四任务验证，14:53 升至八任务。最初 85 个守护样本 RSS 峰值 4.23 GiB、最低 free 81%、新增 swapout 0。30 秒正常优先级调度探针最大唤醒延迟约 10 ms，ToDesk 进程持续获得 CPU，编译子树 nice 10、ToDesk nice 0。该探针不测远端画面或输入时延，不能保证全程零卡顿。原内存、换页、心跳及低优先级保护没有提高或移除；没有清理对象缓存、没有改变 args.gn。

随后八任务在大文件组 RSS 6.006 GiB 触线停止，free 79%、新增 swapout 0。15:04 的六任务尝试也触线，因此实际稳定档已降为四任务。新增 `build:native-lean:adaptive` 包装器：只对 owned RSS 保护停止执行 8→6→4→2→1 的有界降档，每档只尝试一次；重新启动前要求连续至少 10 秒 free≥45% 且零新增换页，等待最多 60 秒。不自动升档，一任务触线也停止；整机压力、换页、心跳、编译错误及用户中断均直接停止。每次尝试保留独立报告，避免把旧 `running` 混同为当前状态。六→四的真实续编已观察到，86 项 JS、14 项 Python 和 83 个 JS 语法检查通过。

2026-10-29 后续检查：上述八任务构建于北京时间 01:01:56 因 V8 metagen 的 GN 查询失败退出，停止时 free 43%、新增 swapout 0，资源守护没有触发。约 09:31 已修复并恢复，最新持续报告改为 `test-results/lean-metagen-resume-20261029/guard-report.json`，原八任务报告保留为失败证据；详见 [chromium-metagen-recovery-2026-10-29.json](chromium-metagen-recovery-2026-10-29.json)。

初始 `gn gen` 限定了 headless 根目标，但 V8 生成器内部的 `gn desc` 没有这些开关，重新加载完整 Chrome 测试图，在 `print_preview/BUILD.gn` 触发 `assert(enable_print_preview)`。相同查询加上 headless 根范围即成功。现将 `lean-root.gn` 作为一个有原始哈希校验的条件片段追加到源码 `.gn`：只有候选构建进程的 `VIRTUAL_DESKTOP_LEAN_ROOT=headless` 环境启用，未设置时保持原默认配置。记录原始/修改后/片段哈希，拒绝未知或自定义文件，避免影响其他构建。未修改 V8 生成器及原生 C++，没有改变 args.gn 或清理对象缓存。

候选流程新增两项提前验证：不带 root CLI 开关的真实 V8 GN 子查询，以及单独生成 `gen/v8/metagen/instance-types.h`。本机均已成功；该头文件 86,849 bytes、SHA-256 `c5faa42595340b24d2426f4dd51ca90fc3b367e5a0e67d421fc184b14c5455d4`，与已验证 component 构建的同名头文件相同。主目标继续八任务编译，恢复时余下约 21,834 条 Ninja 命令。新增保护测试后 12 项 Python 和 81 个 JS 语法检查通过；头文件一致不等于新引擎完成或通过 C++/原生/视觉验收。

此前资源结果：八任务在 V8 较大的生成代码编译阶段于 09:33 再次保护停止，free 33%、该次采样新增 swapout 89.5 MiB；代码生成预检已通过，停止原因为内存压力。确认采样进程全部退出、整机余量恢复后，约 09:37 以 **四任务**续编，保留八任务上限配置和全部内存保护。该次报告 `test-results/lean-metagen-four-jobs-20261029/guard-report.json` 后来于 09:54 也记录了内存压力停止，现为历史证据。退出桌面端后可用内存和实际工作负载已有变化，但不能为坚持八并行而顶着换页运行，没有自动升档或重试循环。

按用户授权检查并退出了闲置的 Epic Games Launcher 与 UnrealEditorServices：正常 Quit 请求仍留后台，核对路径后发送 SIGTERM，确认两个进程均退出。没有关闭当前 Codex、Chrome、ToDesk 或 8081/8082 的原生会话。83 项 JS、10 项 Python 和 81 个 JS 语法检查通过；本轮没有修改 Chromium C++ 源码或取得新的二进制验收。

```bash
# 先检查记录的 PID/状态，避免启动第二份编译。
python3 -B experiments/chromium-engine/lean-build.py status --root /Volumes/Extreme-APFS/Builds

# 启动器自动对编译子树降低 CPU/I/O 优先级；不要并行跑浏览器压测。
npm run build:native-lean:adaptive -- --root /Volumes/Extreme-APFS/Builds \
  --jobs 6 --max-rss-mib 6144 --output test-results/lean-adaptive
```

当前没有新二进制、C++ 验收或轻量引擎的体积/内存结果。构建完成后仍需为 monolithic 工件增加独立验证布局，并用同配置重建/执行相关 C++ 测试、原生输入/帧和本地视觉回归，再决定替换当前引擎。

缩小程序文件与降低网页内存是两条工作线。RSS 后续还需按实际物理占用、进程角色、V8/图片/字体及 SKP 序列化临时副本拆分；移走编译器和开发资源不会自动减少页面的 JS heap、解码缓存或帧副本。
