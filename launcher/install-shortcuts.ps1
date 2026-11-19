# Creates the "jPlay" shortcuts (Desktop and Start Menu) with the jPlay icon (JPLAY-BRAND-001).
# Closing the app window (taskbar or its X) stops the server; there is no separate stop shortcut.
$here = $PSScriptRoot
$ws = New-Object -ComObject WScript.Shell
$targets = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'))
foreach ($dir in $targets) {
  # shortcuts from earlier versions (the app was called Airwave Discovery)
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $dir 'Stop Airwave Discovery.lnk')
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $dir 'Airwave Discovery.lnk')
  $lnk = $ws.CreateShortcut((Join-Path $dir 'jPlay.lnk'))
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = '"' + (Join-Path $here 'run-hidden.vbs') + '" launch.ps1'
  $lnk.WorkingDirectory = $here
  $lnk.IconLocation = (Join-Path $here 'jplay.ico') + ',0'
  $lnk.Description = 'Start jPlay. Close its window to stop the server.'
  $lnk.Save()
  Write-Host "created $($lnk.FullName)"
}
