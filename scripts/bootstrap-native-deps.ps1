<#
.SYNOPSIS
Downloads the pinned native SDK and header-only dependencies.

.DESCRIPTION
Populates third_party from fixed upstream versions. Existing artifacts are
reused so regular builds remain fast and do not require repeated downloads.
#>
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$dependenciesRoot = Join-Path $projectRoot 'third_party'
$cacheRoot = Join-Path $dependenciesRoot '.cache'

New-Item -ItemType Directory -Force -Path $dependenciesRoot, $cacheRoot | Out-Null

function Get-DependencyArchive {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if (-not (Test-Path $Destination)) {
        Write-Host "Downloading $Uri"
        Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing
    }
}

# Keep these versions aligned with the paths validated in native/CMakeLists.txt.
$webViewVersion = '1.0.4078.44'
$webViewRoot = Join-Path $dependenciesRoot 'webview2'
$webViewHeader = Join-Path $webViewRoot 'build\native\include\WebView2.h'
if (-not (Test-Path $webViewHeader)) {
    $webViewArchive = Join-Path $cacheRoot "Microsoft.Web.WebView2.$webViewVersion.zip"
    Get-DependencyArchive `
        -Uri "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$webViewVersion" `
        -Destination $webViewArchive
    Expand-Archive -LiteralPath $webViewArchive -DestinationPath $webViewRoot -Force
}

$sqliteVersion = '3530300'
$sqliteRoot = Join-Path $dependenciesRoot 'sqlite'
$sqliteSource = Join-Path $sqliteRoot "sqlite-amalgamation-$sqliteVersion\sqlite3.c"
if (-not (Test-Path $sqliteSource)) {
    $sqliteArchive = Join-Path $cacheRoot "sqlite-amalgamation-$sqliteVersion.zip"
    Get-DependencyArchive `
        -Uri "https://www.sqlite.org/2026/sqlite-amalgamation-$sqliteVersion.zip" `
        -Destination $sqliteArchive
    Expand-Archive -LiteralPath $sqliteArchive -DestinationPath $sqliteRoot -Force
}

$jsonVersion = '3.12.0'
$jsonHeader = Join-Path $dependenciesRoot 'nlohmann\include\nlohmann\json.hpp'
if (-not (Test-Path $jsonHeader)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $jsonHeader) | Out-Null
    Get-DependencyArchive `
        -Uri "https://raw.githubusercontent.com/nlohmann/json/v$jsonVersion/single_include/nlohmann/json.hpp" `
        -Destination $jsonHeader
}

Write-Host 'Native dependencies are ready.'
