#!/usr/bin/env python3
"""Messenger Catch-up build tool (generic).
  patool.py bootstrap WORK DBDIR     DBDIR = ArtifactData out_dir holding chunks/*.json, threading/current.json,
                                     summary/current.json, meta/chat.json. Writes WORK/all.json, WORK/base/*, WORK/state.json.
  patool.py build WORK RUNDIR SPEC   RUNDIR = out_dir with the touched chunks/*.json + meta/chat.json fetched after import.
                                     Writes RUNDIR/out/{threading,summary}.json, then advances WORK (all.json, base, state).
SPEC (JSON): {"join":{"convid":[i,...]}, "links":{"i":[parent,"r|rq|rg|i|c"] or null for no link},
  "newconvs":[{"id","title","tag","outcome","key":[...]}], "bullets":{"convid":[["text",[refs]],...]},
  "outcome":{"convid":"..."}, "key":{"convid":[...]}, "deals":[{kind,tag,conv,text,links?,refs}],
  "dealEdit":{"convid":{"text":"...","addRefs":[...]}}, "open":[{conv,ask,to,note}], "closeOpen":[ask,...],
  "answered":[{conv,ask,answer,refs}], "mentions":[{"note","refs":[[i],...]}]}
Link defaults per new message: Messenger reply link (pi / pmid) -> 'r' ('rq' if matched by quote in-browser);
else quote match against stored history (same author + first 20 chars, latest wins) -> 'rq';
reply to a photo with no Messenger link -> latest photo by that author, 'rg' + a CHECK warning;
else 'c' if same author as the previous member of its conversation, otherwise 'i' to that member (printed as GUESS
for review; none if that member is over 3 h older -> ROOT). Override any GUESS in "links" and rebuild."""
import json,sys,re,os,glob,collections,subprocess

def _n(s):
    s=re.sub('[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\u200D]','',s or '')  # Messenger drops emoji from quotes
    s=re.sub(r'\s+',' ',s).strip().rstrip('…').strip().lower()
    return re.sub(r'^[^\w@$#("\']+','',s)
def _who_ok(m,p):
    r=(m.get('r') or '')
    if r.lower()=='you': return p['f']=='You'
    if r.lower() in('themself','themselves','himself','herself'): return p['f']==m['f']
    return p['f']==r or r.startswith(p['f']) or p['f'].startswith(r)
def resolve(m,pool,window=300,n=20):
    if not m.get('r'): return None,None
    cand=[p for p in pool if m['i']-window<=p['i']<m['i'] and _who_ok(m,p)]
    q=_n(m.get('q'))
    if q in('','attachment','photo','gif','video','sticker'):
        c=[p for p in cand if p.get('p') or p.get('a') or not p.get('b')]
        return (max(c,key=lambda p:p['i'])['i'],'rg') if c else (None,None)
    key=q[:n]
    c=[p for p in cand if _n(p.get('b')).startswith(key)] or [p for p in cand if key in _n(p.get('b'))]
    return (max(c,key=lambda p:p['i'])['i'],'rq') if c else (None,None)

def _min(m):  # date from d, time by regex from t, so any Messenger label form (old dates) parses
    import datetime
    d=datetime.date.fromisoformat(m['d']); x=re.search(r'(\d{1,2}):(\d{2})\s*([AP]M)',m.get('t') or '',re.I)
    if not x: return d.toordinal()*1440
    return d.toordinal()*1440+(int(x.group(1))%12+(12 if x.group(3).upper()=='PM' else 0))*60+int(x.group(2))
def _short(m): return ((m.get('b') or '').replace('\n',' ')[:60]+(' [photo]' if m.get('p') else '')+(' [link]' if m.get('a') else '')) or '[media]'

def _load(p): return json.load(open(p))
def _dump(o,p):
    os.makedirs(os.path.dirname(p),exist_ok=True); json.dump(o,open(p,'w'),ensure_ascii=False)
TZ='America/Los_Angeles'
def _ts(): return subprocess.check_output(['date','+%a %b %-d, %-I:%M %p'],env={'TZ':TZ,'PATH':'/usr/bin:/bin'}).decode().strip()

def bootstrap(work,db):
    ms=[]
    for f in sorted(glob.glob(db+'/chunks/*.json')): ms+=_load(f)['msgs']
    byi={}
    for m in ms: byi[m['i']]=m
    al=[byi[i] for i in sorted(byi)]
    assert [m['i'] for m in al]==list(range(len(al))),'gap in stored messages'
    mt=_load(db+'/meta/chat.json'); assert mt['lastI']==(al[-1]['i'] if al else -1),(mt['lastI'],len(al))
    _dump(al,work+'/all.json'); _dump(_load(db+'/threading/current.json'),work+'/base/threading.json'); _dump(_load(db+'/summary/current.json'),work+'/base/summary.json')
    st={'base':al[-1]['i'] if al else -1,'stops':(mt.get('anchorMids') or [])[::-1],'tz':mt.get('tz') or 'America/Los_Angeles'}; _dump(st,work+'/state.json')
    print('bootstrap ok: %d messages, last #%d; STOPS=%s'%(len(al),st['base'],json.dumps(st['stops'])))

def build(work,run,specp):
    global TZ
    sp=_load(specp); st=_load(work+'/state.json'); base=st['base']; TZ=st.get('tz') or TZ
    ms=[]
    for f in sorted(glob.glob(run+'/chunks/*.json')): ms+=_load(f)['msgs']
    al=_load(work+'/all.json'); byi={m['i']:m for m in al}
    assert (al[-1]['i'] if al else -1)==base==len(al)-1,(len(al),base)
    for m in ms:
        if m['i'] in byi: assert byi[m['i']]==m,('stored copy differs',m['i'])
    new=sorted({m['i']:m for m in ms if m['i']>base}.values(),key=lambda m:m['i']); N={m['i']:m for m in new}
    ids=[m['i'] for m in new]; assert ids and ids==list(range(base+1,base+1+len(ids))),ids
    bym={m.get('m'):m['i'] for m in al+new if m.get('m')}
    t=_load(work+'/base/threading.json'); s=_load(work+'/base/summary.json'); C={cv['id']:cv for cv in t['convs']}
    for nc in sp.get('newconvs',[]):
        assert nc['id'] not in C,('conv id exists',nc['id']); cv={'id':nc['id'],'title':nc['title'],'members':[]}; t['convs'].append(cv); C[nc['id']]=cv
        s['convs'].append({'id':nc['id'],'tag':nc.get('tag',''),'synopsis':[],'outcome':nc.get('outcome',''),'key':nc.get('key',[])})
    joined={}
    for cid,mem in sp['join'].items():
        assert cid in C,('unknown conv',cid)
        for i in mem: assert i not in joined,('joined twice',i); joined[i]=cid
    assert sorted(joined)==ids,('unassigned or extra',sorted(set(ids)^set(joined)))
    for i in ids:
        cv=C[joined[i]]; m=N[i]; prev=[x for x in cv['members'] if x<i]; LS=sp.get('links',{}); L=LS.get(str(i))
        if not L and not (str(i) in LS and L is None):  # "i": null in links = deliberately no link (a new topic)
            if m.get('pi'): L=[m['pi'],'rq' if m.get('pq') else 'r']
            elif m.get('pmid') and m['pmid'] in bym: L=[bym[m['pmid']],'rq' if m.get('pq') else 'r']
            elif m.get('r'):
                pr,k=resolve(m,al+new)
                if pr is not None:
                    L=[pr,k]; print(('CHECK photo-reply guess' if k=='rg' else 'matched by quote'),i,'->',pr)
                else: print('WARN reply parent not found',i,'- set "links" by hand')
            if not L and prev:
                p=max(prev); P=byi.get(p) or N.get(p)
                if _min(m)-_min(P)<=180:
                    L=[p,'c' if P['f']==m['f'] else 'i']
                    print('GUESS %d -> %d %s | %s: %s  <=  %s: %s'%(i,p,L[1],m['f'][:12],_short(m),P['f'][:12],_short(P)))
                else: print('ROOT %d (over 3 h since the conversation\'s previous message) | %s'%(i,_short(m)))
        cv['members'].append(i); cv['members'].sort()
        if L: t['links'][str(i)]=L
    t['to']=ids[-1]
    Cn=collections.Counter(v[1] for v in t['links'].values())
    t['note']=re.sub(r'^\d+ reply links.*?\(replies to photos\) by best match',"%d reply links read straight from Messenger; %d matched by their quoted text and %d (replies to photos) by best match"%(Cn['r'],Cn['rq'],Cn['rg']),t.get('note',''))
    seen=collections.Counter(x for cv in t['convs'] for x in cv['members'])
    lo=min(min(cv['members']) for cv in t['convs'] if cv['members'])
    for i in range(lo,ids[-1]+1): assert seen[i]==1,('message in %d conversations'%seen[i],i)
    for k,v in t['links'].items(): assert v[0]<int(k),('link must point back',k,v)
    SC={c['id']:c for c in s['convs']}
    for cid,bs in sp.get('bullets',{}).items():
        for tx,refs in bs: assert len(tx.split())<=15,('bullet over 15 words',tx); SC[cid]['synopsis'].append({'t':tx,'refs':refs})
    for cid,o in sp.get('outcome',{}).items(): assert len(o.split())<=12,('outcome over 12 words',o); SC[cid]['outcome']=o
    for cid,k in sp.get('key',{}).items(): SC[cid]['key']=k
    s['deals']+=sp.get('deals',[])
    for cid,e in sp.get('dealEdit',{}).items():
        d=[d for d in s['deals'] if d['conv']==cid][0]
        if 'text' in e: d['text']=e['text']
        d['refs']=sorted(set(d['refs']+e.get('addRefs',[])))
    s['open']=sp.get('open',[])+[o for o in s['open'] if o['ask'] not in sp.get('closeOpen',[])]
    s['answered']=sp.get('answered',[])+s['answered']; s['mentions']=sp.get('mentions',[])+s['mentions']
    s['toI']=ids[-1]
    cm={cv['id']:set(cv['members']) for cv in t['convs']}
    for cv in s['convs']:
        for k in cv.get('key',[]): assert k in cm[cv['id']],('key not in conv',cv['id'],k)
        for b in cv['synopsis'] if isinstance(cv['synopsis'],list) else []:
            assert b['refs'] and all(r in cm[cv['id']] for r in b['refs']),('bullet ref not in conv',cv['id'],b)
    for o in s['open']+s['answered']: assert all(r in cm[o['conv']] for r in [o['ask']]+o.get('refs',[])),('ref not in conv',o)
    for d in s['deals']: assert d['conv'] in cm,('deal conv missing',d['conv'])
    last={c:max(m) for c,m in cm.items() if m}; s['convs'].sort(key=lambda c:-last.get(c['id'],0))
    mt=_load(run+'/meta/chat.json'); a=mt['anchorMids']; assert mt['lastI']==ids[-1] and a[-1]==new[-1]['m'],'meta/chat not updated by import'
    ts=_ts(); t['builtAt']=ts; s['generatedAt']=ts
    _dump(t,run+'/out/threading.json'); _dump(s,run+'/out/summary.json')
    _dump(t,work+'/base/threading.json'); _dump(s,work+'/base/summary.json'); _dump(al+new,work+'/all.json')
    st={'base':ids[-1],'stops':a[::-1],'tz':TZ}; _dump(st,work+'/state.json')
    print('build ok: #%d-#%d | %s | next STOPS=%s'%(ids[0],ids[-1],dict(collections.Counter(joined.values())),json.dumps(st['stops'])))

if __name__=='__main__':
    cmd=sys.argv[1]
    if cmd=='bootstrap': bootstrap(sys.argv[2].rstrip('/'),sys.argv[3].rstrip('/'))
    elif cmd=='build': build(sys.argv[2].rstrip('/'),sys.argv[3].rstrip('/'),sys.argv[4])
    else: sys.exit(__doc__)
