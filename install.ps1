# 把 image-gen skill 安装到 DSH 用户技能目录
# 目标：$env:DSH_HOME\skills\image-gen\SKILL.md（skill-filesystem 的 user-dsh 根，rank 400）
# 装完无需重启：目录被 watch，新会话/下一次 catalog 刷新即可用 /image-gen 或在模型侧被加载。

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$dest = Join-Path $dshHome 'skills\image-gen'

if (-not (Test-Path (Join-Path $src 'SKILL.md'))) { throw "在 $src 下找不到 SKILL.md，脚本要放在 skill 包根目录" }

New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Path (Join-Path $src 'SKILL.md') -Destination $dest -Force
foreach ($sub in 'scripts', 'references') {
  $from = Join-Path $src $sub
  if (Test-Path $from) {
    Copy-Item -Path $from -Destination $dest -Recurse -Force
  }
}
Write-Host "已安装到: $dest"
Write-Host "校验: $(Test-Path (Join-Path $dest 'SKILL.md')) ; 脚本: $(Test-Path (Join-Path $dest 'scripts\gen-image.mjs'))"
