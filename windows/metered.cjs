'use strict';
// ALLOWANCE-ARCH-001: is this connection metered? Windows is asked (the same answer Settings > Network shows as
// "Metered connection"). The app's mobile data allowance applies only when it says yes; a desktop on Wi-Fi or a
// cable is never limited. Asked at most once a minute, off the main thread's path; costs no network.
const { execFile } = require('node:child_process');

const QUESTION = [
  '[void][Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]',
  '$p=[Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()',
  "if($p){$c=$p.GetConnectionCost(); '{0}|{1}|{2}' -f $c.NetworkCostType,$c.Roaming,$c.OverDataLimit} else {'none'}",
].join('; ');

/** `Unrestricted|False|False` -> false, a fixed or variable cost, roaming or over the limit -> true, anything else -> null. */
function parseCost(out) {
  const m = /^(Unrestricted|Fixed|Variable|Unknown)\|(True|False)\|(True|False)\s*$/.exec(String(out || '').trim());
  if (!m) return null;
  if (m[2] === 'True' || m[3] === 'True') return true;
  if (m[1] === 'Fixed' || m[1] === 'Variable') return true;
  return m[1] === 'Unrestricted' ? false : null;
}

function askWindows() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', QUESTION], { timeout: 8000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

function createMetered({ ask = askWindows, clock = Date.now, everyMs = 60_000 } = {}) {
  let known = null;
  let askedAt = -Infinity;
  let running = Promise.resolve();
  const refresh = () => {
    if (clock() - askedAt < everyMs) return;
    askedAt = clock();
    running = Promise.resolve()
      .then(ask)
      .then((out) => {
        const v = parseCost(out);
        if (v !== null) known = v;
      })
      .catch(() => undefined);
  };
  return {
    /** The last answer (false until Windows has said otherwise); asks again in the background when it is old. */
    current() {
      refresh();
      return known === true;
    },
    settled: () => running,
  };
}

const shared = process.platform === 'win32' ? createMetered() : createMetered({ ask: async () => 'none' });

module.exports = { parseCost, createMetered, current: () => shared.current() };
