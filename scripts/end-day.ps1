# end-day.ps1 — финальный сценарий перед уходом с этого ПК.
#
# Проверяет наличие чувствительных строк (страховка от случайного коммита ИНН/ключей),
# делает один WIP-коммит со всеми изменениями и пушит в feature/contract-module.
#
# История: WIP-коммиты на feature-ветке нормальны — squash при merge в main.

param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# ─── 1. Security grep ────────────────────────────────────────────────────────
# Уже отслеживаемые файлы оставляем как есть (старая утечка). Проверяем только
# изменения текущего рабочего дерева — что нового мы собираемся запушить.

Write-Host "[1/4] Security grep на staged + working tree..." -ForegroundColor Cyan

$pattern = '(sk-[a-zA-Z0-9_-]{20,}|7725498690|9709020074|910000000000|Хайятт|Стрекалов|Хаиров|Симоненко)'

# diff против HEAD — только новые/изменённые строки (с префиксом +)
$diff = git diff HEAD -- ':!supabase/migrations/20260421000002_contractors.sql' ':!supabase/migrations/20260421000003_comments.sql' 2>$null
$untracked = git ls-files --others --exclude-standard 2>$null

$leak = $false

if ($diff -match $pattern) {
    Write-Host "  Найдены sensitive строки в diff:" -ForegroundColor Red
    $diff -split "`n" | Where-Object { $_ -match "^\+" -and $_ -match $pattern } | ForEach-Object {
        Write-Host "    $_" -ForegroundColor Yellow
    }
    $leak = $true
}

foreach ($f in $untracked) {
    if (-not (Test-Path $f) -or (Get-Item $f).PSIsContainer) { continue }
    $hits = Select-String -Path $f -Pattern $pattern -CaseSensitive:$false -ErrorAction SilentlyContinue
    if ($hits) {
        Write-Host "  Sensitive в untracked $f`:" -ForegroundColor Red
        $hits | ForEach-Object { Write-Host "    $($_.LineNumber): $($_.Line.Trim())" -ForegroundColor Yellow }
        $leak = $true
    }
}

if ($leak) {
    Write-Host "`nABORT: вынеси чувствительные данные в business_data.yaml перед коммитом." -ForegroundColor Red
    exit 1
}
Write-Host "  OK." -ForegroundColor Green

# ─── 2. Что меняем ───────────────────────────────────────────────────────────

Write-Host "[2/4] git status..." -ForegroundColor Cyan
$status = git status --porcelain
if (-not $status) {
    Write-Host "  Изменений нет — push не нужен." -ForegroundColor Green
    exit 0
}
$status -split "`n" | ForEach-Object { Write-Host "  $_" }

if ($DryRun) {
    Write-Host "`n[dry-run] коммит и push не выполняются." -ForegroundColor Yellow
    exit 0
}

# ─── 3. WIP-коммит + push ────────────────────────────────────────────────────

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
$machine = $env:COMPUTERNAME
$msg = "WIP $timestamp ($machine)"

Write-Host "`n[3/4] git add -A && git commit..." -ForegroundColor Cyan
git add -A
git commit -m $msg

Write-Host "`n[4/4] git push..." -ForegroundColor Cyan
git push

Write-Host "`nГотово. Можно закрывать ПК." -ForegroundColor Green
