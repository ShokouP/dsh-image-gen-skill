---
name: image-gen
description: "用 DSH 本机已存的 API 凭证生图与改图：文生图、图生图/编辑（换背景、改风格、加/去元素）、透明背景、批量出图，落盘并返回本地路径（MiniMax image-01 / 阿里 Qwen-Image / 智谱 CogView / 火山 Seedream 5.0）。当用户要求「画一张/生成图片/出图/配图/做封面/插画/海报/头像/概念图」或「把这张图改成…/换背景/抠图/透明背景」时使用；不用于看图与图像分析（那是读图能力），也不用于图表、图标、SVG 等应当用代码绘制的图形。"
whenToUse: 需要新增一张本地图片文件（插图、封面、海报、头像、概念图、素材），或需要基于已有图片做编辑（换背景、改风格、改局部、抠成透明背景）且本机没有现成图片工具时。用户明确说画图、生图、出图、改图、p图、image generation/edit 时。
---

# image-gen —— 用本机已存凭证生图 / 改图（v2）

调用本 skill 目录下的 `scripts/gen-image.mjs`（纯 Node，无第三方依赖）。脚本自己从
`~/.dsh/.credentials.yaml` 的 refs 段取对应 API key，**不要在命令里贴 key**。

## 60 秒上手

```powershell
# <skill> = 本 skill 加载结果里 "Base directory" 给出的绝对路径

# 文生图
node "<skill>/scripts/gen-image.mjs" --prompt "一只在雨夜窗边的橘猫，胶片质感" --aspect 16:9

# 图生图 / 改图（--image 可重复，最多 4 张）
node "<skill>/scripts/gen-image.mjs" --prompt "把背景换成雪天，主体不变" --image .\cat.jpg

# 批量 3 张（串行，按张计费）
node "<skill>/scripts/gen-image.mjs" --prompt "品牌吉祥物" --count 3
```

输出是**一个 JSON**（stdout）：单张看 `path/width/height/bytes/ms/watermark`，多张看 `images[]` 与 `paths[]`。
成功后把 `path` 用 Markdown 图片或 `present` 交给用户，例如 `![生成的图](<path>)`。

提示词含双引号、换行、或命令转义麻烦时，先写进临时文件再用 `--prompt-file`：

```powershell
Set-Content -Path .\tmp\p.txt -Value "雨夜霓虹街道，赛博朋克，电影感" -Encoding utf8
node "<skill>/scripts/gen-image.mjs" --prompt-file .\tmp\p.txt --aspect 9:16 --out .\out\images
```

## 参数速查

| 参数 | 说明 |
|---|---|
| `--prompt <text>` / `--prompt-file <path>` | 提示词；`--prompt-file -` 从 stdin 读 |
| `--image <path>` | 参考图/待编辑图，**可重复**最多 4 张；给了即进入编辑模式 |
| `--aspect <a>` | `1:1`(默认) / `4:3` / `3:4` / `16:9` / `9:16` / `3:2` / `2:3` / `21:9` |
| `--size <WxH>` | 显式像素尺寸，覆盖比例（如 `2048x2048`） |
| `--count <n>` | 生成 1–4 张，串行；Seedream 不支持 n，由脚本循环调用 |
| `--transparent` | 透明背景：**必须配 `--image`**（Seedream Pro 编辑路径），输出 PNG 并本地校验 alpha |
| `--out <dir>` | 输出目录，默认 `<cwd>/image-gen-out` |
| `--quality <q>` | `auto`(默认) / `high` / `best`，决定 provider 顺序与画质档 |
| `--provider <id>` | 强制单一通道：`minimax` / `dashscope` / `zhipu` / `ark` |
| `--model <id>` | 覆盖模型（编辑默认 `qwen-image-3.0` / Seedream Flash） |
| `--list` | 列出 provider、能力、凭证可用性、Ark 可用模型；不出图、不花钱 |
| `--dry-run` | 只打印将要发的请求 |

## provider 能力

| provider | 文生图 | 改图/编辑 | 透明背景 | 速度 | 成本 | 水印 |
|---|---|---|---|---|---|---|
| `minimax` | ✅ | ❌ | ❌ | ~15s | 套餐内 | 无 |
| `dashscope` | ✅ | ✅ Qwen-Image | ❌ | ~7s / 90–250s | 按张 | 无 |
| `zhipu` | ✅ | ❌ | ❌ | ~10s | 免费 | **有「AI生成」** |
| `ark` (Seedream) | ✅ | ✅ Flash/Pro | ✅ 仅 Pro 编辑 | ~10s / ~28s | Flash ~0.12 元/张 | 无 |

- 文生图 `auto`：MiniMax → 万相 → 智谱 → Seedream Flash（失败自动切下一个）。
- 改图 `auto`：Seedream Flash → Qwen-Image（Qwen 编辑较慢，90–250s，脚本对编辑路径默认给到 300s 超时）。
- 编辑模型：Qwen 用 `qwen-image-3.0`（默认）或 `--model qwen-image-3.0-pro`；注意 `qwen-image-edit` 系列已下线，不要再用。
- `--quality high`：Seedream Flash 优先（2K，画质最好）；`best`：Seedream Pro 优先。
- 用户要求**无水印**时别落到 `zhipu`。
- 用户要求**透明背景**时：必须先给 `--image`（带 alpha 的 PNG 参考图），脚本走 Seedream 编辑 + `background:"transparent"` + `output_format:"png"`，并本地校验产物 alpha；实测 Flash 也能出真透明（约 20s），Pro 更慢（约 75s）。校验不通过时返回 `transparent:false`，不要口头承诺已透明。

## 改图要点（提高成功率）

1. 指令写「改什么 + 保留什么」：`把背景换成雪天，主体姿势和颜色不变`，比单说「换成雪天」稳。
2. 多图输入时在 prompt 里按顺序说明角色：`图1 是人物，图2 是背景，把人物放到图2 的场景里`。
3. 参考图 ≤4 张、单张 <10MB；太大先压缩。
4. 输出尺寸/比例可能被 provider 调整，以返回的 `width/height` 为准。

## 失败怎么办

- 先读 stdout JSON 的 `attempts`：`kind` 为 `auth`(key 无效)、`quota`(额度/限流，别立刻重试)、
  `bad_request`(参数/尺寸不合法)、`moderation`(提示词被审核拒绝)、`network`(网络/超时)。
- `moderation` 时改提示词（去掉血腥、真人姓名、敏感政治/色情描述）后重试一次，不要换 provider 硬撞。
- 全部失败时按 `attempts` 逐条看错误，换 `--provider` / `--aspect` / 退回 `--quality auto`。
- 图片 URL 是临时签名链接，脚本已立即下载落盘；**不要**把 URL 当作产物返回给用户。

## 硬性规则

1. 一次调用最多 4 张图；需要更多就分多次（串行，别并发刷额度）。
2. 绝不在命令、日志或回复里回显 API key；脚本只打印掩码。
3. 成功必须给出本地 `path`（或直接展示图片），不要只说「已生成」。
4. 透明背景只在提供参考图且走 Seedream Pro 编辑时可靠；纯文生图不要承诺透明输出。
5. 生成前若提示词含真实人名、品牌 logo、政治人物等，先改写为通用描述，避免审核失败。

详细 API 事实、尺寸上限、错误码与计费见 `references/providers.md`。
