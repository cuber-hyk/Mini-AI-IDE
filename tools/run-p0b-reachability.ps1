# 运行 P0b 可达性与登录实测 / 受控实验
#
# 自检（10 秒，不联网，验证工具链路）：
#   pwsh -File tools\run-p0b-reachability.ps1 -SelfTest
#
# 基线实测：
#   pwsh -File tools\run-p0b-reachability.ps1 -Profile baseline
#
# 受控实验（一次只改一个变量：UA 中移除 Electron 与应用名标记，其余一律不动）：
#   pwsh -File tools\run-p0b-reachability.ps1 -Variant noident -Profile noident
#
# 运行后：在弹出的窗口里**手动**登录、**手动**提问。结束时直接关闭窗口
#        （或按 Ctrl+S 随时保存）—— 报告会自动写入 docs\audits\。
#
# 注意：真实施测必须在**普通 PowerShell**里跑，不要放在 AI 助手的执行沙箱内
#       （沙箱会限制子进程对外网络，表现为页面永远加载不出来）。

param(
    [string]$Url = 'https://chat.deepseek.com/',
    [string]$Out = '',
    [switch]$SelfTest,
    # 只探测模式：不等待人工操作，检查登录态是否还在（用于"免登录"验证，避免重复登录）
    [switch]$ProbeOnly,
    # 受控实验：noident = 仅移除 UA 中的 Electron/ 与应用名标记，其余一律不动（现为默认）
    [ValidateSet('', 'noident', 'baseline')]
    [string]$Variant = '',
    # 实验分区后缀：让不同实验互不污染登录态（不传则复用正式分区与已登录会话）
    [string]$Profile = ''
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
    $suffix = if ($SelfTest) { 'p0b-selftest' }
              elseif ($ProbeOnly) { 'p0b-session-probe' }
              elseif ($Profile) { "p0b-experiment-$Profile" }
              else { 'p0b-reachability-raw' }
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
    $args1 = @('--self-test', "--out=$Out")
    if ($Variant) { $args1 += "--variant=$Variant" }
    if ($Profile) { $args1 += "--profile=$Profile" }
    & $exe $appDir @args1
    Write-Host "退出码: $LASTEXITCODE"
    if (Test-Path $Out) {
        $r = Get-Content $Out -Raw | ConvertFrom-Json
        Write-Host ("实际：challengesDetected = {0}、httpErrors = {1}、signal = {2}" -f `
            $r.summary.challengesDetected, $r.summary.httpErrors, $r.summary.signal)
        Write-Host ("实验分区：{0}；UA 变体：{1}" -f $r.partition, $(if ($r.variant) { $r.variant.variant } else { 'n/a' }))
    }
    exit 0
}

if ($ProbeOnly) {
    Write-Host '============================================================'
    Write-Host ' P0b 会话探测（不登录，12 秒后自动结束）'
    Write-Host '============================================================'
    Write-Host " 目标地址 : $Url"
    Write-Host " 报告输出 : $Out"
    Write-Host " 会话分区 : $(if ($Profile) { "persist:postcheck-$Profile" } else { 'persist:postcheck' })"
    Write-Host ''
    Write-Host ' 用途：检查登录态是否还在（避免为了验证而反复登录——重复登录本身有风控风险）'
    Write-Host '============================================================'
    $argsP = @('--probe-only', "--url=$Url", "--out=$Out")
    if ($Variant) { $argsP += "--variant=$Variant" }
    if ($Profile) { $argsP += "--profile=$Profile" }
    & $exe $appDir @argsP
    Write-Host "退出码: $LASTEXITCODE"
    if (Test-Path $Out) {
        $r = Get-Content $Out -Raw | ConvertFrom-Json
        Write-Host ("会话状态：loggedIn = {0}（会话 cookie: {1}）" -f $r.session.loggedIn, $r.session.hasSessionCookie)
        Write-Host ("挑战命中：{0} 条；4xx/5xx：{1} 条" -f $r.summary.challengesDetected, $r.summary.httpErrors)
        Write-Host ("UA：{0}" -f $r.sessionFacts.userAgent)
    }
    exit 0
}

Write-Host '============================================================'
Write-Host ' P0b 可达性与登录实测'
Write-Host '============================================================'
Write-Host " 目标地址 : $Url"
Write-Host " 报告输出 : $Out"
Write-Host " 会话分区 : $(if ($Profile) { "persist:postcheck-$Profile" } else { 'persist:postcheck（正式分区）' })"
Write-Host " UA 变体  : $(if ($Variant) { $Variant } else { 'noident（默认，稳态）' })"
Write-Host ''
Write-Host ' 注意：若会话仍在（用 -ProbeOnly 可查），本步骤通常**不需要再登录**。'
Write-Host '       只有在确实被要求登录时才手动登录一次。'
Write-Host ''
Write-Host ' 请在打开的窗口里【全部手动】操作：'
Write-Host '   1. 如已登录：随便问一句话，确认能正常对话'
Write-Host '      如未登录：用你平时的方式登录一次'
Write-Host '   2. 观察登录页是否出现「使用环境异常…建议您使用我们的官方产品」'
Write-Host '   3. 若出现人机验证 —— 不要试图绕过，截图记下提示原文，然后关窗'
Write-Host '   4. 结束时直接关闭窗口'
Write-Host ''
Write-Host ' 本工具只做只读记录：不注入、不代填、不代答、不模拟点击。'
Write-Host '============================================================'
Write-Host ''

$runArgs = @($appDir, "--url=$Url", "--out=$Out")
if ($Variant) { $runArgs += "--variant=$Variant" }
if ($Profile) { $runArgs += "--profile=$Profile" }
& $exe @runArgs
$code = $LASTEXITCODE
Write-Host "退出码: $code"
if (Test-Path $Out) { Write-Host "报告: $Out" }
