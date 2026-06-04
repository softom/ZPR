# Wrapper для tg_classifier.py --apply --days 1 — запускается раз в 4 часа.

$ErrorActionPreference = 'Continue'

$RepoDir = (Resolve-Path "$PSScriptRoot\..").Path
$PyExe   = 'C:\Users\tigra\.conda\envs\zpr\python.exe'
$LogDir  = 'D:\ЗПР_Хранилище\logs'
$Log     = Join-Path $LogDir 'tg_classifier.log'

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

function Write-Log($msg) {
    Add-Content -Path $Log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding UTF8
}

$script = Join-Path $RepoDir 'tg_classifier.py'

Write-Log "=== start tg_classifier --apply --days 1 ==="

$output = & $PyExe $script '--apply' '--days' '1' 2>&1
$exitCode = $LASTEXITCODE

foreach ($line in $output) {
    Add-Content -Path $Log -Value $line.ToString() -Encoding UTF8
}

Write-Log "=== exited with code $exitCode ==="
exit $exitCode
