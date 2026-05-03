# Автозапуск Next.js dev-сервера для ЗПР.
# Запускается Task Scheduler при входе в Windows.
Set-Location -Path 'D:\CODE\zpr_code\ui'
$log = 'D:\CODE\zpr_code\ui\dev.log'
"=== Start: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File -FilePath $log -Encoding utf8 -Append
# Ждём Docker Desktop (Supabase зависит от него)
$tries = 0
while ($tries -lt 30) {
    $v = & docker version --format '{{.Server.Version}}' 2>$null
    if ($LASTEXITCODE -eq 0 -and $v) { break }
    Start-Sleep -Seconds 5
    $tries++
}
"Docker ready after $($tries*5)s" | Out-File -FilePath $log -Encoding utf8 -Append
# Запускаем dev-сервер. npm.cmd находится в PATH (установлен с Node.js).
& npm.cmd run dev *>> $log
