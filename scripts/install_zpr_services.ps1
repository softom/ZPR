# ════════════════════════════════════════════════════════════════════════
# Регистрирует Task Scheduler задачи для ЗПР как «сервисы»:
#
#   ZPR_Telegram_Listener     — TG inbox в фоне (от логина пользователя)
#                              + realtime L1 классификатор
#   ZPR_TG_Classifier_Batch   — L2 LLM классификатор раз в 4 часа
#
# Запуск (без admin):
#   powershell -ExecutionPolicy Bypass -File .\scripts\install_zpr_services.ps1
#
# Удалить:
#   .\scripts\uninstall_zpr_services.ps1
#
# Статус:
#   .\scripts\status_zpr_services.ps1
# ════════════════════════════════════════════════════════════════════════

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$LogDir   = 'D:\ЗПР_Хранилище\logs'

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    Write-Host "[INFO] Создана папка логов: $LogDir"
}

Write-Host "RepoRoot: $RepoRoot"
Write-Host "LogDir:   $LogDir"
Write-Host ""

# ────────────────────────────────────────────────────────────────────────
# Task 1: ZPR_Telegram_Listener (continuous, at login)
# ────────────────────────────────────────────────────────────────────────
$listenerTaskName = 'ZPR_Telegram_Listener'
$listenerScript   = Join-Path $RepoRoot 'scripts\run_tg_listener.ps1'

$listenerAction   = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$listenerScript`""
$listenerTrigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$listenerSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
$listenerSettings.ExecutionTimeLimit = 'PT0S'   # без лимита времени

$listenerPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask -TaskName $listenerTaskName `
    -Action      $listenerAction `
    -Trigger     $listenerTrigger `
    -Settings    $listenerSettings `
    -Principal   $listenerPrincipal `
    -Description 'ZPR Telegram listener: слушает whitelist чатов через Telethon, классифицирует входящие сообщения (L1 правила).' `
    -Force | Out-Null
Write-Host "[OK] $listenerTaskName зарегистрирован (auto-start с логина, рестарт при крэше)"

# ────────────────────────────────────────────────────────────────────────
# Task 2: ZPR_TG_Classifier_Batch (every 4 hours)
# ────────────────────────────────────────────────────────────────────────
$classifierTaskName = 'ZPR_TG_Classifier_Batch'
$classifierScript   = Join-Path $RepoRoot 'scripts\run_tg_classifier.ps1'

$classifierAction   = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$classifierScript`""
$classifierTrigger  = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddHours(9)) `
    -RepetitionInterval (New-TimeSpan -Hours 4)
$classifierSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew

$classifierPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask -TaskName $classifierTaskName `
    -Action      $classifierAction `
    -Trigger     $classifierTrigger `
    -Settings    $classifierSettings `
    -Principal   $classifierPrincipal `
    -Description 'ZPR TG classifier batch: каждые 4 часа догоняет L2 LLM классификацию текстовых обсуждений за последние сутки.' `
    -Force | Out-Null
Write-Host "[OK] $classifierTaskName зарегистрирован (каждые 4 часа)"

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════════"
Write-Host "Задачи установлены. Поведение:"
Write-Host ""
Write-Host "  $listenerTaskName"
Write-Host "    └─ стартует при логине $env:USERNAME"
Write-Host "    └─ ждёт supabase_db_zpr_code Docker"
Write-Host "    └─ работает непрерывно (без лимита по времени)"
Write-Host "    └─ при крэше — рестарт через 1 мин (до 99 попыток)"
Write-Host ""
Write-Host "  $classifierTaskName"
Write-Host "    └─ каждые 4 часа начиная с 9:00"
Write-Host "    └─ taймаут 30 минут"
Write-Host ""
Write-Host "Логи (rotating tail рекомендуется):"
Write-Host "  $LogDir\telegram_listener.log"
Write-Host "  $LogDir\tg_classifier.log"
Write-Host ""
Write-Host "Управление:"
Write-Host "  taskschd.msc                                      # GUI"
Write-Host "  Start-ScheduledTask  -TaskName $listenerTaskName"
Write-Host "  Stop-ScheduledTask   -TaskName $listenerTaskName"
Write-Host "  Get-ScheduledTaskInfo -TaskName $listenerTaskName"
Write-Host ""
Write-Host "Запустить сейчас (без ожидания логина / 4 часов):"
Write-Host "  Start-ScheduledTask -TaskName $listenerTaskName"
Write-Host "  Start-ScheduledTask -TaskName $classifierTaskName"
