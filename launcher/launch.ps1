# Airwave Discovery launcher (Windows). Starts the local server if it is not running, opens the app
# window, and stops the server it started once that window is closed (from the taskbar or the window's X).
# Only the server this launcher started is stopped; a server started some other way is left alone.
param([int]$Port = 8787, [switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$demo = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:$Port/"
$data = Join-Path $demo '.data'
$profile = Join-Path $data 'app-window-profile'
New-Item -ItemType Directory -Force -Path $data | Out-Null
$log = Join-Path $data 'launcher.log'

function Say($m) { Add-Content -Path $log -Value ("{0:s} {1}" -f (Get-Date), $m) }
function Fail($m) {
  Say "FAIL $m"
  (New-Object -ComObject WScript.Shell).Popup("$m`n`nDetails: $log", 0, 'Airwave Discovery', 16) | Out-Null
  exit 1
}
function Test-Up {
  try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri ($url + 'api/health')).StatusCode -eq 200 } catch { $false }
}
# Every Edge process that belongs to the Airwave window profile. None left means the window is closed.
function Get-AppWindowProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*--user-data-dir=$profile*" })
}
function Stop-Server {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -LocalAddress 127.0.0.1 -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listener) { return }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
  if ($p.CommandLine -notmatch 'airwave_discovery') { Say "port $Port is held by another program; left alone"; return }
  # the server, then the uvicorn/uv/node processes that started it
  $kill = @($p.ProcessId)
  $pp = $p.ParentProcessId
  while ($pp) {
    $q = Get-CimInstance Win32_Process -Filter "ProcessId=$pp"
    if (-not $q -or $q.Name -notmatch '^(uv|uvicorn|node|python)\.exe$') { break }
    $kill += $pp
    $pp = $q.ParentProcessId
  }
  $kill | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
  Say "server stopped (PIDs $($kill -join ', '))"
}

$started = $false
if (-not (Test-Up)) {
  $busy = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if ($busy) { Fail "Port $Port is used by another program (PID $($busy[0].OwningProcess)). Stop it or free the port." }
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Fail 'Node 22 or newer was not found on PATH.' }
  Say "starting server on $url"
  $env:PYTHONPATH = ''   # the Hermes desktop app leaks a PYTHONPATH that breaks uv
  $env:AIRWAVE_DISCOVERY_PORT = "$Port"
  Start-Process -FilePath $node -ArgumentList @((Join-Path $demo 'start.mjs'), '--port', "$Port") `
    -WorkingDirectory $demo -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $data 'server.out.log') -RedirectStandardError (Join-Path $data 'server.err.log')
  $deadline = (Get-Date).AddSeconds(240)   # a first run may rebuild the web app
  while (-not (Test-Up)) {
    if ((Get-Date) -gt $deadline) { Fail "The server did not answer within 4 minutes. See $data\server.err.log" }
    Start-Sleep -Milliseconds 500
  }
  $started = $true
  Say 'server is up'
}
if ($NoOpen) { exit 0 }

# A window for this profile is already open: it has its own watcher, so this launch is done.
if ((Get-AppWindowProcesses).Count -gt 0) { Say 'window already open'; exit 0 }

$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
          "$env:ProgramFiles\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) {
  Start-Process $url   # no app-window browser: default browser, nothing to watch, so the server stays up
  exit 0
}
# its own profile folder, so the app window never joins the user's normal browser windows
Start-Process -FilePath $edge -ArgumentList @("--app=$url", "--user-data-dir=$profile", '--window-size=1280,900', '--no-first-run')
$t = (Get-Date).AddSeconds(20)
while ((Get-AppWindowProcesses).Count -eq 0 -and (Get-Date) -lt $t) { Start-Sleep -Milliseconds 300 }
if ((Get-AppWindowProcesses).Count -eq 0) { Fail 'The app window did not open.' }
Say 'window open; watching it'

if ($started) {
  # watch until the last Airwave window is gone (two quiet checks, so a brief restart does not count)
  $quiet = 0
  while ($quiet -lt 2) {
    Start-Sleep -Seconds 2
    if ((Get-AppWindowProcesses).Count -eq 0) { $quiet++ } else { $quiet = 0 }
  }
  Stop-Server
  Say 'window closed'
}
