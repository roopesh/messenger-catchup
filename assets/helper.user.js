// ==UserScript==
// @name         Messenger Catch-up Helper
// @namespace    https://claude.ai/
// @version      1.4
// @description  Jump-to-message links for your Messenger Catch-up page, plus the scan/verify/capture steps Claude runs during a refresh. Read-only except opening the Reply box when you follow a Reply link.
// @match        https://www.facebook.com/messages/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function(){
  if(window.__mcHelper||document.documentElement.hasAttribute('data-mc-helper'))return;window.__mcHelper='1.4';
  document.documentElement.setAttribute('data-mc-helper','1.4');
  /* While a scan runs, clicks on links are swallowed so scrolling can't navigate away. Registered once per page load. */
  document.addEventListener('click',e=>{const a=e.target.closest&&e.target.closest('a[href]');if(a&&window.__rf&&!window.__rf.done)e.preventDefault();},true);
/* A message's date from its Messenger time label: "9:15 AM" (today), "Yesterday 9:15 AM", "Monday 9:15 AM" or "Mon 9:15 AM"
   (the last 7 days), "November 3, 2026 9:15 AM" or "Nov 3 9:15 AM" (a year-less date in the future means last year).
   Returns "YYYY-MM-DD", or null for a label it can't read. */
function mcDate(when,now){now=now||new Date();const W=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'],M=['january','february','march','april','may','june','july','august','september','october','november','december'];
  const ymd=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');const ago=n=>{const d=new Date(now);d.setDate(d.getDate()-n);return ymd(d);};
  const pick=(names,w)=>{w=w.toLowerCase();return w.length>=3?names.findIndex(x=>x.indexOf(w)===0):-1;};const s=String(when||'').trim();
  if(/^\d{1,2}:\d{2}/.test(s)||/^today\b/i.test(s))return ymd(now);
  if(/^yesterday\b/i.test(s))return ago(1);
  const md=s.match(/^([A-Za-z]+)\.? (\d{1,2})(?![\d:])(?:,? (\d{4}))?/);
  if(md){const mi=pick(M,md[1]);if(mi>=0){let d=new Date(md[3]?+md[3]:now.getFullYear(),mi,+md[2]);if(!md[3]&&d-now>864e5)d=new Date(now.getFullYear()-1,mi,+md[2]);return ymd(d);}}
  const dw=s.match(/^([A-Za-z]+)\.?\s/);if(dw){const wi=pick(W,dw[1]);if(wi>=0)return ago(((now.getDay()-wi)+7)%7||7);}
  return null;}
window.__mcDate=mcDate;
async function mcScan(STOPS,FIRST){STOPS=STOPS||[];sessionStorage.removeItem('__mcsave');
for(let w=0;w<40;w++){const l=document.querySelector('[role="log"]');if(l&&l.getBoundingClientRect().width>=300)break;await new Promise(r=>setTimeout(r,500));}
window.__rf={phase:'collect',order:[],info:{},parents:{},done:false,err:null,steps:0,t0:Date.now()};
await (async()=>{const R=window.__rf;try{

const sleep=ms=>new Promise(r=>setTimeout(r,ms));const N=s=>(s||'').replace(/\s+/g,' ').trim();
let LOG=null,SC=null;
const log=()=>{if(!LOG||!LOG.isConnected)LOG=document.querySelector('[role="log"]');return LOG;};
const sc=()=>{if(!SC||!SC.isConnected)SC=Array.from(log().querySelectorAll('div')).find(x=>{const s=getComputedStyle(x);return /(auto|scroll)/.test(s.overflowY)&&x.scrollHeight>x.clientHeight;});return SC;};
const dec=h=>{try{const u=new URL(h,location.href);if(u.hostname==='l.facebook.com'){const t=u.searchParams.get('u');if(t){const x=new URL(t);x.searchParams.delete('fbclid');return x.toString();}}return u.toString();}catch(e){return h;}};
function photos(e){const imgs=Array.from(e.querySelectorAll('a[href*="messenger_media"] img, [aria-label^="Open photo"] img')).filter(i=>i.currentSrc&&/fbcdn/.test(i.currentSrc));
 const big=imgs.filter(i=>!(i.naturalWidth&&i.naturalWidth<=220&&i.naturalHeight<=120));
 return {srcs:[...new Set(big.map(i=>i.currentSrc))],gif:!!e.querySelector('img[alt="GIF Image"]')||(imgs.length>0&&big.length===0)};}
function collect(){const ids=[];log().querySelectorAll('[data-message-id]').forEach(e=>{const id=e.getAttribute('data-message-id');ids.push(id);const labels=Array.from(e.querySelectorAll('[aria-label]')).map(x=>x.getAttribute('aria-label'));const prev=R.info[id];const text=e.innerText;const ph=photos(e);
 if(!prev||text.length>prev.text.length)R.info[id]={label:e.getAttribute('aria-label')||'',text,reply:labels.includes('Go to replied message'),rx:labels.filter(l=>/reactions? with/.test(l)),att:labels.filter(l=>/^Open Attachment|^Open photo/i.test(l)),links:[...new Set(Array.from(e.querySelectorAll('a[href]')).map(a=>dec(a.getAttribute('href'))))],ph:(prev&&prev.ph&&prev.ph.srcs.length>ph.srcs.length)?prev.ph:ph};
 else if(ph.srcs.length>prev.ph.srcs.length)prev.ph=ph;});
 if(!ids.length)return;if(!R.order.length){R.order=ids;return;}const set=new Set(R.order);const k=ids.findIndex(i=>set.has(i));if(k<0){R.gap=(R.gap||0)+1;R.order=ids.concat(R.order);return;}
 R.order.splice(R.order.indexOf(ids[k]),0,...ids.slice(0,k));let pos=R.order.indexOf(ids[k]);for(let j=k+1;j<ids.length;j++){if(!set.has(ids[j]))R.order.splice(pos+1,0,ids[j]);pos=R.order.indexOf(ids[j]);}}
for(let w=0;w<20&&!(log()&&sc());w++)await sleep(500);
let s=sc();for(let b=0;b<4;b++){s=sc();s.scrollTop=s.scrollHeight;await sleep(700);}collect();
const hit=()=>{if(FIRST&&FIRST.count){if(R.order.length>FIRST.count)return R.order[R.order.length-FIRST.count-1];return R.atTop?'__top__':null;}return STOPS.find(m=>R.order.includes(m));};
let extra=0,tops=0;for(let r=0;r<1500;r++){if(hit()){if(++extra>2)break;}s=sc();const st=Math.round(s.clientHeight*0.6);s.scrollTop=s.scrollTop>st?s.scrollTop-st:0;await sleep(s.scrollTop<5?1500:500);collect();R.steps++;if(FIRST&&s.scrollTop<5){if(++tops>8)R.atTop=true;}else tops=0;}
R.tCollect=Date.now()-R.t0;const anchor=hit();if(!anchor){R.err=FIRST?'Could not load enough history for the first catch-up':'None of the stored anchor messages was found while scrolling back';R.done=true;return;}
R.anchor=anchor;R.win=anchor==='__top__'?R.order.slice():R.order.slice(R.order.indexOf(anchor)+1);
R.phase='replies';const reps=R.win.filter(id=>R.info[id].reply);R.replyCount=reps.length;
/* 1) quote match: a reply's quote must match exactly one earlier loaded message from the replied-to person (12+ chars) */
const posOf=id=>R.order.indexOf(id);
for(const id of reps){const m=R.info[id];const lines=m.text.split('\n');const rm=(lines[0]||'').match(/^(.*) replied to (.*)$/);if(!rm)continue;
 let who=rm[2];if(/^you$/i.test(who))who='You';else if(/^(themself|themselves|himself|herself|yourself)$/i.test(who))who=rm[1]==='You'?'You':rm[1];else if(/^participant$/i.test(who))continue;
 const lab=m.label.replace(/^At .+?(?:AM|PM|am|pm), /,'');const from=rm[1];const lb=lab.indexOf(from+': ')===0?lab.slice(from.length+2):'';
 const oi=m.text.indexOf('Original message:\n');if(oi<0)continue;const r2=m.text.slice(oi+18);const bi=lb?r2.lastIndexOf(lb.slice(0,Math.min(20,lb.length))):-1;
 const qn=N(bi>0?r2.slice(0,bi):r2.split('\n')[0]).replace(/…$/,'').trim();if(qn.length<12)continue;
 const me=posOf(id);const c=R.order.slice(0,me).filter(o=>{const L=(R.info[o]||{}).label||'';const a=L.replace(/^At .+?(?:AM|PM|am|pm), /,'');return a.indexOf(who+': ')===0&&N(a.slice(who.length+2)).indexOf(qn)===0;});
 if(c.length===1){const L=R.info[c[0]].label;R.parents[id]={p:c[0],pl:L.slice(0,120),how:'q'};}}
R.quoteMatched=Object.keys(R.parents).length;
/* 2) click only what the quotes couldn't settle */
async function bring(id){const want=posOf(id);for(let t=0;t<80;t++){const e=log().querySelector('[data-message-id="'+CSS.escape(id)+'"]');if(e){e.scrollIntoView({block:'center'});await sleep(200);return log().querySelector('[data-message-id="'+CSS.escape(id)+'"]')||e;}
 const els=log().querySelectorAll('[data-message-id]');const fi=els.length?posOf(els[0].getAttribute('data-message-id')):-1;s=sc();const st=Math.round(s.clientHeight*0.8);
 if(fi<0||want<fi)s.scrollTop=Math.max(0,s.scrollTop-st);else s.scrollTop=s.scrollTop+st;await sleep(450);collect();}return null;}
/* Click ONLY replies to a photo/attachment (no quoted text to match). Text replies are matched by Claude against the stored history. */
const isPhotoReply=id=>{const t=R.info[id].text||'';const oi=t.indexOf('Original message:\n');if(oi<0)return true;const f=(t.slice(oi+18).split('\n')[0]||'').trim();return !f||/^(Attachment|Photo|GIF|Video|Sticker)$/i.test(f);};
R.photoReplies=reps.filter(isPhotoReply).length;
for(const id of reps.slice().reverse()){if(R.parents[id]||!isPhotoReply(id))continue;const e=await bring(id);if(!e){R.parents[id]={err:'notfound'};continue;}
 const b=e.querySelector('[aria-label="Go to replied message"]');if(!b){R.parents[id]={err:'nobtn'};continue;}
 if(document.activeElement)document.activeElement.blur();b.click();let got=null;
 for(let t=0;t<10;t++){await sleep(250);const a=document.activeElement;const am=a&&a.closest&&a.closest('[data-message-id]');if(am&&am.getAttribute('data-message-id')!==id){got=am;break;}}
 R.parents[id]=got?{p:got.getAttribute('data-message-id'),pl:(got.getAttribute('aria-label')||'').slice(0,120)}:{err:'nofocus'};R.steps++;}
R.tReplies=Date.now()-R.t0;
sessionStorage.setItem('__mcsave',JSON.stringify({win:R.win,info:Object.fromEntries(R.win.concat(Object.values(R.parents).map(p=>p.p).filter(Boolean)).map(id=>[id,R.info[id]]).filter(x=>x[1])),parents:R.parents,anchor:R.anchor,replyCount:R.replyCount}));
R.phase='done';}catch(e){R.err=String(e&&e.stack||e);}R.done=true;})();
const R=window.__rf;return {err:R.err,anchor:R.anchor||null,win:R.win?R.win.length:0,reps:R.replyCount||0,qm:R.quoteMatched||0,gap:R.gap||0,perr:Object.values(R.parents||{}).filter(p=>p.err).length,photoReplies:R.photoReplies||0,ms:Date.now()-R.t0,labels:(R.win||[]).slice(-40).map(id=>(R.info[id].label||"").slice(0,90))};}
async function mcVerify(){
window.__v={order:[],done:false,err:null,gap:0};await (async()=>{const V=window.__v;try{const sleep=ms=>new Promise(r=>setTimeout(r,ms));const S=JSON.parse(sessionStorage.getItem('__mcsave'));const anchor=S.anchor;let LOG=null,SC=null;const log=()=>{if(!LOG||!LOG.isConnected)LOG=document.querySelector('[role="log"]');return LOG;};const sc=()=>{if(!SC||!SC.isConnected)SC=Array.from(log().querySelectorAll('div')).find(x=>{const s=getComputedStyle(x);return /(auto|scroll)/.test(s.overflowY)&&x.scrollHeight>x.clientHeight;});return SC;};
function collect(){const ids=[...log().querySelectorAll('[data-message-id]')].map(e=>e.getAttribute('data-message-id'));if(!ids.length)return;if(!V.order.length){V.order=ids;return;}const set=new Set(V.order);const k=ids.findIndex(i=>set.has(i));if(k<0){V.gap++;V.order=ids.concat(V.order);return;}V.order.splice(V.order.indexOf(ids[k]),0,...ids.slice(0,k));let pos=V.order.indexOf(ids[k]);for(let j=k+1;j<ids.length;j++){if(!set.has(ids[j]))V.order.splice(pos+1,0,ids[j]);pos=V.order.indexOf(ids[j]);}}
async function pass(frac,ms){V.order=[];V.gap=0;const TOP=anchor==='__top__';let tops=0;let s=sc();for(let b=0;b<4;b++){s=sc();s.scrollTop=s.scrollHeight;await sleep(600);}collect();let extra=0;for(let r=0;r<1500;r++){if(TOP?tops>8:V.order.includes(anchor)){if(++extra>2)break;}s=sc();const st=Math.round(s.clientHeight*frac);s.scrollTop=s.scrollTop>st?s.scrollTop-st:0;await sleep(s.scrollTop<5?1500:ms);collect();if(s.scrollTop<5)tops++;else tops=0;}
 if(!TOP&&!V.order.includes(anchor))return false;const w=TOP?V.order.slice():V.order.slice(V.order.indexOf(anchor)+1);V.win=w;V.prefixSame=JSON.stringify(w.slice(0,S.win.length))===JSON.stringify(S.win);V.extra=w.length-S.win.length;return V.gap===0&&V.prefixSame;}
for(let w=0;w<20&&!(log()&&sc());w++)await sleep(500);
V.mode='fast';let ok=await pass(0.6,500);if(!ok){V.mode='slow';ok=await pass(0.35,900);}V.ok=ok;if(!ok&&!V.order.includes(anchor))V.err='anchor not found';}catch(e){V.err=String(e);}V.done=true;})();
const X=window.__v;return {ok:!!X.ok,gap:X.gap,prefixSame:!!X.prefixSame,extra:X.extra,err:X.err,win:X.win?X.win.length:0,mode:X.mode};}
async function mcCapture(BASE){
return await (async()=>{const R=JSON.parse(sessionStorage.getItem('__mcsave'));const N=s=>(s||'').replace(/\s+/g,' ').trim();
const now=new Date();const todayD=mcDate('12:00',now);const guessed=[];let lastD=null;
const D=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const pos=new Map(R.win.map((id,k)=>[id,BASE+1+k]));const firsts=Object.values(R.info).map(x=>x.text.split('\n')[0]);
const out=R.win.map((id,k)=>{const m=R.info[id];const lab=m.label;const wm=lab.match(/^At (.+?(?:AM|PM|am|pm)), /);const when=wm?wm[1]:'';const after=wm?lab.slice(wm[0].length):'';
 const lines=m.text.split('\n');const first=lines[0]||'';let from='',rTo='';const rm=m.reply?first.match(/^(.*) replied to (.*)$/):null;/* only a real reply (it has a reply link): message text can say "X replied to Y" too */
 if(rm){from=rm[1];rTo=rm[2];}else if(first&&(after===first||after.indexOf(first+': ')===0))from=first;else from=firsts.find(c=>c&&(after===c||after.indexOf(c+': ')===0))||after.split(': ')[0];
 if(/^You\b/.test(after)||(rm&&rm[1]==='You')||/^You sent (a photo|\d+ photos|an attachment|a GIF|a sticker|a video|a voice message)\.?$/.test(first))from='You';/* own status lines only, never a message that starts "You sent…" */
 const lb=after.indexOf(from+': ')===0?after.slice(from.length+2):'';let j=0;
 if(rm){j=1;if(lines[1]==='Original message:'){if(lb){const key=N(lb).slice(0,20);const rest=lines.slice(2);let f=-1;for(let t=rest.length-1;t>=0;t--){if(N(rest.slice(t).join(' ')).indexOf(key)===0){f=t;break;}}j=f>=0?2+f:3;}else{let t2=2;while(t2<lines.length&&!/…$/.test(lines[t2]))t2++;j=t2<lines.length?t2+1:3;}}}else if(lines[0]===from)j=1;
 const body=lines.slice(j);while(body.length&&(/^\d+$/.test(body[body.length-1].trim())||/^(Sent \d+[smhd] ago|Sent|Seen|Delivered)$/.test(body[body.length-1].trim())))body.pop();
 let bt=body.join('\n').trim().replace(/^(?:·\s*\n)?Edited\n/,'').trim();if(/^(GIPHY|Edited|·)$/.test(N(bt)))bt='';
 const a=(m.att.filter(x=>/^Open Attachment, /.test(x)).map(x=>x.replace(/^Open Attachment, /,''))[0]||'');
 let b;if(a&&!lb)b='';else if(lb&&N(bt).indexOf(N(lb))===0)b=bt;else if(lb)b=lb;else b=bt;if(a&&lb&&N(b)!==N(lb))b=lb;{const del=lines.map(x=>x.trim()).find(x=>/^(?:You|.+?) (?:deleted|unsent|removed) a message\.?$/.test(x));/* Messenger's own line, alone; never a message that merely says it */
  if(del&&!lines.some(x=>x.trim()&&x.trim()!==del&&x.trim()!==from))b='(deleted a message)';}
 let q='';const oi=m.text.indexOf('Original message:\n');if(oi>=0){const r2=m.text.slice(oi+18);const bi=b?r2.lastIndexOf(b.slice(0,Math.min(20,b.length))):-1;q=(bi>0?r2.slice(0,bi):r2.split('\n')[0]).trim();}
 const media=m.links.find(l=>/messenger_media/.test(l))||'';const pm=media.match(/attachment_id=(\d+)/);
 const ext=m.links.filter(l=>!/messenger_media|l\.facebook|facebook\.com\/share\//.test(l)).map(l=>l.replace(/[?&](utm_[^&]+|srtk=[^&]+|fs=e|s=m|ref=[^&]+|fbclid=[^&]+)/g,'').replace(/\?&/,'?').replace(/[?&]$/,'').replace(/^([^?#]*)&/,'$1?'));
 let dd=mcDate(when,now);if(!dd){guessed.push(BASE+1+k);dd=lastD||todayD;}lastD=dd;/* unreadable label: borrow the previous message's date */const tmm=when.match(/(\d{1,2}:\d{2})\s*([AP]M)/i);const tm=tmm?tmm[1]+' '+tmm[2].toUpperCase():'12:00 AM';const wd=D[new Date(dd+'T12:00:00').getDay()];
 const o={i:BASE+1+k,t:wd+' '+tm,f:from,b,m:id,d:dd};if(rTo)o.r=rTo;if(q)o.q=q.slice(0,160);
 if(m.rx.length)o.x=m.rx.map(r=>r.replace(/; see who reacted to this\.?/,'').replace(/ reactions? with /,' ')).join('; ');
 if(ext.length)o.l=[...new Set(ext)];if(a)o.a=a.slice(0,220);if(pm)o.p=pm[1];
 const pr=R.parents[id];if(pr){if(pr.p&&pos.has(pr.p)){o.pi=pos.get(pr.p);if(pr.how==='q')o.pq=1;}else if(pr.p){o.pmid=pr.p;o.pl=pr.pl;if(pr.how==='q')o.pq=1;}else o.perr=pr.err;}
 return o;});
const sha=async t=>{const dg=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(t));return [...new Uint8Array(dg)].map(x=>x.toString(16).padStart(2,'0')).join('');};
const b64=blob=>new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(String(fr.result).split(',')[1]);fr.onerror=rej;fr.readAsDataURL(blob);});
const photos=[];const gifs=[];const failed=[];
for(const [k,id] of R.win.entries()){const m=R.info[id];if(!m||!m.ph)continue;const i=BASE+1+k;if(!m.ph.srcs.length){if(m.ph.gif)gifs.push(i);continue;}
 for(const [j,u] of m.ph.srcs.entries()){try{const r=await fetch(u);const bl=await r.blob();if(!/^image\/(jpeg|png|webp|gif)$/.test(bl.type))throw bl.type;photos.push({i,k:j,type:bl.type,b64:await b64(bl)});}catch(e){failed.push(i);}}}
const msgsTxt=JSON.stringify(out);const cap={kind:'mc-capture',base:BASE,anchor:R.anchor,count:out.length,sha:await sha(msgsTxt),msgs:out,gifs,photos,phsha:await sha(JSON.stringify(photos))};
const text=JSON.stringify(cap);window.__capText=text;
document.body.innerHTML='';const bt=document.createElement('button');bt.id='__copy';bt.textContent='COPY CAPTURE';bt.style.cssText='position:fixed;left:16px;top:16px;width:260px;height:56px;font:700 18px system-ui;z-index:2147483647;background:#0a7;color:#fff;border:0;border-radius:8px';
const st=document.createElement('div');st.id='__copyst';st.style.cssText='position:fixed;left:300px;top:30px;font:16px system-ui;z-index:2147483647';
bt.onclick=async()=>{try{await navigator.clipboard.writeText(text);st.textContent='COPIED '+text.length+' chars';}catch(e){st.textContent='COPY FAILED: '+e;}};
const art=document.createElement('article');art.style.marginTop='90px';const pre=document.createElement('pre');pre.style.whiteSpace='pre-wrap';pre.textContent=msgsTxt;art.append(pre);document.body.append(bt,st,art);
return 'count '+out.length+' len '+text.length+' sha '+cap.sha.slice(0,8)+' photos '+photos.length+(failed.length?' FAILED '+failed:'')+' gifs '+gifs+' you '+out.filter(o=>o.f==='You').map(o=>o.i)+(guessed.length?' DATES-GUESSED '+guessed:'');})();
}
  function jump(){
(async function mcJump(){
  var h=location.hash.match(/mcjump=([^&]+)/);if(!h)return;var mid=decodeURIComponent(h[1]);var wantReply=!/noreply/.test(location.hash);
  if(window.__mcJumping===mid)return;window.__mcJumping=mid;
  var sleep=function(ms){return new Promise(function(r){setTimeout(r,ms);});};
  var tip=document.getElementById('mcjump-tip');if(!tip){tip=document.createElement('div');tip.id='mcjump-tip';tip.style.cssText='position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:2147483647;background:#1f5fd6;color:#fff;font:600 14px system-ui;padding:8px 14px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.3)';document.body.appendChild(tip);}
  var say=function(t){tip.textContent=t;tip.style.display='block';};
  say('Jump: finding the message…');
  var log=function(){return document.querySelector('[role="log"]');};
  for(var w=0;w<60&&!(log()&&log().getBoundingClientRect().width>=300);w++)await sleep(250);
  if(!log()){say('Jump: chat not loaded.');return;}
  var sc=function(){return Array.prototype.find.call(log().querySelectorAll('div'),function(x){var s=getComputedStyle(x);return /(auto|scroll)/.test(s.overflowY)&&x.scrollHeight>x.clientHeight;});};
  var find=function(){return log().querySelector('[data-message-id="'+CSS.escape(mid)+'"]');};
  var e=find(),n=0,top=0;
  if(!e){for(var bb=0;bb<5;bb++){var s0=sc();if(s0)s0.scrollTop=s0.scrollHeight;await sleep(600);}e=find();}
  while(!e&&n<600){var s=sc();if(!s)break;s.scrollTop=Math.max(0,s.scrollTop-Math.round(s.clientHeight*0.9));if(s.scrollTop<5){top++;if(top>12)break;}else top=0;await sleep(s.scrollTop<5?1200:350);n++;if(n%10===0)say('Jump: scrolling back… ('+n+')');e=find();}
  if(!e){say('Jump: couldn’t find that message.');window.__mcJumping=null;setTimeout(function(){tip.style.display='none';},6000);return;}
  e.scrollIntoView({block:'center'});await sleep(400);e=find();
  e.style.outline='3px solid #f5b400';e.style.borderRadius='10px';setTimeout(function(){var x=find();if(x)x.style.outline='';},8000);
  if(wantReply){['pointerover','pointerenter','mouseover','mouseenter','mousemove'].forEach(function(t){e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});
    var b=null;for(var k=0;k<10&&!b;k++){await sleep(150);b=e.querySelector('[aria-label="Reply to this message"]');}
    if(b){b.click();say('Jump: reply box is ready. Type and press Enter.');}else say('Jump: found it (hover it and click Reply).');}
  else say('Jump: found it.');
  history.replaceState(null,'',location.pathname+location.search);window.__mcJumping=null;
  setTimeout(function(){tip.style.display='none';},5000);
})();
  }
  async function probe(anchor){var sleep=function(ms){return new Promise(function(r){setTimeout(r,ms);});};
    for(var w=0;w<60;w++){var l=document.querySelector('[role="log"]');if(l&&l.getBoundingClientRect().width>=300)break;await sleep(250);}
    await sleep(2500);var ids=[].map.call(document.querySelectorAll('[role="log"] [data-message-id]'),function(e){return e.getAttribute('data-message-id');});
    var k=ids.indexOf(anchor);return {vis:document.visibilityState,n:ids.length,found:k>=0,after:k>=0?ids.length-k-1:null};}
  /* Full refresh pipeline: scan, reload, verify after the reload, then capture. State rides in sessionStorage across the reload. */
  async function full(a){sessionStorage.removeItem('mc_result');const r=await mcScan(a.stops,a.first);if(r.err||!r.win){const o=Object.assign({stage:'scan',run:a.run||null},r);sessionStorage.setItem('mc_result',JSON.stringify(o));return o;}
    sessionStorage.setItem('mc_pipe',JSON.stringify({base:a.base,run:a.run||null,scan:r,t0:Date.now()}));setTimeout(function(){location.reload();},300);return {stage:'reloading',scan:r};}
  async function resumePipe(){const p=JSON.parse(sessionStorage.getItem('mc_pipe')||'null');if(!p)return;sessionStorage.removeItem('mc_pipe');
    let out={stage:'verify',run:p.run||null,scan:p.scan};
    try{await new Promise(function(r){setTimeout(r,5000);});const v=await mcVerify();out.verify=v;
      if(v.ok){out.stage='captured';out.capture=await mcCapture(p.base);}else out.stage='verify-failed';}catch(e){out.err=String(e);}
    out.ms=Date.now()-p.t0;sessionStorage.setItem('mc_result',JSON.stringify(out));}
  const CMDS={probe:a=>probe(a.anchor),scan:a=>mcScan(a.stops,a.first),verify:()=>mcVerify(),capture:a=>mcCapture(a.base),full:a=>full(a),
    jump:a=>{history.replaceState(null,'',location.pathname+'#mcjump='+encodeURIComponent(a.mid)+(a.reply===false?'&noreply':''));jump();return {started:true};},
    ping:()=>({v:'1.4'})};
  /* Bridge: Claude's browser tool dispatches 'mc-cmd' with a JSON string; the answer lands in sessionStorage 'mc_res_<id>'. Works whether the userscript runs in the page or in the extension's own world. */
  document.addEventListener('mc-cmd',async function(e){let d;try{d=JSON.parse(e.detail);}catch(x){return;}if(!CMDS[d.cmd])return;
    sessionStorage.setItem('mc_res_'+d.id,JSON.stringify({running:true}));
    let res;try{res=await CMDS[d.cmd](d.args||{});}catch(x){res={err:String(x&&x.stack||x)};}
    sessionStorage.setItem('mc_res_'+d.id,JSON.stringify(res));});
  resumePipe();
  jump();addEventListener('hashchange',jump);
  var last=location.href;setInterval(function(){if(location.href!==last){last=location.href;if(/mcjump=/.test(location.hash))jump();}},800);
})();
