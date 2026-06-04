#Requires -RunAsAdministrator
$ErrorActionPreference = 'Continue'
foreach ($port in @(3000, 54321)) {
    & netsh interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 2>&1 | Out-Null
}
& netsh interface portproxy show all 2>&1 | Out-File "$PSScriptRoot\..\ui\firewall.log" -Encoding utf8 -Force
