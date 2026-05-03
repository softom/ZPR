# Applies new migrations to the local Supabase DB via docker container.
# Idempotent: repeated runs apply only files not yet in _applied_migrations.
#
# Usage:
#     .\scripts\db-migrate.ps1
#     .\scripts\db-migrate.ps1 -DryRun           # show what would be applied
#     .\scripts\db-migrate.ps1 -Container name   # custom container name
#
# Requires:
#     - Docker Desktop running
#     - supabase_db_zpr_code container up (run `supabase start`)

param(
    [switch]$DryRun,
    [string]$Container = 'supabase_db_zpr_code'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$migDir   = Join-Path $repoRoot 'supabase\migrations'

if (-not (Test-Path $migDir)) {
    Write-Host "[FAIL] Migrations folder not found: $migDir" -ForegroundColor Red
    exit 1
}

# 1 - Container alive?
$ps = docker ps --filter "name=$Container" --format '{{.Names}}' 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "[FAIL] Docker is not available. Start Docker Desktop." -ForegroundColor Red
    exit 1
}
if (-not $ps) {
    Write-Host "[FAIL] Container '$Container' is not running. Run: supabase start" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Container '$Container' is running" -ForegroundColor Green

# 2 - Fetch list of already-applied migrations (empty if table absent)
$appliedQuery = "SELECT filename FROM _applied_migrations ORDER BY filename;"
$appliedRaw = docker exec $Container psql -U postgres -d postgres -t -A -c $appliedQuery 2>$null
if ($LASTEXITCODE -eq 0 -and $appliedRaw) {
    $applied = $appliedRaw | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() }
    Write-Host "[OK] Registry: $($applied.Count) migrations already applied" -ForegroundColor Green
} else {
    $applied = @()
    Write-Host "[WARN] Table _applied_migrations missing - will bootstrap" -ForegroundColor Yellow
}

# 3 - Files on disk
$files = Get-ChildItem -Path $migDir -Filter '*.sql' | Sort-Object Name
Write-Host "[OK] Migration files on disk: $($files.Count)"

# 4 - New = not in registry
$newFiles = $files | Where-Object { $applied -notcontains $_.Name }

if ($newFiles.Count -eq 0) {
    Write-Host "[OK] All migrations applied, nothing to do" -ForegroundColor Green
    docker exec $Container psql -U postgres -d postgres -c "NOTIFY pgrst, 'reload schema';" | Out-Null
    exit 0
}

Write-Host ""
Write-Host "New migrations to apply: $($newFiles.Count)" -ForegroundColor Cyan
foreach ($f in $newFiles) { Write-Host "  - $($f.Name)" }
Write-Host ""

if ($DryRun) {
    Write-Host "[DryRun] Nothing applied. Remove -DryRun to apply." -ForegroundColor Yellow
    exit 0
}

# 5 - Apply one by one with ON_ERROR_STOP (psql returns non-zero on first error)
foreach ($f in $newFiles) {
    Write-Host "-> $($f.Name)" -ForegroundColor Cyan
    $sql = Get-Content -Raw -Encoding utf8 -Path $f.FullName

    $sql | docker exec -i $Container psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[FAIL] Migration '$($f.Name)' errored (exit $LASTEXITCODE). Stopping." -ForegroundColor Red
        Write-Host "       Subsequent migrations NOT applied. Fix the issue and re-run." -ForegroundColor Red
        exit 1
    }

    # Register in registry (bootstrap migration inserts itself, ON CONFLICT guards us)
    $mark = "INSERT INTO _applied_migrations (filename) VALUES ('$($f.Name)') ON CONFLICT DO NOTHING;"
    docker exec $Container psql -U postgres -d postgres -c $mark | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[FAIL] Could not register '$($f.Name)' in registry." -ForegroundColor Red
        exit 1
    }
    Write-Host "   [OK] applied and registered" -ForegroundColor Green
}

# 6 - Reload PostgREST schema cache so new functions/columns become visible via API
docker exec $Container psql -U postgres -d postgres -c "NOTIFY pgrst, 'reload schema';" | Out-Null
Write-Host ""
Write-Host "[OK] Done: $($newFiles.Count) migrations applied, PostgREST cache reloaded" -ForegroundColor Green
