"""Tests for scripts/catchup.py (bootstrap + build). Run: python3 -m unittest discover -s tests
Known bugs from docs/BACKLOG.md are marked expectedFailure; when one starts passing, unittest reports
"unexpected success": remove the marker and close the backlog item."""
import contextlib,importlib.util,io,json,os,sys,tempfile,unittest

ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec=importlib.util.spec_from_file_location('catchup',os.path.join(ROOT,'scripts','catchup.py'))
catchup=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(catchup)

def tm(h,mi,day='Fri'):
    return '%s %d:%02d %s'%(day,(h%12) or 12,mi,'PM' if h>=12 else 'AM')
def msg(i,f,b='',h=9,mi=None,d='2026-11-06',**kw):
    o={'i':i,'t':tm(h,i if mi is None else mi),'d':d,'f':f,'b':b,'m':'mid.%d'%i};o.update(kw);return o

def w(p,o):
    os.makedirs(os.path.dirname(p),exist_ok=True)
    with open(p,'w') as fh: json.dump(o,fh)
def r(p):
    with open(p) as fh: return json.load(fh)

class Env:
    """A scratch WORK dir plus fake ArtifactData out_dirs, shaped like the real ones."""
    def __init__(self,d):
        self.d=d;self.msgs=[];self.n=0;self.work=os.path.join(d,'work')
    def _chunks(self,into,only_new_from=None):
        for k in range(0,len(self.msgs),82):
            ch=self.msgs[k:k+82]
            if only_new_from is None or ch[-1]['i']>=only_new_from:
                w(os.path.join(into,'chunks','c%04d.json'%k),{'start':k,'msgs':ch})
    def seed(self,msgs=(),threading=None,summary=None,meta=None):
        db=os.path.join(self.d,'db');self.msgs=list(msgs);self._chunks(db)
        os.makedirs(os.path.join(db,'chunks'),exist_ok=True)
        last=self.msgs[-1] if self.msgs else None
        w(os.path.join(db,'meta','chat.json'),dict({'lastI':last['i'] if last else -1,'anchorMids':[m['m'] for m in self.msgs[-3:]],'tz':'America/Los_Angeles'},**(meta or {})))
        w(os.path.join(db,'threading','current.json'),threading or {'convs':[],'links':{},'to':-1,'note':''})
        w(os.path.join(db,'summary','current.json'),summary or {'version':2,'convs':[],'open':[],'answered':[],'deals':[],'mentions':[],'toI':-1})
        return quiet(catchup.bootstrap,self.work,db)
    def run(self,new,meta=None):
        """Simulate an import: append `new`, write the touched chunks and the updated meta/chat into a RUN dir."""
        self.n+=1;run=os.path.join(self.d,'run%d'%self.n);first=new[0]['i'];self.msgs+=new;self._chunks(run,first)
        w(os.path.join(run,'meta','chat.json'),meta or {'lastI':self.msgs[-1]['i'],'anchorMids':[m['m'] for m in self.msgs[-3:]]})
        return run
    def build(self,run,spec):
        p=os.path.join(self.d,'spec%d.json'%self.n);w(p,spec);return quiet(catchup.build,self.work,run,p)
    def state(self): return r(os.path.join(self.work,'state.json'))

def quiet(fn,*a):
    buf=io.StringIO()
    with contextlib.redirect_stdout(buf): fn(*a)
    return buf.getvalue()

# A first run that exercises every default-link rule.
SCENARIO=[
    msg(0,'Ana','Anyone selling a 30L pack?'),
    msg(1,'Ben','I have one, $120'),                                   # GUESS i -> 0
    msg(2,'Ben','barely used'),                                        # GUESS c -> 1
    msg(3,'You',"I'll take it",r='Ben',q='I have one, $120',pi=1),     # Messenger link -> r
    msg(4,'Ana','nice',r='Ben',q='barely used',pi=2,pq=1),             # quote-matched in browser -> rq
    msg(5,'Cy','me too',r='Ana',q='Anyone selling a 30L pack?'),       # quote match on history -> rq
    msg(6,'Dee','',p='999'),                                           # a photo, first in its conv
    msg(7,'Ben','that one?',r='Dee',q='Photo'),                        # photo reply, no link -> rg + CHECK
    msg(8,'Ana','new topic',h=13,mi=30),                               # >3 h after its conv's last message -> ROOT
    msg(9,'Ben','hmm',h=13,mi=31),                                     # would GUESS, spec says null
    msg(10,'Cy','x',h=13,mi=32),                                       # spec override
]
SPEC={'newconvs':[{'id':'gear1106','title':'30L pack','tag':'For sale','outcome':'Sold to You','key':[0,3]},
                  {'id':'pics1106','title':'Photos'}],
      'join':{'gear1106':[0,1,2,3,4,5,8,9,10],'pics1106':[6,7]},
      'links':{'9':None,'10':[5,'i']},
      'bullets':{'gear1106':[['Ana asked for a 30L pack',[0]],['Ben offered one for $120',[1,2]]]},
      'deals':[{'kind':'sale','tag':'For sale','conv':'gear1106','text':'30L pack $120','refs':[1]}],
      'open':[{'conv':'gear1106','ask':8,'to':'anyone','note':''}],
      'answered':[{'conv':'gear1106','ask':0,'answer':'Ben has one for $120','refs':[1]}],
      'mentions':[{'note':'Ben replied to you','refs':[[3]]}]}

class TestBootstrap(unittest.TestCase):
    def setUp(self): self.t=tempfile.TemporaryDirectory();self.e=Env(self.t.name)
    def tearDown(self): self.t.cleanup()
    def test_empty_seed(self):
        out=self.e.seed()
        self.assertIn('bootstrap ok: 0 messages, last #-1',out)
        self.assertEqual(self.e.state(),{'base':-1,'stops':[],'tz':'America/Los_Angeles'})
        self.assertEqual(r(os.path.join(self.e.work,'all.json')),[])
    def test_existing_history_and_stops(self):
        ms=[msg(i,'Ana','m%d'%i,mi=i%60) for i in range(100)]
        self.e.seed(ms)
        st=self.e.state();self.assertEqual(st['base'],99);self.assertEqual(st['stops'],['mid.99','mid.98','mid.97'])
        self.assertEqual(len(r(os.path.join(self.e.work,'all.json'))),100)
    def test_tz_from_meta(self):
        self.e.seed(meta={'tz':'Europe/Berlin'});self.assertEqual(self.e.state()['tz'],'Europe/Berlin')
    def test_gap_in_stored_messages(self):
        with self.assertRaisesRegex(AssertionError,'gap in stored messages'):
            self.e.seed([msg(0,'Ana'),msg(2,'Ben')])
    def test_lastI_mismatch(self):
        with self.assertRaises(AssertionError): self.e.seed([msg(0,'Ana')],meta={'lastI':5})

class TestBuild(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.e=Env(self.t.name);self.e.seed()
    def tearDown(self): self.t.cleanup()
    def first(self):
        run=self.e.run([dict(m) for m in SCENARIO]);out=self.e.build(run,SPEC);return run,out

    def test_default_links(self):
        run,out=self.first();t=r(os.path.join(run,'out','threading.json'))
        self.assertEqual(t['links'],{'1':[0,'i'],'2':[1,'c'],'3':[1,'r'],'4':[2,'rq'],'5':[0,'rq'],'7':[6,'rg'],'10':[5,'i']})
    def test_printed_review_lines(self):
        _,out=self.first()
        for line in ('GUESS 1 -> 0 i','GUESS 2 -> 1 c','matched by quote 5 -> 0','CHECK photo-reply guess 7 -> 6','ROOT 8'):
            self.assertIn(line,out)
        self.assertNotIn('GUESS 9',out);self.assertNotIn('GUESS 10',out)
        self.assertIn('build ok: #0-#10',out)
    def test_threading_and_summary_outputs(self):
        run,_=self.first();t=r(os.path.join(run,'out','threading.json'));s=r(os.path.join(run,'out','summary.json'))
        self.assertEqual({c['id']:c['members'] for c in t['convs']},{'gear1106':[0,1,2,3,4,5,8,9,10],'pics1106':[6,7]})
        self.assertEqual(t['to'],10);self.assertTrue(t['builtAt'])
        self.assertEqual(s['toI'],10);self.assertTrue(s['generatedAt']);self.assertEqual(s['version'],2)
        self.assertEqual([c['id'] for c in s['convs']],['gear1106','pics1106'])   # newest activity first
        g=s['convs'][0];self.assertEqual(g['outcome'],'Sold to You');self.assertEqual(len(g['synopsis']),2)
        self.assertEqual(s['open'][0]['ask'],8);self.assertEqual(s['answered'][0]['ask'],0)
        self.assertEqual(s['deals'][0]['refs'],[1]);self.assertEqual(s['mentions'][0]['refs'],[[3]])
    def test_work_advances(self):
        self.first();st=self.e.state()
        self.assertEqual(st['base'],10);self.assertEqual(st['stops'],['mid.10','mid.9','mid.8'])
        self.assertEqual(len(r(os.path.join(self.e.work,'all.json'))),11)
        self.assertEqual(r(os.path.join(self.e.work,'base','threading.json'))['to'],10)

    def test_incremental_build(self):
        self.first()
        new=[msg(11,'Dee','still available?',h=13,mi=40,r='Ben',q='I have one, $120',pmid='mid.1'),   # parent by Messenger id from history
             msg(12,'Ben','yes',h=13,mi=41),
             msg(13,'Ana','also selling a stove',h=13,mi=42)]
        run=self.e.run(new)
        out=self.e.build(run,{'newconvs':[{'id':'stove1106','title':'Stove'}],
                              'join':{'gear1106':[11,12],'stove1106':[13]},
                              'closeOpen':[8],'answered':[{'conv':'gear1106','ask':11,'answer':'yes','refs':[12]}],
                              'outcome':{'gear1106':'Still available'},
                              'dealEdit':{'gear1106':{'text':'30L pack $120, still available','addRefs':[12]}},
                              'bullets':{'stove1106':[['Ana is selling a stove',[13]]]}})
        t=r(os.path.join(run,'out','threading.json'));s=r(os.path.join(run,'out','summary.json'))
        self.assertEqual(t['links']['11'],[1,'r']);self.assertEqual(t['links']['12'],[11,'i'])
        self.assertNotIn('13',t['links'])                                   # first message of a new conv
        self.assertEqual(s['open'],[]);self.assertEqual([a['ask'] for a in s['answered']],[11,0])
        self.assertEqual(s['deals'][0]['text'],'30L pack $120, still available');self.assertEqual(s['deals'][0]['refs'],[1,12])
        self.assertEqual(s['convs'][0]['id'],'stove1106')
        self.assertEqual(self.e.state()['base'],13);self.assertIn('build ok: #11-#13',out)

    def test_quote_match_latest_wins_and_window(self):
        ms=[msg(0,'Ana','same words here again'),msg(1,'Ana','same words here again'),msg(2,'Ben','ok')]
        self.assertEqual(catchup.resolve(dict(msg(3,'Ben','x'),r='Ana',q='same words here again'),ms),(1,'rq'))
        far=[msg(0,'Ana','far away words')]
        self.assertEqual(catchup.resolve(dict(msg(301,'Ben','x'),r='Ana',q='far away words'),far),(None,None))
        self.assertEqual(catchup.resolve(dict(msg(300,'Ben','x'),r='Ana',q='far away words'),far),(0,'rq'))
    def test_quote_match_you_and_themself(self):
        ms=[msg(0,'You','my own words here'),msg(1,'Ben','ben says something')]
        self.assertEqual(catchup.resolve(dict(msg(2,'Ana','x'),r='you',q='my own words here'),ms),(0,'rq'))
        self.assertEqual(catchup.resolve(dict(msg(2,'Ben','x'),r='themself',q='ben says something'),ms),(1,'rq'))
    def test_normalize(self):
        self.assertEqual(catchup._n('🔥🔥 Great   DEAL…'),'great deal')
        self.assertEqual(catchup._n('  "Quoted"  '),'"quoted"')
    def test_minutes(self):
        self.assertEqual(catchup._min(msg(0,'A',h=12,mi=0))-catchup._min(msg(0,'A',h=0,mi=0)),12*60)
        old=msg(0,'A',d='2025-10-12');old['t']='October 12, 2025 at 9:00 AM'      # any label form: time by regex
        self.assertEqual(catchup._min(old)%1440,9*60)

class TestRestore(unittest.TestCase):
    """B2: a build keeps the WORK it started from in WORK/prev; `restore` undoes it so the same RUN can be built again."""
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.e=Env(self.t.name);self.e.seed()
        self.run=self.e.run([msg(0,'Ana','a'),msg(1,'Ben','b')]);self.spec={'newconvs':[{'id':'a','title':'A'}],'join':{'a':[0,1]}}
    def tearDown(self): self.t.cleanup()
    def W(self,f): return r(os.path.join(self.e.work,f))
    def test_rebuild_without_restore_says_what_to_do(self):
        self.e.build(self.run,self.spec)
        with self.assertRaisesRegex(AssertionError,r'RUN already built into WORK \(WORK is at #1, RUN ends at #1\)\. To build it again, run: catchup.py restore WORK'):
            self.e.build(self.run,self.spec)
    def test_restore_then_rebuild_with_a_new_spec(self):
        self.e.build(self.run,self.spec);self.assertEqual(self.e.state()['base'],1)
        out=quiet(catchup.restore,self.e.work);self.assertIn('restore ok: WORK back at #-1',out)
        self.assertEqual(self.e.state()['base'],-1);self.assertEqual(self.W('all.json'),[]);self.assertEqual(self.W('base/threading.json')['convs'],[])
        self.assertFalse(os.path.exists(os.path.join(self.e.work,'prev')))
        self.e.build(self.run,{'newconvs':[{'id':'b','title':'B'}],'join':{'b':[0,1]}})
        self.assertEqual([c['id'] for c in r(os.path.join(self.run,'out','threading.json'))['convs']],['b'])
        self.assertEqual(self.e.state()['base'],1)
    def test_restore_only_undoes_the_last_build(self):
        self.e.build(self.run,self.spec);run2=self.e.run([msg(2,'Cy','c')]);self.e.build(run2,{'join':{'a':[2]}})
        quiet(catchup.restore,self.e.work);self.assertEqual(self.e.state()['base'],1);self.assertEqual(len(self.W('all.json')),2)
        with self.assertRaisesRegex(AssertionError,'nothing to restore'): catchup.restore(self.e.work)
    def test_nothing_to_restore_after_bootstrap(self):
        with self.assertRaisesRegex(AssertionError,'nothing to restore'): catchup.restore(self.e.work)
    def test_bootstrap_clears_a_stale_prev(self):
        self.e.build(self.run,self.spec);self.assertTrue(os.path.exists(os.path.join(self.e.work,'prev')))
        self.e.seed();self.assertFalse(os.path.exists(os.path.join(self.e.work,'prev')))
    def test_rejected_build_leaves_prev_alone(self):
        self.e.build(self.run,self.spec);before=self.W('prev/state.json')
        run2=self.e.run([msg(2,'Cy','c')])
        with self.assertRaises(AssertionError): self.e.build(run2,{'join':{'nope':[2]}})
        self.assertEqual(self.W('prev/state.json'),before)
    def test_cli_restore(self):
        import subprocess
        self.e.build(self.run,self.spec)
        p=subprocess.run([sys.executable,os.path.join(ROOT,'scripts','catchup.py'),'restore',self.e.work],capture_output=True,text=True)
        self.assertEqual(p.returncode,0,p.stderr);self.assertIn('restore ok',p.stdout)

class TestBuildRejects(unittest.TestCase):
    """Every assert fires before anything is written, so WORK never advances on a rejected build."""
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.e=Env(self.t.name);self.e.seed()
        self.new=[msg(0,'Ana','question here'),msg(1,'Ben','answer here'),msg(2,'Cy','more')]
        self.conv={'newconvs':[{'id':'a','title':'A'}]}
    def tearDown(self): self.t.cleanup()
    def reject(self,spec,pattern='',new=None,meta=None):
        before=self.e.state();run=self.e.run(new or self.new,meta)
        with self.assertRaisesRegex(AssertionError,pattern): self.e.build(run,spec)
        self.assertEqual(self.e.state(),before,'WORK advanced on a rejected build')
        self.assertFalse(os.path.exists(os.path.join(run,'out')),'RUN/out written on a rejected build')
    def spec(self,**kw): return dict(self.conv,join={'a':[0,1,2]},**kw)

    def test_bullet_over_15_words(self):
        self.reject(self.spec(bullets={'a':[[' '.join(['w']*16),[0]]]}),'bullet over 15 words')
    def test_bullet_15_words_ok(self):
        run=self.e.run(self.new);self.e.build(run,self.spec(bullets={'a':[[' '.join(['w']*15),[0]]]}))
    def test_outcome_over_12_words(self):
        self.reject(self.spec(outcome={'a':' '.join(['w']*13)}),'outcome over 12 words')
    def test_joined_twice(self):
        self.reject(dict(self.conv,newconvs=[{'id':'a','title':'A'},{'id':'b','title':'B'}],join={'a':[0,1,2],'b':[2]}),'joined twice')
    def test_unassigned_message(self):
        self.reject(dict(self.conv,join={'a':[0,1]}),'unassigned or extra')
    def test_extra_message(self):
        self.reject(dict(self.conv,join={'a':[0,1,2,3]}),'unassigned or extra')
    def test_unknown_conv(self):
        self.reject({'join':{'nope':[0,1,2]}},'unknown conv')
    def test_conv_id_exists(self):
        run=self.e.run(self.new);self.e.build(run,self.spec())
        self.new=[msg(3,'Ana','x')];self.reject({'newconvs':[{'id':'a','title':'again'}],'join':{'a':[3]}},'conv id exists')
    def test_link_must_point_back(self):
        self.reject(self.spec(links={'1':[2,'i']}),'link must point back')
    def test_key_not_in_conv(self):
        self.reject(dict(newconvs=[{'id':'a','title':'A','key':[5]}],join={'a':[0,1,2]}),'key not in conv')
    def test_bullet_ref_not_in_conv(self):
        self.reject(dict(newconvs=[{'id':'a','title':'A'},{'id':'b','title':'B'}],join={'a':[0,1],'b':[2]},bullets={'a':[['x',[2]]]}),'bullet ref not in conv')
    def test_bullet_without_refs(self):
        self.reject(self.spec(bullets={'a':[['x',[]]]}),'bullet ref not in conv')
    def test_open_ask_not_in_conv(self):
        self.reject(dict(newconvs=[{'id':'a','title':'A'},{'id':'b','title':'B'}],join={'a':[0,1],'b':[2]},open=[{'conv':'a','ask':2,'to':'anyone'}]),'ref not in conv')
    def test_deal_conv_missing(self):
        self.reject(self.spec(deals=[{'conv':'zzz','text':'x','refs':[0]}]),'deal conv missing')
    def test_meta_not_updated_by_import(self):
        self.reject(self.spec(),'meta/chat not updated',meta={'lastI':-1,'anchorMids':['x']})
    def test_new_messages_not_consecutive(self):
        self.reject(dict(self.conv,join={'a':[0,2]}),'',new=[msg(0,'Ana'),msg(2,'Ben')])
    def test_stored_copy_differs(self):
        run=self.e.run(self.new);self.e.build(run,self.spec())
        self.e.msgs[1]=dict(self.e.msgs[1],b='edited after the fact')          # the RUN chunk disagrees with WORK
        self.new=[msg(3,'Ana','x')];self.reject({'join':{'a':[3]}},'stored copy differs')

class TestKnownBugs(unittest.TestCase):
    """docs/BACKLOG.md items, written as the fixed behavior. Expected to fail until fixed."""
    def setUp(self): self.t=tempfile.TemporaryDirectory();self.e=Env(self.t.name);self.e.seed()
    def tearDown(self): self.t.cleanup()
    @unittest.expectedFailure
    def test_B1_note_filled_for_new_pages(self):
        run=self.e.run([msg(0,'Ana','a'),msg(1,'Ben','b',r='Ana',q='a',pi=0)])
        self.e.build(run,{'newconvs':[{'id':'a','title':'A'}],'join':{'a':[0,1]}})
        self.assertIn('reply links',r(os.path.join(run,'out','threading.json'))['note'])
    @unittest.expectedFailure
    def test_B3_dealEdit_without_deal_is_a_clear_error(self):
        run=self.e.run([msg(0,'Ana','a')])
        with self.assertRaises(AssertionError): self.e.build(run,{'newconvs':[{'id':'a','title':'A'}],'join':{'a':[0]},'dealEdit':{'a':{'text':'x'}}})
    @unittest.expectedFailure
    def test_B4_cross_conversation_link_flagged(self):
        run=self.e.run([msg(0,'Ana','a'),msg(1,'Ben','b')])
        out=self.e.build(run,{'newconvs':[{'id':'a','title':'A'},{'id':'b','title':'B'}],'join':{'a':[0],'b':[1]},'links':{'1':[0,'i']}})
        self.assertIn('WARN',out)
    @unittest.expectedFailure
    def test_B5_unfound_reply_left_unlinked(self):
        run=self.e.run([msg(0,'Ana','a'),msg(1,'Ben','b',r='Zed',q='something from before the window')])
        self.e.build(run,{'newconvs':[{'id':'a','title':'A'}],'join':{'a':[0,1]}})
        self.assertNotIn('1',r(os.path.join(run,'out','threading.json'))['links'])
    @unittest.expectedFailure
    def test_B11_messenger_link_to_message_zero(self):
        # pi=0 is falsy, so a Messenger reply link to #0 is ignored and the quote/photo fallback runs instead.
        run=self.e.run([msg(0,'Ana','',p='5'),msg(1,'Ana','other photo',p='6'),msg(2,'Ben','love it',r='Ana',q='Photo',pi=0)])
        self.e.build(run,{'newconvs':[{'id':'a','title':'A'}],'join':{'a':[0,1,2]}})
        self.assertEqual(r(os.path.join(run,'out','threading.json'))['links']['2'],[0,'r'])

class TestCli(unittest.TestCase):
    def test_usage_on_unknown_command(self):
        import subprocess
        p=subprocess.run([sys.executable,os.path.join(ROOT,'scripts','catchup.py'),'nope'],capture_output=True,text=True)
        self.assertEqual(p.returncode,1);self.assertIn('catchup.py bootstrap WORK DBDIR',p.stderr)

if __name__=='__main__': unittest.main()
