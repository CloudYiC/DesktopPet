<#
.SYNOPSIS
Builds the React frontend and native Windows application.

.DESCRIPTION
Bootstraps pinned C++ dependencies, restores the npm lockfile, builds the
frontend, configures CMake for Visual Studio 2022 x64, and compiles the selected
configuration. Use -SkipFrontend only when frontend/dist is already current.
#>
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug',
    [switch]$SkipFrontend
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

& (Join-Path $PSScriptRoot 'check-cxx11.ps1')
& (Join-Path $PSScriptRoot 'bootstrap-native-deps.ps1')

# Regenerate both the web favicon and Windows icon resource from one source.
& (Join-Path $PSScriptRoot 'generate-app-icons.ps1')

if (-not $SkipFrontend) {
    Push-Location (Join-Path $projectRoot 'frontend')
    try {
        if (Test-Path 'package-lock.json') {
            npm ci
            if ($LASTEXITCODE -ne 0) {
                throw "npm ci failed with exit code $LASTEXITCODE."
            }
        } else {
            npm install
            if ($LASTEXITCODE -ne 0) {
                throw "npm install failed with exit code $LASTEXITCODE."
            }
        }
        npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "Frontend build failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
}

# All generated files stay below out/ so source directories remain reproducible.
$buildRoot = Join-Path $projectRoot 'out\build'

cmake -S $projectRoot -B $buildRoot `
    -G 'Visual Studio 17 2022' -A x64
if ($LASTEXITCODE -ne 0) {
    throw "CMake configure failed with exit code $LASTEXITCODE."
}

cmake --build $buildRoot --config $Configuration --parallel
if ($LASTEXITCODE -ne 0) {
    throw "Native build failed with exit code $LASTEXITCODE."
}

$exe = Join-Path $buildRoot "native\$Configuration\CuteYiyiDesktopPet.exe"
Write-Host "Build complete: $exe"
