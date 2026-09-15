<#
.SYNOPSIS
Verifies the complete prerequisite EXEs embedded in a built offline installer.

.DESCRIPTION
Uses an existing trusted full 7-Zip CLI to test the NSIS archive, extract only
the two prerequisite files into a new out/verification directory, and compare
their sizes and SHA-256 hashes against both source files and the build manifest.
No installer is executed; this is not a clean offline-machine installation test.
The tool is not downloaded or installed by this script.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Installer,
    [Parameter(Mandatory = $true)]
    [string]$SevenZipPath,
    [string]$Manifest,
    [string]$PrerequisiteSource
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = Split-Path -Parent $PSScriptRoot
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$sevenZip = (Resolve-Path -LiteralPath $SevenZipPath).Path
if (-not $Manifest) { $Manifest = "$installerPath.manifest.json" }
if (-not $PrerequisiteSource) {
    $PrerequisiteSource = Join-Path $projectRoot 'out/installer/prerequisites'
}
$manifestPath = (Resolve-Path -LiteralPath $Manifest).Path
$sourceRoot = (Resolve-Path -LiteralPath $PrerequisiteSource).Path
$metadata = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$expectedFiles = @('vc_redist.x64.exe', 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe')

function Get-FileEvidence {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path
    if ($item.PSIsContainer) { throw "Expected a file: $Path" }
    [ordered]@{
        file = $item.Name
        size = $item.Length
        sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    }
}

function Assert-EvidenceEqual {
    param($Actual, $Expected, [string]$Label)
    if ($Actual.size -ne $Expected.size -or
        $Actual.sha256 -ine $Expected.sha256) {
        throw "$Label size or SHA-256 does not match."
    }
}

function Invoke-ArchiveCheck {
    param([string[]]$Arguments)
    $output = @(& $sevenZip @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "7-Zip failed with exit code ${LASTEXITCODE}:`n$($output -join "`n")"
    }
    return ($output -join "`n")
}

if ($metadata.target -ne 'windows-x64' -or
    $metadata.offlinePrerequisites -ne $true -or
    @($metadata.prerequisites).Count -ne $expectedFiles.Count) {
    throw 'Manifest is not a Windows x64 installer with exactly two offline prerequisites.'
}
$installerEvidence = Get-FileEvidence -Path $installerPath
if ($installerEvidence.file -cne $metadata.installer.file -or
    $installerEvidence.file -cne "CloudYiAssistant-Setup-$($metadata.appVersion).exe") {
    throw 'Installer filename and manifest version do not agree.'
}
Assert-EvidenceEqual $installerEvidence $metadata.installer 'Installer/manifest'

# The extraction paths come only from this fixed allowlist, never the manifest.
$archiveEntries = @($expectedFiles | ForEach-Object { '$PLUGINSDIR\' + $_ })
$listing = Invoke-ArchiveCheck -Arguments (@('l', '-slt', '-spd', $installerPath) + $archiveEntries)
if ($listing -notmatch '(?m)^Type = Nsis\r?$') {
    throw 'Installer is not a recognized NSIS archive.'
}
foreach ($archiveEntry in $archiveEntries) {
    $entryPattern = '(?m)^Path = ' + [Regex]::Escape($archiveEntry) + '\r?$'
    if ([Regex]::Matches($listing, $entryPattern).Count -ne 1) {
        throw "Expected exactly one embedded entry: $archiveEntry"
    }
}

$testOutput = Invoke-ArchiveCheck -Arguments @('t', $installerPath)
$verificationRoot = Join-Path $projectRoot 'out/verification'
$runRoot = Join-Path $verificationRoot ('offline-payload-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot | Out-Null
$extractOutput = Invoke-ArchiveCheck -Arguments (
    @('e', '-spd', '-y', "-o$runRoot", $installerPath) + $archiveEntries
)
$actualFiles = @(Get-ChildItem -LiteralPath $runRoot -File)
if ($actualFiles.Count -ne $expectedFiles.Count) {
    throw 'Extraction did not produce exactly the two prerequisite EXEs.'
}

$verifiedPrerequisites = foreach ($filename in $expectedFiles) {
    $records = @($metadata.prerequisites | Where-Object { $_.file -ceq $filename })
    if ($records.Count -ne 1) { throw "Missing or duplicate manifest record: $filename" }
    $sourceEvidence = Get-FileEvidence -Path (Join-Path $sourceRoot $filename)
    $embeddedEvidence = Get-FileEvidence -Path (Join-Path $runRoot $filename)
    Assert-EvidenceEqual $sourceEvidence $records[0] "$filename source/manifest"
    Assert-EvidenceEqual $embeddedEvidence $records[0] "$filename embedded/manifest"
    Assert-EvidenceEqual $embeddedEvidence $sourceEvidence "$filename embedded/source"
    [ordered]@{
        file = $filename
        size = $embeddedEvidence.size
        sha256 = $embeddedEvidence.sha256
        sourceMatches = $true
        manifestMatches = $true
    }
}

$report = [ordered]@{
    checkedAt = [DateTimeOffset]::UtcNow.ToString('o')
    appVersion = $metadata.appVersion
    scope = 'Archive integrity and embedded prerequisites; no installer executed.'
    cleanOfflineMachineInstallTestPerformed = $false
    archiveIntegrityPassed = $true
    installer = $installerEvidence
    tool = [ordered]@{
        path = $sevenZip
        version = (Get-Item -LiteralPath $sevenZip).VersionInfo.FileVersion
    }
    prerequisites = @($verifiedPrerequisites)
}
$reportPath = Join-Path $runRoot 'verification.json'
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Host "PASS: complete prerequisite EXEs match source and manifest for $($metadata.appVersion)."
Write-Host "Report: $reportPath"
Write-Host 'No installer was executed; a clean offline-machine installation test remains separate.'
