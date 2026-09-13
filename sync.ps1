<#
  sync.ps1 — 把 p2p-battle 运行时前端同步到 p2p-battle-app\www
  ============================================================
  执行顺序：
    1) 运行时镜像同步：$Source（游戏本体工程）-> $Dest（www），并清理 www 中的残留文件
    2) 发布 landing   ：$AppRoot\landing -> $Dest\landing（APP 首页：二维码 + 进入游戏）
    3) 重打适配补丁（幂等，只改 www，不动游戏本体）：
         ① www/src/P2P2_net_transport.js  信令基址优先取 location.origin（同源环境）
         ② www/config/runtime.json SIGNAL_BASE 降级为兜底地址
         ③ www/index.html          「本地局域网」开关默认取消勾选
    4) 校验补丁结果并打印统计

  排除规则（不进入 www）：
    文件：server_local.py、README.md、config-editor.html / .css / .js
    目录：tools\、docs\、config\_backup\

  用法：
    powershell -ExecutionPolicy Bypass -File sync.ps1
    powershell -ExecutionPolicy Bypass -File sync.ps1 -NoMirror      # 只复制、不删除残留
    powershell -ExecutionPolicy Bypass -File sync.ps1 -DryRun        # 预演，不落盘
    powershell -ExecutionPolicy Bypass -File sync.ps1 -SkipPatch -SkipLanding
#>
[CmdletBinding()]
param(
  [string] $Source  = 'C:\Workspace\Marvis\p2p-battle',
  [string] $AppRoot = 'C:\Workspace\Marvis\p2p-battle-app',
  [string] $Dest    = '',
  [int]    $Port    = 8080,
  [switch] $NoMirror,
  [switch] $SkipPatch,
  [switch] $SkipLanding,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
if (-not $Dest) { $Dest = Join-Path $AppRoot 'www' }

# 游戏本体网络层文件名（游戏本体已改为 P2P2_ 前缀命名；后续本体再改名只需改这一处）
$NetJsRel = 'src\P2P2_net_transport.js'

# ================================================================== 排除规则
$ExcludeRelDirs  = @('tools', 'docs', 'config\_backup', '__pycache__', '.git', 'node_modules')
$ExcludeRelFiles = @('server_local.py', 'README.md', 'config-editor.html', 'config-editor.css', 'config-editor.js')
$PreserveRelDirs = @('landing')      # APP 自有目录，镜像清理时跳过
$PatchTargets    = @($NetJsRel, 'config\runtime.json', 'index.html')   # 需要重打适配补丁的文件

$UTF8NoBom = New-Object System.Text.UTF8Encoding($false)

# ================================================================== 基础函数
function Read-TextUtf8([string]$path) { [System.IO.File]::ReadAllText($path, $UTF8NoBom) }

function Write-TextUtf8([string]$path, [string]$text) {
  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($path, $text, $UTF8NoBom)
}

function Test-Excluded([string]$rel) {
  $norm = $rel -replace '/', '\'
  foreach ($d in $ExcludeRelDirs) {
    if ($norm.Equals($d, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($norm.StartsWith($d + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  $leaf = Split-Path -Leaf $norm
  foreach ($f in $ExcludeRelFiles) {
    if ($leaf.Equals($f, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  if ($leaf.StartsWith('.')) { return $true }      # 隐藏文件
  if ($leaf.EndsWith('~')) { return $true }        # 编辑器/Office 临时文件
  return $false
}

function Get-RelFileList([string]$root) {
  $out = @()
  if (-not (Test-Path -LiteralPath $root)) { return $out }
  $prefix = $root.TrimEnd('\') + '\'
  foreach ($fi in (Get-ChildItem -LiteralPath $root -Recurse -File -Force)) {
    $rel = $fi.FullName.Substring($prefix.Length)
    if (-not (Test-Excluded $rel)) {
      $out += [pscustomobject]@{ Rel = $rel; Full = $fi.FullName; Len = $fi.Length; Time = $fi.LastWriteTimeUtc }
    }
  }
  return $out
}

# ================================================================== 适配补丁
function Apply-PatchNetJs {
  $path = Join-Path $destFull $NetJsRel
  if (-not (Test-Path -LiteralPath $path)) { Write-Host ('[补丁1] 跳过：找不到 www\' + $NetJsRel) -ForegroundColor Red; return 0 }
  $txt  = Read-TextUtf8 $path
  $orig = $txt
  $notes = @()

  if ($txt -notmatch 'function\s+resolveSignalBase\s*\(') {
    $anchor = 'class Net {'
    $cnt = ([regex]::Matches($txt, [regex]::Escape($anchor))).Count
    if ($cnt -ne 1) {
      Write-Host ("[补丁1] 失败：锚点 'class Net {{{{}}}}' 匹配 {0} 次，未修改 {1}" -f $cnt, $NetJsRel) -ForegroundColor Red
      return 0
    }
    $helper = @'
// ===== 信令基址解析（APP 打包版适配，由 sync.ps1 注入）=====
// 优先级：① window.__SIGNAL_BASE__ / URL ?signal=  显式注入（APP 原生侧可传局域网地址）
//         ② location.origin                       同源环境：页面由内置服务托管时直接复用当前 origin
//         ③ GAME_CONFIG.SIGNAL_BASE               降级兜底（离线/自定义部署）
function resolveSignalBase() {
  try {
    if (typeof window !== 'undefined') {
      var inj = window.__SIGNAL_BASE__;
      if (!inj && window.location && window.location.search) {
        var m = /[?&]signal=([^&#]+)/.exec(window.location.search);
        if (m) inj = decodeURIComponent(m[1]);
      }
      if (inj && typeof inj === 'string') return inj.replace(/\/+$/, '');
    }
    var loc = (typeof location !== 'undefined') ? location : null;
    if (loc && /^https?:$/i.test(loc.protocol) && loc.host) {
      return loc.origin || (loc.protocol + '//' + loc.host);
    }
  } catch (e) { /* 忽略：降级到配置兜底 */ }
  return (typeof GAME_CONFIG !== 'undefined' && GAME_CONFIG && GAME_CONFIG.SIGNAL_BASE) || '';
}

'@
    $idx = $txt.IndexOf($anchor)
    $txt = $txt.Substring(0, $idx) + $helper + $txt.Substring($idx)
    $notes += '注入 resolveSignalBase()'
  } else {
    $notes += 'resolveSignalBase() 已存在'
  }

  $oldLine = 'this.signalBase = GAME_CONFIG.SIGNAL_BASE;'
  $newLine = 'this.signalBase = resolveSignalBase();'
  if ($txt.Contains($oldLine)) {
    $txt = $txt.Replace($oldLine, $newLine)
    $notes += '构造器改用 resolveSignalBase()'
  } elseif ($txt.Contains($newLine)) {
    $notes += '构造器已是 resolveSignalBase()'
  } else {
    Write-Host '[补丁1] 警告：未找到构造器锚点 this.signalBase = GAME_CONFIG.SIGNAL_BASE;' -ForegroundColor Red
  }

  # 同步更新构造器上方已过时的注释文案（原文写的是“默认取 config”）
  $cmtTouched = $false
  $cmtPairs = @(
    @('// 信令服务器基址：默认取 config（服务器/公网场景），',
      '// 信令服务器基址：优先取 location.origin（APP 内置服务同源托管），'),
    @('// 粘贴“对局令牌”加入时会被令牌内解析出的地址覆盖（局域网直连互通）。',
      '// 令牌 / URL 参数可显式覆盖（setSignalBase），配置值仅作离线兜底。')
  )
  foreach ($cp in $cmtPairs) {
    if ($txt.Contains($cp[0])) { $txt = $txt.Replace($cp[0], $cp[1]); $cmtTouched = $true }
  }
  if ($cmtTouched) { $notes += '更新基址注释文案' }

  if ($txt -ne $orig) {
    if (-not $DryRun) { Write-TextUtf8 $path $txt }
    Write-Host ('[补丁1] www\' + $NetJsRel + ' 已更新：' + ($notes -join '；')) -ForegroundColor Green
    return 1
  }
  Write-Host ('[补丁1] www\' + $NetJsRel + ' 无需变更：' + ($notes -join '；')) -ForegroundColor DarkGray
  return 0
}

function Apply-PatchRuntimeJson {
  $path = Join-Path $destFull 'config\runtime.json'
  if (-not (Test-Path -LiteralPath $path)) { Write-Host '[补丁2] 跳过：找不到 www\config\runtime.json' -ForegroundColor Red; return 0 }
  $txt = Read-TextUtf8 $path
  $fallback = 'http://127.0.0.1:' + $Port
  $pattern  = '("SIGNAL_BASE"\s*:\s*")[^"]*(")'
  if (-not [regex]::IsMatch($txt, $pattern)) {
    Write-Host '[补丁2] 警告：runtime.json 中未找到 SIGNAL_BASE 字段' -ForegroundColor Red
    return 0
  }
  $out = [regex]::Replace($txt, $pattern, ('${1}' + $fallback + '${2}'))
  if ($out -ne $txt) {
    if (-not $DryRun) { Write-TextUtf8 $path $out }
    Write-Host ('[补丁2] www\config\runtime.json 已更新：SIGNAL_BASE -> ' + $fallback + '（降级兜底）') -ForegroundColor Green
    return 1
  }
  Write-Host ('[补丁2] www\config\runtime.json 无需变更：SIGNAL_BASE 已是 ' + $fallback) -ForegroundColor DarkGray
  return 0
}

function Apply-PatchIndexHtml {
  $path = Join-Path $destFull 'index.html'
  if (-not (Test-Path -LiteralPath $path)) { Write-Host '[补丁3] 跳过：找不到 www\index.html' -ForegroundColor Red; return 0 }
  $txt  = Read-TextUtf8 $path
  $orig = $txt
  $notes = @()

  # (a) 取消「本地局域网」默认勾选
  $chkPat = '(<input\s+type="checkbox"\s+id="lanMode"[^>]*?)\s+checked(\s*>)'
  if ([regex]::IsMatch($txt, $chkPat)) {
    $txt = [regex]::Replace($txt, $chkPat, '$1$2')
    $notes += 'lanMode 默认取消勾选'
  } elseif ($txt -match 'id="lanMode"') {
    $notes += 'lanMode 已是未勾选'
  } else {
    Write-Host '[补丁3] 警告：未找到 lanMode 复选框' -ForegroundColor Red
  }

  # (b) 同步更新提示文案（原文案描述"默认勾选"，与新默认相反）
  $titlePat = '(<label class="check lan-check" title=")([^"]*)(")'
  $newTitle = '默认不勾选=创建/加入房间走令牌服务器在线房间（APP 内置信令服务）；勾选则改走本地局域网（0 服务器手动贴码星形直连）'
  $m = [regex]::Match($txt, $titlePat)
  if ($m.Success) {
    if ($m.Groups[2].Value -eq $newTitle) { $notes += '提示文案已是新版' }
    else {
      $txt = $txt.Substring(0, $m.Groups[2].Index) + $newTitle + $txt.Substring($m.Groups[2].Index + $m.Groups[2].Length)
      $notes += '提示文案已更新'
    }
  } else {
    Write-Host '[补丁3] 警告：未找到 lan-check 提示文案锚点' -ForegroundColor Red
  }

  if ($txt -ne $orig) {
    if (-not $DryRun) { Write-TextUtf8 $path $txt }
    Write-Host ('[补丁3] www\index.html 已更新：' + ($notes -join '；')) -ForegroundColor Green
    return 1
  }
  Write-Host ('[补丁3] www\index.html 无需变更：' + ($notes -join '；')) -ForegroundColor DarkGray
  return 0
}

# ================================================================== 前置校验
Write-Host ''
Write-Host '=== sync.ps1 : p2p-battle -> www 运行时同步 ===' -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath $Source)) { throw "源目录不存在：$Source" }
foreach ($must in @('index.html', $NetJsRel, 'config\runtime.json', 'lib\pixi.min.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $Source $must))) { throw "源目录缺少运行时文件：$must" }
}
$destFull = [System.IO.Path]::GetFullPath($Dest)
$appFull  = [System.IO.Path]::GetFullPath($AppRoot).TrimEnd('\')
if ([System.IO.Path]::GetFileName($destFull).ToLower() -ne 'www') {
  throw "目标目录必须名为 www（当前：$destFull），拒绝执行以避免误删。"
}
if (-not $destFull.StartsWith($appFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "目标目录必须位于 APP 工程内（$appFull），当前：$destFull"
}
Write-Host ("源目录  : {0}" -f $Source)
Write-Host ("目标目录: {0}" -f $destFull)
Write-Host ("排除文件: {0}" -f ($ExcludeRelFiles -join ', '))
Write-Host ("排除目录: {0}" -f (($ExcludeRelDirs | Where-Object { $_ -notin @('.git', 'node_modules') }) -join ', '))
if ($DryRun) { Write-Host '模式    : DryRun（只预演，不落盘）' -ForegroundColor Yellow }
if ($NoMirror) { Write-Host '模式    : NoMirror（不清理残留文件）' -ForegroundColor Yellow }

# ================================================================== 1) 运行时同步
$srcFiles = @(Get-RelFileList $Source)
$copied = 0; $unchanged = 0
foreach ($f in $srcFiles) {
  $target = Join-Path $destFull $f.Rel
  $need = $true
  if (Test-Path -LiteralPath $target) {
    $ti = Get-Item -LiteralPath $target
    if ($ti.Length -eq $f.Len -and $ti.LastWriteTimeUtc -eq $f.Time) { $need = $false }
  }
  if (-not $need) { $unchanged++; continue }
  if ($DryRun) { Write-Host ("  [copy] {0}" -f $f.Rel) -ForegroundColor DarkGray }
  else {
    $dir = Split-Path -Parent $target
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Copy-Item -LiteralPath $f.Full -Destination $target -Force
  }
  $copied++
}
$refreshCount = 0
foreach ($f in $srcFiles) { if ($PatchTargets -contains ($f.Rel -replace '/', '\')) { $refreshCount++ } }
Write-Host ("[1/4] 运行时同步：新增/更新 {0} 个（其中 {1} 个为适配基底文件，每次以游戏本体为基底重新下发后再重打补丁），未变化 {2} 个，源文件共 {3} 个" -f $copied, $refreshCount, $unchanged, $srcFiles.Count) -ForegroundColor Green

# ================================================================== 2) 发布 landing
$landingSrc   = Join-Path $appFull 'landing'
$landingFiles = @()
if (-not $SkipLanding) {
  if (-not (Test-Path -LiteralPath $landingSrc)) { throw "未找到 APP 首页源目录：$landingSrc" }
  $landingFiles = @(Get-RelFileList $landingSrc)
  $lc = 0
  foreach ($f in $landingFiles) {
    $target = Join-Path (Join-Path $destFull 'landing') $f.Rel
    $need = $true
    if (Test-Path -LiteralPath $target) {
      $ti = Get-Item -LiteralPath $target
      if ($ti.Length -eq $f.Len -and $ti.LastWriteTimeUtc -eq $f.Time) { $need = $false }
    }
    if (-not $need) { continue }
    if ($DryRun) { Write-Host ("  [landing] {0}" -f $f.Rel) -ForegroundColor DarkGray }
    else {
      $dir = Split-Path -Parent $target
      if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
      Copy-Item -LiteralPath $f.Full -Destination $target -Force
    }
    $lc++
  }
  Write-Host ("[2/4] 发布 landing：{0} 个文件 -> www\landing（本次更新 {1} 个）" -f $landingFiles.Count, $lc) -ForegroundColor Green
} else {
  Write-Host '[2/4] 发布 landing：已跳过（-SkipLanding）' -ForegroundColor DarkYellow
}

# ================================================================== 3) 镜像清理
$keep = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
foreach ($f in $srcFiles)     { [void]$keep.Add(($f.Rel -replace '/', '\')) }
foreach ($f in $landingFiles) { [void]$keep.Add('landing\' + ($f.Rel -replace '/', '\')) }
$removed = @()
if (-not $NoMirror -and (Test-Path -LiteralPath $destFull)) {
  $destPrefix = $destFull.TrimEnd('\') + '\'
  foreach ($fi in (Get-ChildItem -LiteralPath $destFull -Recurse -File -Force)) {
    $norm = ($fi.FullName.Substring($destPrefix.Length)) -replace '/', '\'
    $preserved = $false
    foreach ($p in $PreserveRelDirs) {
      if ($norm.StartsWith($p + '\', [System.StringComparison]::OrdinalIgnoreCase)) { $preserved = $true }
    }
    if ($preserved) { continue }
    if (-not $keep.Contains($norm)) {
      if ($DryRun) { Write-Host ("  [del ] {0}" -f $norm) -ForegroundColor DarkGray }
      else { Remove-Item -LiteralPath $fi.FullName -Force }
      $removed += $norm
    }
  }
  if (-not $DryRun) {
    foreach ($di in (Get-ChildItem -LiteralPath $destFull -Recurse -Directory -Force | Sort-Object { $_.FullName.Length } -Descending)) {
      if ($di.FullName -like (Join-Path $destFull 'landing*')) { continue }
      if (-not (Get-ChildItem -LiteralPath $di.FullName -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $di.FullName -Force }
    }
  }
  Write-Host ("[3/4] 镜像清理：移除 {0} 个残留文件" -f $removed.Count) -ForegroundColor Green
} else {
  Write-Host '[3/4] 镜像清理：已跳过（-NoMirror 或目标目录尚不存在）' -ForegroundColor DarkYellow
}

# ================================================================== 4) 适配补丁
$patchCount = 0
if (-not $SkipPatch) {
  $patchCount += Apply-PatchNetJs
  $patchCount += Apply-PatchRuntimeJson
  $patchCount += Apply-PatchIndexHtml
  Write-Host ("[4/4] 适配补丁：本次写入 {0} 个文件（补丁幂等，重复执行不会重复改写）" -f $patchCount) -ForegroundColor Green
} else {
  Write-Host '[4/4] 适配补丁：已跳过（-SkipPatch）' -ForegroundColor DarkYellow
}

# ================================================================== 结果校验 + 统计
if (-not $DryRun) {
  Write-Host ''
  Write-Host '--- 校验 ---' -ForegroundColor Cyan
  $net  = Read-TextUtf8 (Join-Path $destFull $NetJsRel)
  $json = Read-TextUtf8 (Join-Path $destFull 'config\runtime.json')
  $html = Read-TextUtf8 (Join-Path $destFull 'index.html')

  $ck1 = ($net -match 'function\s+resolveSignalBase\s*\(') -and ($net -match 'this\.signalBase = resolveSignalBase\(\);')
  $ck2 = ($json -match ('"SIGNAL_BASE"\s*:\s*"http://127\.0\.0\.1:' + $Port + '"'))
  $ck3 = ($html -notmatch 'id="lanMode"\s+checked') -and ($html -match 'id="lanMode"')

  Write-Host ("  [1] net_transport.js 信令基址优先 location.origin : {0}" -f $(if ($ck1) { 'OK' } else { '未通过' })) -ForegroundColor $(if ($ck1) { 'Green' } else { 'Red' })
  Write-Host ("  [2] runtime.json SIGNAL_BASE 降级兜底    : {0}" -f $(if ($ck2) { 'OK' } else { '未通过' })) -ForegroundColor $(if ($ck2) { 'Green' } else { 'Red' })
  Write-Host ("  [3] index.html lanMode 默认未勾选        : {0}" -f $(if ($ck3) { 'OK' } else { '未通过' })) -ForegroundColor $(if ($ck3) { 'Green' } else { 'Red' })

  $destFiles = @(Get-ChildItem -LiteralPath $destFull -Recurse -File -Force)
  $sizeMB = [math]::Round((($destFiles | Measure-Object -Property Length -Sum).Sum / 1MB), 2)
  Write-Host ("  www 文件总数 {0} 个，合计 {1} MB" -f $destFiles.Count, $sizeMB) -ForegroundColor Gray

  $forbidden = @('server_local.py', 'config-editor.html', 'config-editor.css', 'config-editor.js', 'README.md')
  $leak = @()
  foreach ($fi in $destFiles) {
    $norm = $fi.FullName.Substring($destFull.TrimEnd('\').Length + 1)
    if ($forbidden -contains $fi.Name) { $leak += $norm }
    if ($norm -like 'tools\*' -or $norm -like 'docs\*' -or $norm -like 'config\_backup\*') { $leak += $norm }
  }
  if ($leak.Count -gt 0) { Write-Host ("  排除规则校验：发现不应存在的文件 -> " + ($leak -join ', ')) -ForegroundColor Red }
  else { Write-Host '  排除规则校验：未发现被排除文件' -ForegroundColor Green }
}
Write-Host ''
