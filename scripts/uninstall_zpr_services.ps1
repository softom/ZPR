# Удаляет Task Scheduler задачи ЗПР (см. install_zpr_services.ps1)

$ErrorActionPreference = 'Continue'

foreach ($name in @('ZPR_Telegram_Listener', 'ZPR_TG_Classifier_Batch')) {
    $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($existing) {
        Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "[OK] Удалена: $name"
    } else {
        Write-Host "[SKIP] Не найдена: $name"
    }
}
