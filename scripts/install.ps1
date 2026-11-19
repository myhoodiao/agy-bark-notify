<#
.SYNOPSIS
    安装并配置 AGY Bark 任务完成通知钩子（Windows）。

.DESCRIPTION
    1. 检查 Node.js 版本（需要 >= 22.5，以支持内置 node:sqlite）。
    2. 将 src/notify.cjs 部署到 ~/.gemini/config/bark-completion/。
    3. 合并写入 ~/.gemini/config/hooks.json 的 bark-completion Stop 钩子（保留已有其他钩子）。
    4. 在本地终端交互式输入设备名（默认 Dev）和 Bark 配对令牌（不回显），写入本地 config.json。
    5. 自动检查配置并可选发送一条测试通知。
#>

[CmdletBinding()]
param(
    [string]$ConfigRoot = (Join-Path $HOME ".gemini\config")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function ConvertFrom-SecureStringPlain {
    param(
        [Parameter(Mandatory = $true)][System.Security.SecureString]$SecureValue
    )
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Extract-BarkDeviceKey {
    param(
        [Parameter(Mandatory = $true)][string]$RawInput
    )
    $trimmed = $RawInput.Trim()
    if (-not $trimmed) {
        return ""
    }

    if ($trimmed -match '^https?://') {
        try {
            $uri = [System.Uri]$trimmed
            $segments = @($uri.AbsolutePath.Split('/') | Where-Object { $_ -ne '' })
            if ($segments.Count -ge 1) {
                return $segments[0].Trim()
            }
        }
        catch {
            return ""
        }
    }

    return $trimmed.Trim('/')
}

function Assert-NodeVersion {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        throw "未检测到 Node.js。请先安装 Node.js >= 22.5（推荐 Node 24 LTS）：https://nodejs.org/"
    }

    $versionText = (& node -v).Trim()
    if ($versionText -notmatch '^v(\d+)\.(\d+)\.(\d+)') {
        throw "无法识别当前 Node.js 版本：$versionText"
    }

    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
        throw "当前 Node.js 版本为 $versionText，低于最低要求 v22.5.0（需要内置 node:sqlite）。请升级后重试。"
    }

    Write-Host "[OK] 检测到 Node.js $versionText" -ForegroundColor Green
}

Write-Host "=== AGY Bark 通知安装向导 ===" -ForegroundColor Cyan

# 1. 检查 Node.js 环境
Assert-NodeVersion

# 2. 定位并部署 notify.cjs
$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceScript = Join-Path $repoRoot "src\notify.cjs"
if (-not (Test-Path -LiteralPath $sourceScript)) {
    throw "未找到源脚本：$sourceScript"
}

$targetDir = Join-Path $ConfigRoot "bark-completion"
$targetScript = Join-Path $targetDir "notify.cjs"
$targetConfig = Join-Path $targetDir "config.json"
$hooksJsonPath = Join-Path $ConfigRoot "hooks.json"

New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
Copy-Item -LiteralPath $sourceScript -Destination $targetScript -Force
Write-Host "[OK] 已部署通知脚本：$targetScript" -ForegroundColor Green

# 3. 合并写入 hooks.json（保留已有其他 hooks）
$hooksObj = [ordered]@{}
if (Test-Path -LiteralPath $hooksJsonPath) {
    $existingRaw = [System.IO.File]::ReadAllText($hooksJsonPath, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
    if ($existingRaw.Trim().Length -gt 0) {
        $parsed = $existingRaw | ConvertFrom-Json
        if ($parsed -is [PSCustomObject]) {
            foreach ($prop in $parsed.PSObject.Properties) {
                $hooksObj[$prop.Name] = $prop.Value
            }
        }
    }
}

$hookCommand = if ($targetScript -match '\s') {
    "node --no-warnings `"$targetScript`""
}
else {
    "node --no-warnings $targetScript"
}
$hooksObj["bark-completion"] = [ordered]@{
    enabled = $true
    Stop    = @(
        [ordered]@{
            type    = "command"
            command = $hookCommand
            timeout = 10
        }
    )
}

$hooksContent = ($hooksObj | ConvertTo-Json -Depth 10) + "`n"
Write-Utf8NoBom -Path $hooksJsonPath -Content $hooksContent
Write-Host "[OK] 已更新 AGY 钩子配置：$hooksJsonPath" -ForegroundColor Green

# 4. 交互式录入设备名与 Bark 配对令牌（仅保存本机，不经过聊天框）
$defaultDeviceName = "Dev"
if (Test-Path -LiteralPath $targetConfig) {
    try {
        $oldCfg = ([System.IO.File]::ReadAllText($targetConfig, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)) | ConvertFrom-Json
        if ($oldCfg.deviceName -and $oldCfg.deviceName.Trim().Length -gt 0) {
            $defaultDeviceName = $oldCfg.deviceName.Trim()
        }
    }
    catch {
        # 忽略损坏旧配置，下面会重新覆盖写入
    }
}

$inputDeviceName = Read-Host "请输入本机显示名称（将显示在通知标题中，直接回车默认：$defaultDeviceName）"
$deviceName = if ($inputDeviceName -and $inputDeviceName.Trim().Length -gt 0) {
    $inputDeviceName.Trim()
}
else {
    $defaultDeviceName
}

$deviceKey = ""
while (-not $deviceKey) {
    $secureKey = Read-Host "请输入 Bark 配对令牌 Device Key（输入时隐藏显示，也支持直接粘贴官方推送链接）" -AsSecureString
    $plainInput = ConvertFrom-SecureStringPlain -SecureValue $secureKey
    $candidate = Extract-BarkDeviceKey -RawInput $plainInput

    if ($candidate -match '^[A-Za-z0-9_-]+$') {
        $deviceKey = $candidate
    }
    else {
        Write-Host "[警告] 令牌格式不正确（仅允许字母、数字、下划线和连字符），请重新输入。" -ForegroundColor Yellow
    }
}

$configPayload = [ordered]@{
    deviceName = $deviceName
    serverUrl  = "https://api.day.app"
    deviceKey  = $deviceKey
}
$configContent = ($configPayload | ConvertTo-Json -Depth 5) + "`n"
Write-Utf8NoBom -Path $targetConfig -Content $configContent
Write-Host "[OK] 已保存本机 Bark 配置：$targetConfig" -ForegroundColor Green

# 5. 状态核验与可选测试推送
$env:AGY_BARK_CONFIG_PATH = $targetConfig
try {
    & node --no-warnings $targetScript --status
    $sendTest = Read-Host "是否立即发送一条测试推送到手机？(Y/n，默认 Y)"
    if (-not $sendTest -or $sendTest.Trim().ToLowerInvariant() -ne "n") {
        & node --no-warnings $targetScript --test
    }
}
finally {
    Remove-Item Env:AGY_BARK_CONFIG_PATH -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "安装完成！下次使用 agy 运行结束时将自动发送 Bark 通知。" -ForegroundColor Cyan
