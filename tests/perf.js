/* Optional timings, for the record (docs/EXPERIMENTS.md): npm run test:perf [sizes...]. Not part of npm test or CI;
   wall-clock is never asserted anywhere (counted checks live in page.test.js's speed and history sections).
   The real page in Chromium with page.test.js's stand-in runtime, seeded from tests/synth.py (mock cast, block layout).
   For each size it prints, per full render (header + summary + messages) in date-range and caught mode, the reads of
   S.msgs and the milliseconds, then one Ask with "include older" at the real cap: bytes sent, messages word for word,
   summary lines, lineFor calls and milliseconds. Default sizes: 6400 25000 50000. */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const T = fs.readFileSync(path.join(__dirname, 'page.test.js'), 'utf8');
const RUNTIME = T.slice(T.indexOf('function runtime(seed) {'), T.indexOf('\nconst META'));
const SKELETON = T.match(/const SKELETON =\s*'([^']+)'/)[1];
const SRC = fs.readFileSync(process.env.PAGE_FILE || path.join(ROOT, 'plugin/skills/refresh/assets/page.html'), 'utf8');
const PAGE = /^<!doctype/i.test(SRC) ? SRC : SKELETON + SRC + '</body></html>';
const URL = 'http://localhost:9917/catchup';
const SIZES = process.argv.slice(2).map(Number).filter(Boolean);
const META = {
  kind: 'messenger-catchup',
  pageVersion: '2.6',
  thread: '4242',
  chatUrl: 'https://www.facebook.com/messages/t/4242',
  threadName: 'Trail Crew',
  shortName: 'Trail',
  ownerName: 'Sam',
  ownerAliases: ['Sam'],
  topic: 'gear',
  outboxAuto: false,
  refreshPhrase: 'refresh my catch-up',
  tz: 'America/Los_Angeles',
  helper: 'installed',
  chunkSize: 82,
};

(async () => {
  const browser = await chromium.launch();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-perf-'));
  for (const n of SIZES.length ? SIZES : [6400, 25000, 50000]) {
    const S0 = JSON.parse(
      execFileSync('python3', [path.join(__dirname, 'synth.py'), 'page', String(n), '1000'], {
        encoding: 'utf8',
        maxBuffer: 1 << 30,
      }),
    );
    const msgs = Object.values(S0.chunks).flatMap(c => c.msgs);
    const meta = Object.assign({}, META, {
      lastI: n - 1,
      lastMid: msgs[n - 1].m,
      anchorMids: msgs.slice(-3).map(m => m.m),
      markerMode: 'time',
      markerFrom: msgs[Math.max(0, n - 920)].d + 'T00:00' /* the last 2 days, about 920 messages */,
      caughtUpI: n - 151,
    });
    const seed = Object.assign(
      { 'meta/chat': meta, 'photos/index': { byI: {}, gifs: [] }, 'refresh/status': { state: 'idle' } },
      S0.new,
    );
    Object.entries(S0.chunks).forEach(([k, v]) => (seed['chunks/' + k] = v));
    /* a big seed goes in by a synchronous fetch, not as an init-script argument */
    const seedFile = path.join(tmp, 'seed-' + n + '.json');
    fs.writeFileSync(seedFile, JSON.stringify(seed));
    const ctx = await browser.newContext({
      viewport: { width: 1000, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
    });
    await ctx.route('https://fonts.googleapis.com/**', r => r.abort());
    await ctx.route(URL, r => r.fulfill({ body: PAGE, contentType: 'text/html; charset=utf-8' }));
    await ctx.route('http://localhost:9917/seed.json', r =>
      r.fulfill({ path: seedFile, contentType: 'application/json' }),
    );
    await ctx.addInitScript({
      content:
        '(function(){var x=new XMLHttpRequest();x.open("GET","/seed.json",false);x.send();window.__seed=JSON.parse(x.responseText);})();' +
        '(' +
        RUNTIME +
        ')(window.__seed);delete window.__seed;',
    });
    const p = await ctx.newPage();
    p.setDefaultTimeout(900000);
    p.on('pageerror', e => console.log('pageerror', e.message));
    await p.goto(URL);
    await p.waitForFunction(n => typeof S !== 'undefined' && S.msgs.length === n && S.threading && S.summary, n, {
      polling: 200,
    });
    await p.waitForTimeout(300);
    const render = await p.evaluate(() => {
      const real = S.msgs;
      const out = {};
      for (const [mode, extra] of [
        ['time', {}],
        ['caught', { markerMode: 'caught' }],
      ]) {
        const box = { n: 0 };
        S.meta = Object.assign({}, S.meta, extra);
        S.msgs = new Proxy(real, {
          get(t, k, r) {
            if (typeof k === 'string' && /^\d+$/.test(k)) box.n++;
            return Reflect.get(t, k, r);
          },
        });
        const t = performance.now();
        renderHeader();
        renderSummary();
        renderMessages();
        document.body.offsetHeight;
        out[mode] = { readsPerMsg: +(box.n / real.length).toFixed(1), ms: Math.round(performance.now() - t) };
        S.msgs = real;
      }
      return out;
    });
    const ask = await p.evaluate(async () => {
      let calls = 0;
      const orig = window.lineFor;
      window.lineFor = function () {
        calls++;
        return orig.apply(this, arguments);
      };
      location.hash = '#ask';
      document.getElementById('ask-all').checked = true;
      document.getElementById('ask-in').value = 'Who organized the group buy?';
      const t = performance.now();
      document.getElementById('ask-go').click();
      while (!__rt.sampleLog.length) await new Promise(r => setTimeout(r, 5));
      const ms = Math.round(performance.now() - t);
      const prompt = __rt.samples[__rt.samples.length - 1][0].content;
      const sec = name => (prompt.split('\n' + name + ' (oldest first):\n')[1] || '').split('\n\n')[0].split('\n');
      return {
        bytes: __rt.sampleLog[0].bytes,
        code: __rt.sampleLog[0].code,
        verbatim: sec('MESSAGES').filter(Boolean).length,
        summaryLines: sec('OLDER HISTORY').filter(Boolean).length,
        lineFor: calls,
        ms,
      };
    });
    console.log(JSON.stringify({ n, render, ask }));
    await ctx.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  await browser.close();
})();
