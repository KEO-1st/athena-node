# ATHENA screen helper — Windows only, capture side.
# Reads one JSON request per line on stdin, answers one JSON line on stdout.
# It only ever takes pictures; mouse and keyboard live in host-input.ps1.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class AthenaScreen {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
try { [AthenaScreen]::SetProcessDPIAware() | Out-Null } catch { }

$script:framePath = Join-Path $PSScriptRoot "screen-frame.jpg"

function Reply($payload) {
  $json = $payload | ConvertTo-Json -Compress -Depth 5
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Get-Bounds {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  return @{ x = $vs.X; y = $vs.Y; width = $vs.Width; height = $vs.Height }
}

function Capture-Screen([int]$maxWidth) {
  $bounds = Get-Bounds
  $bmp = New-Object System.Drawing.Bitmap($bounds.width, $bounds.height)
  $graphics = [System.Drawing.Graphics]::FromImage($bmp)
  $graphics.CopyFromScreen($bounds.x, $bounds.y, 0, 0, (New-Object System.Drawing.Size($bounds.width, $bounds.height)))
  $graphics.Dispose()

  $width = $bmp.Width
  $height = $bmp.Height
  if ($maxWidth -gt 0 -and $width -gt $maxWidth) {
    $scale = $maxWidth / $width
    $nextWidth = [int][Math]::Round($width * $scale)
    $nextHeight = [int][Math]::Round($height * $scale)
    $small = New-Object System.Drawing.Bitmap($nextWidth, $nextHeight)
    $smallGraphics = [System.Drawing.Graphics]::FromImage($small)
    $smallGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $smallGraphics.DrawImage($bmp, 0, 0, $nextWidth, $nextHeight)
    $smallGraphics.Dispose()
    $bmp.Dispose()
    $bmp = $small
    $width = $nextWidth
    $height = $nextHeight
  }

  # Plain JPEG on purpose: setting encoder quality needs EncoderParameters,
  # which antivirus blocks as a screenshot-stealer signature. Size comes from
  # maxWidth instead.
  $bmp.Save($script:framePath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $bmp.Dispose()

  $bytes = 0
  try { $bytes = (Get-Item -LiteralPath $script:framePath).Length } catch { }

  return @{
    path = $script:framePath
    bytes = $bytes
    width = $width
    height = $height
    screenX = $bounds.x
    screenY = $bounds.y
    screenW = $bounds.width
    screenH = $bounds.height
  }
}

Reply @{ ok = $true; ready = $true; role = 'screen'; version = 1; powershell = $PSVersionTable.PSVersion.ToString() }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }

  $id = $null
  try {
    $cmd = $line | ConvertFrom-Json
    $id = $cmd.id
    $op = [string]$cmd.op

    switch ($op) {
      'info' {
        $bounds = Get-Bounds
        Reply @{
          id = $id; ok = $true
          screenWidth = $bounds.width; screenHeight = $bounds.height
          screenX = $bounds.x; screenY = $bounds.y
        }
      }
      'capture' {
        $maxWidth = 1280
        if ($null -ne $cmd.maxWidth) { $maxWidth = [int]$cmd.maxWidth }
        $frame = Capture-Screen $maxWidth
        $frame['id'] = $id
        $frame['ok'] = $true
        Reply $frame
      }
      default {
        Reply @{ id = $id; ok = $false; error = "Unknown op `"$op`"." }
      }
    }
  } catch {
    Reply @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
}
