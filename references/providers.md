# Provider 事实表（本机实测于 2026-11-05）

本文件是 `scripts/gen-image.mjs` 的依据。新增 provider 时按同样格式补一行 + 在脚本
`PROVIDERS` / `SIZE_MAP` 里加一条实现即可。所有 key 都从 `~/.dsh/.credentials.yaml`
的 `refs:` 段读取，也支持同名环境变量覆盖。

| provider | keyRef | endpoint | 模型 | 尺寸参数 | 返回取图 | 水印 | 实测耗时 |
|---|---|---|---|---|---|---|---|
| `minimax` | `MINIMAX1_API_KEY` | `POST https://api.minimaxi.com/v1/image_generation`（备用 `api.minimax.cn`） | `image-01` | `aspect_ratio` 枚举，或 `width`/`height`（512–2048，8 的倍数） | `data.image_urls[0]`（24h 过期）或 `response_format:"base64"` → `data.image_base64[0]` | 无 | 14–15s |
| `dashscope` | `QWEN_TOKEN_PLAN_CN_API_KEY` | `POST https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis` + 头 `X-DashScope-Async: enable`，轮询 `GET /api/v1/tasks/{id}` | `wan2.2-t2i-flash` / `wanx2.1-t2i-turbo` | `parameters.size`，**用 `*` 连接**：`1024*1024` | `output.results[0].url` | 无 | 提交 0.5s + 轮询到 6.5s |
| `zhipu` | `ZAI_CODING_CN_API_KEY` | `POST https://open.bigmodel.cn/api/paas/v4/images/generations` | `cogview-3-flash` | `1024x1024` / `1440x720` / `720x1440` / `1152x864` / `864x1152` / `1344x768` / `768x1344` | `data[0].url`（约 7 天有效） | **固定「AI生成」水印，`watermark_enabled:false` 也去不掉** | 9–11s |
| `ark` | `ARK_API_KEY` | `POST https://ark.cn-beijing.volces.com/api/v3/images/generations` | `doubao-seedream-5-0-flash-260915` / `doubao-seedream-5-0-pro-260628` | `"1K"` / `"2K"` 或显式 `WxH`；面积 921 600–4 622 420 px，比例 ≤16:1，**无 4K** | `data[0].url`（TOS 预签名 24h）或 `response_format:"b64_json"` | `watermark:false` 无 | Flash 9.5–10.5s / Pro 27.9s |

## 各 provider 的坑

### MiniMax
- **成功判定要两层**：HTTP 200 不代表成功，必须看 `base_resp.status_code === 0`。
- 业务错误码：`1004` 鉴权失败、`1008` 余额不足、`1002` 限流、`1026` 敏感内容。
- `api.minimax.io`（国际站）用本机套餐 key 会返回 `base_resp:2049 invalid api key`，**只用 `api.minimaxi.com` / `api.minimax.cn`**。
- `aspect_ratio` 与 `width/height` 同时给时以比例优先；脚本二选一。

### DashScope（通义万相）
- 必须带 `X-DashScope-Async: enable`，提交后拿 `output.task_id` 轮询，`task_status` 为 `SUCCEEDED` 才有图。
- `compatible-mode/v1/images/generations` 对这类 token-plan key 返回 404 空体，**别走 OpenAI 兼容层**。
- 返回里 `actual_prompt` 是平台改写后的提示词，`usage.image_count` 为张数。

### 智谱
- `cogview-3-flash` 是免费档，代价是右下角水印；`cogview-4` / `glm-image` 需要资源包，无额度时报 429 `code=1113 余额不足`。
- 同一个 coding key 的对话额度与图片额度是分开的：chat 200 不代表能生图。

### 火山方舟 Ark（Seedream）
- **model id 必须带日期后缀**：`doubao-seedream-5-0-flash-260915`（写成 `250915` 或省略后缀都会 404 `InvalidEndpointOrModel.NotFound`）。脚本会先 `GET /api/v3/models`，按 `domain=="ImageGeneration" && status=="Published"` 自动挑最新 id，离线时回退到上面的常量。
- **禁传** `sequential_image_generation` 与 `stream`（传任何值都 400）；`n` 被忽略，一次一张。
- `size:"4K"` 不存在；`4096x4096` 超出面积上限 4 622 420 px。要控比例就传显式 `WxH`（脚本的 `SIZE_MAP.ark` 已按比例算好且不超限）。
- 错误码：`400 InvalidParameter`、`401 AuthenticationError`、`ModelNotOpen`（未开通）、`429 SetLimitExceeded`（勿立即重试）；同步接口断连仍会计费。
- 同 key 还可用 `doubao-seedream-5-0-pro-260628`（更慢更贵）和 `doubao-seedream-4-0-250828`（更便宜）。

## 价格参考（会变，以控制台为准）

| provider | 单张价格 | 说明 |
|---|---|---|
| `zhipu` cogview-3-flash | 免费 | 有水印 |
| `ark` Seedream 5.0 Flash | ~0.12 元/张 | 2K，无水印，性价比最高 |
| `ark` Seedream 5.0 Pro | 明显更贵（数倍） | 约 28s/张，`--quality best` |
| `dashscope` wan2.2-t2i-flash | 按张计费（百炼控制台） | 无免费额度说明 |
| `minimax` image-01 | 套餐 key 内 | 视套餐额度 |

## 新增 provider 的步骤

1. 在脚本 `PROVIDERS` 加：`keyRef`、`models`、`endpoint`、`watermark`、`cost`、`generate()` 实现。
2. 在 `SIZE_MAP` 加比例→尺寸映射；实在不支持就把映射写成 `2K` 这类档位串。
3. 成功判定统一返回 `{ kind: 'url' | 'b64', url | b64, modelUsed }`，错误用 `providerError()` 抛，带 `kind` 以便回退。
4. 在 `buildChain()` 里决定它出现在哪个质量档，并在本文件补一行实测结果（endpoint、耗时、坑、价格）。

---

# v2 能力（图生图 / 透明背景 / 多图，实测 2026-11-05）

## 图生图 / 编辑

| provider | 端点 | 请求体要点 | 实测 |
|---|---|---|---|
| `ark` | 与文生图同一个 `POST /api/v3/images/generations` | `image` 为 **dataURL 字符串数组**（1–10 张），必须带 `data:image/jpeg;base64,` 前缀，裸 base64 会 400 `invalid url specified`；顺序即 prompt 里的「图1/图2」 | Flash 14–16s / 2048²；Pro 74.6s；2 张参考图实测 OK（`usage.input_images=2`，输出 2816×1584） |
| `dashscope` | `POST /api/v1/services/aigc/multimodal-generation/generation`（同步，无 `X-DashScope-Async`） | `{model, input:{messages:[{role:"user", content:[{image:dataURL}…,{text:prompt}]}]}, parameters:{}}`；取图 `output.choices[0].message.content[].image` | `qwen-image-3.0` 默认；`qwen-image-3.0-pro` 90–110s；`qwen-image-edit*` 全 `Model not exist`（旧名已下线）。单次曾耗时 250s，故编辑路径默认 300s 超时 |
| `minimax` | — | **不支持**：`image` / `image_url` 被静默忽略（传 `"not-an-image"` 仍 200 出图）；`subject_reference.image_file` 只收公网 URL | 只能纯文生图 |
| `zhipu` | — | 不支持编辑 | — |

## 透明背景

- 只有 `ark` 支持，且必须同时满足：**恰好 1 张带 alpha 的 PNG 输入** + `background:"transparent"` + `output_format:"png"`。
- 错误链（按顺序报不同错）：`exactly one input image` → `requires a PNG input` → `requires a PNG input with at least one transparent pixel`。
- 实测输出：PNG RGBA，86.4% 像素 alpha=0、四角 alpha=0（真透明），2368×1776 / 3.72MB / 20.9s（Flash 编辑路径）。Pro 同样支持但 74s。
- 文生图路径传 `background:"transparent"` 会 400，所以脚本在 `--transparent` 时强制要求 `--image`。
- 判定透明不能只看「RGBA 容器」：要看 `colorType==4/6` 或 `tRNS` chunk，必要时用 Pillow 统计透明像素比例。

## 多图（--count）

- 脚本统一串行循环调用；MiniMax 原生 `n` 1–9、DashScope `n` 1–6 都可用，但为统一落盘/命名仍走循环，成本按张累加。
- Ark（Seedream Flash/Pro）**忽略 `n`**，且 `sequential_image_generation` 传任何值都 400，只能循环。

## 超时建议

| 场景 | 建议超时 |
|---|---|
| 文生图（MiniMax / DashScope / 智谱） | 120s |
| Seedream Flash 文生图/编辑 | 120s |
| Seedream Pro / 透明背景 | 180s（实测 74–75s） |
| Qwen-Image 编辑 | 300s（实测 90–250s） |

---

# v3 全模型可调用性矩阵（2026-11-05，27 次真实调用）

结论：**22/25 组合可用**，不可用的 3 条全部是「额度/能力不支持」，**没有鉴权失败或模型不存在**。

## 文生图（11 个模型可用）

| provider | model | 结果 | 耗时 | 产物 |
|---|---|---|---|---|
| minimax | image-01 | ✅ | 20.1s | 1024² jpeg |
| dashscope | wan2.2-t2i-flash | ✅ 异步 | 10.8s | 1024² png |
| dashscope | wanx2.1-t2i-turbo | ✅ 异步 | 13.6s | 1024² png |
| dashscope | qwen-image-3.0 | ✅ multimodal | 58.7s | 2048² png |
| dashscope | qwen-image-3.0-pro | ✅ | 70.3s | 2048² png |
| dashscope | qwen-image-2.1-turbo | ✅ 最快 Qwen | 15.1s | 2736×1536 png |
| zhipu | cogview-3-flash | ✅ 带水印 | 8.1s | 1024² jpeg |
| ark | 5-0-flash-260915 | ✅ | 8.4s | 1024² jpeg |
| ark | 5-0-pro-260628 | ✅ | 17.5s | 1152×864 jpeg |
| ark | 4-0-250828 | ✅ | 4.0s | 1152×864 jpeg |
| ark | 4-0-20260415 | ✅ | 5.7s | 1024² jpeg |
| ark | 4-5-251128 | ✅ 仅 2K | 0.4s→重试 6.8s | 2048² jpeg |

不可用：`zhipu/cogview-4`、`zhipu/glm-image` → 429 `{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}`
（同 key 的 cogview-3-flash 正常 → 是付费额度问题，不是鉴权）。`ark/4-5` 传 `size:"1K"` → 400 `InvalidParameter: size not supported for model doubao-seedream-4-5`。

## 编辑（8 个模型可用）

| provider | model | 耗时 |
|---|---|---|
| ark | 5-0-flash-260915 | 8.1s |
| ark | 5-0-pro-260628 | 56.6s |
| ark | 4-0-250828 | 5.0s |
| ark | 4-5-251128（2K） | 14.0s |
| dashscope | qwen-image-3.0 | 47.4s |
| dashscope | qwen-image-3.0-pro | **103.3s（最慢）** |
| dashscope | qwen-image-2.1-pro | 33.2s |
| dashscope | qwen-image-2.1-turbo | 14.2s |

## 透明背景（2 个模型可用）

| provider | model | 耗时 | alpha 校验 |
|---|---|---|---|
| ark | 5-0-flash-260915 | 9.1s | RGBA，68.9% 像素 alpha=0，四角全透明，3.02MB |
| ark | 5-0-pro-260628 | 68.4s | RGBA，72.6% 像素 alpha=0，四角全透明，4.23MB |
| ark | 4-5-251128 | ❌ | `InvalidParameter: The parameter 'output_format' is not supported by the current model` |

## 自检命令

```powershell
node "<skill>/scripts/gen-image.mjs" --verify fast   # 每 provider 一条核心路径（7 次）
node "<skill>/scripts/gen-image.mjs" --verify all    # 上面 22 条完整矩阵
node "<skill>/scripts/gen-image.mjs" --verify all --dry-run  # 只看矩阵不调用
```

`verify` 输出 `{ ok, total, passed, failed, results[] }`，每条含 provider/model/mode/HTTP 结果/耗时/产物路径/错误原文。

本机 2026-11-05 15:47–15:57 跑 `--verify all`：**22/22 通过，642s**（Slowest: ark pro transparent 91.6s、qwen-3.0-pro edit 80.3s、ark pro edit 71.2s；4-5 的 t2i/edit 均自动走 2K 通过）。


