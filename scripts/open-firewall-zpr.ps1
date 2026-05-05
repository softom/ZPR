# Открывает порты 3000 (Next.js UI) и 54321 (Supabase) во входящем направлении
# для всех профилей Windows Firewall (Domain, Private, Public).
#
# Запускать ОТ АДМИНИСТРАТОРА:
#   PowerShell -> Правый клик на файле -> "Run as administrator"
# или из admin-PowerShell:
#   pwsh -ExecutionPolicy Bypass -File .\open-firewall-zpr.ps1
#
# Откатить:
#   Get-NetFirewallRule -DisplayName "ZPR *" | Remove-NetFirewallRule

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

$rules = @(
    @{ Name = 'ZPR Next.js (3000)';   Port = 3000  },
    @{ Name = 'ZPR Supabase (54321)'; Port = 54321 }
)

foreach ($r in $rules) {
    # Удалить старое правило с тем же именем (idempotent)
    Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule `
        -DisplayName $r.Name `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort $r.Port `
        -Profile Domain,Private,Public `
        -Enabled True | Out-Null
    Write-Host "OK: $($r.Name) -> TCP $($r.Port) [Domain,Private,Public]" -ForegroundColor Green
}

Write-Host ""
Write-Host "Готово. Проверка правил:" -ForegroundColor Cyan
Get-NetFirewallRule -DisplayName "ZPR *" |
    Select-Object DisplayName, Enabled, Direction, Action, Profile |
    Format-Table -AutoSize
