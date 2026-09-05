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
$outRoot = Join-Path $projectRoot 'out'
$generatedIconRoot = Join-Path $outRoot 'generated\app-icons'
$generatedAppPng = Join-Path $generatedIconRoot 'app-icon.png'
$generatedAppIco = Join-Path $generatedIconRoot 'CuteYiyiDesktopPet.ico'
$publicCharacterSource = Join-Path $projectRoot `
    'frontend\public\assets\milo-sprite.png'
$privateCharacterSource = Join-Path $projectRoot `
    'artifacts\private-characters\default-girl.png'

& (Join-Path $PSScriptRoot 'check-cxx11.ps1')
& (Join-Path $PSScriptRoot 'bootstrap-native-deps.ps1')

# Generate build-only branding without copying private artwork into a tracked
# source directory. Public clones deterministically fall back to the mouse.
$appIconSource = $publicCharacterSource
$appIconLayout = 'Sprite4x2'
if (Test-Path -LiteralPath $privateCharacterSource) {
    $appIconSource = $privateCharacterSource
    $appIconLayout = 'Single'
    Write-Host 'Application branding: packaged pink Yiyi character'
} else {
    Write-Host 'Application branding: public mouse fallback'
}
& (Join-Path $PSScriptRoot 'generate-app-icons.ps1') `
    -SourceSprite $appIconSource `
    -SourceLayout $appIconLayout `
    -PngOutput $generatedAppPng `
    -IcoOutput $generatedAppIco

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

# The generated favicon follows the selected native brand icon. Both outputs
# remain below ignored build directories when the private character is used.
$generatedAppPngOutput = Join-Path $projectRoot `
    'frontend\dist\assets\app-icon.png'
New-Item -ItemType Directory -Force `
    -Path (Split-Path -Parent $generatedAppPngOutput) | Out-Null
Copy-Item -LiteralPath $generatedAppPng `
    -Destination $generatedAppPngOutput -Force

# Personal character artwork stays under the ignored artifacts directory. When
# present locally it is copied only into generated UI output and the installer;
# public source builds remain functional and fall back to the mouse character.
$privateCharacterOutput = Join-Path $projectRoot `
    'frontend\dist\assets\private-default-girl.png'
if (Test-Path -LiteralPath $privateCharacterSource) {
    New-Item -ItemType Directory -Force `
        -Path (Split-Path -Parent $privateCharacterOutput) | Out-Null
    Copy-Item -LiteralPath $privateCharacterSource `
        -Destination $privateCharacterOutput -Force
    Write-Host "Private installer character: $privateCharacterOutput"
} elseif (-not $SkipFrontend) {
    Write-Host 'Private installer character not found; using the public mouse default.'
}

# All generated files stay below out/ so source directories remain reproducible.
$buildRoot = Join-Path $outRoot 'build'

cmake -S $projectRoot -B $buildRoot `
    -G 'Visual Studio 17 2022' -A x64 `
    "-DCLOUDYI_APP_ICON=$generatedAppIco"
if ($LASTEXITCODE -ne 0) {
    throw "CMake configure failed with exit code $LASTEXITCODE."
}

cmake --build $buildRoot --config $Configuration --parallel
if ($LASTEXITCODE -ne 0) {
    throw "Native build failed with exit code $LASTEXITCODE."
}

$exe = Join-Path $buildRoot "native\$Configuration\CuteYiyiDesktopPet.exe"
Write-Host "Build complete: $exe"
