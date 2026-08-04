param(
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $repoRoot 'web'

Push-Location $webRoot
try {
    if (-not $SkipInstall) {
        npm ci
    }
    npm run build
}
finally {
    Pop-Location
}

Write-Host "Web static export: $webRoot\out"
