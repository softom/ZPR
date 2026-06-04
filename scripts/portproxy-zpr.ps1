# Добавляет netsh portproxy на 0.0.0.0:<port> -> 127.0.0.1:<port>
# для 3000 (UI) и 54321 (Supabase). Идемпотентен.
#
# Запускать ОТ АДМИНИСТРАТОРА.

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Continue'
$log = "$PSScriptRoot\..\ui\firewall.log"

$out = @()
foreach ($port in @(3000, 54321)) {
    & netsh interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 2>&1 | Out-Null
    $r = & netsh interface portproxy add v4tov4 listenport=$port listenaddress=0.0.0.0 connectport=$port connectaddress=127.0.0.1 2>&1
    $out += "portproxy 0.0.0.0:$port -> 127.0.0.1:$port : $r"
}
$out += '--- portproxy table ---'
$out += (& netsh interface portproxy show all 2>&1 | Out-String)
$out += '--- Docker fw rules (Inbound) ---'
$out += (Get-NetFirewallRule -Direction Inbound -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Docker' } | Select-Object DisplayName, Enabled, Action, Profile | Format-Table -AutoSize | Out-String)

$out -join [Environment]::NewLine | Out-File $log -Encoding utf8 -Force
