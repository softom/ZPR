# start-day.ps1 — сценарий старта рабочего дня на этом ПК.
#
# 1. git pull
# 2. Проверяет секреты (config.py, business_data.yaml, ui/.env.local)
# 3. pip install / npm install (если что-то поменялось — быстро no-op)
# 4. supabase start (локальная БД) — пропустит если используется VPN-схема (флаг -SkipSupabase)
# 5. Применяет миграции и seed
# 6. Запускает UI dev-сервер в новом окне

param(
    [switch]$SkipSupabase,   # для VPN-схемы: БД на другом ПК, локальную не поднимаем
    [switch]$SkipUi          # не запускать npm run dev (например, работаем только с Python)
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# ─── 1. Pull ─────────────────────────────────────────────────────────────────

Write-Host "[1/6] git pull..." -ForegroundColor Cyan
git pull --ff-only

# ─── 2. Проверка секретов ───────────────────────────────────────────────────

Write-Host "[2/6] Проверка секретов..." -ForegroundColor Cyan
$missing = @()
if (-not (Test-Path 'config.py'))          { $missing += 'config.py' }
if (-not (Test-Path 'business_data.yaml')) { $missing += 'business_data.yaml' }
if (-not (Test-Path 'ui\.env.local'))      { $missing += 'ui\.env.local' }
if ($missing.Count -gt 0) {
    Write-Host "  Не хватает: $($missing -join ', ')" -ForegroundColor Red
    Write-Host "  Скопируй из D:\Dropbox\_secrets\zpr_code\" -ForegroundColor Yellow
    exit 1
}
Write-Host "  OK." -ForegroundColor Green

# ─── 3. Зависимости ──────────────────────────────────────────────────────────

Write-Host "[3/6] pip install (если нужно)..." -ForegroundColor Cyan
pip install -q -r requirements.txt

Write-Host "      npm install (если нужно)..." -ForegroundColor Cyan
Push-Location ui
npm install --prefer-offline --no-audit --no-fund
Pop-Location

# ─── 4. Supabase ─────────────────────────────────────────────────────────────

if ($SkipSupabase) {
    Write-Host "[4/6] Supabase: SKIP (используется удалённая БД)" -ForegroundColor Yellow
} else {
    Write-Host "[4/6] supabase start..." -ForegroundColor Cyan
    supabase start

    Write-Host "       Применяем миграции..." -ForegroundColor Cyan
    & "$PSScriptRoot\db-migrate.ps1"

    Write-Host "       seed business_data.yaml -> БД..." -ForegroundColor Cyan
    python seed_business_data.py
}

# ─── 5. Запуск UI ───────────────────────────────────────────────────────────

if ($SkipUi) {
    Write-Host "[5/6] UI dev-сервер: SKIP" -ForegroundColor Yellow
} else {
    Write-Host "[5/6] Старт UI dev-сервера в новом окне..." -ForegroundColor Cyan
    Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$repoRoot\ui'; npm run dev"
}

# ─── 6. Готово ───────────────────────────────────────────────────────────────

Write-Host "`n[6/6] Готово." -ForegroundColor Green
Write-Host "  UI:     http://localhost:3000"
Write-Host "  Studio: http://localhost:54323"
Write-Host "  В конце дня: .\scripts\end-day.ps1"
