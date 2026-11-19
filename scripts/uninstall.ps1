<#
.SYNOPSIS
    卸载 AGY Bark 任务完成通知钩子（Windows）。

.DESCRIPTION
    1. 仅从 ~/.gemini/config/hooks.json 中移除 bark-completion 节点，保留其他已有钩子。
    2. 可选删除 ~/.gemini/config/bark-completion/ 目录（包含本地 config.json）。
#>

[CmdletBinding()]
param(
    [string]$ConfigRoot = (Join-Path $HOME ".gemini\config"),
    [switch]$RemoveFiles
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

$hooksJsonPath = Join-Path $ConfigRoot "hooks.json"
$targetDir = Join-Path $ConfigRoot "bark-completion"

if (Test-Path -LiteralPath $hooksJsonPath) {
    $raw = [System.IO.File]::ReadAllText($hooksJsonPath, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
    if ($raw.Trim().Length -gt 0) {
        $parsed = $raw | ConvertFrom-Json
        $hooksObj = [ordered]@{}
        $removed = $false
        if ($parsed -is [PSCustomObject]) {
            foreach ($prop in $parsed.PSObject.Properties) {
                if ($prop.Name -eq "bark-completion") {
                    $removed = $true
                    continue
                }
                $hooksObj[$prop.Name] = $prop.Value
            }
        }
        if ($removed) {
            $hooksContent = ($hooksObj | ConvertTo-Json -Depth 10) + "`n"
            Write-Utf8NoBom -Path $hooksJsonPath -Content $hooksContent
            Write-Host "[OK] 已从 $hooksJsonPath 移除 bark-completion 钩子。" -ForegroundColor Green
        }
        else {
            Write-Host "[提示] $hooksJsonPath 中未找到 bark-completion 钩子。" -ForegroundColor Yellow
        }
    }
}
else {
    Write-Host "[提示] 未找到 $hooksJsonPath，无需修改钩子配置。" -ForegroundColor Yellow
}

if (Test-Path -LiteralPath $targetDir) {
    $shouldDelete = $RemoveFiles.IsPresent
    if (-not $shouldDelete) {
        $answer = Read-Host "是否同时删除本地脚本与配置文件目录 $targetDir ？(y/N，默认 N)"
        $shouldDelete = ($answer -and $answer.Trim().ToLowerInvariant() -eq "y")
    }
    if ($shouldDelete) {
        Remove-Item -LiteralPath $targetDir -Recurse -Force
        Write-Host "[OK] 已删除目录：$targetDir" -ForegroundColor Green
    }
    else {
        Write-Host "[保留] 已保留目录：$targetDir" -ForegroundColor Cyan
    }
}

Write-Host "卸载完成。" -ForegroundColor Cyan
