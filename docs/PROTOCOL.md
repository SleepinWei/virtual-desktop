# v0 协议与 API

仅绑定 loopback。管理凭据来自 `ADMIN_TOKEN`，开发默认 `dev-local`。所有 API 凭据放在 `Authorization: Bearer TOKEN`；不支持通过 URL query 传 token。不设置跨域 CORS。页面源与 Host 需要是本地服务。

## 生命周期

```http
POST /api/sessions
Authorization: Bearer dev-local
Content-Type: application/json

{"profileId":"optional-profile-id","viewport":{"width":960,"height":720}}
```

成功返回 HTTP 201 与 `id/profileId/state/epoch/owner`，以及独立 `agentToken/viewerToken/humanToken`。真实 token 只在创建响应中返回，不进入列表或日志。

请求会等待有界队列的准入结果。超过队列上限返回 429 `QUEUE_FULL`，等待超时返回 503 `QUEUE_TIMEOUT`。默认同时最多 8 个 worker、2 个并发启动、16 个等待创建；默认等待 15 秒。配置 `MAX_ACTIVE/MAX_QUEUED/MAX_STARTING`。单会话操作队列上限 64；本地进程最多保留 4096 条 session 记录。

`GET /api/sessions` 使用管理 token，返回 session 元数据与队列统计，不返回 session token。

```http
POST /api/sessions/SESSION_ID/release
Authorization: Bearer MANAGEMENT_TOKEN
Content-Type: application/json

{"save":true}
```

成功保存后回收 worker，session 进入 `COLD`。用相同 `profileId` 再次创建，会恢复示例应用状态并分配新 session id 与新 token。旧 session 的页面内存、输入去重缓存和控制 epoch 不迁移。`save:false` 会丢弃尚未保存的应用变更。

### 原生网址预览

验证引擎并启用 `--external-sites` 后，可创建指定网址的原生会话：

```json
{"backend":"chromium","url":"https://search.bilibili.com/all?keyword=virtual%20desktop","profileId":"optional-profile-id"}
```

网址自动确定已有站点策略，保留 path/query/fragment；缺协议默认 HTTPS。仅接受 `sites.js` 中的导航域及其子域、HTTPS 默认端口，不接受凭据、资源 CDN 域或本地地址。`url` 仅适用于 Chromium backend。返回 `url` 为实际最终地址；`GET /health` 的 `urlPreview.enabled/domains` 和 `externalUrls` 用于发现配置。配置未启用返回 `NATIVE_URL_DISABLED`，不符合规则返回 `URL_NOT_ALLOWED`。

`POST /api/native/targets/resolve` 使用管理凭据和 `{"url":"..."}`，只校验并返回 `{site,url,label}`，不分配或回收浏览器，容量已满时也能校验。原生 viewer 的 Website URL 支持粘贴及回车；先校验，再 `release {save:true}`，然后以相同 `profileId` 创建新会话。两个执行浏览器依次运行，Cookie/localStorage 可恢复，原人工接管状态用新 token/epoch 重新申请。JS heap、DOM、sessionStorage 和旧输入去重历史不迁移。

无效网址保留当前页；通过校验后发生的网络或原生绘图失败会显示错误，旧页可能已回收，可重试其他网址。当前已实测 Bilibili 首页与搜索页的原生重放；视频、完整图片动画、站内所有链接及任意网站兼容性尚未验收。单次页面仍绑定其原生 URL/widget，粘贴新 URL 通过替换会话访问。

## agent 观察与操作

`GET /api/sessions/ID/observe`：三种 session token 均可读，返回文本、交互目标和边界框、`seq` 及 `control:{owner,epoch}`。不是完整浏览器 AX API。

```json
{
  "epoch": 1,
  "actionId": "unique-action-001",
  "action": { "type": "fill", "selector": "#task-input", "value": "New task" }
}
```

发送到 `POST /api/sessions/ID/actions`。支持：

| type | 参数 | 语义 |
| --- | --- | --- |
| fill | selector, value | 示例输入框赋值与 input 事件；最多 200 字符 |
| click | selector | 当前 DOM 中按钮 click 事件 |
| pointer | x, y, seq | 按 CSS 坐标定位当前画面目标；过期 seq 被拒绝 |
| viewport | width, height | 更新布局与绘制视口；宽 480–1600、高 320–1600 |

返回 `seq/actionId/deduplicated`。同 actionId 同负载在最近 1000 个成功动作缓存内只执行一次；同 id 不同负载返回 409 `ACTION_ID_REUSED`。超出缓存或 worker 重建后，不提供去重保证。客户端不要自动重试结果未知的外部副作用。

viewer token 写入返回 403 `READ_ONLY`。owner 或 epoch 不符返回 409 `CONTROL_LOST`。控制权校验与动作执行在同一个 session 的串行队列内，接管会等待已受理动作结束；已经发生的变更无法回滚。

## 画面协议

`GET /api/sessions/ID/frame` 返回完整 snapshot。`?since=SEQ` 在服务端仍保留这个前一帧时返回 delta，当前帧相同时返回 unchanged，更旧的基线返回 snapshot。v0 只保留当前和前一帧，不堆积无人观看期间的历史帧。

```json
{
  "type": "snapshot",
  "version": 1,
  "seq": 1,
  "viewport": { "width": 960, "height": 720, "contentHeight": 720 },
  "commands": [
    {"id":"n1:box","op":"rect","x":0,"y":0,"width":960,"height":720,"fill":"#f0f4fa","stroke":"transparent","strokeWidth":0,"radius":0}
  ],
  "targets": [],
  "sessionId": "SESSION_ID",
  "control": { "owner": "agent", "epoch": 1 }
}
```

绘图指令白名单：

- `rect`：坐标、尺寸、填充、描边、圆角。
- `text`：文字、字号、颜色、边界；文本测量与换行是 v0 的近似实现。
- `path`：折线点序列与描边；不是任意 JS 或 SVG 执行。

delta 包含 `baseSeq/seq/upserts/removes/order/viewport/targets`。`order` 是完整命令绘制顺序，`targets` 是当前交互目标。客户端基线不匹配时应重新请求 snapshot。路由与控制元数据不属于场景命令。

v0 仍发送完整顺序和 targets，使用 HTTP 轮询；没有实现字体/图片缓存、图层级失效、压缩、推送和客户端动画。不能将它的 JSON 大小当作未来浏览器协议的固定成本。

## 人工接管

`POST /api/sessions/ID/control` 需要 human token：

```json
{"epoch":1,"owner":"human"}
```

返回递增后的 epoch。交还用当前 epoch 与 `owner:"agent"`。agent 随后重新 observe 获取 epoch 与页面状态；旧输入不能缓冲到接管结束后继续发送。

当前 UI 是创建者的本地实验控制台，内存里持有创建响应中的能力，默认用 viewer token 获取帧、点击“Take control”才切换人类控制。它不是一个向第三方分发只读链接的产品实现。

## 诊断

管理 token 可访问 `GET /api/sessions/ID/metrics`，返回 worker pid、内存与命令数。`pixelBackend:null` 描述此 PoC 没有像素生成后端，**不是计数器或独立 trace 证明**。

部分受限环境没有 `/proc`，当前 RSS 读数会缺失。此时 `rss:null`，并保留 `maxRssKiB` 生命周期峰值。不要把峰值当作当前内存。


## 原生帧资源与输入（实验）

原生后端独立使用 `native/frame-protocol.js`，版本仍为 1。图片描述为 `kind:image`、SHA-256 `id`、`bytes`、`width/height` 与 `images/<id>.img`；picture 的 `images` 引用依赖，字体/图片描述必须先于 picture。二进制不进入帧 JSON 或 worker IPC。可选 `animationPolicy:first-frame` 仅在执行浏览器明确禁用图片动画时使用；缺少标记仍拒绝动画容器。圆角 `roundedClip`、surface 的 `isolated` 和 `SrcOver`/`DstIn` 处理见 [NATIVE_IMAGES.md](NATIVE_IMAGES.md)。

ACK 响应的 `current` 表示本次成功呈现的完整帧是否仍等同最新原生帧；`accepted:false` 不声明当前性。点击需带原有 connection epoch、seq、frameId。服务端从最近两份已确认的原生帧元数据计算可能覆盖该坐标的保守签名，并在 worker 派发前重验；与坐标无关、可证明完全分离的图层变化可忽略。目标资源/变换/遮挡/滚动改变仍拒绝，过旧坐标元数据也拒绝。滚轮保持整帧校验；键盘使用原有最多 16 份小型确认历史。
