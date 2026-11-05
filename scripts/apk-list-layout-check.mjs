// Run via scripts/CDP driver exposing {evalPage, send, sleep}, with Saved containing real songs.
// LIST-AVAILABILITY-001 / SAVED-MOBILE-001: labels must retain useful space, not only avoid overflow.
import assert from 'node:assert/strict';
export async function run({evalPage,send,sleep}) {
 const result=[];
 await evalPage(`if (!document.querySelector('.tracks--saved')) { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Saved'); if(!b)throw Error('Saved tab missing'); b.click(); } return true;`);
 await sleep(1000);
 try {
  for(const width of [320,360,412,1280]){
   await send('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:2.625,mobile:true});await sleep(350);
   const g=await evalPage(`const rows=[...document.querySelectorAll('.tracks--saved > .track')];return {width:innerWidth,scroll:document.documentElement.scrollWidth,rows:rows.map(r=>{const t=r.querySelector('.track__text').getBoundingClientRect(),a=r.querySelector('.track__actions').getBoundingClientRect(),b=r.getBoundingClientRect();return {title:r.querySelector('.track__title').textContent,textWidth:t.width,overlap:Math.min(t.right,a.right)>Math.max(t.left,a.left)&&Math.min(t.bottom,a.bottom)>Math.max(t.top,a.top),actionsWithin:a.left>=b.left-1&&a.right<=b.right+1};})};`);
   result.push(g);console.log(JSON.stringify(g));assert(g.rows.length>0,'must test populated Saved');
   assert(g.scroll<=g.width+1,'document has horizontal overflow');
   for(const r of g.rows){assert(r.textWidth>=120,`${width}px: ${r.title} only has ${r.textWidth.toFixed(1)}px of readable title space`);assert(!r.overlap);assert(r.actionsWithin);}
  }
 } finally {await send('Emulation.clearDeviceMetricsOverride');}
 return result;
}
