$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskVenvPython = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
$taskRequirements = Join-Path $PSScriptRoot 'requirements.txt'
$taskRequirementsStamp = Join-Path $PSScriptRoot '.venv/smena-requirements.sha256'

if (-not (Test-Path -LiteralPath $taskVenvPython)) {
    $taskCandidates = @(
        @{ Name = 'py'; Arguments = @('-3') },
        @{ Name = 'python'; Arguments = @() }
    )
    $taskCreated = $false
    foreach ($taskCandidate in $taskCandidates) {
        $taskCommand = Get-Command $taskCandidate.Name -ErrorAction SilentlyContinue
        if (-not $taskCommand) { continue }
        $taskArguments = $taskCandidate.Arguments
        & $taskCommand.Source @taskArguments -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'
        if ($LASTEXITCODE -ne 0) { continue }
        & $taskCommand.Source @taskArguments -m venv '.venv'
        if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать виртуальное окружение Python.' }
        $taskCreated = $true
        break
    }
    if (-not $taskCreated) {
        throw 'Установите Python 3.10 или новее с python.org, включите Add Python to PATH и повторите запуск.'
    }
}

& $taskVenvPython -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'
if ($LASTEXITCODE -ne 0) {
    throw 'Виртуальное окружение недоступно или использует Python старше 3.10. Создайте .venv заново.'
}

$taskRequirementsHash = (Get-FileHash -LiteralPath $taskRequirements -Algorithm SHA256).Hash
$taskInstalledHash = if (Test-Path -LiteralPath $taskRequirementsStamp) {
    (Get-Content -LiteralPath $taskRequirementsStamp -Raw).Trim()
} else { '' }
if ($taskRequirementsHash -ne $taskInstalledHash) {
    Write-Host 'Устанавливаю зависимости Python. При первой установке нужен интернет.'
    & $taskVenvPython -m pip install -r $taskRequirements
    if ($LASTEXITCODE -ne 0) { throw 'Установка зависимостей завершилась ошибкой.' }
    Set-Content -LiteralPath $taskRequirementsStamp -Value $taskRequirementsHash -Encoding ASCII
}

$taskPort = if ($env:SMENA_PORT) { $env:SMENA_PORT } else { '8000' }
Write-Host "Откройте http://127.0.0.1:$taskPort. Для остановки нажмите Ctrl+C."
& $taskVenvPython (Join-Path $PSScriptRoot 'run.py')
exit $LASTEXITCODE
