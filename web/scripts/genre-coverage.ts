// How well do real genre words land: normalize() keeps them, classify() names family and subgenre.
import { makeTag, normalize } from '../src/engine/genres';
import { classify } from '../src/engine/classify';
import { SUBS } from '../src/engine/genre-table';
import { fold } from '../src/engine/identity';

const subLost: string[] = [];
for (const s of SUBS) {
  for (const a of [s.name, ...s.aliases]) {
    const t = makeTag(a, 'probe', 'track', 0.6);
    const c = t ? classify([t], null) : null;
    if (c?.key !== s.key) subLost.push(`${s.family}/${s.key} <- "${a}" => ${t?.name ?? 'DROPPED'} -> ${c ? `${c.familySlug}/${c.key}` : 'none'}`);
  }
}
console.log('picker subgenre words that miss their own subgenre:', subLost.length);
console.log(subLost.join('\n'));

// Real words: SoundCloud's genre menu, common MusicBrainz / Last.fm genre tags, YouTube/Apple genres.
const REAL = `Alternative Rock,Ambient,Classical,Country,Dance & EDM,Dancehall,Deep House,Disco,Drum & Bass,Dubstep,Electronic,Folk & Singer-Songwriter,Hip-hop & Rap,House,Indie,Jazz & Blues,Latin,Metal,Piano,Pop,R&B & Soul,Reggae,Reggaeton,Rock,Soundtrack,Techno,Trance,Trap,Triphop,World,
cloud rap,emo rap,plugg,pluggnb,rage,drill,uk drill,ny drill,jersey club,phonk,drift phonk,memphis rap,horrorcore,boom bap,conscious hip hop,jazz rap,gangsta rap,west coast hip hop,east coast hip hop,southern hip hop,crunk,dirty south,hyphy,grime,afroswing,uk rap,trap soul,melodic rap,underground hip hop,abstract hip hop,alternative hip hop,experimental hip hop,lo-fi hip hop,chillhop,
alternative r&b,contemporary r&b,neo soul,new jack swing,quiet storm,funk,p-funk,soul,motown,gospel,afrobeats,afropop,amapiano,afro house,alté,reggaeton,latin trap,dembow,bachata,corridos tumbados,salsa,cumbia,brazilian funk,funk carioca,baile funk,
dance pop,electropop,synthpop,hyperpop,bedroom pop,art pop,k-pop,j-pop,teen pop,indie pop,dream pop,chamber pop,
indie rock,shoegaze,slowcore,midwest emo,emo,post-punk,post-rock,math rock,noise rock,garage rock,grunge,pop punk,punk rock,hardcore,metalcore,deathcore,nu metal,djent,black metal,death metal,doom metal,stoner rock,psychedelic rock,progressive rock,classic rock,hard rock,folk rock,surf rock,
house,deep house,tech house,progressive house,future house,bass house,melodic techno,hard techno,minimal,trance,psytrance,drum and bass,liquid funk,neurofunk,jungle,breakcore,dubstep,riddim,brostep,future bass,uk garage,2-step,speed garage,hardstyle,hard dance,gabber,synthwave,darkwave,witch house,idm,glitch,electro,
ambient,downtempo,chillwave,lo-fi,vaporwave,new age,trip hop,chillout,lounge,
jazz,smooth jazz,bebop,jazz fusion,acid jazz,blues,delta blues,country,bluegrass,americana,folk,singer-songwriter,classical,opera,soundtrack,video game music`.split(',').map((x) => x.trim()).filter(Boolean);

let fam = 0, sub = 0;
const noFamily: string[] = [], noSub: string[] = [];
for (const w of REAL) {
  const t = makeTag(w, 'probe', 'track', 0.6);
  const c = t ? classify([t], null) : null;
  if (c) fam++; else noFamily.push(`${w}${t ? ` (=${t.name})` : ' (dropped)'}`);
  if (c?.key) sub++; else if (c) noSub.push(`${w} -> ${c.familySlug}${t ? ` (=${t.name})` : ''}`);
}
console.log(`\nREAL words ${REAL.length}: family ${fam}, subgenre ${sub}`);
console.log('NO FAMILY:', noFamily.join(' | '));
console.log('FAMILY ONLY:', noSub.join(' | '));
void fold; void normalize;
