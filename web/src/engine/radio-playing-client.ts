// RADIO-PLAYING-NOW-001: the Radio tab's "who is playing this artist or song now" search, asked through the shell's
// public-address guard like every other radio lookup. Kept apart from radio-client so a page without it still loads.
import { radioNative } from './radio-client';
import { RadioPlayingNow } from './radio-tunein';

export const radioPlayingNow = new RadioPlayingNow(async u => (await radioNative<{ text: string }>({ op: 'request', url: u })).text);
