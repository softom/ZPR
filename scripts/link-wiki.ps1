# Links the project WIKI (knowledge base) into the repo as a directory junction.
#
# The WIKI lives in the synced Dropbox / remotely-save Obsidian vault, NOT in git
# (it is .gitignore'd). This script recreates the `MD WIKI` junction so that the
# relative path `MD WIKI/` keeps resolving in the main checkout AND in every
# git worktree under .claude\worktrees\.
#
# Run once per clone / new worktree. Idempotent: skips junctions already present.
#
# Usage:
#     .\scripts\link-wiki.ps1
#     .\scripts\link-wiki.ps1 -AllWorktrees       # also (re)link every worktree (default ON)
#     .\scripts\link-wiki.ps1 -ThisOnly           # link only the current root
#     .\scripts\link-wiki.ps1 -Source "D:\path\to\MD WIKI"   # custom WIKI source
#
# Requires: the WIKI source folder to exist (synced via Dropbox/remotely-save).

param(
    [string]$Source = 'D:\Dropbox\Приложения\remotely-save\Золотые Пески России\MD WIKI',
    [switch]$ThisOnly
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path -LiteralPath $Source)) {
    Write-Host "[FAIL] WIKI source not found: $Source" -ForegroundColor Red
    Write-Host "       Make sure Dropbox / remotely-save is synced, or pass -Source." -ForegroundColor Yellow
    exit 1
}

# Collect roots: main repo + all worktrees (unless -ThisOnly)
$roots = @($repoRoot)
$wtDir = Join-Path $repoRoot '.claude\worktrees'
if (-not $ThisOnly -and (Test-Path -LiteralPath $wtDir)) {
    $roots += Get-ChildItem -LiteralPath $wtDir -Directory | ForEach-Object { $_.FullName }
}

foreach ($root in $roots) {
    $link = Join-Path $root 'MD WIKI'
    if (Test-Path -LiteralPath $link) {
        Write-Host "[skip] already present: $link" -ForegroundColor DarkGray
        continue
    }
    cmd /c "mklink /J `"$link`" `"$Source`"" | Out-Null
    if (Test-Path -LiteralPath $link) {
        Write-Host "[OK]   linked: $link" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] could not link: $link" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "WIKI source: $Source" -ForegroundColor Cyan

