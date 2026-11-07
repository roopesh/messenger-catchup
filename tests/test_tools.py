"""Repo-level checks: helper copies in sync, the sync tool itself, the skill ZIP, and SKILL.md's file references.
Run: python3 -m unittest discover -s tests"""
import html,importlib.util,os,re,shutil,subprocess,tempfile,unittest,urllib.parse,zipfile

ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec=importlib.util.spec_from_file_location('sync_helper',os.path.join(ROOT,'tools','sync-helper.py'))
sync=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(sync)
def read(*p):
    with open(os.path.join(ROOT,*p),encoding='utf-8') as fh: return fh.read()
SHIPPED=['SKILL.md','VERSION','assets/page.html','assets/helper.user.js','scripts/catchup.py']

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

class TestReleaseVersion(unittest.TestCase):
    """VERSION is the release version; package.json, its lockfile and the newest CHANGELOG entry must match it."""
    def setUp(self): self.v=read('VERSION').strip()
    def test_semver(self): self.assertRegex(self.v,r'^\d+\.\d+\.\d+$')
    def test_package_json(self):
        import json
        self.assertEqual(json.loads(read('package.json'))['version'],self.v)
        lock=json.loads(read('package-lock.json'));self.assertEqual(lock['version'],self.v);self.assertEqual(lock['packages']['']['version'],self.v)
    def test_changelog_top_entry(self):
        top=re.search(r'^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d\d-\d\d)$',read('CHANGELOG.md'),re.M)
        self.assertTrue(top,'CHANGELOG.md needs "## [X.Y.Z] - YYYY-MM-DD" entries');self.assertEqual(top.group(1),self.v,'newest CHANGELOG entry must be VERSION')
    def test_changelog_versions_descend(self):
        vs=[tuple(map(int,v.split('.'))) for v in re.findall(r'^## \[(\d+\.\d+\.\d+)\]',read('CHANGELOG.md'),re.M)]
        self.assertEqual(vs,sorted(vs,reverse=True));self.assertEqual(len(vs),len(set(vs)),'duplicate CHANGELOG version')

class TestNoLeftoverNames(unittest.TestCase):
    def test_no_pa_names_in_shipped_files(self):
        for f in SHIPPED:
            self.assertNotRegex(read(f),r'\bpa(Scan|Verify|Capture)\b|patool|pa-capture|pa-cmd|pa_result|packaholic',f)

class TestSkillReferences(unittest.TestCase):
    def test_every_referenced_file_exists(self):
        refs=set(re.findall(r'`((?:assets|scripts)/[\w.\-]+)`',read('SKILL.md')))
        self.assertTrue(refs)
        for r in refs: self.assertTrue(os.path.exists(os.path.join(ROOT,r)),r)

class TestPrePushHook(unittest.TestCase):
    """.githooks/pre-push blocks direct pushes to main (installed by npm run setup)."""
    HOOK=os.path.join(ROOT,'.githooks','pre-push')
    def push(self,remote_ref):
        return subprocess.run([self.HOOK,'origin','url'],input='refs/heads/x 1111 %s 2222\n'%remote_ref,capture_output=True,text=True).returncode
    def test_executable(self): self.assertTrue(os.access(self.HOOK,os.X_OK))
    def test_blocks_main(self): self.assertEqual(self.push('refs/heads/main'),1)
    def test_allows_branches_and_tags(self):
        self.assertEqual(self.push('refs/heads/fix/thing'),0);self.assertEqual(self.push('refs/tags/v9.9.9'),0)
    def test_ci_workflow_has_the_three_jobs(self):
        wf=read('.github','workflows','test.yml')
        for job in ('  test:','  version-bump:','  pr-only:'): self.assertIn('\n'+job+'\n',wf)
        self.assertIn('npm test',wf)

class TestReleaseScript(unittest.TestCase):
    def test_release_script(self):
        f=os.path.join(ROOT,'tools','release.sh');self.assertTrue(os.access(f,os.X_OK))
        self.assertEqual(subprocess.run(['sh','-n',f]).returncode,0)
    def test_notes_extraction_matches_changelog(self):
        v=read('VERSION').strip()
        out=subprocess.run(['awk','-v','h=## [%s] '%v,'index($0,h)==1{f=1;next} /^## \\[/{f=0} f',os.path.join(ROOT,'CHANGELOG.md')],capture_output=True,text=True).stdout
        self.assertTrue(out.strip());self.assertNotIn('\n## [',out)

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
