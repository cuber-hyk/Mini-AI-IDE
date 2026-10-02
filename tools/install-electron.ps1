# 安装共享 Electron 二进制（tools/ workspace 只需一份，约 246MB）
#
# 为什么需要脚本：@electron/get 读取的是环境变量 ELECTRON_MIRROR 而不是 npm config，
# 且本机默认 GitHub Releases 源在 Node fetch 下会失败。另外 pnpm 默认拦截 postinstall，
# 所以 install.js 必须手动执行一次。
#
# 用法：pwsh -File tools\install-electron.ps1

$ErrorActionPreference = 'Stop'
$tools = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $tools 'node_modules\electron\dist\electron.exe'

if (Test-Path $exe) {
    Write-Host "Electron 二进制已存在，跳过安装：$exe"
    exit 0
}

Write-Host '设置镜像并执行 electron install.js ...'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
# 若外层环境预设了 ELECTRON_RUN_AS_NODE，会让后续 Electron 以 Node 模式启动（无窗口、无输出）
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

Push-Location $tools
try {
    node 'node_modules\electron\install.js'
    if ($LASTEXITCODE -ne 0) { throw "install.js 退出码 $LASTEXITCODE" }
} finally {
    Pop-Location
}

if (-not (Test-Path $exe)) { throw "安装后仍未找到 $exe" }
Write-Host "完成：$exe ($((Get-Item $exe).Length) bytes)"
