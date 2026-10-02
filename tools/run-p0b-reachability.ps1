# 运行 P0b 可达性与登录实测
#
# 自检（10 秒，不联网，验证工具链路）：
#   pwsh -File tools\run-p0b-reachability.ps1 -SelfTest
#
# 真实施测：
#   pwsh -File tools\run-p0b-reachability.ps1
#   pwsh -File tools\run-p0b-reachability.ps1 -Url "https://chat.deepseek.com/"
#
# 运行后：在弹出的窗口里**手动**登录、**手动**复制粘贴、**手动**发送。
# 结束方式：直接关闭窗口（或按 Ctrl+S 随时保存）—— 报告会自动写入 docs\audits\。
#
# 注意：真实施测必须在**普通 PowerShell**里跑，不要放在 AI 助手的执行沙箱内
#       （沙箱会限制子进程对外网络，表现为页面永远加载不出来）。

param(
    [string]$Url = 'https://chat.deepseek.com/',
    [string]$Out = '',
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$tools = Join-Path $repoRoot 'tools'
$appDir = Join-Path $tools 'reachability-probe'
$exe = Join-Path $tools 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path $exe)) {
    throw "未找到 Electron 二进制。请先运行：pwsh -File tools\install-electron.ps1"
}

if (-not $Out) {
    $stamp = Get-Date -Format 'yyyy-MM-dd'
    $suffix = if ($SelfTest) { 'p0b-selftest' } else { 'p0b-reachability-raw' }
    $Out = Join-Path $repoRoot "docs\audits\$stamp-$suffix.json"
}

# 关键：外层环境可能预设 ELECTRON_RUN_AS_NODE=1，会让 Electron 以 Node 模式启动（无窗口、无输出）
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

if ($SelfTest) {
    Write-Host '============================================================'
    Write-Host ' P0b 工具自检（不联网，10 秒内自动结束）'
    Write-Host '============================================================'
    Write-Host " 报告输出 : $Out"
    Write-Host ' 预期：challengesDetected = 1、httpErrors = 2、signal = blocking-signal-observed'
    Write-Host '============================================================'
    & $exe $appDir '--self-test' "--out=$Out"
    Write-Host "退出码: $LASTEXITCODE"
    if (Test-Path $Out) {
        $r = Get-Content $Out -Raw | ConvertFrom-Json
        Write-Host ("实际：challengesDetected = {0}、httpErrors = {1}、signal = {2}" -f `
            $r.summary.challengesDetected, $r.summary.httpErrors, $r.summary.signal)
    }
    exit 0
}

Write-Host '============================================================'
Write-Host ' P0b 可达性与登录实测'
Write-Host '============================================================'
Write-Host " 目标地址 : $Url"
Write-Host " 报告输出 : $Out"
Write-Host ''
Write-Host ' 请在打开的窗口里【全部手动】操作：'
Write-Host '   1. 用你平时的方式登录（扫码 / 验证码 / 密码均可）'
Write-Host '   2. 随便问一句话，确认能正常对话'
Write-Host '   3. 若出现人机验证或"环境异常"提示 —— 不要试图绕过，'
Write-Host '      截图并记下提示文字，然后直接关闭窗口即可'
Write-Host '   4. 结束时直接关闭窗口'
Write-Host ''
Write-Host ' 本工具只做只读记录：不注入、不代填、不代答、不模拟点击。'
Write-Host '============================================================'
Write-Host ''

& $exe $appDir "--url=$Url" "--out=$Out"
$code = $LASTEXITCODE
Write-Host "退出码: $code"
if (Test-Path $Out) { Write-Host "报告: $Out" }
