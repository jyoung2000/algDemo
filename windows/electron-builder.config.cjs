/**
 * Packaging for the Windows Airwave Discovery app. One portable exe (no install, nothing left behind)
 * and an NSIS installer. The web app, the engine and the audio model are inside; the user needs no
 * Node, Python or uv. Signed when a codesign.properties (pfxFile, pfxPassword) exists in AIRWAVE_SIGNING_DIR or
 * ~/airwave-signing, kept outside the repo; unsigned otherwise. A self-signed certificate does not clear
 * Windows SmartScreen: it identifies the publisher once the user trusts airwave-discovery-codesign.cer.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function signingProps() {
  const dir = process.env.AIRWAVE_SIGNING_DIR || path.join(os.homedir(), 'airwave-signing');
  const file = path.join(dir, 'codesign.properties');
  if (!fs.existsSync(file)) return null;
  const props = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) props[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return props.pfxFile && props.pfxPassword ? props : null;
}
const sign = signingProps();

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.nowplaying.discovery',
  productName: 'Airwave Discovery',
  directories: { output: 'release', app: __dirname },
  electronVersion: '44.1.1',
  files: ['main.cjs', 'preload.cjs', 'bridge.cjs', 'hosts.cjs', 'downloads.cjs', 'package.json', '../launcher/airwave-discovery.ico'],
  asar: true,
  extraResources: [
    { from: '../web/dist', to: 'web', filter: ['**/*'] },
    { from: '../.data/models', to: 'models', filter: ['model_epoch_36.onnx', 'model_epoch_36.onnx.data'] },
    { from: '../docs/LICENSES.md', to: 'web/licenses/LICENSES.md' },
    // The downloaders, run as separate programs by downloads.cjs: yt-dlp, spotDL and ffmpeg.
    { from: '../.data/tools', to: 'tools', filter: ['yt-dlp.exe', 'spotdl.exe', 'ffmpeg.exe'] },
  ],
  npmRebuild: false,
  electronLanguages: ['en-US'],
  win: {
    icon: '../launcher/airwave-discovery.ico',
    ...(sign ? { signtoolOptions: { certificateFile: sign.pfxFile, certificatePassword: sign.pfxPassword, signingHashAlgorithms: ['sha256'] } } : {}),
    target: [{ target: 'portable', arch: ['x64'] }, { target: 'nsis', arch: ['x64'] }],
    artifactName: 'Airwave-Discovery-${version}-${arch}.${ext}',
  },
  nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false },
};
