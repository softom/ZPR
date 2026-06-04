# Показывает статус задач ЗПР + хвосты логов

$ErrorActionPreference = 'Continue'

$tasks = @('ZPR_Telegram_Listener', 'ZPR_TG_Classifier_Batch')
$LogDir = 'D:\ЗПР_Хранилище\logs'

foreach ($name in $tasks) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Host "[?]   $name — не зарегистрирована (запусти install_zpr_services.ps1)"
        continue
    }
    $info = Get-ScheduledTaskInfo -TaskName $name
    $state = $task.State
    $lastRun  = if ($info.LastRunTime.Year -gt 1900) { $info.LastRunTime.ToString('dd.MM HH:mm') } else { 'никогда' }
    $lastCode = $info.LastTaskResult
    $nextRun  = if ($info.NextRunTime.Year -gt 1900) { $info.NextRunTime.ToString('dd.MM HH:mm') } else { '—' }
    $codeNote = switch ($lastCode) {
        0       { '✓ ok' }
        267009  { '⏳ в работе' }
        $null   { '—' }
        default { "код $lastCode" }
    }
    Write-Host ("[{0,-8}] {1}" -f $state, $name)
    Write-Host ("              last run: {0,-13}  {1}" -f $lastRun, $codeNote)
    Write-Host ("              next run: {0}" -f $nextRun)
}

Write-Host ""
Write-Host "─── Логи (хвосты по 6 строк) ──────────────────────────────"
foreach ($log in @('telegram_listener.log', 'tg_classifier.log')) {
    $path = Join-Path $LogDir $log
    Write-Host ""
    Write-Host "── $log ──"
    if (Test-Path $path) {
        Get-Content $path -Tail 6 | ForEach-Object { "  $_" } | Write-Host
    } else {
        Write-Host "  [пусто — нет файла]"
    }
}
