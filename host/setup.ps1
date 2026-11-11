param(
    [string]$ExtensionId = 'npoilipflmekpheijopnkkodofinhaci',
    [string]$RootPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'test-files'),
    [string]$HostName = 'cn.campus_ai.readonly',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
if ($ExtensionId -notmatch '^[a-p]{32}$') { throw '扩展 ID 格式不正确。' }
if ($HostName -notmatch '^[a-z0-9_]+(\.[a-z0-9_]+)*$') { throw '本机连接名称格式不正确。' }
$node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { throw '没有找到 Node.js。请先从 https://nodejs.org/ 安装 Node.js，然后重新运行安装。' }
$version = & $node.Source -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^(\d+)\.' -or [int]$Matches[1] -lt 18) {
    throw '需要 Node.js 18 或更高版本。请更新 Node.js 后重新运行安装。'
}
$root = (Resolve-Path -LiteralPath $RootPath).Path
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw '默认工作目录不存在。' }
$manifestPath = Join-Path $PSScriptRoot 'native-host.json'
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
if (Test-Path -LiteralPath $registryPath) {
    $previous = (Get-Item -LiteralPath $registryPath).GetValue('')
    if ($previous -and $previous -ine $manifestPath -and -not $Force) {
        throw "检测到已有本机连接指向 $previous，未修改现有连接。若确定要切换到此目录，请按说明使用 -Force 重新安装。"
    }
}
$manifest = @{
    name = $HostName
    description = 'Campus AI local assistant'
    path = (Join-Path $PSScriptRoot 'host.cmd')
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'config.json'), (@{ root = $root } | ConvertTo-Json), $utf8)
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), $utf8)
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath
Write-Host '本机连接已安装。请重新打开 Chrome 或 Edge，并按 README 加载浏览器扩展。'
