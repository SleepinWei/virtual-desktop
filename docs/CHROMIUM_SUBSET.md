# Chromium 最小运行子集

2026-10-28：已提取并验证一版独立 **native runtime 包**，阶段为 `packaged-native-runtime-candidate`。它复用已通过 C++ 验证的 component 构建，完成运行文件提取；深度裁剪版本仅通过 GN 配置，尚未编译。实际记录见 [chromium-subset-2026-10-28.json](chromium-subset-2026-10-28.json)。

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

仓库的 `experiments/chromium-engine/lean-mac-arm64.gn` 使用非 component 构建、按体积优化，关闭 PDF、打印、headless CLI 命令和 Local State prefs。保留 DCHECK，不使用 ThinLTO，以控制后续本机构建成本。候选输出独立放在 `out/VirtualDesktopLean`，没有修改已验证构建的参数。

固定 Chromium 版本的 GN 图已生成：12,186 targets / 2,204 build files，`--fail-on-unused-args` 通过。需要限定 root target 和 root pattern，否则该版本的无关完整 Chrome 测试会因关闭打印而触发断言：

```bash
# 在 Chromium src 下，把仓库的 lean-mac-arm64.gn 复制为该新目录的 args.gn 后运行。
gn gen out/VirtualDesktopLean --root-target=//headless:headless_shell \
  --root-pattern=//headless:headless_shell --fail-on-unused-args
```

这里只完成配置，没有新二进制、C++ 验收或体积/内存结果。后续需在受控资源下构建单一 `headless_shell` 目标；为 monolithic 工件增加独立验证布局，并用同配置重建/执行相关 C++ 测试、原生输入/帧和本地视觉回归，再决定替换当前引擎。

缩小程序文件与降低网页内存是两条工作线。RSS 后续还需按实际物理占用、进程角色、V8/图片/字体及 SKP 序列化临时副本拆分；移走编译器和开发资源不会自动减少页面的 JS heap、解码缓存或帧副本。
