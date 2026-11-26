# ATHENA input helper — Windows only, mouse and keyboard side.
# Reads one JSON request per line on stdin, answers one JSON line on stdout.
# It never captures the screen; that lives in host-screen.ps1.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class AthenaInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, IntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint flags, UIntPtr extra);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  public static int[] Cursor() {
    POINT p;
    GetCursorPos(out p);
    return new int[] { p.X, p.Y };
  }
}
'@
try { [AthenaInput]::SetProcessDPIAware() | Out-Null } catch { }

function Reply($payload) {
  $json = $payload | ConvertTo-Json -Compress -Depth 5
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Send-Click([int]$x, [int]$y, [string]$button, [int]$clicks) {
  [AthenaInput]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 35
  $down = 0x0002
  $up = 0x0004
  if ($button -eq 'right') { $down = 0x0008; $up = 0x0010 }
  elseif ($button -eq 'middle') { $down = 0x0020; $up = 0x0040 }
  if ($clicks -lt 1) { $clicks = 1 }
  for ($i = 0; $i -lt $clicks; $i++) {
    [AthenaInput]::mouse_event($down, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 28
    [AthenaInput]::mouse_event($up, 0, 0, 0, [IntPtr]::Zero)
    if ($i -lt $clicks - 1) { Start-Sleep -Milliseconds 90 }
  }
}

function Send-Scroll([int]$amount) {
  if ($amount -eq 0) { $amount = 3 }
  $steps = [Math]::Min([Math]::Abs($amount), 20)
  $delta = 120
  if ($amount -lt 0) { $delta = -120 }
  for ($i = 0; $i -lt $steps; $i++) {
    [AthenaInput]::mouse_event(0x0800, 0, 0, $delta, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 40
  }
}

# Virtual-key codes. SendKeys cannot press the Windows key at all, so keys go
# through keybd_event and a real VK table instead.
$script:VK = @{
  'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B
  'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E; 'space' = 0x20; 'spacebar' = 0x20
  'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
  'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pgup' = 0x21; 'pagedown' = 0x22; 'pgdn' = 0x22
  'insert' = 0x2D; 'ins' = 0x2D; 'printscreen' = 0x2C; 'prtsc' = 0x2C
  'win' = 0x5B; 'windows' = 0x5B; 'lwin' = 0x5B; 'rwin' = 0x5C; 'super' = 0x5B
  'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12; 'shift' = 0x10
  'apps' = 0x5D; 'menu' = 0x5D; 'capslock' = 0x14; 'numlock' = 0x90; 'scrolllock' = 0x91; 'pause' = 0x13
  'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73; 'f5' = 0x74; 'f6' = 0x75
  'f7' = 0x76; 'f8' = 0x77; 'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B
  'volumeup' = 0xAF; 'volumedown' = 0xAE; 'volumemute' = 0xAD
  'playpause' = 0xB3; 'nexttrack' = 0xB0; 'prevtrack' = 0xB1
}

function Resolve-Vk([string]$name) {
  $key = $name.Trim().ToLower()
  if (-not $key) { return $null }
  if ($script:VK.ContainsKey($key)) { return [byte]$script:VK[$key] }
  if ($key.Length -eq 1) {
    # letters, digits and the punctuation that maps 1:1 to a VK code
    $upper = $key.ToUpper()
    if ($upper -match '^[A-Z0-9]$') { return [byte][char]$upper }
  }
  return $null
}

function Send-KeyCombo([string]$name) {
  $parts = @($name.Split('+') | Where-Object { $_ -ne '' })
  if ($parts.Count -eq 0) { throw 'Nothing to press.' }
  $codes = @()
  foreach ($part in $parts) {
    $code = Resolve-Vk $part
    if ($null -eq $code) { throw "Unknown key '$part'." }
    $codes += $code
  }
  $KEYUP = 0x0002
  # every key but the last is held down, the last is tapped, then all release
  for ($i = 0; $i -lt $codes.Count - 1; $i++) {
    [AthenaInput]::keybd_event($codes[$i], 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 18
  }
  $lastVk = $codes[-1]
  [AthenaInput]::keybd_event($lastVk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 45
  [AthenaInput]::keybd_event($lastVk, 0, $KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 18
  for ($i = $codes.Count - 2; $i -ge 0; $i--) {
    [AthenaInput]::keybd_event($codes[$i], 0, $KEYUP, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 12
  }
  return $name
}

function Send-Text([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return }
  $copied = $false
  try {
    Set-Clipboard -Value $text
    Start-Sleep -Milliseconds 70
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    $copied = $true
  } catch {
    $copied = $false
  }
  if (-not $copied) {
    $escaped = $text -replace '([+^%~(){}\[\]])', '{$1}'
    [System.Windows.Forms.SendKeys]::SendWait($escaped)
  }
}

Reply @{ ok = $true; ready = $true; role = 'input'; version = 1; powershell = $PSVersionTable.PSVersion.ToString() }

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
        $cursor = [AthenaInput]::Cursor()
        Reply @{ id = $id; ok = $true; cursorX = $cursor[0]; cursorY = $cursor[1] }
      }
      'move' {
        [AthenaInput]::SetCursorPos([int]$cmd.x, [int]$cmd.y) | Out-Null
        Reply @{ id = $id; ok = $true }
      }
      'click' {
        $button = 'left'
        if ($cmd.button) { $button = [string]$cmd.button }
        $clicks = 1
        if ($cmd.clicks) { $clicks = [int]$cmd.clicks }
        Send-Click ([int]$cmd.x) ([int]$cmd.y) $button $clicks
        Reply @{ id = $id; ok = $true }
      }
      'scroll' {
        $amount = 3
        if ($null -ne $cmd.amount) { $amount = [int]$cmd.amount }
        Send-Scroll $amount
        Reply @{ id = $id; ok = $true }
      }
      'key' {
        $sent = Send-KeyCombo ([string]$cmd.key)
        Reply @{ id = $id; ok = $true; sent = $sent }
      }
      'type' {
        Send-Text ([string]$cmd.text)
        Reply @{ id = $id; ok = $true }
      }
      default {
        Reply @{ id = $id; ok = $false; error = "Unknown op `"$op`"." }
      }
    }
  } catch {
    Reply @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
}
