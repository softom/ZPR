# Ручной триггер обновления TG для UI-кнопки на /events.
# Останавливает listener task, делает backfill, классификатор, перезапускает.
# Возвращает JSON в stdout (всё остальное — в stderr).
#
# Параметры: -Days N (default 3)

param(
    [int]$Days = 3
)

$ErrorActionPreference = 'Continue'

$RepoDir = (Resolve-Path "$PSScriptRoot\..").Path
$PyExe   = 'C:\Users\tigra\.conda\envs\zpr\python.exe'

$started = Get-Date
$summary = @{
    success            = $false
    backfill_new       = 0
    backfill_duplicate = 0
    classifier_new     = 0
    classifier_merged  = 0
    duration_seconds   = 0
    error              = $null
    log                = @()
}

function Add-LogEntry($msg) {
    $stamp = (Get-Date).ToString('HH:mm:ss')
    $summary.log += "[$stamp] $msg"
    [Console]::Error.WriteLine("[$stamp] $msg")
}

try {
    # 1. Stop listener task — освободить .tg_session
    Add-LogEntry "Stopping listener task..."
    Stop-ScheduledTask -TaskName 'ZPR_Telegram_Listener' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    # Ждём пока python из listener'а реально умрёт (до 10 сек)
    for ($i = 0; $i -lt 10; $i++) {
        $alive = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
            Where-Object { $_.CommandLine -like '*telegram_listener.py*--listen*' }
        if (-not $alive) { break }
        Start-Sleep -Seconds 1
    }

    # 2. Backfill
    Add-LogEntry "Backfill --days $Days..."
    $backfillOutput = & $PyExe "$RepoDir\telegram_listener.py" "--backfill" $Days 2>&1
    foreach ($line in $backfillOutput) {
        $s = $line.ToString()
        [Console]::Error.WriteLine("  bf: $s")
        # Парсим строки вида "Готово: 24 новых, 2 дублей."
        if ($s -match 'Готово:\s*(\d+)\s*новых,\s*(\d+)\s*дублей') {
            $summary.backfill_new       = [int]$Matches[1]
            $summary.backfill_duplicate = [int]$Matches[2]
        }
    }

    # 3. Classifier
    Add-LogEntry "Classifier --apply --days $Days..."
    $classifierOutput = & $PyExe "$RepoDir\tg_classifier.py" "--apply" "--days" $Days 2>&1
    foreach ($line in $classifierOutput) {
        $s = $line.ToString()
        [Console]::Error.WriteLine("  cl: $s")
        # "Записано в БД: 6 новых preliminary, 0 слито с существующими"
        if ($s -match 'Записано в БД:\s*(\d+)\s*новых preliminary,\s*(\d+)\s*слито') {
            $summary.classifier_new    = [int]$Matches[1]
            $summary.classifier_merged = [int]$Matches[2]
        }
    }

    # 4. Restart listener task
    Add-LogEntry "Restarting listener task..."
    Start-ScheduledTask -TaskName 'ZPR_Telegram_Listener'

    $summary.success = $true
} catch {
    $summary.error = $_.Exception.Message
    Add-LogEntry "ERROR: $($_.Exception.Message)"
    # Попытаться вернуть listener в Running даже при ошибке
    try { Start-ScheduledTask -TaskName 'ZPR_Telegram_Listener' } catch {}
}

$summary.duration_seconds = [int]((Get-Date) - $started).TotalSeconds
$summary | ConvertTo-Json -Depth 5 -Compress
