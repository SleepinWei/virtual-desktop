# 原生图片资源与真实站点预览

真实网页继续由 Blink 执行 JS、DOM 和布局。图片绘制记录使用原始压缩资源的引用，本机 CanvasKit 执行图片解码、绘制及合成。服务端输出原始编码及绘图记录，没有截图、像素重编码、GPU readback 或 DOM 重建画面。

最终包 `/Volumes/Extreme-APFS/Runtimes/virtual-desktop-web-156-20261030` 的本轮结果见 [验收证据](chromium-native-images-2026-10-30.json)：135 JS、16 Python、29 C++，7 组图片区域及真实 Bilibili 坐标/直接输入通过。密集文字与公开网站严格视觉仍未通过。

## 数据链路

1. 原生 compositor 按 `visible_layer_rect` 录制可见内容，保留原始坐标和实际滚动偏移。
2. 录制专用 ImageProvider 验证图片，保留 lazy SkImage。shader/filter 路径保留原始 PaintImage，不将它包装为已解码纹理。
3. SKP 中的图片改为 `vdimage1` + SHA-256 引用。原始压缩文件由后台 writer 写入私有 `images/<hash>.img`，写完后才发布依赖帧。
4. worker IPC 和帧 JSON 只携带资源描述及文件路径。网关校验长度与哈希并保留打开的 inode；每次 HTTP 响应使用独立文件描述符。
5. viewer 校验二进制资源、本机解码并注册图片，再解码依赖的 SKP。缺失、损坏、尺寸不符或超预算均不显示、不 ACK。

CanvasKit 内置解码器负责常见格式；精简 codec 集未覆盖的静态 AVIF 可由本地浏览器 `createImageBitmap` 解码，转换为本地 PNG 后注册为 lazy SkImage。临时 bitmap 和 canvas 随后释放。其他无法解码的格式明确拒绝；服务端不承担该像素转换。

## 合成与资源约束

圆角数据来自 cc 的 `MaskFilterInfo`，在目标 surface 坐标中应用。每个 picture 使用透明的独立 backing，避免内部 `DstIn` 清除父背景。圆角、透明度及 masking surface 按组进行合成；compositor 的 blend mode 仅支持 `SrcOver` 和 `DstIn`，其他模式继续拒绝。

PaintWorklet 的 deferred image 使用当前活跃树已经准备好的 `PaintWorkletRecordMap`，输出实际 PaintRecord；直接图片、shader 和 image-filter 路径都保留录制专用 provider。缺少记录时明确拒绝，不伪造空图或复用错误状态。该处理仍是绘图指令录制，执行网站自己编写的 Canvas/WebGL 等代码不在此保证内。

图片单资源最大 16 MiB；尺寸最多 8192×8192，且单图不超过 16 Mi pixels。单帧图片解码工作量最多 64 Mi pixels，不是常驻 RGBA 预算。registry 保留原始压缩资源和 lazy SkImage，Skia 解码缓存配置为 32 MiB；完整性验证时逐张解码并释放临时 bitmap，避免仅凭有效 header 接受截断文件。全部压缩资源仍受原有 128 MiB 总预算限制。这些边界不是整个浏览器 RSS 硬限额，临时分配和浏览器自身仍由 watchdog 独立监视。

切换可见区域后，客户端立即释放不再使用的图片及依赖 picture，ACK 如实反映当前缓存。私有图片仅对被授予该帧的 viewer/epoch 可用。字体继续使用独立二进制与 runtime 预置资源。

默认仍拒绝动画图片。Bilibili 明确使用“静态图片预览”：Chromium `imageAnimationPolicy=2` 固定首帧，资源携带 `animationPolicy:first-frame`，客户端只在该标记存在时允许本地首帧解码；普通对照使用相同设置。两帧 GIF 的实际 WASM 测试验证首帧像素，并移除标记确认拒绝。JS、CSS 动画和轮播继续运行，完整图片动画尚未支持。

纹理、增益图、重解释色彩及尚未覆盖的绘图语义仍明确拒绝。CSS filters/backdrop filters、视频、WebGL、多 widget/导航等能力不能从这些图片测试外推。网站自身的 Canvas/WebGL 执行也不等于已完全消除服务端像素工作；通用引擎关卡仍未通过。

## 动态页面的坐标围栏

下方轮播变动不应一律使顶部搜索框过期。网关和执行 worker 均以原生 surface/item 的 bounds、transform、clip、圆角外框、层序及资源哈希，计算可能覆盖点击坐标的保守签名；变换采用 AABB，边缘额外保留 2 px。覆盖位置的 picture 变动、遮挡、移动、滚动或来源变动均拒绝。较大的 picture 即使只在另一处变化也可能保守拒绝；没有从 DOM 重建命中区域。

每 viewer 仅保留最近 2 份无资源字节的原生帧元数据供坐标校验，键盘继续使用 16 份小型确认签名。滚轮仍要求整帧一致。ACK `current` 仅表示整帧是否追上；点击区域可以在其他区域动画继续运行时保持有效。最终真实站点测试首试点击成功后输入 8 个字符，无拒绝请求或残留错误提示。

## 验证

`guarded-native-tests.js --task images --in-process-gpu` 对普通图片、CSS 背景、圆角、渐变遮罩、明确首帧 GIF 及矢量对照执行本地回放，与独立普通浏览器的区域像素比较。参考截图只用于验证，不进入生产数据流。测试还直接验证：缺失图片、“哈希有效但格式损坏”及有效 header 的截断图片不会被替换为空白图。

图片区域与文字区域分别记录。既有的密集文字像素差异仍会阻止通用网站及等画质性能验收，不能由整页背景或图片正确掩盖。`compare-site.js` 继续要求原生回放与 JPEG 对照的独立区域全部通过，才接受性能比值。

## 小红书访问限制

当前新建实验会话被小红书跳转到 `website-login/error`，返回 300012。域名白名单没有拦截其请求。用户的日常浏览器可以打开小红书，因此不能据此声称整个网络都不可访问；日常浏览器与新实验会话的登录、扩展及网络环境也未被证明相同。

服务端会刷新并检查 JS 跳转后的最终地址，将该情况报告为 `SITE_ACCESS_RESTRICTED`，不暴露风控 URL 中的查询凭据。此分类不代表已经解除站点限制，也不自动复制日常浏览器的登录状态。按用户选择，真实站点验证先使用哔哩哔哩。
