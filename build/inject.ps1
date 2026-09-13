<#
  inject.ps1 — 把 android-overlay 的原生代码注入 Capacitor 生成的 android 工程
  ==============================================================================
  前置（在 Capacitor 工程根目录 = 本文件所在目录执行）：
      npm ci
      npx cap add android
      npx cap sync android
  然后：
      pwsh -NoProfile -File ./inject.ps1
      （Windows 本地亦可 powershell -ExecutionPolicy Bypass -File .\inject.ps1）

  本脚本完成 6 件事（全部幂等，可重复执行）：
    1) 复制 android-overlay 的 4 个 .java 到 app/src/main/java/<appId 点转斜杠>/：
         SignalServer.java / LanAddress.java / ServerService.java -> signal/ 子包
         MainActivity.java -> 覆盖 Capacitor 模板生成的同名文件（模板 launcher 声明不动）
    2) 把源码中的包名占位符 __APP_PKG__ 替换为 appId（同时替换 manifest 片段里的 __APP_ID__）
    3) 生成 app/src/main/res/xml/network_security_config.xml（AndroidManifest 里引用了它，
       缺失会直接编译失败；局域网是纯 HTTP/WS，Android 9+ 必须显式放行明文）
    4) 合并 manifest-fragment.xml 进 android/app/src/main/AndroidManifest.xml：
         ① 7 条 <uses-permission> 插到 <application> 之前（已存在的自动跳过）
         ② <application> 追加 usesCleartextTraffic / networkSecurityConfig / hardwareAccelerated
         ③ <service android:name=".signal.ServerService" ...>（含 <property>）插进 <application> 内
         ④ 不注入 <activity>（片段里已整体注释，避免与模板同名声明冲突导致 aapt2 报错）
    5) 对齐静态资源根目录：cap sync 把 webDir 拷到 assets/public，而内置服务读的是 assets/www
       （SignalServer.ASSETS_ROOT = "www"）-> 把 assets/public 重命名为 assets/www
    6) 向 android/app/build.gradle 追加（带 BEGIN/END 标记，命中标记即跳过）：
         - NanoHTTPD / NanoWSD 2.3.1 依赖
         - Java 17 compileOptions（模板缺失时才补）
         - packagingOptions 排除 NanoHTTPD 自带 META-INF 资源，避免打包冲突
         - 单 ABI 瘦身：abiFilters 'arm64-v8a'

  本脚本不做任何编译动作，也不改动 android-overlay / www 里的源文件。

  参数：
    -AndroidDir      android 工程目录，默认 <脚本目录>\android
    -OverlayDir      overlay 目录，默认 <脚本目录>\..\android-overlay
    -ConfigPath      capacitor.config.json 路径，默认 <脚本目录>\capacitor.config.json
    -AppId           显式指定 appId；默认从 capacitor.config.json 读取
    -KeepPublicCopy  额外保留一份 assets/public 副本（给 Capacitor 内置本地服务器兜底），默认不保留
#>
[CmdletBinding()]
param(
    [string] $AndroidDir = '',
    [string] $OverlayDir = '',
    [string] $ConfigPath = '',
    [string] $AppId = '',
    [switch] $KeepPublicCopy
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

# ================================================================== 基础
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-TextUtf8([string] $path) {
    if (-not (Test-Path -LiteralPath $path)) { throw "文件不存在: $path" }
    return [System.IO.File]::ReadAllText($path, $Utf8NoBom)
}

function Write-TextUtf8([string] $path, [string] $text) {
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom)
}

function Write-Step([string] $msg) { Write-Host ("[inject] " + $msg) }
function Get-Utf8Bytes([string] $text) { return $Utf8NoBom.GetByteCount($text) }

if (-not $PSScriptRoot) { throw "无法确定脚本目录（请使用 -File 方式运行本脚本）" }
$ScriptRoot = $PSScriptRoot
if (-not $AndroidDir) { $AndroidDir = [System.IO.Path]::Combine($ScriptRoot, 'android') }
if (-not $OverlayDir) { $OverlayDir = [System.IO.Path]::Combine((Split-Path -Parent $ScriptRoot), 'android-overlay') }
if (-not $ConfigPath) { $ConfigPath = [System.IO.Path]::Combine($ScriptRoot, 'capacitor.config.json') }

# ================================================================== 0) 前置校验 + appId
if (-not (Test-Path -LiteralPath $OverlayDir)) { throw "未找到 overlay 目录: $OverlayDir" }
if (-not (Test-Path -LiteralPath ([System.IO.Path]::Combine($AndroidDir, 'app')))) {
    throw "未找到 Capacitor 安卓工程: $AndroidDir（请先执行 npx cap add android / npx cap sync android）"
}

if (-not $AppId) {
    if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "未找到 capacitor.config.json: $ConfigPath（可用 -AppId 显式指定）" }
    $cfgText = Read-TextUtf8 $ConfigPath
    $cfgMatch = [regex]::Match($cfgText, '"appId"\s*:\s*"([^"]+)"')
    if (-not $cfgMatch.Success) { throw "capacitor.config.json 中未解析到 appId: $ConfigPath" }
    $AppId = $cfgMatch.Groups[1].Value
}
if ($AppId -notmatch '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$') { throw "appId 不是合法的 Java 包名: $AppId" }

$pkgPath  = ($AppId -replace '\.', [string][System.IO.Path]::DirectorySeparatorChar)
$javaRoot = [System.IO.Path]::Combine($AndroidDir, 'app', 'src', 'main', 'java')
$mainRoot = [System.IO.Path]::Combine($AndroidDir, 'app', 'src', 'main')

Write-Step ("appId      = " + $AppId)
Write-Step ("androidDir = " + $AndroidDir)

# ================================================================== 1)+2) 复制 Java 并替换包名
$javaTargets = @(
    @{ File = 'SignalServer.java';  Sub = 'signal' },
    @{ File = 'LanAddress.java';    Sub = 'signal' },
    @{ File = 'ServerService.java'; Sub = 'signal' },
    @{ File = 'MainActivity.java';  Sub = '' }
)

$javaReport = @()
foreach ($t in $javaTargets) {
    $src = [System.IO.Path]::Combine($OverlayDir, $t.File)
    if (-not (Test-Path -LiteralPath $src)) { throw ("overlay 缺少源文件: " + $src) }

    $text = Read-TextUtf8 $src
    if ($text.IndexOf('__APP_PKG__') -lt 0) {
        throw ($t.File + " 中未找到占位符 __APP_PKG__，拒绝继续（避免注入错误包名导致编译失败）")
    }
    $text = $text.Replace('__APP_PKG__', $AppId)

    $destDir = $javaRoot
    if ($t.Sub) { $destDir = [System.IO.Path]::Combine($destDir, $pkgPath, $t.Sub) } else { $destDir = [System.IO.Path]::Combine($destDir, $pkgPath) }
    $dest = [System.IO.Path]::Combine($destDir, $t.File)

    $overwrote = Test-Path -LiteralPath $dest
    Write-TextUtf8 $dest $text
    $javaReport += [pscustomobject]@{ File = $t.File; Dest = $dest; Bytes = (Get-Utf8Bytes $text); Overwrite = $overwrote }
    Write-Step ("java  -> " + $dest + "  (" + (Get-Utf8Bytes $text) + " B" + $(if ($overwrote) { ", 覆盖模板同名文件" } else { "" }) + ")")
}

# ================================================================== 3) network_security_config.xml
$nscPath = [System.IO.Path]::Combine($mainRoot, 'res', 'xml', 'network_security_config.xml')
$nscXml = @'
<?xml version="1.0" encoding="utf-8"?>
<!-- 由 android-overlay/inject.ps1 生成：局域网内全部流量为明文 HTTP / WebSocket，需显式放行 -->
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
'@
Write-TextUtf8 $nscPath ($nscXml + "`n")
Write-Step ("res  -> " + $nscPath)

# ================================================================== 4) 合并 AndroidManifest.xml
$manifestPath = [System.IO.Path]::Combine($mainRoot, 'AndroidManifest.xml')
$manifest = Read-TextUtf8 $manifestPath
$fragment = Read-TextUtf8 ([System.IO.Path]::Combine($OverlayDir, 'manifest-fragment.xml'))
$fragment = $fragment.Replace('__APP_PKG__', $AppId).Replace('__APP_ID__', $AppId)

$manifestNotes = @()

# 4.1 权限
$permNames = @()
foreach ($pm in [regex]::Matches($fragment, '<uses-permission\s+android:name="([^"]+)"')) {
    $permNames += $pm.Groups[1].Value
}
if ($permNames.Count -eq 0) { throw "manifest-fragment.xml 中未解析到任何 <uses-permission>" }

$missingPerms = @()
foreach ($p in $permNames) {
    if ($manifest.IndexOf('android:name="' + $p + '"') -lt 0) { $missingPerms += $p }
}
if ($missingPerms.Count -gt 0) {
    $permBlock = (($missingPerms | ForEach-Object { '    <uses-permission android:name="' + $_ + '" />' }) -join "`n")
    $appOpenRe = [regex]'(?<nl>\r?\n)(?<ind>[ \t]*)<application\b'
    $appOpen = $appOpenRe.Match($manifest)
    if (-not $appOpen.Success) { throw "AndroidManifest.xml 中未找到 <application> 节点: $manifestPath" }
    $replacement = $appOpen.Groups['nl'].Value + $permBlock + $appOpen.Groups['nl'].Value + $appOpen.Groups['ind'].Value + '<application'
    $manifest = $manifest.Substring(0, $appOpen.Index) + $replacement + $manifest.Substring($appOpen.Index + $appOpen.Length)
    $manifestNotes += ("插入 " + $missingPerms.Count + " 条 uses-permission: " + ($missingPerms -join ', '))
} else {
    $manifestNotes += ("权限已齐全（" + $permNames.Count + " 条），跳过")
}

# 4.2 <application> 属性
$appTagMatch = [regex]::Match($manifest, '<application\b[^>]*>')
if (-not $appTagMatch.Success) { throw "AndroidManifest.xml 中未找到 <application ...> 开始标签: $manifestPath" }
$appTag = $appTagMatch.Value
$wantedAttrs = @(
    @{ Probe = 'usesCleartextTraffic';  Line = '        android:usesCleartextTraffic="true"' },
    @{ Probe = 'networkSecurityConfig'; Line = '        android:networkSecurityConfig="@xml/network_security_config"' },
    @{ Probe = 'hardwareAccelerated';   Line = '        android:hardwareAccelerated="true"' }
)
$attrLines = @()
foreach ($a in $wantedAttrs) { if ($appTag.IndexOf($a.Probe) -lt 0) { $attrLines += $a.Line } }
if ($attrLines.Count -gt 0) {
    $newAppTag = $appTag.Substring(0, $appTag.Length - 1).TrimEnd() + "`n" + ($attrLines -join "`n") + '>'
    $manifest = $manifest.Substring(0, $appTagMatch.Index) + $newAppTag + $manifest.Substring($appTagMatch.Index + $appTagMatch.Length)
    $manifestNotes += ("补充 application 属性 " + $attrLines.Count + " 个")
} else {
    $manifestNotes += "application 属性已齐全，跳过"
}

# 4.3 ServerService 节点
$svcMatch = [regex]::Match($fragment, '(?s)<service\b.*?</service>')
if (-not $svcMatch.Success) { throw "manifest-fragment.xml 中未解析到 <service> 节点" }
if ($manifest.IndexOf('.signal.ServerService') -ge 0) {
    $manifestNotes += "ServerService 节点已存在，跳过"
} else {
    $svcLines = @()
    foreach ($ln in ($svcMatch.Value -replace "`r`n", "`n").Split("`n")) { if ($ln.Trim() -ne '') { $svcLines += $ln } }
    $minIndent = 9999
    foreach ($ln in $svcLines) {
        $lead = ($ln.Length - $ln.TrimStart().Length)
        if ($lead -lt $minIndent) { $minIndent = $lead }
    }
    if ($minIndent -eq 9999) { $minIndent = 0 }
    $svcIndented = (($svcLines | ForEach-Object { '        ' + $_.Substring($minIndent).TrimEnd() }) -join "`n")
    $appCloseRe = [regex]'(?<nl>\r?\n)(?<ind>[ \t]*)</application>'
    $appClose = $appCloseRe.Match($manifest)
    if (-not $appClose.Success) { throw "AndroidManifest.xml 中未找到 </application>: $manifestPath" }
    $replacement = $appClose.Groups['nl'].Value + $svcIndented + $appClose.Groups['nl'].Value + $appClose.Groups['ind'].Value + '</application>'
    $manifest = $manifest.Substring(0, $appClose.Index) + $replacement + $manifest.Substring($appClose.Index + $appClose.Length)
    $manifestNotes += '插入 <service android:name=".signal.ServerService"> 节点'
}

Write-TextUtf8 $manifestPath $manifest
Write-Step ("man  -> " + $manifestPath)
foreach ($n in $manifestNotes) { Write-Step ("        · " + $n) }

# ================================================================== 5) assets/public -> assets/www
$assetsDir = [System.IO.Path]::Combine($mainRoot, 'assets')
$publicDir = [System.IO.Path]::Combine($assetsDir, 'public')
$wwwDir    = [System.IO.Path]::Combine($assetsDir, 'www')

if (Test-Path -LiteralPath $wwwDir) {
    Write-Step ("assets/www 已存在，跳过重命名（重跑场景；如需刷新内容请先删掉 assets/www 再跑一遍 cap sync + inject）")
} elseif (Test-Path -LiteralPath $publicDir) {
    Move-Item -LiteralPath $publicDir -Destination $wwwDir
    Write-Step "assets -> public 已重命名为 www（SignalServer.ASSETS_ROOT 读的就是它）"
} else {
    throw "未找到 assets/public 或 assets/www —— 请先执行 npx cap sync android（内置服务的静态根目录必须是 assets/www）"
}

if ($KeepPublicCopy -and (Test-Path -LiteralPath $wwwDir) -and -not (Test-Path -LiteralPath $publicDir)) {
    Copy-Item -LiteralPath $wwwDir -Destination $publicDir -Recurse
    Write-Step "assets -> 已额外保留 assets/public 副本（Capacitor 内置本地服务器兜底）"
}

# ================================================================== 6) app/build.gradle 注入
$gradlePath = [System.IO.Path]::Combine($AndroidDir, 'app', 'build.gradle')
$gradle = Read-TextUtf8 $gradlePath
$marker = 'android-overlay/inject.ps1'

$gradleAction = ''
if ($gradle.IndexOf($marker) -ge 0) {
    $gradleAction = '已注入过（命中标记），跳过'
} else {
    $depBlock = @'
// 内置信令服务依赖：NanoHTTPD + NanoWSD 2.3.1（纯 Java 实现，无原生库）
dependencies {
    implementation "org.nanohttpd:nanohttpd:2.3.1"
    implementation "org.nanohttpd:nanohttpd-websocket:2.3.1"
}
'@

    $androidBlocks = @()
    if ($gradle.IndexOf('JavaVersion.VERSION_17') -lt 0) {
        $androidBlocks += @'
android {
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
}
'@
    }
    $androidBlocks += @'
android {
    // 单 ABI 瘦身：只打包 arm64-v8a（当代安卓手机），剔除其余 ABI 的原生库
    defaultConfig {
        ndk {
            abiFilters 'arm64-v8a'
        }
    }
    packagingOptions {
        // NanoHTTPD 自带 META-INF 资源，避免打包冲突导致合并失败
        resources {
            excludes += ['META-INF/NOTICE', 'META-INF/LICENSE', 'META-INF/DEPENDENCIES']
        }
    }
}
'@

    $injectText = "`n// ==================== injected by android-overlay/inject.ps1 (BEGIN) ====================`n" +
                  $depBlock + "`n" +
                  ($androidBlocks -join "`n") +
                  "// ==================== injected by android-overlay/inject.ps1 (END) ====================`n"

    Write-TextUtf8 $gradlePath ($gradle.TrimEnd() + "`n" + $injectText)
    $gradleAction = "已追加依赖 / Java17 / packagingOptions / abiFilters(arm64-v8a)"
}
Write-Step ("grad -> " + $gradlePath + "  · " + $gradleAction)

# ================================================================== 汇总
Write-Host ""
Write-Host "==================== inject 完成 ===================="
Write-Host ("appId           : " + $AppId)
Write-Host ("Java 注入目标   : " + [System.IO.Path]::Combine($javaRoot, $pkgPath))
Write-Host ("Manifest        : " + $manifestPath)
Write-Host ("应用资源目录    : " + $wwwDir)
Write-Host ("Gradle          : " + $gradlePath)
Write-Host "下一步（仅云端/本地有编译环境时）：cd android && ./gradlew assembleDebug"
