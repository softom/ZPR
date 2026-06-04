# Делает мост IPv4 -> IPv6 loopback для Supabase (54321).
# Нужен потому, что Docker Desktop публикует порт только на IPv6 (::), и Windows
# dual-stack принимает IPv4 на TCP-уровне, но не доводит запрос до backend'а
# с внешних адресов — соединение принимается, ответа нет.
#
# Listener: 0.0.0.0:54321 (IPv4 со всех интерфейсов)
# Forward:  ::1:54321     (IPv6 loopback, где Docker/wslrelay принимает)

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Continue'

# Удалить старые v4tov4 если остались, и v4tov6 с теми же параметрами
& netsh interface portproxy delete v4tov4 listenport=54321 listenaddress=0.0.0.0 2>&1 | Out-Null
& netsh interface portproxy delete v4tov6 listenport=54321 listenaddress=0.0.0.0 2>&1 | Out-Null

$out = & netsh interface portproxy add v4tov6 listenport=54321 listenaddress=0.0.0.0 connectport=54321 connectaddress=::1 2>&1

$report = @()
$report += "add v4tov6 0.0.0.0:54321 -> [::1]:54321 : $out"
$report += '--- portproxy table ---'
$report += (& netsh interface portproxy show all 2>&1 | Out-String)

$report -join [Environment]::NewLine | Out-File "$PSScriptRoot\..\ui\firewall.log" -Encoding utf8 -Force
