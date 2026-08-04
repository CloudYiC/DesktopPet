<#
.SYNOPSIS
Checks project-owned native sources for common post-C++11 constructs.

.DESCRIPTION
MSVC does not provide a dedicated /std:c++11 switch, so CMake's C++11 setting
is supplemented with a source audit. Third-party code is intentionally excluded.
#>

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nativeRoot = Join-Path $projectRoot 'native'
$cmakePath = Join-Path $projectRoot 'CMakeLists.txt'

$cmakeText = Get-Content -LiteralPath $cmakePath -Raw
if ($cmakeText -notmatch 'set\(CMAKE_CXX_STANDARD\s+11\)') {
    throw 'CMakeLists.txt must set CMAKE_CXX_STANDARD to 11.'
}

$forbiddenPatterns = [ordered]@{
    'std::filesystem\b' = 'C++17 std::filesystem'
    'std::optional\b' = 'C++17 std::optional'
    'std::nullopt\b' = 'C++17 std::nullopt'
    'std::clamp\b' = 'C++17 std::clamp'
    'std::make_unique\b' = 'C++14 std::make_unique'
    'std::string_view\b' = 'C++17 std::string_view'
    'std::variant\b' = 'C++17 std::variant'
    'std::any\b' = 'C++17 std::any'
    'std::byte\b' = 'C++17 std::byte'
    'if\s+constexpr' = 'C++17 if constexpr'
    '\[\[(nodiscard|maybe_unused|fallthrough)\]\]' = 'C++17 standard attribute'
    '(const\s+)?auto\s*\[[^\]]+\]\s*=' = 'C++17 structured binding'
    '\[[^\]]*\]\s*\(\s*auto(?:\s|&|\*)' = 'C++14 generic lambda'
    '(?<![A-Za-z0-9_])\d[\d]*''\d' = 'C++14 digit separator'
}

$sourceFiles = Get-ChildItem -LiteralPath $nativeRoot -Recurse -File |
    Where-Object { $_.Extension -in @('.h', '.hpp', '.cpp', '.cc') }

$violations = foreach ($file in $sourceFiles) {
    $content = Get-Content -LiteralPath $file.FullName -Raw
    foreach ($entry in $forbiddenPatterns.GetEnumerator()) {
        if ($content -match $entry.Key) {
            [pscustomobject]@{
                File = $file.FullName.Substring($projectRoot.Length + 1)
                Feature = $entry.Value
            }
        }
    }
}

if ($violations) {
    $details = ($violations | ForEach-Object {
        "  $($_.File): $($_.Feature)"
    }) -join [Environment]::NewLine
    throw "Post-C++11 code was found:`n$details"
}

Write-Host "C++11 compatibility check passed ($($sourceFiles.Count) source files)."
