# dsh-image-gen-skill

用 **DSH 本机已存的 API 凭证**给 DeepSeek Harness（`dsh`）的文/图模型加上生图与改图能力：
文生图、图生图/编辑、透明背景、批量出图 —— 一个纯 Node 脚本 + 一份 `SKILL.md`，**零第三方依赖**。

<p>
  <img src="docs/preview-text2image.jpg" width="46%" alt="text-to-image 示例">
  <img src="docs/preview-edit-background.jpg" width="46%" alt="编辑：换背景示例">
</p>

## 它是什么

DSH 的 skill 只是一份磁盘上的说明 + 资源文件（`<DSH_HOME>/skills/<name>/SKILL.md`）。
本仓库就是这样一个 skill 包：模型读到 `SKILL.md` 后，会用 `pwsh`/`bash` 调用 `scripts/gen-image.mjs` 出图。

脚本从 `~/.dsh/.credentials.yaml` 的 `refs:` 段读取各家 API key（也支持同名环境变量覆盖），
**不需要你把 key 写进任何配置文件或命令**。没配置的 provider 会被自动跳过。

## 支持的 provider（均本机实测）

| provider | 文生图 | 改图/编辑 | 透明背景 | 速度 | 参考成本 | 水印 |
|---|---|---|---|---|---|---|
| 火山方舟 `ark`（Seedream 5.0 Flash / Pro） | ✅ | ✅ | ✅ 仅 Pro | 10s / 28–75s | Flash ≈0.12 元/张 | 无 |
| 阿里通义 `dashscope`（万相 / Qwen-Image） | ✅ | ✅ Qwen-Image | ❌ | 7s / 90–250s | 按张 | 无 |
| MiniMax `minimax`（image-01） | ✅ | ❌ | ❌ | ~15s | 套餐内 | 无 |
| 智谱 `zhipu`（CogView-3-Flash） | ✅ | ❌ | ❌ | ~10s | 免费 | **有「AI生成」** |

按能力自动降级：文生图 `MiniMax → 万相 → 智谱 → Seedream`；改图 `Seedream → Qwen-Image`；
`--quality high` 用 Seedream Flash（2K 画质最好），`--quality best` 用 Seedream Pro。

## 安装

```powershell
# 方式一：一键安装（Windows）
pwsh -File .\install.ps1

# 方式二：手动把本仓库放到 DSH 用户技能目录
#   Windows: %USERPROFILE%\.dsh\skills\image-gen\
#   macOS/Linux: ~/.dsh/skills/image-gen/
# 目录里要有 SKILL.md、scripts/、references/
```

装完**不需要重启**：skill 目录被 watch，新会话即可用 `/image-gen`，模型侧也会自动发现。
项目级安装则放到 `<project>/.dsh/skills/image-gen/` 或 `<project>/.agents/skills/image-gen/`。

## 用法

```powershell
# <skill> = skill 加载结果里的 "Base directory"
node "<skill>/scripts/gen-image.mjs" --prompt "一只在雨夜窗边的橘猫，胶片质感" --aspect 16:9

# 图生图 / 编辑（--image 可重复，最多 4 张）
node "<skill>/scripts/gen-image.mjs" --prompt "把背景换成雪天，主体不变" --image .\cat.jpg

# 透明背景（必须给一张带 alpha 的 PNG 参考图）
node "<skill>/scripts/gen-image.mjs" --prompt "保留主体，背景完全透明" --image .\cutout.png --transparent

# 批量 3 张 + 高质量档
node "<skill>/scripts/gen-image.mjs" --prompt "品牌吉祥物，矢量扁平风" --count 3 --quality high

# 看当前可用性（不出图、不花钱）
node "<skill>/scripts/gen-image.mjs" --list
```

### 主要参数

| 参数 | 说明 |
|---|---|
| `--prompt` / `--prompt-file` | 提示词；`--prompt-file -` 读 stdin |
| `--image` | 参考图/待编辑图，可重复；给了即进入编辑模式 |
| `--aspect` | `1:1` `4:3` `3:4` `16:9` `9:16` `3:2` `2:3` `21:9` |
| `--size WxH` | 显式尺寸，覆盖比例 |
| `--transparent` | 透明背景（ark 编辑路径，输出 PNG 并本地校验 alpha） |
| `--count 1..4` | 串行生成多张 |
| `--quality auto\|high\|best` | provider 顺序与画质档 |
| `--provider minimax\|dashscope\|zhipu\|ark` | 强制单一通道 |
| `--out` `--name` `--timeout` `--retries` | 输出目录 / 文件名前缀 / 超时 / 重试 |
| `--list` `--dry-run` | 可用性检查 / 只打印请求 |

### 输出契约

stdout 永远是一个 JSON：

```json
{
  "ok": true, "mode": "text-to-image", "provider": "ark",
  "model": "doubao-seedream-5-0-flash-260915",
  "path": "C:\\...\\image-gen-out\\一只在雨夜窗边的橘猫-20261105135912.jpg",
  "width": 2560, "height": 1440, "format": "jpeg", "hasAlpha": false,
  "transparent": false, "bytes": 759054, "ms": 18607, "watermark": false,
  "attempts": [{ "provider": "ark", "ok": true, "ms": 18607 }]
}
```

失败时 `ok:false` + `attempts[].kind`（`auth` / `quota` / `bad_request` / `moderation` / `network`），退出码 1。

## 凭证

脚本读取顺序：**环境变量 → `~/.dsh/.credentials.yaml` 的 `refs:`**。对应 ref 名：

| provider | ref / 环境变量 |
|---|---|
| MiniMax | `MINIMAX1_API_KEY` |
| 阿里百炼 | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| 智谱 | `ZAI_CODING_CN_API_KEY` |
| 火山方舟 | `ARK_API_KEY` |

只放你实际拥有的 key；缺失的 provider 会被跳过。key 只用于请求头，脚本输出一律掩码（`sk-cp-…(125)`）。

## 已知限制

- 只做「一次一张」的同步生成；长任务（视频、组图）不在范围内。
- 透明背景依赖 Seedream，必须先有带 alpha 的 PNG 输入；文生图直出透明不支持。
- Qwen-Image 编辑较慢（90–250s），默认给 300s 超时。
- 参考图上限：Seedream 10 张、Qwen 3.0 系 1–3 张；本脚本统一限制 4 张以控制成本。
- 各家参数差异大，`--size` 超出上限时脚本会回退到该 provider 的默认尺寸并在 `note` 里说明。

## License

MIT。API 事实与踩坑记录来自本机实测；结构上参考了社区同类项目
（[dingchenhui0618-arch/dsh-imagegen-skill](https://github.com/dingchenhui0618-arch/dsh-imagegen-skill)、
[PerryLink/dsh-draw](https://github.com/PerryLink/dsh-draw)、
[randomix777/dsh-image-gen](https://github.com/randomix777/dsh-image-gen)），代码为独立实现。
