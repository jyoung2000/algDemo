# Creates the "Airwave Discovery" shortcuts (Desktop and Start Menu) with the Airwave icon.
# Closing the app window (taskbar or its X) stops the server; there is no separate stop shortcut.
$here = $PSScriptRoot
$ws = New-Object -ComObject WScript.Shell
$targets = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'))
foreach ($dir in $targets) {
  # the stop shortcut from earlier versions
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $dir 'Stop Airwave Discovery.lnk')
  $lnk = $ws.CreateShortcut((Join-Path $dir 'Airwave Discovery.lnk'))
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = '"' + (Join-Path $here 'run-hidden.vbs') + '" launch.ps1'
  $lnk.WorkingDirectory = $here
  $lnk.IconLocation = (Join-Path $here 'airwave-discovery.ico') + ',0'
  $lnk.Description = 'Start Airwave Discovery. Close its window to stop the server.'
  $lnk.Save()
  Write-Host "created $($lnk.FullName)"
}
