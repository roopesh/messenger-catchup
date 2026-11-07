/* Page tests: assets/page.html in headless Chromium with a stand-in claude.ai runtime (in-memory db, assets, sample).
   Covers the importer (every check), the real pipeline (sim captures -> page import -> scripts/catchup.py -> render),
   catch-up markers, date entry, outbox, Ask Claude, Views and known bugs.
   Run from the repo root after tests/sim.js (it writes tests/out/sim_caps.json): node tests/page.test.js
   KNOWN lines are docs/BACKLOG.md bugs; they don't fail the run. A FIXED? line means one now passes: close it. */
const {chromium}=require('playwright');const fs=require('fs');const os=require('os');const path=require('path');const crypto=require('crypto');const {execFileSync}=require('child_process');
const ROOT=path.join(__dirname,'..');const PAGE=fs.readFileSync(path.join(ROOT,'assets/page.html'),'utf8');const URL='http://localhost:9917/catchup';
const CATCHUP=path.join(ROOT,'scripts/catchup.py');const CAPS=path.join(__dirname,'out/sim_caps.json');
const ok=(c,msg)=>{console.log((c?'PASS ':'FAIL ')+msg);if(!c)process.exitCode=1;};
const known=(c,msg)=>console.log(c?'FIXED? '+msg+' (passes now: update the test and docs/BACKLOG.md)':'KNOWN '+msg);
const sha=t=>crypto.createHash('sha256').update(t).digest('hex');
const NAMES=['Ana','Ben','You','Cy','Dee'];const TODAY=new Date();const ymd=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
function mk(i,extra){const h=9+Math.floor(i/60),mi=i%60;return Object.assign({i,t:'Fri '+((h%12)||12)+':'+String(mi).padStart(2,'0')+' '+(h<12?'AM':'PM'),f:NAMES[i%5],b:'message '+i,m:'mid.'+i,d:ymd(TODAY)},extra||{});}
function cap(msgs,o={}){const photos=o.photos||[];const c={kind:o.kind||'mc-capture',base:o.base??(msgs.length?msgs[0].i-1:-1),anchor:'x',count:msgs.length,sha:sha(JSON.stringify(msgs)),msgs,gifs:o.gifs||[],photos,phsha:o.phsha||sha(JSON.stringify(photos))};if(o.dry)c.dry=true;return c;}
const range=(a,b,f)=>Array.from({length:b-a+1},(_,k)=>f?f(a+k):mk(a+k));
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/* Stand-in for the claude.ai artifact runtime. Runs before the page script. */
function runtime(seed){
  const store=new Map(),subs=new Map(),writes=[],uploads=[],samples=[];const clone=o=>o==null?o:JSON.parse(JSON.stringify(o));
  const sub=(k,cb)=>{if(!subs.has(k))subs.set(k,[]);subs.get(k).push(cb);};
  const docSnap=p=>{const v=store.get(p);return {exists:v!==undefined,id:p.split('/').pop(),data:()=>clone(v)};};
  const collSnap=c=>({docs:[...store.keys()].filter(k=>k.split('/')[0]===c&&k.split('/').length===2).sort().map(k=>({id:k.split('/')[1],data:()=>clone(store.get(k))}))});
  const notify=p=>setTimeout(()=>{(subs.get('d:'+p)||[]).forEach(cb=>cb(docSnap(p)));const c=p.split('/')[0];(subs.get('c:'+c)||[]).forEach(cb=>cb(collSnap(c)));},0);
  function doc(p){return {
    get:async()=>docSnap(p),
    set:async o=>{store.set(p,clone(o));writes.push({p,op:'set',v:clone(o)});notify(p);},
    update:async o=>{if(!store.has(p))throw Object.assign(new Error('missing '+p),{code:'not_found'});store.set(p,Object.assign(clone(store.get(p)),clone(o)));writes.push({p,op:'update',v:clone(o)});notify(p);},
    onSnapshot:cb=>{sub('d:'+p,cb);setTimeout(()=>cb(docSnap(p)),0);return ()=>{};}};}
  let auto=0;
  const collection=c=>({doc:id=>doc(c+'/'+id),add:async o=>{const id='a'+(++auto);await doc(c+'/'+id).set(o);return {id};},onSnapshot:cb=>{sub('c:'+c,cb);setTimeout(()=>cb(collSnap(c)),0);return ()=>{};}});
  const assets={upload:async(blob,o)=>{const id='blob'+(uploads.length+1);uploads.push({id,size:blob.size,type:o.type});return {id,sizeBytes:blob.size,contentType:o.type};}};
  async function sample(msgs,o){samples.push(msgs);const text='Ben offered one [#1]. Ana asked [#0, #2].';if(o&&o.onText)o.onText({text});return {text};}
  sample.json=async prompt=>{samples.push(prompt);return {title:'By person',intro:'Grouped by who posted.',sections:[{heading:'Ben',tag:'open',summary:'Sells things [#1].',refs:[1]}]};};
  Object.entries(seed||{}).forEach(([p,v])=>store.set(p,clone(v)));
  window.__rt={store,writes,uploads,samples,write:(p,v)=>doc(p).set(v),get:p=>clone(store.get(p)),all:()=>Object.fromEntries([...store].map(([k,v])=>[k,clone(v)]))};
  window.claude={use:async n=>({db:{doc,collection},assets,sample})[n]||null};
}
const META={kind:'messenger-catchup',pageVersion:'1.1',thread:'4242',chatUrl:'https://www.facebook.com/messages/e2ee/t/4242',threadName:'Trail Crew',shortName:'Trail',ownerName:'Sam',ownerAliases:['Sam','Sammy'],topic:'gear',outboxAuto:false,refreshPhrase:'refresh my catch-up',tz:'America/Los_Angeles',helper:'inject',chunkSize:82,lastI:-1,anchorMids:[],markerMode:null};
const SEED=()=>({'meta/chat':Object.assign({},META),'threading/current':{convs:[],links:{},to:-1,note:''},'summary/current':{version:2,convs:[],open:[],answered:[],deals:[],mentions:[],toI:-1},'photos/index':{byI:{},gifs:[]},'refresh/status':{state:'idle'}});

let browser;
async function open(seed){
  const ctx=await browser.newContext({viewport:{width:1000,height:900},locale:'en-US',timezoneId:'America/Los_Angeles'});
  await ctx.route('https://fonts.googleapis.com/**',r=>r.abort());await ctx.route(URL,r=>r.fulfill({body:PAGE,contentType:'text/html; charset=utf-8'}));
  await ctx.addInitScript(runtime,seed);const p=await ctx.newPage();p.errors=[];p.on('pageerror',e=>p.errors.push(e.message));
  await p.goto(URL);await p.waitForFunction(()=>window.__rt&&document.getElementById('window').textContent!=='Loading the chat…');await p.waitForTimeout(200);return p;}
const get=(p,k)=>p.evaluate(k=>__rt.get(k)??null,k);
const nWrites=(p,re)=>p.evaluate(src=>__rt.writes.filter(w=>new RegExp(src).test(w.p)).length,re);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(p,fn,arg,ms=10000){const t=Date.now();for(;;){const v=await p.evaluate(fn,arg);if(v)return v;if(Date.now()-t>ms)return null;await sleep(100);}}
/* Paste like Claude does: a paste event on the page body (or another target). Returns the new refresh/lastImport, or null if the page ignored it. */
async function paste(p,text,sel='body',ms=10000){const before=JSON.stringify(await get(p,'refresh/lastImport'));
  await p.evaluate(([t,s])=>{const dt=new DataTransfer();dt.setData('text/plain',t);document.querySelector(s).dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));},[text,sel]);
  return until(p,b=>{const v=__rt.get('refresh/lastImport');return v&&JSON.stringify(v)!==b?v:null;},before,ms);}
async function viaButton(p,text){const before=JSON.stringify(await get(p,'refresh/lastImport'));
  await p.evaluate(t=>{document.getElementById('imp').open=true;document.getElementById('imp-in').value=t;document.getElementById('imp-go').click();},text);
  return until(p,b=>{const v=__rt.get('refresh/lastImport');return v&&JSON.stringify(v)!==b?v:null;},before);}

/* ---------- 1. importer ---------- */
async function importer(){
  const p=await open(SEED());
  ok(await p.title()==='Trail Catch-up'&&(await p.textContent('#h1'))==='Trail Catch-up','boot: title and heading come from meta/chat');
  ok((await p.textContent('#eyebrow')).includes('Trail Crew'),'boot: eyebrow shows the thread name');
  ok((await p.textContent('#window')).includes('No messages stored yet'),'boot: empty store message');
  let r=await paste(p,JSON.stringify(cap(range(1,3))));ok(r&&!r.ok&&/Gap|must start at #0/.test(r.msg)&&!(await get(p,'chunks/c0000')),'first import that does not start at #0 is refused ('+(r&&r.msg)+')');
  // first import: 120 messages, crosses the 82-message chunk size, one photo, one GIF
  const first=range(0,119,i=>mk(i,i===10?{p:'777',b:''}:{}));
  r=await paste(p,JSON.stringify(cap(first,{photos:[{i:10,k:0,type:'image/png',b64:PNG}],gifs:[5]})));
  ok(r&&r.ok&&r.src==='paste'&&r.fresh===120,'first import by paste: ok, 120 new ('+(r&&r.msg)+')');
  ok(r&&/IMPORT OK: 120 new messages, #0–#119 \(chunks c0000, c0082\)/.test(r.msg)&&/1 photo stored/.test(r.msg),'first import: message names both chunks and the photo');
  ok(await until(p,()=>{const t=document.getElementById('toast');return t&&!t.hidden&&/IMPORT OK/.test(t.textContent);}),'first import: toast shown');
  const c0=await get(p,'chunks/c0000'),c82=await get(p,'chunks/c0082');
  ok(c0&&c0.start===0&&c0.msgs.length===82&&c82&&c82.start===82&&c82.msgs.length===38,'chunks: c0000 holds 82, c0082 holds 38');
  ok(c0.msgs[10].p==='777'&&c0.msgs[10].b===''&&!('pi' in c0.msgs[0]),'chunks: fields kept, empty ones dropped, b kept as ""');
  let m=await get(p,'meta/chat');
  ok(m.lastI===119&&m.lastMid==='mid.119'&&JSON.stringify(m.anchorMids)===JSON.stringify(['mid.117','mid.118','mid.119'])&&m.lastT===first[119].t,'meta/chat: lastI, lastMid, lastT, anchorMids updated');
  ok(m.ownLastI===117&&m.ownLastMid==='mid.117','meta/chat: ownLastI = your newest message');
  const ph=await get(p,'photos/index');const up=await p.evaluate(()=>__rt.uploads);
  ok(ph&&JSON.stringify(ph.byI['10'])==='["/_blob/blob1"]'&&JSON.stringify(ph.gifs)==='[5]'&&up.length===1&&up[0].size===Buffer.from(PNG,'base64').length&&up[0].type==='image/png','photos: uploaded byte-identical size, photos/index and gifs updated');
  // same capture again
  let w0=await nWrites(p,'^chunks/');r=await paste(p,JSON.stringify(cap(first,{photos:[{i:10,k:0,type:'image/png',b64:PNG}]})));
  ok(r&&r.ok&&/Nothing new/.test(r.msg)&&await nWrites(p,'^chunks/')===w0,'same capture again: "Nothing new", no chunk writes');
  // overlap + new
  r=await paste(p,JSON.stringify(cap(range(117,130))));
  ok(r&&r.ok&&r.fresh===11&&(await get(p,'chunks/c0082')).msgs.length===49&&(await get(p,'meta/chat')).lastI===130,'overlapping capture #117–#130: 11 new, appended to c0082');
  // rejections: nothing written for any of them
  const bad=[
    ['tampered message',()=>{const c=cap(range(131,133));c.msgs[0].b='changed';return c;},/Checksum mismatch/],
    ['photo checksum',()=>cap(range(131,132),{photos:[{i:131,k:0,type:'image/png',b64:PNG}],phsha:'0'.repeat(64)}),/Photo checksum mismatch/],
    ['gap after the store',()=>cap(range(132,134)),/Gap: the capture starts at #132 but the store ends at #130/],
    ['numbers not consecutive',()=>cap([mk(131),mk(133)]),/aren't consecutive at #133/],
    ['overlap disagrees with the store',()=>cap(range(129,131,i=>mk(i,i===129?{m:'mid.other'}:{}))),/#129 doesn't match the stored message/],
    ['missing date',()=>cap([Object.assign(mk(131),{d:undefined})]),/#131 is missing a field/],
    ['date in the wrong format',()=>cap([mk(131,{d:'11/06/2026'})]),/#131 is missing a field/],
    ['photo with a bad type',()=>cap(range(131,131),{photos:[{i:131,k:0,type:'text/plain',b64:PNG}]}),/Photo for #131 is malformed/],
    ['photo for a message not in the capture',()=>cap(range(131,131),{photos:[{i:500,k:0,type:'image/png',b64:PNG}]}),/Photo for #500 is malformed/],
  ];
  for(const [name,mkCap,re] of bad){const w=await nWrites(p,'^(chunks|meta|photos)/');r=await paste(p,JSON.stringify(mkCap()));
    ok(r&&!r.ok&&re.test(r.msg)&&await nWrites(p,'^(chunks|meta|photos)/')===w,'refused, nothing written: '+name+' ('+(r&&r.msg)+')');}
  r=await paste(p,JSON.stringify(cap(range(131,132),{dry:true})));ok(r&&r.ok&&r.dry&&/DRY RUN OK: 2 new messages/.test(r.msg)&&(await get(p,'meta/chat')).lastI===130,'dry run: every check, nothing written');
  ok(await paste(p,'hello there',undefined,800)===null,'plain text paste is ignored');
  ok(await paste(p,JSON.stringify(cap(range(131,132),{kind:'cc-capture'})),undefined,800)===null,'old cc-capture kind is ignored on paste');
  r=await viaButton(p,JSON.stringify(cap(range(131,132),{kind:'cc-capture'})));ok(r&&!r.ok&&/isn't a catch-up capture/.test(r.msg),'old cc-capture kind refused by the Import button');
  r=await viaButton(p,'{not json');ok(r&&!r.ok&&/not valid JSON/.test(r.msg),'Import button: invalid JSON refused');
  ok(await paste(p,JSON.stringify(cap(range(131,132))),'#ask-in',800)===null,'paste into a text box is not treated as an import');
  r=await viaButton(p,JSON.stringify(cap(range(131,132))));ok(r&&r.ok&&r.src==='button'&&r.fresh===2&&(await p.inputValue('#imp-in'))==='','Import button: valid capture imported, box cleared');
  ok((await get(p,'meta/chat')).lastI===132,'store ends at #132 after all of the above');
  ok(p.errors.length===0,'importer: no page errors '+JSON.stringify(p.errors));
  await p.context().close();}

/* ---------- 2. real pipeline: sim captures -> page import -> catchup.py -> render ---------- */
function exportDb(all,dir){fs.rmSync(dir,{recursive:true,force:true});
  for(const [k,v] of Object.entries(all)){if(/^(chunks\/|meta\/chat$|threading\/current$|summary\/current$)/.test(k)){fs.mkdirSync(path.join(dir,path.dirname(k)),{recursive:true});fs.writeFileSync(path.join(dir,k+'.json'),JSON.stringify(v));}}
  fs.mkdirSync(path.join(dir,'chunks'),{recursive:true});}
const py=(...a)=>execFileSync('python3',['-W','ignore::ResourceWarning',CATCHUP,...a],{encoding:'utf8'});
function specFor(n,msgs,convOf){
  const conv=m=>{if(m.pi!=null&&convOf[m.pi])return convOf[m.pi];return Math.floor(m.i/10)%2?'packs1':'trail1';};
  const join={};msgs.forEach(m=>{const c=conv(m);convOf[m.i]=c;(join[c]=join[c]||[]).push(m.i);});
  const s={join,bullets:{}};Object.entries(join).forEach(([c,ids])=>{s.bullets[c]=[[ids.length+' new messages in this conversation',[ids[0]]]];});
  if(n===1){s.newconvs=[{id:'trail1',title:'Trail shoes',tag:'For sale',outcome:'Still deciding',key:[]},{id:'packs1',title:'Packs'}];
    s.deals=[{kind:'sale',tag:'For sale',conv:'trail1',text:'Trail shoes, size 10, $60',refs:[join.trail1[0]]}];
    s.open=[{conv:'packs1',ask:join.packs1[join.packs1.length-1],to:'anyone',note:'Nobody answered yet'}];}
  if(n===2){const o=s._closed=Object.keys(convOf).map(Number).filter(i=>convOf[i]==='packs1'&&i<msgs[0].i).pop();s.closeOpen=[o];s.answered=[{conv:'packs1',ask:o,answer:'Answered later',refs:[]}];delete s._closed;}
  const you=msgs.filter(m=>/^you$/i.test(m.r||''));if(you.length)s.mentions=[{note:'Replied to you',refs:you.map(m=>[m.i])}];
  return s;}
async function pipeline(){
  if(!fs.existsSync(CAPS)){ok(false,'pipeline: '+path.relative(ROOT,CAPS)+' missing: run tests/sim.js first (npm test does)');return;}
  const caps=JSON.parse(fs.readFileSync(CAPS,'utf8'));const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mc-pipe-'));const work=path.join(tmp,'work');
  const p=await open(SEED());exportDb(await p.evaluate(()=>__rt.all()),path.join(tmp,'seed'));
  ok(/bootstrap ok: 0 messages/.test(py('bootstrap',work,path.join(tmp,'seed'))),'pipeline: bootstrap from the seeded page');
  const convOf={};let n=0;
  for(const c of caps){n++;const r=await paste(p,JSON.stringify(c));ok(r&&r.ok&&r.fresh===c.count,'pipeline import '+n+': '+(r&&r.msg));
    const run=path.join(tmp,'run'+n);exportDb(await p.evaluate(()=>__rt.all()),run);
    const spec=path.join(tmp,'spec'+n+'.json');fs.writeFileSync(spec,JSON.stringify(specFor(n,c.msgs,convOf)));
    let out;try{out=py('build',work,run,spec);}catch(e){out=String(e.stdout||'')+String(e.stderr||e);}
    ok(/build ok: #\d+-#\d+/.test(out),'pipeline build '+n+': '+(out.match(/build ok[^\n]*/)||[out.trim().split('\n').pop()])[0]);
    const th=JSON.parse(fs.readFileSync(path.join(run,'out/threading.json'),'utf8'));const sm=JSON.parse(fs.readFileSync(path.join(run,'out/summary.json'),'utf8'));
    await p.evaluate(([t,s])=>{__rt.write('threading/current',t);__rt.write('summary/current',s);},[th,sm]);}
  await p.waitForTimeout(400);
  const total=caps.reduce((a,c)=>a+c.count,0);const th=await get(p,'threading/current');const sm=await get(p,'summary/current');
  ok(total===57&&(await get(p,'meta/chat')).lastI===56,'pipeline: 3 imports, 57 messages stored (#0–#56)');
  ok(th.links['33']&&th.links['33'][0]===30&&th.links['33'][1]==='r','pipeline: photo reply #33 linked to #30 from the clicked Messenger link');
  ok([77,84,91,98,105,112,119].map(x=>x-70).every(i=>th.links[i]&&th.links[i][1]==='rq'),'pipeline: 7 quote-matched text replies kept as rq');
  // summary tab
  const strip=await p.$$eval('#strip .stat',s=>s.map(x=>x.textContent));ok(strip[0]==='57new messages','header: 57 new messages ('+strip[0]+')');
  const cards=await p.$$eval('#v-summary article.cv',a=>a.map(x=>x.dataset.conv));ok(cards.length===2&&cards.includes('trail1')&&cards.includes('packs1'),'summary: one card per conversation ('+cards+')');
  const chips=await p.$$eval('#v-summary .seg.filt button',b=>b.map(x=>x.textContent));ok(chips.join('|')==='All (2)|Open questions (0)|Deals & sales (1)|Answered (1)','summary: filter counts ('+chips.join('|')+')');
  ok(await p.$eval('#v-summary',v=>/Trail shoes, size 10, \$60/.test(v.textContent)&&/Answered later/.test(v.textContent)),'summary: deal and answered call-outs rendered in their cards');
  const needs=await p.$$eval('#v-summary .item.mention .snip',s=>s.length);ok(needs===(sm.mentions[0]||{refs:[]}).refs.length&&needs>0,'summary: "Needs you" lists every reply to you ('+needs+')');
  ok(await p.$$eval('#v-summary article.cv[data-conv="trail1"] button.bul',b=>b.length)===0,'summary: a bullet citing the deal\'s message is hidden (the deal call-out covers it)');
  ok(await p.$$eval('#v-summary article.cv[data-conv="packs1"] button.bul',b=>b.length)===3,'summary: packs1 shows its 3 bullets, one per build');
  await p.click('#v-summary article.cv[data-conv="packs1"] button.bul');ok(await until(p,()=>{const d=document.querySelector('article.cv[data-conv="packs1"] details.thr');return d&&d.open&&d.querySelector('.msg.flash');}),'summary: a bullet opens its thread and highlights its messages');
  await p.click('#v-summary .seg.filt button:nth-child(3)');ok((await p.$$eval('#v-summary article.cv',a=>a.map(x=>x.dataset.conv))).join()==='trail1','summary: Deals filter shows only the card with the deal');
  await p.click('#v-summary .seg.filt button:nth-child(1)');
  // messages tab, threaded
  await p.evaluate(()=>{location.hash='#messages';});await p.waitForTimeout(150);
  ok(await p.$$eval('#msgs details.conv',d=>d.length)===2&&await p.$('#msgs .legend'),'messages: threaded view with 2 conversations and a legend');
  ok(await p.$eval('#m33',r=>!!r.closest('.kids')&&/reply to #30/.test(r.textContent)),'messages: #33 nested under its parent with "reply to #30"');
  ok(await p.$eval('#m30 .pics img',i=>i.getAttribute('src'))==='/_blob/blob1','messages: photo #30 shown from its uploaded blob');
  const href=await p.$eval('#m40 a.replylink',a=>a.href);ok(href.startsWith(META.chatUrl+'#mcjump=')&&href.includes(encodeURIComponent('mid.$mock110')),'messages: Reply in Messenger uses the stored e2ee chatUrl + #mcjump=<mid>');
  await p.click('#lay-flat');ok(await p.$$eval('#msgs .msg',r=>r.length)===57,'messages: timeline shows all 57');
  await p.fill('#msg-q','Message number 75 ');await p.waitForTimeout(300);ok(await p.$$eval('#msgs .msg',r=>r.length)===1,'messages: filter by text finds exactly one');
  await p.fill('#msg-q','');await p.waitForTimeout(250);
  // markers
  await p.evaluate(()=>{location.hash='#summary';});await p.click('#caught');
  ok(await until(p,()=>{const m=__rt.get('meta/chat');return m.markerMode==='caught'&&m.caughtUpI===56;}),'marker: Mark caught up saves caughtUpI = newest, mode caught');
  ok(await until(p,()=>document.querySelector('#strip .stat .n').textContent==='0'&&/You're caught up through #56/.test(document.getElementById('v-summary').textContent)),'marker: window empty, "You\'re caught up"');
  const ownI=(await get(p,'meta/chat')).ownLastI;await p.click('#marker input[value="own"]');
  ok(await until(p,o=>__rt.get('meta/chat').markerMode==='own'&&document.querySelector('#strip .stat .n').textContent===String(56-o),ownI),'marker: "since your last message" shows the '+(56-ownI)+' after #'+ownI);
  // date entry regression (EXPERIMENTS.md §6): no save and no rebuild while typing; one save after the pause
  const from='#marker input[aria-label="From"]';await p.waitForTimeout(300);const before=await nWrites(p,'^meta/chat$');await p.click(from);await p.waitForTimeout(300);
  const handle=await p.evaluateHandle(()=>document.activeElement);ok(await handle.evaluate((e,s)=>e.matches(s),from),'date entry: the From box has focus');
  await p.keyboard.press('ArrowLeft');await p.keyboard.press('ArrowLeft');await p.keyboard.press('ArrowLeft');await p.keyboard.press('ArrowLeft');await p.keyboard.press('ArrowLeft');
  const want=ymd(TODAY)+'T09:15';const [Y,M,D]=ymd(TODAY).split('-');await p.keyboard.type(M+D+Y+'0915A',{delay:60});
  ok(await handle.evaluate(e=>e.isConnected&&document.activeElement===e),'date entry: the box was not rebuilt while typing');
  ok(await nWrites(p,'^meta/chat$')===before,'date entry: nothing saved while typing');
  ok(await handle.inputValue()===want,'date entry: box holds '+want+' ('+await handle.inputValue()+')');
  await p.waitForTimeout(1900);const ws=await p.evaluate(()=>__rt.writes.filter(w=>w.p==='meta/chat'&&'markerFrom' in w.v));
  ok(ws.length===1&&ws[0].v.markerFrom===want&&ws[0].v.markerMode==='time','date entry: exactly one save after the pause, with the typed value');
  await p.keyboard.press('Tab');await p.waitForTimeout(300);
  ok(/Catch-up window: /.test(await p.textContent('#window')),'date entry: header shows the date window');
  // outbox
  await p.click('#marker input[value="own"]');await p.evaluate(()=>{location.hash='#messages';});await p.click('#lay-flat');await p.waitForTimeout(200);
  const ri=56;await p.click('#m'+ri+' button.rh');await p.fill('#m'+ri+' .compose textarea','on my way');await p.click('#m'+ri+' .compose button.primary');
  const ob=await until(p,()=>{const k=[...__rt.store.keys()].find(k=>k.startsWith('outbox/'));return k?Object.assign({id:k},__rt.get(k)):null;});
  ok(ob&&ob.i===ri&&ob.mid==='mid.$mock126'&&ob.text==='on my way'&&ob.state==='queued'&&ob.to==='Ben'&&ob.queuedAt,'outbox: Reply here queues {i, mid, to, text, state:queued}');
  ok(await until(p,i=>/reply queued/.test(document.querySelector('#m'+i).textContent)&&!document.querySelector('#m'+i+' .compose'),ri),'outbox: the row shows a "reply queued" chip once saved');
  await p.evaluate(()=>{location.hash='#summary';});ok(await until(p,()=>/Your replies/.test(document.getElementById('v-summary').textContent)&&/1 queued/.test(document.getElementById('v-summary').textContent)),'outbox: "Your replies · 1 queued" on Summary');
  await p.click('#v-summary .item.ob button.link');ok(await until(p,id=>__rt.get(id).state==='cancelled',ob.id),'outbox: Cancel this reply sets state cancelled');
  // ask + views (stub sample)
  await p.evaluate(()=>{location.hash='#ask';});await p.fill('#ask-in','What was for sale?');await p.click('#ask-go');
  ok(await until(p,()=>document.querySelectorAll('#chat .turn.assistant a.cite').length===3),'ask: answer rendered with [#n] citations as links');
  const prompt=await p.evaluate(()=>__rt.samples[0][0].content);ok(/MESSAGES:\n#\d+ \[/.test(prompt)&&prompt.includes('Sam'),'ask: prompt carries the owner name and the window messages');
  ok(await until(p,()=>[...__rt.store.keys()].some(k=>k.startsWith('qa/'))),'ask: question and answer saved to qa');
  await p.click('#chat a.cite');ok(await until(p,()=>location.hash==='#messages'&&document.querySelector('.msg.flash')),'ask: a citation jumps to the message');
  await p.evaluate(()=>{location.hash='#views';});await p.fill('#view-in','group by person');await p.click('#view-go');
  ok(await until(p,()=>/By person/.test(document.getElementById('view-out').textContent)&&[...__rt.store.keys()].some(k=>k.startsWith('views/'))),'views: built view rendered and saved');
  ok(p.errors.length===0,'pipeline: no page errors '+JSON.stringify(p.errors));
  await p.context().close();fs.rmSync(tmp,{recursive:true,force:true});}

/* ---------- 3. config variants and known bugs ---------- */
async function variants(){
  let p=await open(Object.assign(SEED(),{'meta/chat':Object.assign({},META,{outboxAuto:true})}));
  ok(/posts it in Messenger/.test(await p.textContent('[data-outbox-mode]')),'outboxAuto on: Refreshing text says Claude posts replies on its next run');
  await paste(p,JSON.stringify(cap(range(0,4))));await p.evaluate(()=>{location.hash='#messages';});await p.waitForTimeout(200);
  await p.click('#m4 button.rh');await p.fill('#m4 .compose textarea','hi');
  await p.evaluate(()=>{window.__seen=[];new MutationObserver(ms=>ms.forEach(m=>{const t=m.target.textContent||'';if(/^Queued\./.test(t))__seen.push(t);})).observe(document.body,{subtree:true,childList:true,characterData:true});});
  await p.click('#m4 .compose button.primary');const seen=await until(p,()=>__seen[0]);
  ok(!!seen,'outbox: "Queued…" confirmation shown (briefly, before the row re-renders)');
  known(seen&&!/and confirm/.test(seen),'B9: "Queued" text says "and confirm" even with auto-posting on');
  await p.context().close();
  // B8: one malformed link in a message
  p=await open(SEED());await paste(p,JSON.stringify(cap(range(0,4,i=>mk(i,i===2?{l:['not a url']}:{})))));await p.evaluate(()=>{location.hash='#messages';});await p.waitForTimeout(300);
  known(await p.$$eval('#msgs .msg',r=>r.length)===5&&p.errors.length===0,'B8: a malformed link crashes the Messages render ('+p.errors.length+' page errors)');
  await p.context().close();
  // B7: a mention of message #0
  p=await open(SEED());await paste(p,JSON.stringify(cap(range(0,4))));
  await p.evaluate(()=>{__rt.write('threading/current',{convs:[{id:'a',title:'A',members:[0,1,2,3,4]}],links:{},to:4,note:''});__rt.write('summary/current',{version:2,convs:[{id:'a',tag:'',synopsis:[],outcome:'',key:[]}],open:[],answered:[],deals:[],mentions:[{note:'Ana named you',refs:[[0]]}],toI:4,generatedAt:'now'});});
  await p.waitForTimeout(300);known(/message 0/.test(await p.$eval('#v-summary .item.mention',e=>e.textContent).catch(()=>'')),'B7: a mention of #0 renders without its text');
  ok(p.errors.length===0,'variants: no page errors '+JSON.stringify(p.errors));
  await p.context().close();}

(async()=>{browser=await chromium.launch();
  try{await importer();await pipeline();await variants();}catch(e){ok(false,'crashed: '+(e&&e.stack||e));}
  await browser.close();})();
