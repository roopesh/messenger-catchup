/* Simulated-Messenger tests for the helper (installed and injected paths).
   Run: cd tests && python3 -m http.server 8765 &  then  node sim.js   (needs Playwright with Chromium). */
const {chromium}=require('playwright');const fs=require('fs');const path=require('path');const D=path.join(__dirname,'..')+'/';fs.mkdirSync(D+'tests/out',{recursive:true});const URL=process.env.MOCK_URL||'http://localhost:8765/mock/messenger.html';
const HELPER=fs.readFileSync(D+'assets/helper.user.js','utf8');

const ok=(c,msg)=>{console.log((c?'PASS ':'FAIL ')+msg);if(!c)process.exitCode=1;};
const bridge=async(p,cmd,args)=>p.evaluate(async([cmd,args])=>{const id='x'+Date.now()+Math.random();document.dispatchEvent(new CustomEvent('mc-cmd',{detail:JSON.stringify({id,cmd,args})}));let r;for(let k=0;k<240;k++){await new Promise(z=>setTimeout(z,250));r=JSON.parse(sessionStorage.getItem('mc_res_'+id)||'null');if(r&&!r.running)break;}return r;},[cmd,args]);
const pollResult=async p=>{for(let k=0;k<240;k++){await p.waitForTimeout(250);const r=await p.evaluate(()=>sessionStorage.getItem('mc_result')).catch(()=>null);if(r)return JSON.parse(r);}return null;};
function checkCap(cap,base,mockFrom,n,label){
  ok(cap.kind==='mc-capture'&&cap.count===n,label+': kind mc-capture, '+n+' messages (got '+cap.count+')');
  ok(cap.msgs.every((m,k)=>m.i===base+1+k&&m.m==='mid.$mock'+(mockFrom+k)),label+': numbering #'+(base+1)+'.. and ids match mock '+mockFrom+'..'+(mockFrom+n-1));
  const names=['Ana','Ben','You','Cy','Dee'];ok(cap.msgs.every((m,k)=>m.f===names[(mockFrom+k)%5]),label+': senders right, incl. "You"');
  return cap;}
(async()=>{const b=await chromium.launch();
 // ---------- A: helper installed (userscript manager emulated with an init script) ----------
 const ctxA=await b.newContext({viewport:{width:900,height:800}});await ctxA.addInitScript('document.addEventListener("DOMContentLoaded",function(){'+HELPER+'\n});');const p=await ctxA.newPage();
 await p.goto(URL);await p.evaluate(()=>{localStorage.clear();sessionStorage.clear();localStorage.setItem('mock_total','120');});await p.reload();await p.waitForTimeout(800);
 ok(await p.evaluate(()=>document.documentElement.dataset.mcHelper==='1.1'),'A: helper running (data-mc-helper=1.1)');
 ok((await bridge(p,'ping',{})).v==='1.1','A: bridge ping');
 let r=await bridge(p,'full',{first:{count:50},base:-1});ok(r.stage==='reloading'&&r.scan.win===50,'A1 first run: scan found 50, reloading (scan '+JSON.stringify({win:r.scan.win,reps:r.scan.reps,qm:r.scan.qm,photoReplies:r.scan.photoReplies,perr:r.scan.perr})+')');
 await p.waitForLoadState('load');let res=await pollResult(p);
 ok(res&&res.stage==='captured'&&res.verify.ok&&res.verify.extra===0,'A1: verify after reload ok, captured');
 const cap1=checkCap(JSON.parse(await p.evaluate(()=>window.__capText)),-1,70,50,'A1');
 const byM=Object.fromEntries(cap1.msgs.map(m=>[m.m,m]));
 const rep=[77,84,91,98,105,112,119].every(i=>{const m=byM['mid.$mock'+i];return m&&m.pi===(i-3)-70&&m.pq===1;});ok(rep,'A1: 7 text replies matched to the right parent by quote');
 const r70=byM['mid.$mock70'];ok(r70.pmid==='mid.$mock67'&&!('pi' in r70),'A1: reply to a message before the window kept as Messenger id (pmid)');
 const pr=byM['mid.$mock103'];ok(pr.pi===30&&!pr.pq,'A1: photo reply resolved by clicking "Go to replied message" -> #30');
 ok(byM['mid.$mock100'].p==='9100100'&&cap1.photos.length===1&&cap1.photos[0].i===30,'A1: photo message + photo bytes captured');
 // incremental: 5 new, plus 2 more arrive between scan and verify
 await p.goto(URL);await p.waitForTimeout(600);await p.evaluate(()=>{sessionStorage.removeItem('mc_result');window.addMsgs(5);});
 const stops=cap1.msgs.slice(-3).map(m=>m.m).reverse();
 r=await bridge(p,'full',{stops,base:49});ok(r.stage==='reloading'&&r.scan.win===5,'A2 incremental: scan found 5 new');
 await p.evaluate(()=>localStorage.setItem('mock_total',String(+localStorage.getItem('mock_total')+2)));
 await p.waitForLoadState('load');res=await pollResult(p);
 ok(res&&res.stage==='captured'&&res.verify.extra===2,'A2: 2 messages arrived mid-run: verify extra=2 accepted (prefix identical)');
 const cap2=checkCap(JSON.parse(await p.evaluate(()=>window.__capText)),49,120,5,'A2');
 // jump
 await p.goto('about:blank');await p.goto(URL+'#mcjump='+encodeURIComponent('mid.$mock80')+'&noreply');let jumped=false;for(let k=0;k<20&&!jumped;k++){await p.waitForTimeout(500);jumped=await p.evaluate(()=>{const e=document.querySelector('[data-message-id="mid.$mock80"]');return !!e&&e.style.outline.includes('3px');});}
 ok(jumped,'A: jump link scrolled back and highlighted #mock80');
 // stale result guard: a new full() clears the old mc_result and tags the new one with its run id
 await p.goto(URL);await p.waitForTimeout(600);const stale=await p.evaluate(()=>JSON.parse(sessionStorage.getItem('mc_result')||'null'));
 r=await bridge(p,'full',{stops:['mid.$mock126','mid.$mock125','mid.$mock124'],base:56,run:'runZ'});
 ok(stale&&stale.stage==='captured'&&r.stage==='scan'&&r.win===0&&!r.err,'A3: old captured result present; full() with nothing new reports stage scan, win 0 (nothing new), not the old capture');
 const after=await p.evaluate(()=>JSON.parse(sessionStorage.getItem('mc_result')||'null'));ok(after&&after.run==='runZ'&&after.stage==='scan','A3: mc_result now belongs to runZ ('+(after&&after.stage)+')');
 // short chat: 30 messages total, first run asks for 50 -> all 30, none dropped; old label forms parse
 await p.goto(URL);await p.evaluate(()=>{localStorage.clear();sessionStorage.clear();localStorage.setItem('mock_total','30');});await p.goto('about:blank');await p.goto(URL);await p.waitForTimeout(800);
 r=await bridge(p,'full',{first:{count:50},base:-1,run:'runS'});ok(r.stage==='reloading'&&r.scan.win===30,'A4 short chat: scan took all 30 (anchor = top of chat)');
 await p.waitForLoadState('load');res=await pollResult(p);ok(res&&res.stage==='captured'&&res.run==='runS','A4: verify to the top ok, captured');
 const cap4=checkCap(JSON.parse(await p.evaluate(()=>window.__capText)),-1,0,30,'A4');
 const m0=cap4.msgs[0],m12=cap4.msgs[12],m22=cap4.msgs[22],m27=cap4.msgs[27];
 ok(m0.d==='2025-10-12'&&m0.t==='Sun 9:00 AM','A4: full-date label -> d=2025-10-12, t="Sun 9:00 AM" (got '+m0.d+' / '+m0.t+')');
 ok(/^Thu \d/.test(m12.t)&&/^\d{4}-\d\d-\d\d$/.test(m12.d),'A4: weekday label -> '+m12.t+' '+m12.d);
 ok(/^\w{3} \d/.test(m22.t)&&m22.d!==m27.d,'A4: "Yesterday" label -> '+m22.t+' '+m22.d+' (today '+m27.d+')');
 fs.writeFileSync(D+'tests/out/sim_cap4.json',JSON.stringify(cap4));
 // ---------- B: no helper; Claude injects the file on each step ----------
 const ctxB=await b.newContext({viewport:{width:900,height:800}});const q=await ctxB.newPage();
 await q.goto(URL);await q.evaluate(()=>{localStorage.clear();sessionStorage.clear();localStorage.setItem('mock_total','127');});await q.reload();await q.waitForTimeout(600);
 ok(await q.evaluate(()=>!document.documentElement.dataset.mcHelper),'B: no helper present');
 await q.evaluate(HELPER);const stopsB=['mid.$mock124','mid.$mock123','mid.$mock122'];
 r=await bridge(q,'scan',{stops:stopsB});ok(r&&r.win===2&&!r.err,'B: injected scan found the 2 newer messages');
 await q.reload();await q.waitForTimeout(800);ok(await q.evaluate(()=>!document.documentElement.dataset.mcHelper),'B: injected code gone after reload (as expected)');
 await q.evaluate(HELPER);const v=await bridge(q,'verify',{});ok(v.ok&&v.gap===0&&v.prefixSame,'B: re-injected verify ok');
 const c=await bridge(q,'capture',{base:54});ok(/^count 2 /.test(c),'B: capture '+c);
 const cap3=checkCap(JSON.parse(await q.evaluate(()=>window.__capText)),54,125,2,'B');
 fs.writeFileSync(D+'tests/out/sim_caps.json',JSON.stringify([cap1,cap2,cap3]));
 await b.close();})();
