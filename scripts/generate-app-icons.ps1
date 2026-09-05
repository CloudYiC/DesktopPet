<#
.SYNOPSIS
Generates the application PNG and multi-resolution Windows ICO assets.

.DESCRIPTION
Produces a deterministic brand icon from either the bundled 4x2 mouse sprite
or a single transparent character image. The ICO contains native-size PNG
frames for the executable, window, notification area, installer, and uninstaller.
#>
param(
    [string]$SourceSprite,
    [ValidateSet('Sprite4x2', 'Single')]
    [string]$SourceLayout = 'Sprite4x2',
    [string]$PngOutput,
    [string]$IcoOutput
)

# Keeping this transformation scripted makes future branding changes
# reproducible instead of relying on an opaque, manually edited ICO file.

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

if (-not $SourceSprite) {
    $SourceSprite = Join-Path $projectRoot 'frontend\public\assets\milo-sprite.png'
}
if (-not $PngOutput) {
    $PngOutput = Join-Path $projectRoot 'frontend\public\assets\app-icon.png'
}
if (-not $IcoOutput) {
    $IcoOutput = Join-Path $projectRoot 'native\resources\CuteYiyiDesktopPet.ico'
}

Add-Type -AssemblyName System.Drawing

function New-RoundedRectanglePath {
    param(
        [Parameter(Mandatory)]
        [System.Drawing.RectangleF]$Bounds,
        [Parameter(Mandatory)]
        [float]$Radius
    )

    $diameter = $Radius * 2
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc($Bounds.Left, $Bounds.Top, $diameter, $diameter, 180, 90)
    $path.AddArc($Bounds.Right - $diameter, $Bounds.Top,
        $diameter, $diameter, 270, 90)
    $path.AddArc($Bounds.Right - $diameter, $Bounds.Bottom - $diameter,
        $diameter, $diameter, 0, 90)
    $path.AddArc($Bounds.Left, $Bounds.Bottom - $diameter,
        $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-ScaledIconBitmap {
    param(
        [Parameter(Mandatory)]
        [System.Drawing.Image]$Source,
        [Parameter(Mandatory)]
        [int]$Size,
        [Parameter(Mandatory)]
        [ValidateSet('Sprite4x2', 'Single')]
        [string]$Layout
    )

    $bitmap = [System.Drawing.Bitmap]::new(
        $Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.SmoothingMode =
            [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.InterpolationMode =
            [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode =
            [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.CompositingQuality =
            [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

        $scale = $Size / 512.0
        $outerBounds = [System.Drawing.RectangleF]::new(
            3 * $scale, 3 * $scale, 506 * $scale, 506 * $scale)
        $innerBounds = [System.Drawing.RectangleF]::new(
            24 * $scale, 24 * $scale, 464 * $scale, 464 * $scale)
        $outerPath = New-RoundedRectanglePath $outerBounds (104 * $scale)
        $innerPath = New-RoundedRectanglePath $innerBounds (88 * $scale)
        $outerBrush = [System.Drawing.SolidBrush]::new(
            [System.Drawing.Color]::FromArgb(255, 22, 139, 133))
        $innerBrush = [System.Drawing.SolidBrush]::new(
            [System.Drawing.Color]::FromArgb(255, 255, 247, 235))
        try {
            $graphics.FillPath($outerBrush, $outerPath)
            $graphics.FillPath($innerBrush, $innerPath)
        } finally {
            $outerBrush.Dispose()
            $innerBrush.Dispose()
            $outerPath.Dispose()
            $innerPath.Dispose()
        }

        if ($Layout -eq 'Single') {
            # A single transparent character is cropped to its upper body. The
            # tighter crop keeps the face recognizable in 16x16 tray icons.
            $sourceBounds = [System.Drawing.RectangleF]::new(
                $Source.Width * 0.15,
                $Source.Height * 0.02,
                $Source.Width * 0.70,
                $Source.Height * 0.70)
        } else {
            # The first 4x2 sprite cell contains the neutral front-facing mouse.
            $sourceBounds = [System.Drawing.RectangleF]::new(38, 68, 318, 342)
        }
        $destinationBounds = [System.Drawing.RectangleF]::new(
            42 * $scale, 34 * $scale, 428 * $scale, 450 * $scale)
        $graphics.DrawImage(
            $Source,
            $destinationBounds,
            $sourceBounds,
            [System.Drawing.GraphicsUnit]::Pixel)
    } finally {
        $graphics.Dispose()
    }
    return $bitmap
}

function Convert-BitmapToPngBytes {
    param(
        [Parameter(Mandatory)]
        [System.Drawing.Bitmap]$Bitmap
    )

    $memory = [System.IO.MemoryStream]::new()
    try {
        $Bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
        return $memory.ToArray()
    } finally {
        $memory.Dispose()
    }
}

foreach ($outputPath in @($PngOutput, $IcoOutput)) {
    $directory = Split-Path -Parent $outputPath
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

$sourceImage = [System.Drawing.Image]::FromFile($SourceSprite)
try {
    $master = New-ScaledIconBitmap `
        -Source $sourceImage -Size 512 -Layout $SourceLayout
    try {
        $master.Save($PngOutput, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $master.Dispose()
    }

    $frames = foreach ($size in @(16, 20, 24, 32, 40, 48, 64, 128, 256)) {
        $bitmap = New-ScaledIconBitmap `
            -Source $sourceImage -Size $size -Layout $SourceLayout
        try {
            [pscustomobject]@{
                Size = $size
                # Preserve Byte[] as one property value. PowerShell otherwise
                # enumerates it and BinaryWriter may select the Boolean overload.
                Bytes = [byte[]](Convert-BitmapToPngBytes -Bitmap $bitmap)
            }
        } finally {
            $bitmap.Dispose()
        }
    }
} finally {
    $sourceImage.Dispose()
}

# ICO files are a directory followed by one image payload per entry. PNG
# payloads preserve alpha correctly and are supported by modern Windows.
$iconStream = [System.IO.MemoryStream]::new()
$writer = [System.IO.BinaryWriter]::new($iconStream)
try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$frames.Count)
    $offset = 6 + (16 * $frames.Count)

    foreach ($frame in $frames) {
        $encodedSize = if ($frame.Size -eq 256) { 0 } else { $frame.Size }
        $writer.Write([byte]$encodedSize)
        $writer.Write([byte]$encodedSize)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$frame.Bytes.Length)
        $writer.Write([uint32]$offset)
        $offset += $frame.Bytes.Length
    }
    foreach ($frame in $frames) {
        $writer.Write([byte[]]$frame.Bytes)
    }
    $writer.Flush()
    [System.IO.File]::WriteAllBytes($IcoOutput, $iconStream.ToArray())
} finally {
    $writer.Dispose()
    $iconStream.Dispose()
}

Write-Host "PNG icon: $PngOutput"
Write-Host "ICO icon: $IcoOutput"
