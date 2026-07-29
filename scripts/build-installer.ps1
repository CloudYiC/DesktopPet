<#
.SYNOPSIS
Builds the signed-prerequisite, offline-capable Windows installer.

.DESCRIPTION
Builds the Release app, obtains a pinned NSIS compiler, validates Microsoft
signatures on redistributable prerequisites, and emits an NSIS setup executable
under out/dist.
#>
param(
    [switch]$SkipAppBuild
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$outRoot = Join-Path $projectRoot 'out'
$releaseRoot = Join-Path $outRoot 'build\native\Release'
$downloadRoot = Join-Path $outRoot 'downloads'
$toolRoot = Join-Path $outRoot 'tools'
$nsisRoot = Join-Path $toolRoot 'nsis-3.12'
$makensis = Join-Path $nsisRoot 'makensis.exe'
$nsisPackageCache = Join-Path $toolRoot 'nsis-package-cache-3.12.0'
$nsisSetupHash = '3BC2B06253A7E4957111BE152AC6A536E0C7478A706E19DA814038DB5D706495'
$installerCache = Join-Path $outRoot 'installer\prerequisites'
$outputRoot = Join-Path $outRoot 'dist'
$installerScript = Join-Path $projectRoot 'installer\CuteYiyiDesktopPet.nsi'
$appIcon = Join-Path $projectRoot 'native\resources\CuteYiyiDesktopPet.ico'
$appExe = Join-Path $releaseRoot 'CuteYiyiDesktopPet.exe'
$uiRoot = Join-Path $releaseRoot 'ui'

$cmakeText = Get-Content -LiteralPath (Join-Path $projectRoot 'CMakeLists.txt') -Raw
# CMake is the single source of truth for the product version passed to NSIS.
$versionMatch = [regex]::Match(
    $cmakeText,
    'project\(\s*[A-Za-z0-9_-]+\s+VERSION\s+([0-9]+\.[0-9]+\.[0-9]+)')
if (-not $versionMatch.Success) {
    throw 'Unable to read the application version from CMakeLists.txt.'
}
$appVersion = $versionMatch.Groups[1].Value
$appFileVersion = "$appVersion.0"

function Get-Download {
    param(
        [Parameter(Mandatory)]
        [string]$Uri,
        [Parameter(Mandatory)]
        [string]$Destination
    )

    if (Test-Path -LiteralPath $Destination) {
        return
    }
    Write-Host "Downloading $Uri"
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
}

function Assert-MicrosoftSignature {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid' -or
        $signature.SignerCertificate.Subject -notlike '*Microsoft Corporation*') {
        throw "The prerequisite is not validly signed by Microsoft: $Path"
    }
}

function Assert-ChildPath {
    param(
        [Parameter(Mandatory)]
        [string]$Parent,
        [Parameter(Mandatory)]
        [string]$Child
    )

    # Destructive cache refreshes are allowed only inside the declared tool root.
    $resolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $resolvedChild = [IO.Path]::GetFullPath($Child)
    if (-not $resolvedChild.StartsWith(
            $resolvedParent,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside $resolvedParent`: $resolvedChild"
    }
}

New-Item -ItemType Directory -Force -Path $outRoot, $downloadRoot, $toolRoot,
    $installerCache, $outputRoot | Out-Null

# Stop only the binary currently being rebuilt, not an installed copy elsewhere.
$runningApp = @(
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -eq 'CuteYiyiDesktopPet.exe' -and
            $_.ExecutablePath -eq $appExe
        }
)
$restartApp = $runningApp.Count -gt 0

try {
    if (-not $SkipAppBuild) {
        foreach ($process in $runningApp) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
        & (Join-Path $PSScriptRoot 'build.ps1') -Configuration Release
        if ($LASTEXITCODE -ne 0) {
            throw "Release build failed with exit code $LASTEXITCODE."
        }
    }

    if (-not (Test-Path -LiteralPath $appExe) -or
        -not (Test-Path -LiteralPath (Join-Path $uiRoot 'index.html'))) {
        throw 'Release application files are missing. Build the Release configuration first.'
    }

    if (-not (Test-Path -LiteralPath $makensis)) {
        $nsisPackage = Join-Path $downloadRoot 'nsis.install.3.12.0.nupkg'
        Get-Download `
            -Uri 'https://community.chocolatey.org/api/v2/package/nsis.install/3.12.0' `
            -Destination $nsisPackage

        if (Test-Path -LiteralPath $nsisPackageCache) {
            Assert-ChildPath -Parent $toolRoot -Child $nsisPackageCache
            Remove-Item -LiteralPath $nsisPackageCache -Recurse -Force
        }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory(
            $nsisPackage,
            $nsisPackageCache)

        $nsisSetup = Join-Path $nsisPackageCache 'tools\nsis-3.12-setup.exe'
        if (-not (Test-Path -LiteralPath $nsisSetup)) {
            throw "NSIS setup was not found in the downloaded package: $nsisSetup"
        }
        $actualNsisHash =
            (Get-FileHash -LiteralPath $nsisSetup -Algorithm SHA256).Hash
        if ($actualNsisHash -ne $nsisSetupHash) {
            throw "NSIS setup checksum mismatch. Expected $nsisSetupHash, got $actualNsisHash."
        }

        $nsisInstall = Start-Process `
            -FilePath $nsisSetup `
            -ArgumentList @('/S', "/D=$nsisRoot") `
            -WindowStyle Hidden `
            -Wait `
            -PassThru
        if ($nsisInstall.ExitCode -notin @(0, 3010)) {
            throw "NSIS setup failed with exit code $($nsisInstall.ExitCode)."
        }
    }

    if (-not (Test-Path -LiteralPath $makensis)) {
        throw "NSIS compiler was not found after installation: $makensis"
    }

    $vcRedist = Join-Path $installerCache 'vc_redist.x64.exe'
    $webViewBootstrapper =
        Join-Path $installerCache 'MicrosoftEdgeWebView2Setup.exe'
    Get-Download `
        -Uri 'https://aka.ms/vc14/vc_redist.x64.exe' `
        -Destination $vcRedist
    Get-Download `
        -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' `
        -Destination $webViewBootstrapper
    Assert-MicrosoftSignature -Path $vcRedist
    Assert-MicrosoftSignature -Path $webViewBootstrapper

    & $makensis `
        "/INPUTCHARSET" `
        "UTF8" `
        "/DAPP_VERSION=$appVersion" `
        "/DAPP_FILE_VERSION=$appFileVersion" `
        "/DAPP_SOURCE=$releaseRoot" `
        "/DAPP_ICON=$appIcon" `
        "/DPREREQ_SOURCE=$installerCache" `
        "/DOUTPUT_DIR=$outputRoot" `
        $installerScript
    if ($LASTEXITCODE -ne 0) {
        throw "Installer build failed with exit code $LASTEXITCODE."
    }

    $installer = Join-Path $outputRoot "CuteYiyiDesktopPet-Setup-$appVersion.exe"
    if (-not (Test-Path -LiteralPath $installer)) {
        throw "Installer output was not created: $installer"
    }
    $hash = Get-FileHash -LiteralPath $installer -Algorithm SHA256
    Write-Host "Installer complete: $installer"
    Write-Host "SHA256: $($hash.Hash)"
} finally {
    if ($restartApp -and -not (
            Get-Process -Name 'CuteYiyiDesktopPet' -ErrorAction SilentlyContinue)) {
        Start-Process -FilePath $appExe -WorkingDirectory $releaseRoot
    }
}
