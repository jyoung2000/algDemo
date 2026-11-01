/**
 * Packaging for the Windows Airwave Discovery app. One portable exe (no install, nothing left behind)
 * and an NSIS installer. The web app, the engine and the audio model are inside; the user needs no
 * Node, Python or uv. Unsigned: Windows SmartScreen will warn on first run.
 */
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
    target: [{ target: 'portable', arch: ['x64'] }, { target: 'nsis', arch: ['x64'] }],
    artifactName: 'Airwave-Discovery-${version}-${arch}.${ext}',
  },
  nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false },
};
