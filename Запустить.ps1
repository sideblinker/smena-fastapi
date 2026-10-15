$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskNodeCommand = Get-Command node -ErrorAction SilentlyContinue
$taskNodePath = if ($taskNodeCommand) { $taskNodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
if (-not (Test-Path -LiteralPath $taskNodePath)) { throw 'Установите Node.js 24 и запустите этот файл снова.' }
Write-Host 'Откройте http://127.0.0.1:4173. Для остановки нажмите Ctrl+C.'
& $taskNodePath server.cjs
