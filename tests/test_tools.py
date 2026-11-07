"""Repo-level checks: helper copies in sync, the sync tool itself, the skill ZIP, and SKILL.md's file references.
Run: python3 -m unittest discover -s tests"""
import html,importlib.util,os,re,shutil,subprocess,tempfile,unittest,urllib.parse,zipfile

ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec=importlib.util.spec_from_file_location('sync_helper',os.path.join(ROOT,'tools','sync-helper.py'))
sync=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(sync)
def read(*p):
    with open(os.path.join(ROOT,*p),encoding='utf-8') as fh: return fh.read()
SHIPPED=['SKILL.md','assets/page.html','assets/helper.user.js','scripts/catchup.py']

class TestHelperCopies(unittest.TestCase):
    def setUp(self): self.src=read('assets','helper.user.js');self.page=read('assets','page.html')
    def textarea(self,page,tid): return html.unescape(re.search(r'<textarea id="%s"[^>]*>(.*?)</textarea>'%tid,page,re.S).group(1))
    def test_page_in_sync(self):
        self.assertEqual(sync.generate(self.page,self.src),self.page,'run tools/sync-helper.py')
    def test_userscript_copy_is_the_file(self):
        self.assertEqual(self.textarea(self.page,'jump-us'),self.src)
    def test_bookmarklet_is_the_jump_code(self):
        bm=self.textarea(self.page,'jump-bm');self.assertTrue(bm.startswith('javascript:(async function mcJump(){'))
        js=urllib.parse.unquote(bm[len('javascript:'):])
        body=re.search(r'^\(async function mcJump\(\)\{\n.*?^\}\)\(\);$',self.src,re.S|re.M).group(0)
        self.assertEqual(js,' '.join(l.strip() for l in body.split('\n')))
    def test_bookmarklet_encoding(self):
        bm=self.textarea(self.page,'jump-bm')
        self.assertNotRegex(bm[len('javascript:'):],r'%(?![0-9A-F]{2})','bare % would break the URL')
        self.assertNotIn('#',bm);self.assertNotIn('^',bm);self.assertTrue(bm.isascii())
    def test_generate_follows_helper_edits(self):
        edited=self.src.replace("say('Jump: found it.')","say('Jump: found it!')")
        self.assertNotEqual(edited,self.src)
        out=sync.generate(self.page,edited)
        self.assertEqual(self.textarea(out,'jump-us'),edited)
        self.assertIn('found it!',urllib.parse.unquote(self.textarea(out,'jump-bm')))
        self.assertEqual(sync.generate(out,edited),out,'generate is not idempotent')
    def test_check_mode_exit_code(self):
        p=subprocess.run(['python3',os.path.join(ROOT,'tools','sync-helper.py'),'--check'],capture_output=True,text=True)
        self.assertEqual(p.returncode,0,p.stderr)

class TestVersions(unittest.TestCase):
    def test_helper_version_strings_agree(self):
        src=read('assets','helper.user.js')
        found={re.search(r'@version\s+(\S+)',src).group(1),re.search(r"__mcHelper='([^']+)'",src).group(1),
               re.search(r"setAttribute\('data-mc-helper','([^']+)'\)",src).group(1),re.search(r"ping:\(\)=>\(\{v:'([^']+)'\}\)",src).group(1)}
        self.assertEqual(len(found),1,found)
    def test_page_version_present(self):
        self.assertRegex(read('assets','page.html'),r'const PAGE_VERSION="\d+\.\d+";')

class TestNoLeftoverNames(unittest.TestCase):
    def test_no_pa_names_in_shipped_files(self):
        for f in SHIPPED:
            self.assertNotRegex(read(f),r'\bcc(Scan|Verify|Capture)\b|cctool|cc-capture|cc-cmd|cc_result',f)

class TestSkillReferences(unittest.TestCase):
    def test_every_referenced_file_exists(self):
        refs=set(re.findall(r'`((?:assets|scripts)/[\w.\-]+)`',read('SKILL.md')))
        self.assertTrue(refs)
        for r in refs: self.assertTrue(os.path.exists(os.path.join(ROOT,r)),r)

class TestZip(unittest.TestCase):
    def test_make_zip_contents(self):
        with tempfile.TemporaryDirectory() as t:
            dst=os.path.join(t,'messenger-catchup')        # make-zip.sh needs this folder name (BACKLOG B10)
            for f in SHIPPED+['make-zip.sh']:
                os.makedirs(os.path.dirname(os.path.join(dst,f)),exist_ok=True);shutil.copy2(os.path.join(ROOT,f),os.path.join(dst,f))
            subprocess.run(['sh',os.path.join(dst,'make-zip.sh')],check=True,capture_output=True)
            names=sorted(n for n in zipfile.ZipFile(os.path.join(t,'messenger-catchup.zip')).namelist() if not n.endswith('/'))
            self.assertEqual(names,sorted('messenger-catchup/'+f for f in SHIPPED))

if __name__=='__main__': unittest.main()
