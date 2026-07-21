param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug',
    [switch]$SkipFrontend
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

& (Join-Path $PSScriptRoot 'bootstrap-native-deps.ps1')

if (-not $SkipFrontend) {
    Push-Location (Join-Path $projectRoot 'frontend')
    try {
        if (Test-Path 'package-lock.json') {
            npm ci
        } else {
            npm install
        }
        npm run build
    } finally {
        Pop-Location
    }
}

$buildRoot = Join-Path $projectRoot 'out\build'

cmake -S $projectRoot -B $buildRoot `
    -G 'Visual Studio 17 2022' -A x64

cmake --build $buildRoot --config $Configuration --parallel

$exe = Join-Path $buildRoot "native\$Configuration\CuteYiyiDesktopPet.exe"
Write-Host "Build complete: $exe"
