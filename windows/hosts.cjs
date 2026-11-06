'use strict';
// Hosts the Windows app's HTTP bridge may reach. Mirrors ALLOWED_HOSTS / ALLOWED_SUFFIXES in
// web/src/engine/net.ts and HOSTS / SUFFIXES in android/.../MainActivity.kt; bridge-allowlist.test.ts
// fails when the three drift apart. Search and metadata only: no download-resolver host is listed.
const HOSTS = [
  'api.deezer.com', 'www.deezer.com', 'deezer.com', 'deezer.page.link', 'link.deezer.com',
  'open.spotify.com', 'spotify.link', 'spotify.app.link',
  'soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com', 'api-v2.soundcloud.com',
  'bandcamp.com', 'www.bandcamp.com', 'api.audius.co', 'audius.co',
  'www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
  'itunes.apple.com', 'music.apple.com',
  'api-partner.spotify.com', 'clienttoken.spotify.com', 'open.spotifycdn.com',
  'open.qobuz.com',
  'music.amazon.com', 'na.web.skill.music.a2z.com',
  'tidal.com', 'resources.tidal.com',
  'api.song.link',
  'lrclib.net', 'musicbrainz.org',
  'genius.com', 'amp.shazam.com',
  'i.ytimg.com',
];
const SUFFIXES = ['.dzcdn.net', '.sndcdn.com'];

function hostAllowed(host) {
  const h = String(host || '').toLowerCase().replace(/\.+$/, '');
  return HOSTS.includes(h) || SUFFIXES.some((s) => h.endsWith(s));
}

module.exports = { HOSTS, SUFFIXES, hostAllowed };
