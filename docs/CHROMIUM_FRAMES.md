# 原生完整帧与本地合成实验

2026-10-28 达到 **native-frame-candidate**：同一真实 Chromium 页面导出 6 个内容层、2 个合成 surface，客户端通过层序变化、平移与 7° 旋转、矩形裁剪、重叠子层的分组透明度、180px 滚动和删层后的逐区域视觉对照。删除后剩 5 个内容层，原层位置的像素误差为 0。完整指标与构建指纹见 [chromium-frames-2026-10-28.json](chromium-frames-2026-10-28.json)。

实验仍限定在 960×720、DPR 1、固定字体和明确 A8 平滑策略的可信页面。`engineSplitGate: not-passed`、`serverRasterBypassed: false` 保留。生产 `src/` 仍是 v0 后端。

## 数据来源与合成

`LayerTreeHostImpl::PrepareToDraw` 在活跃树完成 `UpdateDrawProperties` 后发出 `VirtualDesktop.RemotePaintFrame`。导出遍历使用 Chromium 自身的 `EffectTreeLayerListIterator`，与 `CalculateRenderPasses` 的来源和层序一致，发生在远程 picture layer 拒绝正常 `WillDraw/AppendQuads` 之前。

每份导出包含完整可绘制成员、render target、surface 边界、变换矩阵、目标坐标空间的 clip、draw opacity、原生 scroll offsets，以及原始 SKP。不能把绘图记录的更新时间当作完整帧，也不能把某次缺少更新的旧层一直保留下去。被移除的层从下一帧权威成员列表消失。

SKP 导出保留 layer 坐标，传入 `GetRasterInducingScrollOffsets()` 提供的实际、已吸附偏移。旧 debug snapshot 的零偏移与平移到原点行为继续保留给旧实验。新增 C++ 像素测试用同一条滚动绘图记录的 0/20px 偏移验证红/蓝像素，并验证非零原点没有丢失。

客户端把每个 target 内的原生前到后顺序转换为后到前绘制。先应用目标空间 clip，再连接 layer/surface 的矩阵。子 surface 使用独立 `saveLayer` 合成后应用组透明度；对子层逐个乘透明度会使重叠区域出错。所有层先画入本地背缓冲，成功后再替换可见 Canvas。没有从 DOM 的文字或边界重建画面。

原生导出带显式 `supported` 和集合计数。Perfetto JSON 可能省略空数组；只有对应计数确为 0 才允许解释为无成员。最新帧不受支持时直接失败，不退回旧的可支持帧。当前处理 picture/solid、二维变换、矩形 clip 和 SrcOver 透明度分组；滤镜、mask、3D、非 SrcOver 等会拒绝，其他图片/Canvas/WebGL/video 路径仍未验证。

## 传输约定

| 字段或行为 | 约定 |
| --- | --- |
| `frame.id` | 原生 PID、tree id、trace timestamp 的组合；同一 source frame number 也可产生新的滚动合成状态 |
| `epoch` / `seq` | 通道会话与单调递增传输序号，独立于 Chromium 的 source frame number |
| `surfaces[].items` | 当前完整成员与绘制顺序；没有引用的旧层不参与下一帧 |
| SKP resource | SHA-256 标识、精确字节数和白名单路径；字体仍嵌在 SKP 中 |
| `presented` ACK | 仅在全部资源通过字节数/哈希校验、解码和本地绘制成功后发送，绑定 epoch、seq、frame id 与实际缓存资源清单 |
| 背压 | 最多 2 个未确认帧，另保留最新的 1 帧；连续更新合并到最新完整快照 |
| 迟到帧 | 收到时及每次异步资源加载后检查序号/epoch；不允许覆盖更新画面 |
| 资源失败 | 释放本次新解码对象、保留上一帧、不 ACK；自动 NACK/重试尚未实现 |
| 缓存 | 单资源最多 32 MiB、总计 128 MiB，按序列化字节计，不是解码后 WASM/RSS 上限；数量及图层/surface/深度另有界限，驱逐反映在 ACK 中，重新引用时再次下载 |

四阶段正向客户端只下载 9 份不同 SKP，共 **207,309 bytes**；逐帧重复发送全部引用会计入 23 份、529,015 bytes。这里只比较此 fixture 的 SKP 字节，不含 JSON、HTTP、首次约 4.35 MB 的 CanvasKit、trace 或其他运行成本。原生 trace 目前仍重复导出完整记录，不能据此声称服务端 CPU 或总带宽收益。

HTTP frame/ACK 通道当前传输的是**已捕获的帧**。用户在 recorder 的真实页面点击、滚动，recorder 关闭后，独立本地浏览器重放这些状态。它还没有把持续运行的 Chromium、agent 动作或人工控制 epoch 接入此通道。实验服务仅绑定 loopback，校验 Host、POST Origin 和资源白名单，最多保留 4 个实验会话；这不是生产会话网关或隔离方案。

## 复现与验证

先按 [CHROMIUM_ENGINE.md](CHROMIUM_ENGINE.md) 完成固定源码的 `apply`、`build`、`test`，以及匹配 Skia 的 CanvasKit 构建。当前过滤测试为 7 项 cc/paint 和 4 项 Viz；不是全部 Chromium 测试。

```bash
npm run experiment:frames -- --root /Volumes/Extreme-APFS/Builds \
  --canvaskit /Volumes/Extreme-APFS/Builds/canvaskit/out \
  --output test-results/chromium-frames-rotation-20261028
```

入口校验成功构建状态、补丁、可执行文件、全部 component/resource 指纹及 CanvasKit 配置/字节。测试页 HTML/CSS/JS/字体的 HTTP 内容也必须与本地固定源文件一致。加 `--saved` 可只重放已有捕获，要求原构建和测试页指纹仍匹配。

输出包含原始 trace、完整帧 manifest、原始 SKP、四阶段 PNG、本地逐区域结果与 `frame-engine-report.json`。只有独立本地验证浏览器生成 PNG；捕获路径无 screenshot/readback 或 DOM 几何绘图提取。

严格阈值沿用平均 RGB 绝对误差 ≤3、任一通道差值 >32 的像素 ≤2%，整图和 7 个独立区域全部检查。默认文字平滑的初次测试整图通过，但标题区域平均误差 5.070、异常像素 5.97%，因此失败并保留反例。显式 A8 配置后通过，没有放宽阈值；默认平滑、其他字体和任意网站仍不在通过范围。

真实浏览器故障注入检查两条路径：迟到旧帧不改变可见像素；返回被篡改但长度相同的 SKP 时，SHA-256 校验失败，旧画面保持，服务端 ACK 停留在前一帧。单元测试另覆盖异步解码乱序、资源释放/驱逐、错误 ACK、epoch 重置、背压和不完整原生数据。

```bash
CHROMIUM_FRAME_CAPTURE_DIRECTORY=test-results/chromium-frames-rotation-20261028 \
CHROMIUM_CAPTURE_DIRECTORY=test-results/chromium-engine-frame-regression-20261028/record-only-display \
CANVASKIT_DIRECTORY=/Volumes/Extreme-APFS/Builds/canvaskit/out \
CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:e2e
```

本机这 5 项浏览器测试全部通过。CI 缺少本机引擎捕获/匹配 runtime 时显式跳过两项原生重放，不用合成记录冒充视觉验收；通用协议与 v0 浏览器测试照常执行。

## 后续实现

1. 将原生 producer 从批量 trace 改为持续输出，接上仍在运行的 Chromium 会话；绑定动作结果、原生 frame 与 viewer ACK，补断线重发和资源失败恢复。
2. 扩展默认字体策略、图片资源与生命周期；覆盖嵌套滚动、缩放/DPR、iframe surface、输入框/IME 和真实网站，继续逐区域验收。
3. 明确 Canvas/WebGL/video/readback 的支持或拒绝边界；不能静默恢复服务端像素路径并仍报告切分成功。
4. 整理最小 runtime 分发包，去掉调试 trace 后测同等任务成功率下的 CPU、RSS、线程、总网络及本地负担，再决定多 worker 调度和人工接管方案。
