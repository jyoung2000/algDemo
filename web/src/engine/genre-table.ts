/**
 * The genre model the classifier uses: the Taste Picker's 8 families and 83 subgenres (names, tempo
 * ranges and sound notes come from taste-catalog.ts, generated from the picker), plus the words that
 * name each one on the streaming services. Aliases are folded (lower case, no punctuation).
 *
 * A word that already has a canonical genre in genres.ts keeps that canonical name; only new words
 * are added here, so existing tags, taste and golden results do not move.
 */

export interface FamilyDef {
  slug: string;
  name: string;
}

export const FAMILIES: FamilyDef[] = [
  { slug: 'rock', name: 'Rock' },
  { slug: 'hip-hop', name: 'Hip-hop' },
  { slug: 'pop', name: 'Pop' },
  { slug: 'indie', name: 'Indie' },
  { slug: 'soul-jazz-funk', name: 'Soul/Jazz/Funk' },
  { slug: 'electronic', name: 'Electronic' },
  { slug: 'ambient-chill', name: 'Ambient/Chill' },
  { slug: 'rnb-afro-latin', name: 'R&B/Afro/Latin' },
];

export interface SubDef {
  /** Canonical genre key stored on tags and taste (e.g. 'trap', 'slowcore'). */
  key: string;
  /** Exactly the picker's subgenre name (see taste-catalog.ts). */
  name: string;
  family: string;
  /** Folded service names that mean this subgenre. */
  aliases: string[];
}

export const SUBS: SubDef[] = [
  // Rock
  { key: 'slowcore', name: 'Slowcore revival', family: 'rock', aliases: ['slowcore', 'sadcore'] },
  { key: 'nu-metal', name: 'Nu-metal revival', family: 'rock', aliases: ['nu metal', 'nu-metal', 'numetal'] },
  { key: 'shoegaze', name: 'Shoegaze revival', family: 'rock', aliases: ['shoegaze', 'shoegazing'] },
  { key: 'djent', name: 'Alt-metal / djent', family: 'rock', aliases: ['djent', 'alt metal', 'alternative metal', 'progressive metal', 'prog metal'] },
  { key: 'indie-sleaze', name: 'Indie sleaze revival', family: 'rock', aliases: ['indie sleaze', 'dance punk', 'dance-punk', 'electroclash'] },
  { key: 'midwest-emo', name: 'Midwest emo revival', family: 'rock', aliases: ['midwest emo', 'emo', 'emo revival', 'emocore'] },
  { key: 'post-punk', name: 'Post-punk revival', family: 'rock', aliases: ['post punk', 'post-punk', 'new wave rock'] },
  { key: 'metalcore', name: 'Metalcore / deathcore', family: 'rock', aliases: ['metalcore', 'deathcore', 'deathcore metal'] },
  { key: 'pop-punk', name: 'Pop-punk revival', family: 'rock', aliases: ['pop punk', 'pop-punk', 'skate punk'] },
  { key: 'hardcore-punk', name: 'Hardcore punk revival', family: 'rock', aliases: ['hardcore punk', 'hardcore', 'hardcore-punk'] },
  // Hip-hop
  { key: 'lo-fi', name: 'Lo-fi hip-hop', family: 'hip-hop', aliases: ['lo fi hip hop', 'lofi hip hop', 'lo fi beats', 'chillhop'] },
  { key: 'boom-bap', name: 'Boom bap revival', family: 'hip-hop', aliases: ['boom bap', 'boom-bap', 'old school hip hop', 'golden age hip hop'] },
  { key: 'jersey-club', name: 'Jersey club (rap crossover)', family: 'hip-hop', aliases: ['jersey club', 'jersey-club'] },
  { key: 'trap', name: 'Trap', family: 'hip-hop', aliases: ['trap music', 'southern trap', 'atlanta trap'] },
  { key: 'drill', name: 'NY / Brooklyn drill', family: 'hip-hop', aliases: ['drill', 'ny drill', 'brooklyn drill', 'chicago drill'] },
  { key: 'plugg', name: 'Plugg / pluggnb', family: 'hip-hop', aliases: ['plugg', 'pluggnb', 'plugg nb'] },
  { key: 'phonk', name: 'Phonk (OG and drift)', family: 'hip-hop', aliases: ['phonk', 'drift phonk', 'memphis phonk', 'memphis rap'] },
  { key: 'trap-metal', name: 'Trap metal / SoundCloud rap', family: 'hip-hop', aliases: ['trap metal', 'soundcloud rap', 'soundcloud', 'emo rap'] },
  { key: 'uk-drill', name: 'UK drill', family: 'hip-hop', aliases: ['uk drill', 'uk-drill'] },
  { key: 'sexy-drill', name: 'Sexy drill', family: 'hip-hop', aliases: ['sexy drill'] },
  { key: 'rage', name: 'Rage', family: 'hip-hop', aliases: ['rage', 'rage rap', 'rage beat'] },
  // Pop
  { key: 'alt-pop', name: 'Alt-pop / dark pop', family: 'pop', aliases: ['alt pop', 'alternative pop', 'dark pop', 'alt-pop'] },
  { key: 'bedroom-pop', name: 'Bedroom pop', family: 'pop', aliases: ['bedroom pop', 'bedroom-pop'] },
  { key: 'country-pop', name: 'Country-pop / Americana crossover', family: 'pop', aliases: ['country pop', 'country-pop', 'americana', 'alt country'] },
  { key: 'tropical-house', name: 'Tropical house pop', family: 'pop', aliases: ['tropical house', 'tropical', 'tropical-house'] },
  { key: 'synthpop', name: 'Synth-pop / 80s revival', family: 'pop', aliases: ['synth pop', 'synth-pop', 'synthpop', '80s', '80s revival', 'new wave'] },
  { key: 'j-pop', name: 'J-pop / city pop revival', family: 'pop', aliases: ['city pop', 'city-pop', 'j-pop revival'] },
  { key: 'k-pop', name: 'K-pop', family: 'pop', aliases: [] },
  { key: 'dance-pop', name: 'Dance-pop / EDM pop', family: 'pop', aliases: ['edm pop', 'edm-pop'] },
  { key: 'digicore', name: 'Digicore', family: 'pop', aliases: ['digicore', 'digi core'] },
  { key: 'pop-rap', name: 'Pop-trap / pop-rap', family: 'pop', aliases: ['pop rap', 'pop-rap', 'pop trap', 'pop-trap'] },
  { key: 'hyperpop', name: 'Hyperpop', family: 'pop', aliases: ['hyperpop', 'hyper pop'] },
  // Indie
  { key: 'indie-folk', name: 'Indie folk', family: 'indie', aliases: ['indie folk', 'folk rock', 'folk pop'] },
  { key: 'dream-pop', name: 'Dream pop', family: 'indie', aliases: ['dream pop', 'dream-pop'] },
  { key: 'chillwave', name: 'Chillwave', family: 'indie', aliases: ['chillwave', 'chill wave'] },
  { key: 'art-pop', name: 'Art pop', family: 'indie', aliases: ['art pop', 'art-pop'] },
  { key: 'slacker-rock', name: 'Lo-fi indie / slacker rock', family: 'indie', aliases: ['lo fi indie', 'lofi indie', 'slacker rock', 'bedroom rock'] },
  { key: 'indietronica', name: 'Indietronica', family: 'indie', aliases: ['indietronica', 'indie electronic', 'indie dance'] },
  { key: 'indie-pop', name: 'Indie pop', family: 'indie', aliases: [] },
  { key: 'garage-psych', name: 'Garage / psych rock', family: 'indie', aliases: ['garage rock', 'psych rock', 'psychedelic rock', 'garage psych', 'psych'] },
  { key: 'jangle-pop', name: 'Jangle pop / C86 revival', family: 'indie', aliases: ['jangle pop', 'jangle-pop', 'c86', 'twee pop'] },
  { key: 'math-rock', name: 'Math rock', family: 'indie', aliases: ['math rock', 'math-rock', 'math'] },
  // Soul/Jazz/Funk
  { key: 'neo-soul', name: 'Neo-soul', family: 'soul-jazz-funk', aliases: ['neo soul', 'neo-soul'] },
  { key: 'uk-soul', name: 'Alternative / UK soul', family: 'soul-jazz-funk', aliases: ['alternative soul', 'uk soul', 'uk-soul'] },
  { key: 'nu-jazz', name: 'Jazz-hop / nu-jazz', family: 'soul-jazz-funk', aliases: ['jazz hop', 'jazz-hop', 'nu jazz', 'nu-jazz', 'jazz rap'] },
  { key: 'spiritual-jazz', name: 'Spiritual jazz / UK jazz revival', family: 'soul-jazz-funk', aliases: ['spiritual jazz', 'uk jazz', 'uk jazz revival'] },
  { key: 'boogie', name: 'Modern funk / boogie revival', family: 'soul-jazz-funk', aliases: ['modern funk', 'boogie', 'funk revival', 'boogie revival'] },
  { key: 'jazz-funk', name: 'Jazz-funk fusion', family: 'soul-jazz-funk', aliases: ['jazz funk', 'jazz-funk', 'jazz fusion', 'fusion'] },
  { key: 'retro-soul', name: 'Retro soul / Daptone revival', family: 'soul-jazz-funk', aliases: ['retro soul', 'daptone', 'northern soul'] },
  { key: 'nu-disco', name: 'Nu-disco / disco revival', family: 'soul-jazz-funk', aliases: ['nu disco', 'nu-disco', 'disco', 'disco revival'] },
  { key: 'soul-pop', name: 'Soul-pop / Motown revival', family: 'soul-jazz-funk', aliases: ['soul pop', 'soul-pop', 'motown'] },
  { key: 'bruk', name: 'Broken beat / bruk revival', family: 'soul-jazz-funk', aliases: ['broken beat', 'broken-beat', 'bruk', 'bruk revival'] },
  // Electronic
  { key: 'melodic-techno', name: 'Melodic techno / melodic house', family: 'electronic', aliases: ['melodic techno', 'melodic house', 'melodic-techno'] },
  { key: 'slap-house', name: 'Slap house', family: 'electronic', aliases: ['slap house', 'slap-house'] },
  { key: 'tech-house', name: 'Tech house', family: 'electronic', aliases: [] },
  { key: 'uk-garage', name: 'UK garage revival (2-step / speed garage)', family: 'electronic', aliases: ['uk garage', 'uk-garage', '2 step', '2-step', 'speed garage', 'garage'] },
  { key: 'hypertechno', name: 'Hypertechno', family: 'electronic', aliases: ['hypertechno', 'hyper techno', 'hardstyle techno'] },
  { key: 'dubstep', name: 'Dubstep / brostep / riddim', family: 'electronic', aliases: ['brostep', 'riddim', 'riddim dubstep'] },
  { key: 'trap-edm', name: 'Trap-EDM', family: 'electronic', aliases: ['trap edm', 'trap-edm', 'edm trap'] },
  { key: 'future-bass', name: 'Future bass', family: 'electronic', aliases: ['future bass', 'future-bass'] },
  { key: 'hard-techno', name: 'Hard techno', family: 'electronic', aliases: ['hard techno', 'hard-techno'] },
  { key: 'jungle', name: 'Jungle revival', family: 'electronic', aliases: ['jungle', 'jungle revival'] },
  { key: 'liquid-dnb', name: 'Liquid drum & bass', family: 'electronic', aliases: ['liquid drum and bass', 'liquid dnb', 'liquid-dnb', 'liquid funk'] },
  // Ambient/Chill
  { key: 'ambient', name: 'Ambient / drone', family: 'ambient-chill', aliases: ['drone', 'dark ambient', 'ambient drone'] },
  { key: 'neoclassical', name: 'Neoclassical / modern classical', family: 'ambient-chill', aliases: ['neoclassical', 'modern classical', 'neo classical'] },
  { key: 'vaporwave', name: 'Vaporwave', family: 'ambient-chill', aliases: ['vaporwave', 'vapor wave'] },
  { key: 'downtempo', name: 'Downtempo / trip-hop', family: 'ambient-chill', aliases: ['trip hop', 'trip-hop', 'chillout', 'chill out'] },
  { key: 'synthwave', name: 'Synthwave / retrowave', family: 'ambient-chill', aliases: ['synthwave', 'retrowave', 'outrun', 'darksynth'] },
  { key: 'organic-house', name: 'Organic house / downtempo house', family: 'ambient-chill', aliases: ['organic house', 'downtempo house', 'organic-house'] },
  { key: 'dub-techno', name: 'Dub techno', family: 'ambient-chill', aliases: ['dub techno', 'dub-techno'] },
  { key: 'future-garage', name: 'Future garage / ambient bass', family: 'ambient-chill', aliases: ['future garage', 'ambient bass', 'future-garage'] },
  { key: 'chillstep', name: 'Chillstep / melodic dubstep', family: 'ambient-chill', aliases: ['chillstep', 'melodic dubstep'] },
  // R&B/Afro/Latin
  { key: 'alt-rnb', name: 'Alt R&B', family: 'rnb-afro-latin', aliases: ['alt r and b', 'alternative r and b', 'alt rnb', 'alt-rnb'] },
  { key: 'reggaeton', name: 'Reggaeton / urbano', family: 'rnb-afro-latin', aliases: ['urbano', 'reggaeton urbano'] },
  { key: 'afrobeats', name: 'Afrobeats', family: 'rnb-afro-latin', aliases: ['afro pop', 'afropop'] },
  { key: 'afroswing', name: 'Afroswing / UK afrobeats', family: 'rnb-afro-latin', aliases: ['afroswing', 'uk afrobeats', 'uk afroswing'] },
  { key: 'moombahton', name: 'Moombahton', family: 'rnb-afro-latin', aliases: ['moombahton', 'moombah'] },
  { key: 'amapiano', name: 'Amapiano', family: 'rnb-afro-latin', aliases: ['amapiano', 'log drum'] },
  { key: 'afro-house', name: 'Afro house', family: 'rnb-afro-latin', aliases: ['afro house', 'afro-house'] },
  { key: 'gqom', name: 'Gqom', family: 'rnb-afro-latin', aliases: ['gqom'] },
  { key: 'baile-funk', name: 'Baile funk / Brazilian funk & phonk', family: 'rnb-afro-latin', aliases: ['baile funk', 'funk carioca', 'brazilian funk', 'baile'] },
  { key: 'trapsoul', name: 'Trapsoul / trap R&B', family: 'rnb-afro-latin', aliases: ['trapsoul', 'trap soul', 'trap r and b', 'trap rnb'] },
  { key: 'latin-trap', name: 'Latin trap', family: 'rnb-afro-latin', aliases: ['latin trap', 'latin-trap'] },
];

/**
 * Generic genre words (already canonical in genres.ts) that place a song in a family when no
 * subgenre is named. A word not listed here places nothing.
 */
export const FAMILY_TAGS: Record<string, string> = {
  rock: 'rock', metal: 'rock', alternative: 'rock', punk: 'rock', grunge: 'rock',
  'hip-hop': 'hip-hop', rap: 'hip-hop',
  pop: 'pop', 'k-pop': 'pop', 'j-pop': 'pop', 'dance-pop': 'pop',
  indie: 'indie', 'indie-pop': 'indie', folk: 'indie', country: 'indie',
  soul: 'soul-jazz-funk', funk: 'soul-jazz-funk', jazz: 'soul-jazz-funk', disco: 'soul-jazz-funk',
  electronic: 'electronic', house: 'electronic', techno: 'electronic', dance: 'electronic', trance: 'electronic',
  'drum-and-bass': 'electronic', dubstep: 'electronic',
  ambient: 'ambient-chill', downtempo: 'ambient-chill', classical: 'ambient-chill', lounge: 'ambient-chill',
  'r&b': 'rnb-afro-latin', latin: 'rnb-afro-latin', reggaeton: 'rnb-afro-latin', afrobeats: 'rnb-afro-latin',
  african: 'rnb-afro-latin', brazilian: 'rnb-afro-latin', reggae: 'rnb-afro-latin',
};
