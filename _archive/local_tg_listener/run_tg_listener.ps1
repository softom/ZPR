# Wrapper для telegram_listener.py --listen — запускается из Task Scheduler.
# Ждёт supabase_db_zpr_code Docker, потом стартует listener с логированием.

$ErrorActionPreference = 'Continue'

$RepoDir = (Resolve-Path "$PSScriptRoot\..").Path
$PyExe   = 'C:\Users\tigra\.conda\envs\zpr\python.exe'
$LogDir  = 'D:\ЗПР_Хранилище\logs'
$Log     = Join-Path $LogDir 'telegram_listener.log'

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

function Write-Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $Log -Value $line -Encoding UTF8
}

# Ждём Supabase Docker container (до 15 минут)
$retry = 0
while ($true) {
    $running = (docker ps --filter "name=supabase_db_zpr_code" --filter "status=running" --format "{{.Names}}" 2>$null) -join ''
    if ($running -match 'supabase_db_zpr_code') { break }
    $retry++
    if ($retry -gt 60) {
        Write-Log "supabase_db_zpr_code не поднялся за 15 минут — пробуем продолжить"
        break
    }
    Write-Log "waiting for supabase_db_zpr_code (try $retry/60)..."
    Start-Sleep -Seconds 15
}
Write-Log "supabase_db_zpr_code is up — стартую listener"

# Запуск listener: stdout+stderr в лог через cmd-redirect (Start-Process -Wait + RedirectStandardOutput)
$listenerScript = Join-Path $RepoDir 'telegram_listener.py'

# Используем Start-Process + ожидаем (RedirectStandardOutput/Error поддерживается)
$tmpStdout = "$LogDir\listener.tmp.out"
$tmpStderr = "$LogDir\listener.tmp.err"
$proc = Start-Process -FilePath $PyExe `
    -ArgumentList @($listenerScript, '--listen') `
    -NoNewWindow `
    -RedirectStandardOutput $tmpStdout `
    -RedirectStandardError  $tmpStderr `
    -PassThru

Write-Log "started PID=$($proc.Id)"

# Хвостим stdout/stderr в основной лог по мере роста, ждём завершения процесса
$lastStdoutLen = 0
$lastStderrLen = 0
while (-not $proc.HasExited) {
    Start-Sleep -Seconds 5
    foreach ($pair in @(@($tmpStdout, [ref]$lastStdoutLen), @($tmpStderr, [ref]$lastStderrLen))) {
        if (Test-Path $pair[0]) {
            $bytes = (Get-Item $pair[0]).Length
            if ($bytes -gt $pair[1].Value) {
                # Открываем с FileShare.ReadWrite — иначе race с пишущим Python (эксклюзивный лок)
                try {
                    $stream = [System.IO.File]::Open(
                        $pair[0], [System.IO.FileMode]::Open,
                        [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                    $stream.Seek($pair[1].Value, 'Begin') | Out-Null
                    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
                    $chunk = $reader.ReadToEnd()
                    $reader.Close(); $stream.Close()
                    if ($chunk) { Add-Content -Path $Log -Value $chunk.TrimEnd() -Encoding UTF8 }
                    $pair[1].Value = $bytes
                } catch {
                    # Файл занят — пропустим этот тик, прочитаем в следующий
                }
            }
        }
    }
}

Write-Log "listener exited with code $($proc.ExitCode)"
exit $proc.ExitCode
