'use strict'; /* an assignment to an undeclared name throws, instead of making a global the parallel cases would share */
/* Simulated-Messenger tests for the helper (installed and injected paths).
   Run from the repo root: npm test (tests/run.js serves the mock and sets MOCK_URL).
   Or by hand: cd tests && python3 -m http.server 8765 &  then  node sim.js

   The cases run in parallel: each sim('name', async b => {...}) below is one case, run on the shared browser b in its
   own browser context (so its own localStorage, sessionStorage and clock), up to SIM_JOBS at a time (default: three
   times the CPU count, at least 4: the cases mostly wait on the helper's timers; SIM_JOBS=1 runs them one by one).
   A case's PASS/FAIL lines are held and printed together under a "--- name (seconds)" header when it ends; a case
   that throws prints FAIL "name crashed" and the rest go on.
   SIM_ONLY=E (or EF, AG...) runs the cases whose name starts with those letters; SIM_ONLY=people,stall runs the cases
   whose name contains one of those words (and any case they wait for).
   To add a case, put this anywhere above the runner at the end of the file:
     sim('X: what it checks', async b => {
       const { ctx, p, capOf } = await fresh(b);
       ...
       await ctx.close();
     });
   Start it from a known state (mode(p, {...}), or seedStorage), never from what another case left behind. A case that
   needs another's result waits for it, sim('name', { after: ['other'] }, async b => ...), and reads it from SHARED.
   Pass { s: seconds } when it takes more than about 10 s, so the longest cases start first. Keep the options before
   the function: that keeps the case body at the file's indent, so cases stay easy to merge. */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const D = path.join(__dirname, '..') + '/';
fs.mkdirSync(D + 'tests/out', { recursive: true });
const URL = process.env.MOCK_URL || 'http://localhost:8765/mock/messenger.html';
const HELPER = fs.readFileSync(D + 'plugin/skills/refresh/assets/helper.user.js', 'utf8');
const HV = HELPER.match(/@version\s+(\S+)/)[1];

/* Each case's lines go to its own buffer (printed when the case ends), found through the async context it runs in */
const LINES = new AsyncLocalStorage();
const say = line => (LINES.getStore() ? LINES.getStore().push(line) : console.log(line));
const ok = (c, msg) => {
  say((c ? 'PASS ' : 'FAIL ') + msg);
  if (!c) process.exitCode = 1;
};
const CASES = [];
/* sim(name, fn) or sim(name, { s, after }, fn): s = rough seconds (longest start first), after = cases to wait for */
const sim = (name, o, fn) => CASES.push(Object.assign({ name, s: 10, after: [] }, fn ? o : {}, { fn: fn || o }));
/* Results one case hands to another, and the files written once every case is done (see main) */
const SHARED = {};
const bridge = async (p, cmd, args) =>
  p.evaluate(
    async ([cmd, args]) => {
      const id = 'x' + Date.now() + Math.random();
      document.dispatchEvent(new CustomEvent('mc-cmd', { detail: JSON.stringify({ id, cmd, args }) }));
      let r;
      for (let k = 0; k < 240; k++) {
        await new Promise(z => setTimeout(z, 250));
        r = JSON.parse(sessionStorage.getItem('mc_res_' + id) || 'null');
        if (r && !r.running) break;
      }
      return r;
    },
    [cmd, args],
  );
const pollResult = async p => {
  for (let k = 0; k < 240; k++) {
    await p.waitForTimeout(250);
    const r = await p.evaluate(() => sessionStorage.getItem('mc_result')).catch(() => null);
    if (r) return JSON.parse(r);
  }
  return null;
};
function checkCap(cap, base, mockFrom, n, label) {
  ok(
    cap.kind === 'mc-capture' && cap.count === n,
    label + ': kind mc-capture, ' + n + ' messages (got ' + cap.count + ')',
  );
  ok(
    cap.msgs.every((m, k) => m.i === base + 1 + k && m.m === 'mid.$mock' + (mockFrom + k)),
    label + ': numbering #' + (base + 1) + '.. and ids match mock ' + mockFrom + '..' + (mockFrom + n - 1),
  );
  const names = ['Ana', 'Ben', 'You', 'Cy', 'Dee'];
  const shown = i => (i === 108 ? 'Captain Cy' : names[i % 5]);
  const full = i =>
    i === 101 ? 'Ben Ortiz' : { Ana: 'Ana Alvarez', Ben: 'Ben Brooks', Cy: 'Cy Chen', Dee: 'Dee Diaz' }[names[i % 5]];
  ok(
    cap.msgs.every((m, k) => m.f === shown(mockFrom + k)),
    label + ': senders right, incl. "You" and a nickname',
  );
  ok(
    cap.msgs.every((m, k) => (m.f === 'You' ? m.fn === undefined : m.fn === full(mockFrom + k))),
    label + ': full names read from the avatars (fn), none on your own messages',
  );
  return cap;
}
/* Every context starts at 12:00 today, local time (time flows on from there): the mock's time-only labels (9:25-11:20 AM)
   mean "today", so they must be in the past, as they always are in Messenger. The captures stay dated today, which the
   page suite (tests/page.test.js) expects. */
const NOW = (d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0))(new Date());
const ymdOf = d =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const newCtx = async (b, helper) => {
  const c = await b.newContext({ viewport: { width: 900, height: 800 } });
  await c.clock.install({ time: NOW });
  if (helper) await c.addInitScript('document.addEventListener("DOMContentLoaded",function(){' + HELPER + '\n});');
  return c;
};
/* A new context (helper installed unless helper is false) and page; capOf() reads the page's last capture */
const fresh = async (b, helper = true) => {
  const ctx = await newCtx(b, helper);
  const p = await ctx.newPage();
  const capOf = async () => JSON.parse((await p.evaluate(() => window.__capText)) || '{"msgs":[]}');
  return { ctx, p, capOf };
};
/* Load the mock with this localStorage (and sessionStorage), then reload so the page starts from it */
const seedStorage = async (p, local, session = {}) => {
  await p.goto(URL);
  await p.evaluate(
    ([l, s]) => {
      localStorage.clear();
      sessionStorage.clear();
      for (const [k, v] of Object.entries(l)) localStorage.setItem(k, v);
      for (const [k, v] of Object.entries(s)) sessionStorage.setItem(k, v);
    },
    [local, session],
  );
};
// ---------- A: helper installed (userscript manager emulated with an init script) ----------
sim('A1, A2: first run, incremental', { s: 42 }, async b => {
  const ctxA = await newCtx(b, true);
  const p = await ctxA.newPage();
  await p.goto(URL);
  await p.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('mock_total', '120');
  });
  await p.reload();
  await p.waitForTimeout(800);
  ok(
    await p.evaluate(v => document.documentElement.dataset.mcHelper === v, HV),
    'A: helper running (data-mc-helper=' + HV + ')',
  );
  ok((await bridge(p, 'ping', {})).v === HV, 'A: bridge ping reports ' + HV);
  // date labels, with "now" pinned so the year boundary is tested whatever day this runs (B6)
  const DATES = [
    ['2026-11-06', '9:15 AM', '2026-11-06'],
    ['2026-11-06', 'Yesterday 9:15 AM', '2026-11-05'],
    ['2026-11-06', 'Monday 9:15 AM', '2026-11-02'],
    ['2026-11-06', 'Mon 9:15 AM', '2026-11-02'],
    ['2026-11-06', 'Thurs 9:15 AM', '2026-11-05'],
    ['2026-11-06', 'Friday 9:15 AM', '2026-10-30'],
    ['2026-11-06', 'November 3, 2026 9:15 AM', '2026-11-03'],
    ['2026-11-06', 'Nov 3, 2026 9:15 AM', '2026-11-03'],
    ['2026-11-06', 'Nov 3 9:15 AM', '2026-11-03'],
    ['2026-11-06', 'Sept 9, 2025 9:15 AM', '2025-09-09'],
    ['2026-11-06', 'Oct. 12, 2025 at 9:00 AM', '2025-10-12'],
    ['2027-01-04', 'December 28 9:15 AM', '2026-12-28'],
    ['2027-01-04', 'Dec 31 9:15 AM', '2026-12-31'],
    ['2027-01-04', 'Jan 3 9:15 AM', '2027-01-03'],
    ['2027-01-04', 'Sunday 9:15 AM', '2027-01-03'],
    ['2026-03-01', 'Feb 28 9:15 AM', '2026-02-28'],
    ['2026-03-01', 'Saturday 9:15 AM', '2026-02-28'],
    ['2026-11-06', 'Someday 9:15 AM', null],
    ['2026-11-06', '', null],
    ['2026-11-06', 'Mont 3 9:15 AM', null],
    ['2026-11-06', '17:52', '2026-11-06'],
    ['2026-11-06', 'Yesterday 17:52', '2026-11-05'],
    ['2026-11-06', '3 Nov 2026 17:52', '2026-11-03'],
    ['2026-11-06', '12 October 2025 09:05', '2025-10-12'],
    ['2027-01-04', '28 Dec 17:52', '2026-12-28'],
  ];
  const got = await p.evaluate(rows => rows.map(([now, l]) => window.__mcDate(l, new Date(now + 'T12:00:00'))), DATES);
  const bad = DATES.filter((r, k) => got[k] !== r[2]).map(
    (r, k) => r[1] + ' @' + r[0] + ' -> ' + got[DATES.indexOf(r)],
  );
  ok(
    !bad.length,
    'B6: ' +
      DATES.length +
      ' date labels parse as expected (incl. short names, New Year, unreadable -> null)' +
      (bad.length ? ' BAD ' + bad.join('; ') : ''),
  );
  let r = await bridge(p, 'full', { first: { count: 50 }, base: -1 });
  ok(
    r.stage === 'reloading' && r.scan.win === 50,
    'A1 first run: scan found 50, reloading (scan ' +
      JSON.stringify({
        win: r.scan.win,
        reps: r.scan.reps,
        qm: r.scan.qm,
        photoReplies: r.scan.photoReplies,
        perr: r.scan.perr,
      }) +
      ')',
  );
  await p.waitForLoadState('load');
  let res = await pollResult(p);
  ok(
    res && res.stage === 'captured' && res.verify.ok && res.verify.extra === 0,
    'A1: verify after reload ok, captured',
  );
  ok(
    res && Array.isArray(res.warn) && !res.warn.length && res.scan.top === false && res.scan.scroller === 'message',
    'A1: the normal mock gives no warnings (mc_result.warn ' +
      JSON.stringify(res && res.warn) +
      '), top false, scroller "message"',
  );
  const cap1 = checkCap(JSON.parse(await p.evaluate(() => window.__capText)), -1, 70, 50, 'A1');
  const byM = Object.fromEntries(cap1.msgs.map(m => [m.m, m]));
  const rep = [77, 84, 91, 98, 105, 112, 119].every(i => {
    const m = byM['mid.$mock' + i];
    return m && m.pi === i - 3 - 70 && m.pq === 1;
  });
  ok(rep, 'A1: 7 text replies matched to the right parent by quote');
  const r70 = byM['mid.$mock70'];
  ok(
    r70.pmid === 'mid.$mock67' && !('pi' in r70),
    'A1: reply to a message before the window kept as Messenger id (pmid)',
  );
  const pr = byM['mid.$mock103'];
  ok(pr.pi === 30 && !pr.pq, 'A1: photo reply resolved by clicking "Go to replied message" -> #30');
  ok(
    byM['mid.$mock100'].p === '9100100' && cap1.photos.length === 1 && cap1.photos[0].i === 30,
    'A1: photo message + photo bytes captured',
  );
  // incremental: 5 new, plus 2 more arrive between scan and verify
  await p.goto(URL);
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    sessionStorage.removeItem('mc_result');
    window.addMsgs(5);
  });
  const stops = cap1.msgs
    .slice(-3)
    .map(m => m.m)
    .reverse();
  r = await bridge(p, 'full', { stops, base: 49 });
  ok(r.stage === 'reloading' && r.scan.win === 5, 'A2 incremental: scan found 5 new');
  await p.evaluate(() => localStorage.setItem('mock_total', String(+localStorage.getItem('mock_total') + 2)));
  await p.waitForLoadState('load');
  res = await pollResult(p);
  ok(
    res && res.stage === 'captured' && res.verify.extra === 2,
    'A2: 2 messages arrived mid-run: verify extra=2 accepted (prefix identical)',
  );
  const cap2 = checkCap(JSON.parse(await p.evaluate(() => window.__capText)), 49, 120, 5, 'A2');
  SHARED.cap1 = cap1;
  SHARED.cap2 = cap2;
  /* A3 goes on from this tab's storage (A2's captured result, 127 messages) */
  SHARED.afterA2 = await p.evaluate(() => [Object.assign({}, localStorage), Object.assign({}, sessionStorage)]);
  await ctxA.close();
});
/* The mock as A2 leaves it: 127 messages */
const MOCK127 = { mock_total: '127' };
sim('A: jump link, selfcheck', { s: 14 }, async b => {
  const { ctx, p } = await fresh(b);
  await seedStorage(p, MOCK127);
  // jump
  await p.goto('about:blank');
  await p.goto(URL + '#mcjump=' + encodeURIComponent('mid.$mock80') + '&noreply');
  let jumped = false;
  for (let k = 0; k < 20 && !jumped; k++) {
    await p.waitForTimeout(500);
    jumped = await p.evaluate(() => {
      const e = document.querySelector('[data-message-id="mid.$mock80"]');
      return !!e && e.style.outline.includes('3px');
    });
  }
  ok(jumped, 'A: jump link scrolled back and highlighted #mock80');
  // selfcheck: every hook the reader relies on is present on the mock; then break them one at a time
  await p.goto(URL);
  await p.waitForTimeout(600);
  let sck = await bridge(p, 'selfcheck', {});
  ok(
    sck && sck.ok && !sck.missing.length && !sck.warn.length && sck.counts.messages > 10 && sck.counts.named > 0,
    'A: selfcheck passes on the mock (' + JSON.stringify(sck && sck.counts) + ')',
  );
  const broken = async (label, mutate, want) => {
    await p.goto(URL);
    await p.waitForTimeout(600);
    await p.evaluate(mutate);
    const r = await bridge(p, 'selfcheck', {});
    ok(
      r && !r.ok === !want.warn && (want.warn ? r.warn : r.missing).some(x => x.includes(want.has)),
      'A: selfcheck names ' + label + ' (' + JSON.stringify(r && (want.warn ? r.warn : r.missing)) + ')',
    );
  };
  await broken(
    'changed message labels',
    () => document.querySelectorAll('[data-message-id]').forEach(e => e.setAttribute('aria-label', 'Message')),
    { has: 'message labels' },
  );
  await broken(
    'missing reply links',
    () => document.querySelectorAll('[aria-label="Go to replied message"]').forEach(e => e.remove()),
    { has: 'Go to replied message' },
  );
  await broken(
    'missing avatars (a warning)',
    () => document.querySelectorAll('[data-message-id] img[alt]').forEach(e => e.remove()),
    { has: 'sender avatars', warn: true },
  );
  await broken('a missing chat log', () => document.querySelector('[role="log"]').setAttribute('role', 'region'), {
    has: 'chat log',
  });
  await ctx.close();
});
sim('A: people scan', { s: 40 }, async b => {
  const { ctx, p } = await fresh(b);
  await seedStorage(p, MOCK127);
  // people: read-only scroll back reading avatars (the one-time name backfill)
  await p.goto(URL);
  await p.waitForTimeout(600);
  const pp = await bridge(p, 'people', { count: 1000 });
  const pairs = new Set(((pp && pp.people) || []).map(([s, f]) => s + '=' + f));
  ok(
    pp &&
      !pp.err &&
      pp.top &&
      pp.seen > 100 &&
      ['Ana=Ana Alvarez', 'Ben=Ben Brooks', 'Ben=Ben Ortiz', 'Cy=Cy Chen', 'Captain Cy=Cy Chen', 'Dee=Dee Diaz'].every(
        x => pairs.has(x),
      ) &&
      ![...pairs].some(x => x.startsWith('You=')),
    'A: people scans back to the top and maps shown names to full names (' + [...pairs].join(', ') + ')',
  );
  await ctx.close();
});
/* F1 review 6: the chat is the thread id in the address, so a reload that only changes the path (/t/<id> to
   /e2ee/t/<id>, or a query) is still the same chat; another id isn't */
sim('HP1: the chat check compares thread ids', { s: 12 }, async b => {
  const { ctx, p } = await fresh(b);
  const base = URL.replace(/messenger\.html$/, '');
  const resume = async (pipeAt, thread, to) => {
    await p.goto(base + pipeAt);
    await p.evaluate(
      x => {
        sessionStorage.removeItem('mc_result');
        sessionStorage.setItem('mc_pipe', JSON.stringify(x));
      },
      { base: 56, run: 'runT', scan: { win: 1, warn: [] }, t0: Date.now(), at: '/mock/' + pipeAt, thread },
    );
    await p.goto(base + to);
    return pollResult(p);
  };
  let res = await resume('t/111', '111', 'e2ee/t/111');
  ok(
    res && res.stage !== 'wrong-thread' && res.thread === '111',
    'HP1: /t/111 reloaded as /e2ee/t/111 is the same chat (' + (res && res.stage) + ')',
  );
  res = await resume('t/111', '111', 't/222');
  const left = await p.evaluate(() => [sessionStorage.getItem('mc_pipe'), sessionStorage.getItem('__mcsave')]);
  ok(
    res &&
      res.stage === 'wrong-thread' &&
      res.err === 'wrong-thread' &&
      res.thread === '222' &&
      !res.verify &&
      !res.capture &&
      left.every(x => x === null),
    'HP1: thread 111 resumed on thread 222 is refused: no verify or capture, the scan state cleared (' +
      (res && res.stage) +
      ')',
  );
  await ctx.close();
});
sim('A3, A5: stale result, message deleted mid-run', { s: 20, after: ['A1, A2: first run, incremental'] }, async b => {
  const { ctx, p } = await fresh(b);
  await seedStorage(p, ...SHARED.afterA2);
  let r, res;
  // stale result guard: a new full() clears the old mc_result and tags the new one with its run id
  await p.goto(URL);
  await p.waitForTimeout(600);
  const stale = await p.evaluate(() => JSON.parse(sessionStorage.getItem('mc_result') || 'null'));
  r = await bridge(p, 'full', { stops: ['mid.$mock126', 'mid.$mock125', 'mid.$mock124'], base: 56, run: 'runZ' });
  ok(
    stale && stale.stage === 'captured' && r.stage === 'scan' && r.win === 0 && !r.err,
    'A3: old captured result present; full() with nothing new reports stage scan, win 0 (nothing new), not the old capture',
  );
  const after = await p.evaluate(() => JSON.parse(sessionStorage.getItem('mc_result') || 'null'));
  ok(
    after && after.run === 'runZ' && after.stage === 'scan',
    'A3: mc_result now belongs to runZ (' + (after && after.stage) + ')',
  );
  // window changes between scan and verify (a message deleted mid-run): the two passes disagree, nothing is captured
  await p.evaluate(() => window.addMsgs(3));
  r = await bridge(p, 'full', { stops: ['mid.$mock126', 'mid.$mock125', 'mid.$mock124'], base: 56, run: 'runD' });
  ok(r.stage === 'reloading' && r.scan.win === 3, 'A5: scan found 3 new');
  await p.evaluate(() => localStorage.setItem('mock_skip', '[128]'));
  await p.waitForLoadState('load');
  res = await pollResult(p);
  ok(
    res &&
      res.run === 'runD' &&
      res.stage === 'verify-failed' &&
      !res.capture &&
      res.verify &&
      !res.verify.prefixSame &&
      res.verify.mode === 'slow',
    'A5: message gone after the scan: verify-failed after the slow retry, no capture (' + (res && res.stage) + ')',
  );
  await ctx.close();
});
sim('A4: short chat', { s: 55 }, async b => {
  const { ctx, p } = await fresh(b);
  let r, res;
  // short chat: 30 messages total, first run asks for 50 -> all 30, none dropped; old label forms parse
  await p.goto(URL);
  await p.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('mock_total', '30');
  });
  await p.goto('about:blank');
  await p.goto(URL);
  await p.waitForTimeout(800);
  r = await bridge(p, 'full', { first: { count: 50 }, base: -1, run: 'runS' });
  ok(
    r.stage === 'reloading' && r.scan.win === 30 && r.scan.top === true,
    'A4 short chat: scan took all 30 (anchor = top of chat, top:true)',
  );
  await p.waitForLoadState('load');
  res = await pollResult(p);
  ok(res && res.stage === 'captured' && res.run === 'runS', 'A4: verify to the top ok, captured');
  const cap4 = checkCap(JSON.parse(await p.evaluate(() => window.__capText)), -1, 0, 30, 'A4');
  const m0 = cap4.msgs[0],
    m12 = cap4.msgs[12],
    m22 = cap4.msgs[22],
    m27 = cap4.msgs[27];
  ok(
    m0.d === '2025-10-12' && m0.t === 'Sun 9:00 AM',
    'A4: full-date label -> d=2025-10-12, t="Sun 9:00 AM" (got ' + m0.d + ' / ' + m0.t + ')',
  );
  const now = NOW,
    dec28 = new Date(now.getFullYear(), 11, 28),
    yr = (dec28 - now > 864e5 ? now.getFullYear() - 1 : now.getFullYear()) + '-12-28';
  ok(
    cap4.msgs[5].d === '2025-10-13' && cap4.msgs[6].d === '2025-10-13',
    'A4: short-month label "Oct 13, 2025" -> 2025-10-13',
  );
  ok(cap4.msgs[8].d === yr, 'A4: year-less "December 28" -> ' + yr + ' (got ' + cap4.msgs[8].d + ')');
  ok(
    cap4.msgs[9].d === cap4.msgs[8].d && /DATES-GUESSED 9$/.test(res.capture),
    'A4: unreadable label borrows the previous date and is reported (' + res.capture.split(' you ')[1] + ')',
  );
  ok(cap4.msgs[15].d === cap4.msgs[12].d && /^Thu /.test(cap4.msgs[15].t), 'A4: short weekday "Thu" = "Thursday"');
  const f26 = cap4.msgs[26],
    f29 = cap4.msgs[29];
  ok(
    f26.f === 'Ben' && f26.b === 'Mike replied to my email yesterday' && !f26.r,
    'A4: follow-on text "Mike replied to…" stays Ben\'s message, not a fake reply (' +
      JSON.stringify([f26.f, f26.b, f26.r]) +
      ')',
  );
  ok(
    cap4.msgs[27].f === 'You' && cap4.msgs[27].b === 'who deleted a message lol?',
    'A4: a message that says "deleted a message" keeps its text (B24) (' + cap4.msgs[27].b + ')',
  );
  ok(
    cap4.msgs[24].f === 'Dee' && cap4.msgs[24].b === '(deleted a message)',
    'A4: Messenger\'s "Dee unsent a message" line is recorded as deleted (' +
      JSON.stringify([cap4.msgs[24].f, cap4.msgs[24].b]) +
      ')',
  );
  ok(
    f29.f === 'Dee' && f29.b === 'You sent the wrong link btw',
    'A4: follow-on text "You sent…" stays Dee\'s message, not yours (' + JSON.stringify([f29.f, f29.b]) + ')',
  );
  ok(/^Thu \d/.test(m12.t) && /^\d{4}-\d\d-\d\d$/.test(m12.d), 'A4: weekday label -> ' + m12.t + ' ' + m12.d);
  ok(
    /^\w{3} \d/.test(m22.t) && m22.d !== m27.d,
    'A4: "Yesterday" label -> ' + m22.t + ' ' + m22.d + ' (today ' + m27.d + ')',
  );
  fs.writeFileSync(D + 'tests/out/sim_cap4.json', JSON.stringify(cap4));
  await ctx.close();
});
// ---------- B: no helper; Claude injects the file on each step ----------
sim('B: helper injected', async b => {
  let r;
  const ctxB = await newCtx(b, false);
  const q = await ctxB.newPage();
  await q.goto(URL);
  await q.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('mock_total', '127');
  });
  await q.reload();
  await q.waitForTimeout(600);
  ok(await q.evaluate(() => !document.documentElement.dataset.mcHelper), 'B: no helper present');
  await q.evaluate(HELPER);
  const stopsB = ['mid.$mock124', 'mid.$mock123', 'mid.$mock122'];
  r = await bridge(q, 'scan', { stops: stopsB });
  ok(r && r.win === 2 && !r.err, 'B: injected scan found the 2 newer messages');
  await q.reload();
  await q.waitForTimeout(800);
  ok(
    await q.evaluate(() => !document.documentElement.dataset.mcHelper),
    'B: injected code gone after reload (as expected)',
  );
  await q.evaluate(HELPER);
  const v = await bridge(q, 'verify', {});
  ok(v.ok && v.gap === 0 && v.prefixSame, 'B: re-injected verify ok');
  const c = await bridge(q, 'capture', { base: 54 });
  ok(/^count 2 /.test(c), 'B: capture ' + c);
  const cap3 = checkCap(JSON.parse(await q.evaluate(() => window.__capText)), 54, 125, 2, 'B');
  SHARED.cap3 = cap3; /* main writes tests/out/sim_caps.json [cap1, cap2, cap3] */
  await ctxB.close();
});
// ---------- D: photo replies whose parents are far up the chat (not loaded; Messenger takes seconds to bring them) ----------
sim('D: far-up photo-reply parents', { s: 30 }, async b => {
  const ctxD = await newCtx(b, true);
  const dp = await ctxD.newPage();
  await dp.goto(URL);
  await dp.evaluate(() => {
    localStorage.setItem('mock_total', '140');
    localStorage.removeItem('mock_skip');
  });
  await dp.goto(URL);
  await dp.waitForTimeout(800);
  const t0 = Date.now();
  const ds = await bridge(dp, 'scan', { stops: ['mid.$mock127', 'mid.$mock126', 'mid.$mock125'] });
  const saved = await dp.evaluate(() => JSON.parse(sessionStorage.getItem('__mcsave') || 'null'));
  const par = id => ((saved && saved.parents[id]) || {}).p || ((saved && saved.parents[id]) || {}).err;
  ok(
    ds &&
      !ds.err &&
      ds.win === 12 &&
      ds.photoReplies === 2 &&
      ds.perr === 0 &&
      par('mid.$mock130') === 'mid.$mock20' &&
      par('mid.$mock136') === 'mid.$mock23',
    'D: both far-up photo-reply parents found by clicking (#130 -> ' +
      par('mid.$mock130') +
      ', #136 -> ' +
      par('mid.$mock136') +
      '; ' +
      Math.round((Date.now() - t0) / 1000) +
      ' s)',
  );
  // a parent slower than the 10 s wait: its late focus lands while the next reply is clicked; never a wrong link
  await dp.evaluate(() => localStorage.setItem('mock_parent_delay', '12000'));
  await dp.goto(URL);
  await dp.waitForTimeout(800);
  const ds2 = await bridge(dp, 'scan', { stops: ['mid.$mock127', 'mid.$mock126', 'mid.$mock125'] });
  const saved2 = await dp.evaluate(() => JSON.parse(sessionStorage.getItem('__mcsave') || 'null'));
  const p2 = id => (saved2 && saved2.parents[id]) || {};
  ok(
    ds2 &&
      !ds2.err &&
      !p2('mid.$mock130').p &&
      !p2('mid.$mock136').p &&
      p2('mid.$mock130').err &&
      p2('mid.$mock136').err === 'nofocus',
    'D: a parent that loads too late is an error to check, never a wrong link (' +
      JSON.stringify([p2('mid.$mock130'), p2('mid.$mock136')]) +
      ')',
  );
  await dp.evaluate(() => localStorage.removeItem('mock_parent_delay'));
  await ctxD.close();
});
// ---------- C: the page's jump bookmarklet, run as a browser runs a javascript: URL (no helper) ----------
sim('C: jump bookmarklet', async b => {
  const PAGE = fs.readFileSync(D + 'plugin/skills/refresh/assets/page.html', 'utf8');
  const bm = PAGE.match(/<textarea id="jump-bm"[^>]*>([^<]*)<\/textarea>/)[1]
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  const ctxC = await newCtx(b, false);
  const w = await ctxC.newPage();
  await w.goto(URL + '#mcjump=' + encodeURIComponent('mid.$mock80') + '&noreply');
  await w.waitForTimeout(600);
  ok(bm.startsWith('javascript:'), 'C: the page carries a javascript: bookmarklet');
  await w.evaluate(decodeURIComponent(bm.slice('javascript:'.length)));
  let bmJumped = false;
  for (let k = 0; k < 30 && !bmJumped; k++) {
    await w.waitForTimeout(500);
    bmJumped = await w.evaluate(() => {
      const e = document.querySelector('[data-message-id="mid.$mock80"]');
      return !!e && e.style.outline.includes('3px');
    });
  }
  ok(bmJumped, 'C: the bookmarklet scrolled back and highlighted #mock80');
  await ctxC.close();
});

/* ---------- G: photos (R2): the next run's backfill scan, and messages with several photos ----------
   A photo the page couldn't store is "owed" (meta/chat.photosOwed); the next refresh scans from just before it
   (references/photos.md › Backfill: STOPS = the three messages before it, BASE = the one before it). Writes
   tests/out/sim_cap_photos.json {first, backfill, multi} for the page suite (P18). */
sim('G: photo backfill scan', { s: 45 }, async b => {
  const c = await newCtx(b, true);
  const p = await c.newPage();
  await mode(p, {}, 120);
  let r = await bridge(p, 'full', { first: { count: 50 }, base: -1, run: 'g1' });
  await p.waitForLoadState('load');
  let res = await pollResult(p);
  const first = JSON.parse(await p.evaluate(() => window.__capText));
  ok(
    res && res.stage === 'captured' && first.count === 50 && first.photos.length === 1 && first.photos[0].i === 30,
    'G: first run of 50 with a photo on #30 (' + (res && res.capture) + ')',
  );
  const stops = first.msgs
    .slice(27, 30)
    .map(m => m.m)
    .reverse();
  await p.goto(URL);
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    sessionStorage.removeItem('mc_result');
    window.addMsgs(5);
  });
  r = await bridge(p, 'full', { stops, base: 29, run: 'g2' });
  ok(
    r && r.stage === 'reloading' && r.scan.win === 25,
    'G: backfill scan with STOPS = #29, #28, #27 and BASE 29: a window from #30, 25 messages (win ' +
      (r && r.scan && r.scan.win) +
      ')',
  );
  await p.waitForLoadState('load');
  res = await pollResult(p);
  const backfill = JSON.parse(await p.evaluate(() => window.__capText));
  ok(
    res &&
      res.stage === 'captured' &&
      res.verify.ok &&
      backfill.msgs[0].i === 30 &&
      backfill.msgs.slice(0, 20).every((m, k) => m.m === first.msgs[30 + k].m && m.i === 30 + k) &&
      backfill.msgs[24].i === 54 &&
      backfill.photos.length === 1 &&
      backfill.photos[0].i === 30,
    'G: backfill capture #30-#54: its ids line up with the stored ones, the owed photo #30 is in it, verify ok',
  );
  SHARED.first = first;
  SHARED.backfill = backfill;
  await c.close();
});
sim('G: several photos per message', { s: 32 }, async b => {
  const { ctx, p } = await fresh(b);
  let r, res;
  // mock_photos=4: every 4th message carries 1-3 photos (a caption too)
  await mode(p, { photos: '4' }, 120);
  r = await bridge(p, 'full', { first: { count: 30 }, base: -1, run: 'g3' });
  await p.waitForLoadState('load');
  res = await pollResult(p);
  const multi = JSON.parse(await p.evaluate(() => window.__capText));
  const want = [];
  for (let k = 0; k < 30; k++) {
    const mi = 90 + k;
    const n = mi === 100 ? 1 : mi % 4 === 0 ? 1 + ((mi / 4) % 3) : 0;
    for (let j = 0; j < n; j++) want.push(k + '.' + j);
  }
  ok(
    res &&
      res.stage === 'captured' &&
      multi.photos.map(ph => ph.i + '.' + ph.k).join() === want.join() &&
      new RegExp(' photos ' + want.length + ' ').test(res.capture),
    'G: messages with several photos: ' +
      want.length +
      ' photos, each in its slot k, the summary counts them (' +
      (res && res.capture) +
      ')',
  );
  SHARED.multi = multi; /* main writes tests/out/sim_cap_photos.json {first, backfill, multi} */
  await ctx.close();
});

/* ---------- H: helper 2.1: photo slots by tile and attachment id (R16), the skip list, failures listed (R15), topMs ----------
   mock_photos=4: #104 and #116 carry 3 photos, #112 two, #108 one, #100 one (attachment ids 92<i><j>, 9100100). The
   window is #100-#119 (STOPS99, BASE 99), as in a backfill scan. Writes tests/out/sim_cap_keys.json {loaded, lazy} for
   the page suite. */
/* capture(m, args): a backfill-style scan of #100-#119 in mock mode m; at(cap, i): message i's photos as "k:aid" */
const photoKeysOn = p => ({
  capture: async (m, args) => {
    await mode(p, m, 120);
    await bridge(p, 'full', Object.assign({ stops: STOPS99, base: 99, run: 'h' }, args));
    await p.waitForLoadState('load');
    const res = await pollResult(p);
    const cap = JSON.parse((await p.evaluate(() => window.__capText)) || 'null');
    return { res, cap: cap || { photos: [] } };
  },
  at: (cap, i) => cap.photos.filter(ph => ph.i === i).map(ph => ph.k + ':' + ph.aid),
});
sim('H1-H4, H6: photo ids and slots, the skip list, failures listed, run id', { s: 56 }, async b => {
  const { ctx, p } = await fresh(b);
  const { capture, at } = photoKeysOn(p);
  // H1: every photo loaded: slots 0.. in page order, each with its attachment id; nothing failed or skipped
  const L = await capture({ photos: '4' });
  ok(
    L.res &&
      L.res.stage === 'captured' &&
      at(L.cap, 104).join() === '0:921040,1:921041,2:921042' &&
      at(L.cap, 100).join() === '0:9100100' &&
      JSON.stringify(L.cap.phfail) === '[]' &&
      !/FAILED|skipped/.test(L.res.capture),
    'H1: photos carry their attachment id (aid) and slot k in page order; phfail empty (' +
      JSON.stringify(at(L.cap, 104)) +
      ')',
  );
  // H2: a lazy image that never loaded (#104's first): the others keep their slots, and it is listed as unloaded
  const Z = await capture({ photos: '4', lazy: '104-0' });
  ok(
    Z.res &&
      Z.res.stage === 'captured' &&
      at(Z.cap, 104).join() === '1:921041,2:921042' &&
      JSON.stringify(Z.cap.phfail) === '[{"i":104,"k":0,"aid":"921040","e":"unloaded"}]' &&
      / FAILED 104 /.test(Z.res.capture),
    'H2: an image that never loaded doesn’t shift the slots after it (#104: 1, 2) and is listed in phfail (' +
      JSON.stringify([at(Z.cap, 104), Z.cap.phfail, Z.res && Z.res.capture]) +
      ')',
  );
  // H3: the skip list (by attachment id, or by slot for slots stored without one): those are never fetched
  const fetched = [];
  const onReq = q => q.resourceType() === 'fetch' && /fbcdn/.test(q.url()) && fetched.push(q.url().split('m=')[1]);
  p.on('request', onReq);
  const S = await capture({ photos: '4' }, { skip: { 104: ['921041', 0], 112: [1] } });
  p.off('request', onReq);
  ok(
    S.res &&
      S.res.stage === 'captured' &&
      at(S.cap, 104).join() === '2:921042' &&
      at(S.cap, 112).join() === '0:921120' &&
      (S.cap.phskip || []).length === 3 &&
      / skipped 3 /.test(S.res.capture) &&
      !fetched.some(f => /^(104-0|104-1|112-1)$/.test(f)) &&
      fetched.includes('104-2'),
    'H3: skip {104: ["921041", 0], 112: [1]}: those 3 photos aren’t fetched or sent, the rest are (fetched ' +
      JSON.stringify(fetched) +
      ', ' +
      (S.res && S.res.capture) +
      ')',
  );
  // H4: a photo whose fetch fails is listed (R15), not just counted
  const R112 = /p100\.jpg\?m=112-0$/;
  await p.route(R112, r => (r.request().resourceType() === 'fetch' ? r.abort() : r.continue()));
  const F = await capture({ photos: '4' });
  await p.unroute(R112);
  ok(
    F.res &&
      F.res.stage === 'captured' &&
      at(F.cap, 112).join() === '1:921121' &&
      JSON.stringify(F.cap.phfail) === '[{"i":112,"k":0,"aid":"921120","e":"fetch"}]' &&
      / FAILED 112 /.test(F.res.capture),
    'H4: a fetch that fails is listed in phfail {i, k, aid, e:"fetch"} (' + (F.res && F.res.capture) + ')',
  );
  fs.writeFileSync(D + 'tests/out/sim_cap_keys.json', JSON.stringify({ loaded: L.cap, lazy: Z.cap }));
  // H6: the capture carries the run id of `full`, so the page counts a failed photo once per run
  ok(L.cap.run === 'h' && Z.cap.run === 'h', 'H6: the capture carries full’s run id (' + L.cap.run + ')');
  await ctx.close();
});
sim('H7, H8: photos sharing an id, placeholder boxes', { s: 28 }, async b => {
  const { ctx, p } = await fresh(b);
  const { capture, at } = photoKeysOn(p);
  // H7: photos of one message that share an attachment id: none is lost; ids dropped, matched by position, a warning
  const SH = await capture({ photos: '4', sharedaid: '1' });
  ok(
    SH.res &&
      SH.res.stage === 'captured' &&
      at(SH.cap, 104).join() === '0:undefined,1:undefined,2:undefined' &&
      at(SH.cap, 112).join() === '0:undefined,1:undefined' &&
      at(SH.cap, 108).join() === '0:92108' &&
      has(SH.res.warn, 'share one Messenger id'),
    'H7: photos sharing one id keep all their slots (no id), others keep theirs, and the scan warns (' +
      JSON.stringify([at(SH.cap, 104), SH.res && SH.res.warn]) +
      ')',
  );
  // H8: a photo link with no image yet (a placeholder box) is an unloaded photo: it keeps its slot and is listed
  const SK = await capture({ photos: '4', skeleton: '104-0' });
  ok(
    SK.res &&
      at(SK.cap, 104).join() === '1:921041,2:921042' &&
      JSON.stringify(SK.cap.phfail) === '[{"i":104,"k":0,"aid":"921040","e":"unloaded"}]',
    'H8: a photo link holding only a placeholder keeps its slot and is listed as unloaded (' +
      JSON.stringify([at(SK.cap, 104), SK.cap.phfail]) +
      ')',
  );
  await ctx.close();
});
sim('H9: two reads of a message merged tile by tile', async b => {
  const { ctx, p } = await fresh(b);
  // H9: merging two reads of a message, tile by tile (window.__mcPh: the scan's own functions)
  await mode(p, {}, 120);
  const mg = await p.evaluate(() => {
    const P = window.__mcPh;
    if (!P) return null;
    const ph = (raw, gif = false) => ({ srcs: raw.filter(x => x.u).map(x => x.u), raw, gif });
    const T = (kind, aid = '', u = '') => ({ u: kind === 'photo' ? u || 'u' + aid : '', aid, kind });
    const show = r => r.tiles.map(t => (t.u || '-') + '/' + t.aid).join() + (r.gif ? ' gif' : '');
    const out = {};
    // an image loaded in the first read, not in a later one (by id, and by place without ids): the URL is kept
    out.fillId = show(P.mergePh(ph([T('photo', 'A'), T('photo', 'B')]), ph([T('unloaded', 'A'), T('photo', 'B')])));
    out.fillPlace = show(P.mergePh(ph([T('photo', '', 'x'), T('unloaded')]), ph([T('unloaded'), T('photo', '', 'y')])));
    // a GIF read before its still loaded, then recognised: a GIF, no phantom unloaded photo
    out.gif = show(P.mergePh(ph([T('unloaded', '5')]), ph([T('gif', '5')], true)));
    // one loaded photo against two unloaded tiles that don't line up: the loaded read wins
    out.known = show(P.mergePh(ph([T('photo', '', 'x')]), ph([T('unloaded'), T('unloaded')])));
    // a message with a placeholder box in its first photo link
    const d = document.createElement('div');
    d.innerHTML =
      '<a href="https://www.facebook.com/messenger_media/?attachment_id=71"><div style="width:9px;height:9px"></div></a>' +
      '<a href="https://www.facebook.com/messenger_media/?attachment_id=72"><img src="/mock/fbcdn/p100.jpg?m=t"></a>';
    out.skeleton = show(P.photoInfo(d));
    return out;
  });
  ok(
    mg &&
      mg.fillId === 'uA/A,uB/B' &&
      mg.fillPlace === 'x/,y/' &&
      mg.gif === ' gif' &&
      mg.known === 'x/' &&
      /^-\/71,.*p100\.jpg\?m=t\/72$/.test(mg.skeleton),
    'H9: reads merge tile by tile: a URL seen once is kept, a recognised GIF beats an unloaded tile, a loaded read ' +
      'beats unloaded tiles that don’t line up, and a placeholder is an unloaded photo (' +
      JSON.stringify(mg) +
      ')',
  );
  await ctx.close();
});
sim('H5: topMs shortens the top-of-chat wait', { s: 33 }, async b => {
  const { ctx, p } = await fresh(b);
  // H5: topMs shortens the top-of-chat wait in the scan, verify and full (a 30-message chat, a first run of 50)
  await mode(p, {}, 30);
  await bridge(p, 'full', { first: { count: 50 }, base: -1, run: 'htop', topMs: 1500 });
  await p.waitForLoadState('load');
  const T = await pollResult(p);
  ok(
    T && T.stage === 'captured' && T.scan.top && T.scan.win === 30 && T.verify.ok && T.scan.ms < 17500 && T.ms < 22500,
    'H5: full with topMs 1500 on a 30-message chat: the top is confirmed in ' +
      (T && T.scan && T.scan.ms) +
      ' ms (about 22 s by default), the reload, verify and capture in ' +
      (T && T.ms) +
      ' ms (about 27 s)',
  );
  await ctx.close();
});

/* ---------- E: helper 2.0: silent failures become warnings (R3), the scroller, the stall timeout, full names (B41) ---------- */
const STOPS99 = ['mid.$mock99', 'mid.$mock98', 'mid.$mock97']; /* window #100-#119 (base 99) of the 120-message mock */
async function mode(p, m, total) {
  await p.goto(URL);
  await p.evaluate(
    ([m, total]) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('mock_total', String(total || 120));
      for (const [k, v] of Object.entries(m)) localStorage.setItem('mock_' + k, v);
    },
    [m, total],
  );
  await p.goto(URL);
  await p.waitForTimeout(700);
}
const has = (list, s) => (list || []).some(x => x.includes(s));
const short = r => JSON.stringify(r && { err: r.err, win: r.win, top: r.top, scroller: r.scroller, warn: r.warn });
sim('E: normal mock: no warnings', async b => {
  const ctx = await newCtx(b, true);
  const p = await ctx.newPage();
  // the normal mock: selfcheck and the scan stay quiet, and report the scroller they used
  await mode(p, {});
  let sck = await bridge(p, 'selfcheck', {});
  ok(
    sck && sck.ok && !sck.warn.length && sck.counts.scroller === 'message' && sck.lang === 'en',
    'E: selfcheck on the normal mock: ok, no warnings, scroller found from a message (' +
      JSON.stringify([sck.warn, sck.counts]) +
      ')',
  );
  let r = await bridge(p, 'scan', { stops: STOPS99, base: 99 });
  ok(
    r &&
      !r.err &&
      r.win === 20 &&
      Array.isArray(r.warn) &&
      !r.warn.length &&
      r.top === false &&
      r.stalled === false &&
      r.scroller === 'message',
    'E: scan on the normal mock: 20 new, no warnings (two Bens and a nickname are normal), top false, scroller "message" (' +
      short(r) +
      ')',
  );
  await ctx.close();
});
sim('E: page language not English', async b => {
  const { ctx, p } = await fresh(b);
  let sck, r;
  // the page language isn't English: warn and keep reading
  await mode(p, { lang: 'de' });
  sck = await bridge(p, 'selfcheck', {});
  r = await bridge(p, 'scan', { stops: STOPS99, base: 99 });
  ok(
    sck &&
      sck.ok &&
      has(sck.warn, 'page language is "de"') &&
      r &&
      !r.err &&
      r.win === 20 &&
      has(r.warn, 'page language is "de"'),
    'E: lang="de": selfcheck and the scan warn and name it, and the scan still reads all 20 (' +
      JSON.stringify(sck.warn) +
      ')',
  );
  await ctx.close();
});
sim('E: 24-hour clock', async b => {
  const { ctx, p } = await fresh(b);
  let sck, r;
  // a 24-hour clock: its own warning, not "Messenger changed", and the times are read
  await mode(p, { h24: '1' });
  sck = await bridge(p, 'selfcheck', {});
  ok(
    sck.ok && !sck.missing.length && has(sck.warn, '24-hour clock'),
    'E: 24-hour labels: selfcheck ok with a 24-hour-clock warning, nothing missing (' +
      JSON.stringify([sck.missing, sck.warn]) +
      ')',
  );
  r = await bridge(p, 'scan', { stops: STOPS99, base: 99 });
  await bridge(p, 'capture', { base: 99 });
  const capOf = async () => JSON.parse((await p.evaluate(() => window.__capText)) || '{"msgs":[]}');
  let cap = await capOf();
  const m110 = cap.msgs.find(m => m.m === 'mid.$mock110') || {};
  ok(
    !r.err &&
      has(r.warn, '24-hour clock') &&
      m110.t === ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][NOW.getDay()] + ' 10:50 AM' &&
      m110.d === ymdOf(NOW) &&
      m110.f === 'Ana' &&
      m110.b === 'Message number 110 about trail shoes and packs',
    'E: 24-hour labels: "10:50" captured as ' + JSON.stringify([m110.t, m110.d, m110.f, m110.b]),
  );
  await ctx.close();
});
sim('E: time labels across midnight', async b => {
  const { ctx, p } = await fresh(b);
  let sck, r;
  // time-only labels across midnight: dates in the future and times going backwards
  await mode(p, { midnight: '1' });
  sck = await bridge(p, 'selfcheck', {});
  r = await bridge(p, 'scan', { stops: STOPS99, base: 99 });
  ok(
    has(r.warn, 'dated in the future') && has(r.warn, 'go backwards') && has(sck.warn, 'go backwards'),
    'E: time-only labels across midnight: the scan and selfcheck warn (' + JSON.stringify(r.warn) + ')',
  );
  await ctx.close();
});
sim('E: photo link with no image', async b => {
  const { ctx, p } = await fresh(b);
  let sck, r;
  // a photo link with no Facebook image
  await mode(p, { noimg: '1' });
  sck = await bridge(p, 'selfcheck', {});
  r = await bridge(p, 'scan', { stops: STOPS99, base: 99 });
  ok(
    has(sck.warn, 'photo link') && has(r.warn, 'photo link(s) with no Facebook image (#100)'),
    'E: a photo link with no image: selfcheck and the scan warn, naming #100 (' + JSON.stringify(r.warn) + ')',
  );
  await ctx.close();
});
sim('E: reworded reply lines', async b => {
  const { ctx, p, capOf } = await fresh(b);
  let sck, r, cap;
  // "X replied to Y" reworded: a warning, and a photo reply whose reply line can't be read is never linked (perr)
  await mode(p, { reword: '1' });
  sck = await bridge(p, 'selfcheck', {});
  r = await bridge(p, 'scan', { stops: STOPS99, base: 99 });
  const saved = await p.evaluate(() => JSON.parse(sessionStorage.getItem('__mcsave') || 'null'));
  const p103 = (saved && saved.parents['mid.$mock103']) || {};
  ok(
    sck.ok && has(sck.warn, 'without an "X replied to Y" line') && has(r.warn, 'without an "X replied to Y" line'),
    'E: reworded reply lines: selfcheck and the scan warn (' + JSON.stringify(sck.warn) + ')',
  );
  await bridge(p, 'capture', { base: 99 });
  cap = await capOf();
  const c103 = cap.msgs.find(m => m.m === 'mid.$mock103') || {};
  ok(
    p103.err === 'noreplyline' && !p103.p && c103.perr === 'noreplyline' && !('pi' in c103) && !('pmid' in c103),
    'E: a photo reply with no readable reply line gets perr "noreplyline", never a link (' +
      JSON.stringify([p103, c103.perr, c103.pi]) +
      ')',
  );
  await ctx.close();
});
sim('E: one shown name, two people', async b => {
  const { ctx, p } = await fresh(b);
  let r;
  // one shown name with full names that don't share a first name (the wrong avatar)
  await mode(p, { wrongav: '1' });
  r = await bridge(p, 'scan', { stops: STOPS99, base: 99 });
  ok(
    has(r.warn, '"Ben" shows as') && has(r.warn, 'Dee Diaz'),
    'E: one shown name mapping to two people warns (' + JSON.stringify(r.warn) + ')',
  );
  await ctx.close();
});
sim('E: runs with one avatar (B41)', async b => {
  const { ctx, p, capOf } = await fresh(b);
  let r, cap;
  // B41: runs of messages with one avatar: every message in the run gets the run's full name
  await mode(p, { group: '1' });
  r = await bridge(p, 'scan', { stops: STOPS99, base: 99 });
  await bridge(p, 'capture', { base: 99 });
  cap = await capOf();
  const names = ['Ana', 'Ben', 'You', 'Cy', 'Dee'];
  const FULL = { Ana: 'Ana Alvarez', Ben: 'Ben Brooks', Cy: 'Cy Chen', Dee: 'Dee Diaz' };
  const wrongFn = cap.msgs.filter((m, k) => {
    const who = names[Math.floor((100 + k) / 3) % 5];
    return m.f !== who || (who === 'You' ? m.fn !== undefined : m.fn !== FULL[who]);
  });
  ok(
    !r.err && cap.count === 20 && !wrongFn.length && !has(r.warn, 'no full names'),
    'E: grouped runs with one avatar each: all ' +
      cap.msgs.filter(m => m.f !== 'You').length +
      " messages from others carry the run's fn (wrong: " +
      JSON.stringify(wrongFn.map(m => [m.i, m.f, m.fn])) +
      ')',
  );
  await ctx.close();
});
sim('E: two Bens back to back', async b => {
  const { ctx, p, capOf } = await fresh(b);
  let r, cap;
  // review #7: two people shown as "Ben" post back to back: each group takes its own avatar's name, never the other's
  await mode(p, { group: '1', twobens: '1' });
  r = await bridge(p, 'scan', { stops: STOPS99, base: 99 });
  await bridge(p, 'capture', { base: 99 });
  cap = await capOf();
  const bens = [105, 106, 107, 108, 109, 110].map(i => (cap.msgs.find(m => m.m === 'mid.$mock' + i) || {}).fn);
  ok(
    JSON.stringify(bens) ===
      JSON.stringify(['Ben Brooks', 'Ben Brooks', 'Ben Brooks', 'Ben Ortiz', 'Ben Ortiz', 'Ben Ortiz']),
    'E: two people shown as "Ben" back to back: each group gets its own avatar\'s full name (' +
      JSON.stringify(bens) +
      ')',
  );
  await ctx.close();
});
sim('E: nested scrolling box', { s: 20 }, async b => {
  const { ctx, p } = await fresh(b);
  let sck, r;
  // review #4: a message inside its own small scrolling box is not the list: a first run still reads all it asked for
  await mode(p, { nested: '1' }, 120);
  sck = await bridge(p, 'selfcheck', {});
  r = await bridge(p, 'scan', { first: { count: 100 } });
  ok(
    sck.counts.scroller === 'message' && r && !r.err && r.win === 100 && r.top === false && r.scroller === 'message',
    'E: the first message in its own scrolling box: the scroller is the list, a first run of 100 reads 100 (' +
      short(r) +
      ')',
  );
  await ctx.close();
});
sim('E: progress bars inside messages', { s: 25 }, async b => {
  const { ctx, p } = await fresh(b);
  let r;
  // review #2: a progress bar inside a message (a poll, a voice clip), or a hidden one, isn't a loading spinner
  await mode(p, { msgbar: '1' }, 30);
  let t0 = Date.now();
  r = await bridge(p, 'scan', { first: { count: 50 } });
  ok(
    r && !r.err && r.win === 30 && r.top === true && r.anchor === '__top__',
    'E: progress bars inside message 0 and hidden at the top: the top of a 30-message chat is still found in ' +
      Math.round((Date.now() - t0) / 1000) +
      ' s (' +
      short(r) +
      ')',
  );
  await ctx.close();
});
sim('E: inner scrollable bar', async b => {
  const { ctx, p } = await fresh(b);
  let sck, r;
  // a scrollable pinned bar before the message list: the scroller is found from a message, not the first scrollable div
  await mode(p, { inner: '1' });
  sck = await bridge(p, 'selfcheck', {});
  r = await bridge(p, 'scan', { stops: ['mid.$mock79', 'mid.$mock78', 'mid.$mock77'], base: 79 });
  ok(
    sck.ok && sck.counts.scroller === 'message' && r && !r.err && r.win === 40 && r.scroller === 'message',
    'E: an inner scrollable bar before the list: selfcheck and the scan use the list (scroller "message"), 40 read (' +
      short(r) +
      ')',
  );
  await ctx.close();
});
sim('E: stalled scan, no spinner', async b => {
  const { ctx, p } = await fresh(b);
  let r, t0;
  // a scan that stops growing: an error instead of hanging (stops) or calling it the top of the chat (first run).
  // Without a spinner (the list keeps snapping back to the bottom): "stalled".
  await mode(p, { stall: 'stuck' });
  t0 = Date.now();
  r = await bridge(p, 'scan', { stops: ['mid.$mock3', 'mid.$mock2', 'mid.$mock1'], stallMs: 4000 });
  ok(
    r && r.err === 'stalled' && r.stalled && !r.top && Date.now() - t0 < 20000,
    'E: a list that never scrolls back (no spinner): the scan returns err "stalled" in ' +
      Math.round((Date.now() - t0) / 1000) +
      ' s (' +
      short(r) +
      ')',
  );
  await ctx.close();
});
sim('E: spinner that stays: scan and first run', { s: 18 }, async b => {
  const { ctx, p } = await fresh(b);
  let r, t0;
  // With a loading spinner that stays at the top: "top-spinner", for a stop scan and for a first run
  await mode(p, { stall: '1' });
  t0 = Date.now();
  r = await bridge(p, 'scan', { stops: ['mid.$mock3', 'mid.$mock2', 'mid.$mock1'], stallMs: 4000 });
  ok(
    r && r.err === 'top-spinner' && r.stalled && !r.top && Date.now() - t0 < 20000,
    'E: history stops loading under a spinner: the scan returns err "top-spinner" in ' +
      Math.round((Date.now() - t0) / 1000) +
      ' s (' +
      short(r) +
      ')',
  );
  await mode(p, { stall: '1' });
  r = await bridge(p, 'full', { first: { count: 100 }, base: -1, run: 'runStall', stallMs: 4000 });
  ok(
    r && r.stage === 'scan' && r.err === 'top-spinner' && r.top === false && r.run === 'runStall',
    'E: a first run under a spinner that stays is "top-spinner", not a truncated "top of the chat" (' +
      JSON.stringify(r && [r.stage, r.err, r.top, r.win, r.anchor]) +
      ')',
  );
  await ctx.close();
});
sim('E: people scan under a spinner', async b => {
  const { ctx, p } = await fresh(b);
  let t0;
  // the people scan and verify don't hang on that spinner either
  await mode(p, { stall: '1' });
  t0 = Date.now();
  const pp = await bridge(p, 'people', { count: 1000, stallMs: 4000 });
  ok(
    pp && pp.stalled && pp.spinner && !pp.top && Date.now() - t0 < 25000,
    'E: the people scan under a spinner stops in ' +
      Math.round((Date.now() - t0) / 1000) +
      ' s with stalled and spinner (' +
      JSON.stringify(pp && { seen: pp.seen, top: pp.top, stalled: pp.stalled, spinner: pp.spinner }) +
      ')',
  );
  await ctx.close();
});
sim('E: verify under a spinner', { s: 32 }, async b => {
  const { ctx, p } = await fresh(b);
  let r, t0;
  await mode(p, {}, 30);
  r = await bridge(p, 'scan', { first: { count: 50 } });
  await p.evaluate(() => localStorage.setItem('mock_stall', '1'));
  await p.reload();
  await p.waitForTimeout(700);
  t0 = Date.now();
  const vr = await bridge(p, 'verify', { stallMs: 4000 });
  ok(
    r && r.top && vr && !vr.ok && vr.err === 'top-spinner' && Date.now() - t0 < 25000,
    'E: verify under a spinner that stays ends with err "top-spinner" in ' +
      Math.round((Date.now() - t0) / 1000) +
      ' s (' +
      JSON.stringify(vr) +
      ')',
  );
  await ctx.close();
});
sim('E: top of a short chat, anchors gone', { s: 42 }, async b => {
  const { ctx, p } = await fresh(b);
  let r, t0;
  // the top of a short chat is reported (top:true), and a stop scan that reaches the top ends with a clear error
  await mode(p, {}, 30);
  r = await bridge(p, 'scan', { first: { count: 50 } });
  ok(
    r && !r.err && r.anchor === '__top__' && r.win === 30 && r.top === true,
    'E: a 30-message chat, first run of 50: top:true, anchor __top__, all 30 (' + short(r) + ')',
  );
  t0 = Date.now();
  r = await bridge(p, 'scan', { stops: ['mid.$gone1', 'mid.$gone2'] });
  ok(
    r && r.top === true && /None of the stored anchor messages was found.*top of the chat/.test(r.err || ''),
    'E: anchors that are gone: the scan stops at the top of the chat with a clear error in ' +
      Math.round((Date.now() - t0) / 1000) +
      ' s (' +
      (r && r.err) +
      ')',
  );
  await ctx.close();
});

/* ---------- F: Reply on photo-only messages (More actions) and the opt-in post command ---------- */
/* fresh() plus the composer's state, waitTip() (the state once the jump's tip is done) and the reply the cases post */
const freshF = async b => {
  const { ctx, p } = await fresh(b);
  const state = () =>
    p.evaluate(() => ({
      sent: window.mockSent.slice(),
      box: document.querySelector('#box').innerText.trim(),
      bar: document.querySelector('#replybar').hidden ? '' : document.querySelector('#replybar').innerText,
      hash: location.hash,
      tip: (document.getElementById('mcjump-tip') || {}).textContent || '',
      res: window.__mcJumpRes || null,
    }));
  const waitTip = async () => {
    for (let k = 0; k < 60; k++) {
      await p.waitForTimeout(250);
      const s = await state();
      if (s.res && s.res.state !== 'running') return s;
    }
    return state();
  };
  const row = { mid: 'mid.$mock110', to: 'Ana', snip: 'Message number 110 about trail shoes', text: 'Sounds good' };
  return { ctx, p, state, waitTip, row };
};
sim('F: jump{reply} through More actions or the Reply button', async b => {
  const { ctx, p, state, waitTip } = await freshF(b);
  // jump{reply} on a photo-only message: its toolbar has no Reply button, so it goes through More actions -> Reply
  await mode(p, {});
  await bridge(p, 'jump', { mid: 'mid.$mock100', reply: true });
  let s = await waitTip();
  ok(
    /reply box is ready/.test(s.tip) && (s.res || {}).via === 'menu' && /^Replying to Ana\nPhoto/.test(s.bar),
    'F: jump{reply} on a photo-only message opens Reply through More actions (' + JSON.stringify([s.tip, s.bar]) + ')',
  );
  await mode(p, {});
  await bridge(p, 'jump', { mid: 'mid.$mock110', reply: true });
  s = await waitTip();
  ok(
    /reply box is ready/.test(s.tip) &&
      (s.res || {}).via === 'button' &&
      /^Replying to Ana\nMessage number 110/.test(s.bar),
    'F: jump{reply} on a text message still uses its Reply button (' + JSON.stringify([s.tip, (s.res || {}).via]) + ')',
  );
  await ctx.close();
});
sim('F: More actions menus without Reply, or left open', async b => {
  const { ctx, p, state, waitTip, row } = await freshF(b);
  let s;
  // review #5: a More actions menu without Reply is closed again, and a menu left open elsewhere is never used
  await mode(p, { noreplymenu: '1' });
  await bridge(p, 'jump', { mid: 'mid.$mock100', reply: true });
  s = await waitTip();
  let menus = await p.evaluate(() => document.querySelectorAll('[role="menu"]').length);
  ok(
    /found it/.test(s.tip) && !menus && !s.bar,
    'F: a More actions menu with no Reply: jump says "found it" and closes the menu (' +
      JSON.stringify([s.tip, menus]) +
      ')',
  );
  await mode(p, { stalemenu: '1' });
  await p.evaluate(() => {
    const e = document.querySelector('[data-message-id="mid.$mock110"]');
    e.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    e.querySelector('[aria-label="More actions"]').click(); /* #110's menu, with Reply, left open */
  });
  await bridge(p, 'jump', { mid: 'mid.$mock100', reply: true });
  s = await waitTip();
  ok(
    /reply box is ready/.test(s.tip) && /^Replying to Ana\nPhoto/.test(s.bar),
    "F: with another message's menu still open, jump uses the menu it opened (" + JSON.stringify(s.bar) + ')',
  );
  await ctx.close();
});
sim('F: post not opted in', async b => {
  const { ctx, p, state, waitTip, row } = await freshF(b);
  let s;
  // not opted in: refused before anything happens
  await mode(p, {});
  let r = await bridge(p, 'post', row);
  s = await state();
  ok(
    r && r.sent === false && r.err === 'not-opted-in' && !r.entered && !s.sent.length && !s.bar && !s.box,
    'F: post without helperPost:true is refused; no Reply opened, nothing typed or sent (' + JSON.stringify(r) + ')',
  );
  r = await bridge(p, 'post', Object.assign({}, row, { helperPost: 'true' }));
  ok(r && r.err === 'not-opted-in', 'F: post with helperPost:"true" (not the boolean) is refused too');
  await ctx.close();
});
sim('F: post: bar names someone else', async b => {
  const { ctx, p, state, waitTip, row } = await freshF(b);
  let s, r;
  // the "Replying to" bar names someone else: refused, nothing typed or sent
  await mode(p, {});
  r = await bridge(p, 'post', Object.assign({}, row, { to: 'Ben', helperPost: true }));
  s = await state();
  ok(
    r && r.err === 'wrong-reply-target' && !r.entered && r.barClosed && !s.bar && !s.sent.length && !s.box,
    'F: post refuses when "Replying to" names someone else; nothing typed or sent, the reply bar closed (' +
      JSON.stringify([r, s.bar]) +
      ')',
  );
  await ctx.close();
});
sim('F: post: bar shows another message', async b => {
  const { ctx, p, state, waitTip, row } = await freshF(b);
  let s, r;
  // the right person but a different message (snip doesn't match)
  await mode(p, {});
  r = await bridge(p, 'post', Object.assign({}, row, { snip: 'Message number 105 about', helperPost: true }));
  s = await state();
  ok(
    r && r.err === 'wrong-reply-target' && r.barClosed && !s.bar && !s.sent.length,
    'F: post refuses when the reply bar shows a different message, and closes the bar (' +
      JSON.stringify(r && r.detail) +
      ')',
  );
  await ctx.close();
});
sim('F: post: box already has text', async b => {
  const { ctx, p, state, waitTip, row } = await freshF(b);
  let s, r;
  // a box that already holds text
  await mode(p, {});
  await p.evaluate(async () => {
    document.querySelector('#box').focus();
    await new Promise(z => setTimeout(z, 120));
    document.execCommand('insertText', false, 'draft');
  });
  r = await bridge(p, 'post', Object.assign({}, row, { helperPost: true }));
  s = await state();
  ok(
    r && r.err === 'box-not-empty' && !s.sent.length && s.box === 'draft' && !s.bar,
    "F: post refuses when the box already has text (the user's draft), leaves it and opens no Reply (" +
      JSON.stringify(r) +
      ')',
  );
  await ctx.close();
});
sim('F: post: shift+Enter taken as Enter', async b => {
  const { ctx, p, state, waitTip, row } = await freshF(b);
  let s, r;
  // review #1: Messenger reads a scripted shift+Enter as Enter: the first line goes out. Never "nothing sent".
  await mode(p, { shiftsends: '1' });
  r = await bridge(p, 'post', Object.assign({}, row, { text: 'First line\nSecond line', helperPost: true }));
  await p.waitForTimeout(600);
  s = await state();
  ok(
    r &&
      r.sent === false &&
      r.err === 'unconfirmed' &&
      r.entered === true &&
      r.partial === true &&
      s.sent.length === 1 &&
      s.sent[0].text === 'First line',
    'F: a shift+Enter taken as Enter sent the first line: post says "unconfirmed" with entered, never a retryable error (' +
      JSON.stringify([r, s.sent]) +
      ')',
  );
  await ctx.close();
});
sim('F: post: bar moves while typing', async b => {
  const { ctx, p, state, waitTip, row } = await freshF(b);
  let s, r;
  // review #6: the reply bar moves to another message while typing: caught before Enter, nothing sent, all tidied
  await mode(p, { retarget: '1' });
  r = await bridge(p, 'post', Object.assign({}, row, { helperPost: true }));
  s = await state();
  ok(
    r && r.err === 'wrong-reply-target' && r.stage === 'enter' && r.cleared && r.barClosed && !s.sent.length && !s.box,
    'F: a reply bar that moves while typing is caught just before Enter; nothing sent, box cleared, bar closed (' +
      JSON.stringify(r) +
      ')',
  );
  await ctx.close();
});
sim('F: post while a Reply link jumps', async b => {
  const { ctx, p, state, waitTip, row } = await freshF(b);
  let s, r;
  // review #6: a jump from a page Reply link is running: post refuses instead of racing it
  await mode(p, {});
  await p.evaluate(() => {
    location.hash = '#mcjump=' + encodeURIComponent('mid.$mock40');
  });
  await p.waitForTimeout(200);
  r = await bridge(p, 'post', Object.assign({}, row, { helperPost: true }));
  await p.waitForTimeout(500);
  s = await state();
  ok(
    r && r.err === 'jump-running' && !r.entered && !s.sent.length && !s.box,
    'F: a page Reply link still jumping: post refuses with "jump-running", nothing typed (' + JSON.stringify(r) + ')',
  );
  await ctx.close();
});
sim('F: a second post while one runs', { s: 18 }, async b => {
  const { ctx, p, state, waitTip, row } = await freshF(b);
  let s;
  // review #3: a second post while one runs: "post-running", never a second send; the first records its stage
  await mode(p, { trusted: '1' });
  const firstPost = p.evaluate(
    async args => {
      const id = 'firstpost';
      document.dispatchEvent(new CustomEvent('mc-cmd', { detail: JSON.stringify({ id, cmd: 'post', args }) }));
      let stages = [],
        r;
      for (let k = 0; k < 160; k++) {
        await new Promise(z => setTimeout(z, 150));
        r = JSON.parse(sessionStorage.getItem('mc_res_' + id) || 'null');
        if (r && r.running && r.stage && stages[stages.length - 1] !== r.stage) stages.push(r.stage);
        if (r && !r.running) break;
      }
      return { r, stages, post: JSON.parse(sessionStorage.getItem('mc_post') || 'null') };
    },
    Object.assign({}, row, { helperPost: true }),
  );
  await p.waitForTimeout(400);
  const second = await bridge(p, 'post', Object.assign({}, row, { helperPost: true }));
  const fp = await firstPost;
  s = await state();
  ok(
    second && second.err === 'post-running' && !second.entered && !s.sent.length,
    'F: a second post while one is running is refused with "post-running" (' + JSON.stringify(second) + ')',
  );
  ok(
    fp.stages.join(',') === 'jump,enter' &&
      fp.post &&
      fp.post.stage === 'enter' &&
      fp.r &&
      fp.r.err === 'enter-not-accepted',
    'F: post records its stage in its result and in mc_post before each key (' +
      JSON.stringify([fp.stages, fp.post && fp.post.stage, fp.r && fp.r.err]) +
      ')',
  );
  await ctx.close();
});
sim('F: post a multi-line reply', async b => {
  const { ctx, p, state, waitTip, row } = await freshF(b);
  let s, r;
  // multi-line: paragraphs with shift+Enter between them, then Enter; returns sent and the new message id
  await mode(p, {});
  const text = 'First line\nSecond line\n\nFourth line, after a blank one';
  r = await bridge(p, 'post', Object.assign({}, row, { text, helperPost: true }));
  s = await state();
  const posted = await p.evaluate(id => {
    const e = document.querySelector('[data-message-id="' + CSS.escape(id || '') + '"]');
    return e ? e.innerText : null;
  }, r && r.mid);
  ok(
    r &&
      r.sent === true &&
      /^mid\.\$sent/.test(r.mid) &&
      s.sent.length === 1 &&
      s.sent[0].text === text &&
      s.sent[0].to === 'mid.$mock110' &&
      !s.box &&
      /^You replied to Ana\n/.test(posted || ''),
    'F: post types a multi-line reply (Lexical line breaks), sends it once as a reply to #110, returns sent + mid (' +
      JSON.stringify([r, s.sent]) +
      ')',
  );
  await ctx.close();
});
sim('F: post to a photo-only message', async b => {
  const { ctx, p, state, waitTip, row } = await freshF(b);
  let s, r;
  // a photo-only message: post goes through More actions as well
  await mode(p, {});
  r = await bridge(p, 'post', { mid: 'mid.$mock100', to: 'Ana', snip: '[photo]', text: 'Nice pack', helperPost: true });
  s = await state();
  ok(
    r && r.sent === true && r.via === 'menu' && s.sent.length === 1 && s.sent[0].to === 'mid.$mock100',
    'F: post replies to a photo-only message through More actions (' + JSON.stringify(r) + ')',
  );
  await ctx.close();
});
sim('F: Enter or line breaks not accepted', { s: 25 }, async b => {
  const { ctx, p, state, waitTip, row } = await freshF(b);
  let s, r;
  // Messenger ignores the helper's Enter (synthetic keys refused): nothing is sent, the text stays for a real Enter
  await mode(p, { trusted: '1' });
  r = await bridge(p, 'post', Object.assign({}, row, { helperPost: true }));
  s = await state();
  ok(
    r &&
      r.sent === false &&
      r.err === 'enter-not-accepted' &&
      r.entered &&
      r.held &&
      !s.sent.length &&
      s.box === 'Sounds good',
    'F: when Enter is not accepted: err enter-not-accepted, nothing sent, the text left in the box (' +
      JSON.stringify(r) +
      ')',
  );
  await p.keyboard.press('Enter'); /* what Claude does next with the computer tool */
  await p.waitForTimeout(700);
  s = await state();
  ok(
    s.sent.length === 1 && s.sent[0].text === 'Sounds good' && s.sent[0].to === 'mid.$mock110',
    'F: ...and a real Enter then posts it as the reply (' + JSON.stringify(s.sent) + ')',
  );
  await mode(p, { trusted: '1' });
  r = await bridge(p, 'post', Object.assign({}, row, { text: 'One\nTwo', helperPost: true }));
  s = await state();
  ok(
    r &&
      r.err === 'linebreak-not-accepted' &&
      r.entered &&
      r.cleared &&
      r.barClosed &&
      !s.box &&
      !s.bar &&
      !s.sent.length,
    'F: line breaks not accepted: refused before Enter (entered: a shift+Enter was pressed), box cleared, bar closed, nothing sent (' +
      JSON.stringify(r) +
      ')',
  );
  await ctx.close();
});
sim('F: outbox.md call 1, composer not focused', async b => {
  const { ctx, p, state, waitTip, row } = await freshF(b);
  let s, r;
  // (c) outbox.md's call 1 when the composer isn't focused yet: Lexical needs a moment after focus before it takes text
  const call1 = [
    ...fs.readFileSync(D + 'plugin/skills/refresh/references/outbox.md', 'utf8').matchAll(/```js\n([\s\S]*?)```/g),
  ][0][1]
    .replace(/^await /, '')
    .replace('ROW', JSON.stringify(row));
  await mode(p, { nofocus: '1' });
  r = await p.evaluate(call1);
  s = await state();
  ok(
    r && r.typed === true && s.box === 'Sounds good',
    "F: outbox.md's call 1 types the first line even when Reply leaves the composer unfocused (" +
      JSON.stringify([r, s.box]) +
      ')',
  );
  await ctx.close();
});
sim('F: a URL hash never posts', { s: 13 }, async b => {
  const { ctx, p, state, waitTip, row } = await freshF(b);
  let s;
  // nothing but the bridge command can post: not a link or URL hash, which only ever opens Reply
  await mode(p, {});
  await p.goto(URL + '#mcjump=' + encodeURIComponent('mid.$mock110') + '&post=1&text=hi&helperPost=true');
  await p.waitForTimeout(4000);
  const opened = await state();
  for (const h of ['#mcpost=', '#post=', '#mcjump=']) {
    await p.goto(URL + h + encodeURIComponent('mid.$mock110') + '&cmd=post&text=hi&helperPost=true&to=Ana');
    await p.waitForTimeout(2500);
  }
  s = await state();
  ok(
    /^Replying to Ana\nMessage number 110/.test(opened.bar) && !opened.sent.length && !s.sent.length && !s.box,
    'F: a URL hash with every post field only opens Reply (it did: ' +
      JSON.stringify(opened.bar) +
      '); nothing is typed or sent (' +
      JSON.stringify(s.sent) +
      ')',
  );
  await ctx.close();
});

/* ---------- S: send replies (the replies skill) and replies first in a refresh (F30) ----------
   A scripted Claude runs plugin/skills/replies/SKILL.md › Send replies step by step, in the order the file lists them (a
   step it has no code for fails the case), with the literals the file gives (the lock, its release, the 20 minutes), the
   bridge from its › Helper, and the code blocks of its copy of references/outbox.md word for word. Its tools are a
   stand-in for ArtifactData (get, query, batch: a write to an existing document must be pinned, a stale pin refuses the
   whole batch) and Claude in Chrome on the mock with the helper. Every call goes to one log, so a case checks what was
   read, what was written, in what order, and whether the Messenger tab was touched at all. */
const RS = fs.readFileSync(D + 'plugin/skills/replies/SKILL.md', 'utf8');
const RS_OUTBOX = fs.readFileSync(D + 'plugin/skills/replies/references/outbox.md', 'utf8');
const RF = fs.readFileSync(D + 'plugin/skills/refresh/SKILL.md', 'utf8');
const OB = [...RS_OUTBOX.matchAll(/```js\n([\s\S]*?)```/g)].map(m => m[1]);
const obCode = (k, row, start = true) =>
  OB[k]
    .replace(/^await /, '')
    .replace('ROW', JSON.stringify(row))
    .replace('START = true', 'START = ' + start);
const RS_STEPS = [
  ...RS.split(/^## /m)
    .find(x => x.startsWith('Send replies'))
    .matchAll(/^\d+\. \*\*(.+?)\.?\*\*.*$/gm),
].map(m => ({ label: m[1], text: m[0] }));
const stepText = label => (RS_STEPS.find(s => s.label === label) || { text: '' }).text;
/* a literal from the file, such as {state:"running",startedAt,step:"replies",by:"send replies"}: bare names filled in */
const lit = (src, fill) =>
  Object.fromEntries(
    src
      .slice(1, -1)
      .split(',')
      .map(kv => {
        const [k, v] = kv.split(/:(.*)/s);
        return [k.trim(), v === undefined ? fill[k.trim()] : JSON.parse(v)];
      }),
  );
const litIn = (text, state) => (text.match(new RegExp('`(\\{state:"' + state + '"[^`]*\\})`')) || [])[1];
const LOCK = litIn(stepText('Take the run lock'), 'running');
const ERR = litIn(stepText('Take the run lock'), 'error');
const DONE = litIn(stepText('Release and report'), 'done');
const WINDOW = +(stepText('Take the run lock').match(/less than (\d+) minutes/) || [])[1];
const BR = RS.split(/^## Helper/m)[1]
  .match(/```js\n([\s\S]*?)```/)[1]
  .split('\n')
  .filter(l => l && !l.startsWith('//'));
const vcmp = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let k = 0; k < Math.max(pa.length, pb.length); k++)
    if ((pa[k] || 0) !== (pb[k] || 0)) return (pa[k] || 0) - (pb[k] || 0);
  return 0;
};
const sq = s => (s || '').replace(/\s+/g, ' ').trim();
const clone = o => JSON.parse(JSON.stringify(o));
/* ArtifactData, as far as these runs use it. ourSending: the most rows this run held in sending at once */
function fakeDB(docs, log) {
  const d = {};
  for (const [k, v] of Object.entries(docs)) d[k] = { v: clone(v), ver: 1 };
  const out = x => x && { data: clone(x.v), version: x.ver };
  const before = new Set(Object.keys(d).filter(k => d[k].v.state === 'sending'));
  const db = { d, ourSending: 0 };
  db.get = path => (log.push('get ' + path), out(d[path]));
  db.query = (coll, states) => (
    log.push('query ' + coll),
    Object.keys(d)
      .filter(k => k.startsWith(coll + '/') && states.includes(d[k].v.state))
      .map(k => Object.assign({ id: k }, out(d[k])))
  );
  db.batch = writes => {
    log.push('batch ' + writes.map(w => w.op + ' ' + w.path + (w.v.state ? ' ' + w.v.state : '')).join(', '));
    for (const w of writes) {
      if (d[w.path] && w.if_version === undefined) throw new Error('unpinned write to ' + w.path);
      if (d[w.path] && w.if_version !== d[w.path].ver) return { refused: w.path };
    }
    const versions = {};
    for (const w of writes) {
      const x = d[w.path];
      d[w.path] = { v: w.op === 'update' && x ? Object.assign(x.v, w.v) : clone(w.v), ver: (x ? x.ver : 0) + 1 };
      versions[w.path] = d[w.path].ver;
    }
    const ours = Object.keys(d).filter(k => k.startsWith('outbox/') && d[k].v.state === 'sending' && !before.has(k));
    db.ourSending = Math.max(db.ourSending, ours.length);
    return { ok: true, versions };
  };
  return db;
}
/* Claude in Chrome on the mock's tab */
function fakeChrome(p, log) {
  return {
    tabs: async () => (log.push('tabs_context_mcp'), [{ url: p.url() }]),
    navigate: async url => {
      log.push('navigate');
      await p.goto(url);
      await p.waitForTimeout(700);
    },
    js: async code => (log.push('javascript_tool'), p.evaluate(code)),
    key: async k => (log.push('key ' + k), p.keyboard.press(k)),
  };
}
/* a helper command through the file's bridge: start, then poll in separate calls until it's no longer running */
async function cmd(chrome, log, name, args) {
  log.push('cmd ' + name);
  const id = 's' + Math.random().toString(36).slice(2, 9);
  await chrome.js(
    BR[0]
      .replace("'ID'", JSON.stringify(id))
      .replace("'CMD'", JSON.stringify(name))
      .replace('ARGS', JSON.stringify(args)),
  );
  const poll =
    '(async () => {' +
    BR[1]
      .replace("'mc_res_ID'", JSON.stringify('mc_res_' + id))
      .replace(/JSON\.stringify\(r\)$/, 'return JSON.stringify(r)') +
    '})()';
  for (let k = 0; k < 12; k++) {
    const r = JSON.parse(await chrome.js(poll));
    if (r && !r.running) return r;
  }
  return null;
}
/* outbox.md › Posting (posting-with-helper.md's post when helperPost is on and the helper is 2.0+): oldest first, one row
   at a time, the pending outcomes carried in each batch, a {pending} stops posting */
async function postRows(R, db, chrome, log, rows) {
  const helperPost = R.meta.helperPost === true && vcmp(R.hv, '2.0') >= 0;
  let pending = [];
  for (const row of rows.slice().sort((a, b) => a.data.queuedAt.localeCompare(b.data.queuedAt))) {
    const r = row.data;
    const args = { mid: r.mid, to: r.to, snip: r.snip, text: r.text };
    const upd = (v, ver) => ({ op: 'update', path: row.id, v, if_version: ver });
    if (!r.mid) {
      pending.push(upd({ state: 'failed', error: 'no Messenger id' }, row.version));
      continue;
    }
    if (!helperPost) {
      let c1 = await chrome.js(obCode(0, args));
      for (let k = 0; c1 && c1.wait !== undefined && k < 5; k++) c1 = await chrome.js(obCode(0, args, false));
      if (!c1 || !c1.typed) {
        pending.push(upd({ state: 'failed', error: (c1 && c1.fail) || 'call 1 never finished' }, row.version));
        continue;
      }
    }
    const b = db.batch(pending.concat([upd({ state: 'sending' }, row.version)]));
    if (b.refused) throw new Error('refused ' + b.refused + ' (a Cancel on the page: not modeled here)');
    pending = [];
    const ver = b.versions[row.id];
    let res;
    if (helperPost) {
      const x = await cmd(chrome, log, 'post', Object.assign({}, args, { helperPost: true }));
      res = x && x.sent ? x : !x || x.err === 'unconfirmed' ? { pending: true } : { fail: x.err };
    } else {
      for (const line of r.text.split('\n').slice(1)) {
        await chrome.key('Shift+Enter');
        if (line) await chrome.js("document.execCommand('insertText',false," + JSON.stringify(line) + ')');
      }
      let threw = false;
      try {
        await chrome.js(obCode(1, args));
      } catch (e) {
        threw = true; /* the browser_batch stops at the throw, so Return never reaches the box */
      }
      if (!threw) await chrome.key('Enter');
      res = threw ? { abort: 'the reply box did not match the reply' } : await chrome.js(obCode(2, args));
    }
    if (res.sent) pending.push(upd({ state: 'sent', sentAt: res.at, sentMid: res.mid }, ver));
    else if (res.pending) break;
    else pending.push(upd({ state: 'failed', error: res.abort || res.fail || "Messenger didn't send it" }, ver));
  }
  if (pending.length) db.batch(pending);
}
const STOP = 'stop';
/* the replies skill's run; yes: the texts the user said yes to in chat (the answer to step 2's listing) */
async function sendReplies({ db, chrome, log, yes = [] }) {
  const R = { said: [] };
  const say = s => (R.said.push(s), log.push('say ' + s), STOP);
  const fresh = s => s && s.data.state === 'running' && (Date.now() - Date.parse(s.data.startedAt)) / 60000 < WINDOW;
  let held;
  const fail = message => {
    db.batch([{ op: 'update', path: 'refresh/status', v: lit(ERR, { message }), if_version: held }]);
    return say(message);
  };
  const DO = {
    'Read the outbox': async () => {
      const rows = db.query('outbox', ['queued', 'sending']);
      if (!rows.length) return say('no replies waiting');
      R.queued = rows.filter(r => r.data.state === 'queued');
      if (!R.queued.length) return say('being confirmed; the next refresh settles them');
    },
    'Check approval': async () => {
      R.meta = db.get('meta/chat').data;
      if (R.meta.outboxAuto === true) R.approved = R.queued;
      else if (!yes.length)
        return say('list ' + JSON.stringify(R.queued.map(r => [r.data.to, r.data.snip, r.data.text])));
      else R.approved = R.queued.filter(r => yes.includes(r.data.text));
      if (!R.approved.length) return say('none approved');
    },
    'Take the run lock': async () => {
      const st = db.get('refresh/status');
      if (fresh(st)) return say('a refresh is running and posts approved replies before it ends');
      const w = db.batch([
        {
          op: 'set',
          path: 'refresh/status',
          v: lit(LOCK, { startedAt: new Date().toISOString() }),
          if_version: st && st.version,
        },
      ]);
      if (w.refused) return fresh(db.get('refresh/status')) ? say('another run took the lock') : say('lock refused');
      held = w.versions['refresh/status'];
    },
    'Find the Messenger tab': async () => {
      const [tab] = await chrome.tabs();
      if (!tab || !tab.url.startsWith(R.meta.chatUrl)) return fail('Messenger tab is on another chat');
      await chrome.navigate(R.meta.chatUrl);
      if ((await chrome.js('document.visibilityState')) !== 'visible')
        return fail('computer asleep or Messenger tab hidden');
      R.hv = await chrome.js('document.documentElement.dataset.mcHelper');
      const sck = await cmd(chrome, log, 'selfcheck', {});
      if (!sck || !sck.ok) return fail('Messenger changed: ' + ((sck && sck.missing) || []).join(', '));
    },
    Post: async () => postRows(R, db, chrome, log, R.approved),
    'Release and report': async () => {
      held = db.batch([
        {
          op: 'update',
          path: 'refresh/status',
          v: lit(DONE, { finishedAt: new Date().toISOString() }),
          if_version: held,
        },
      ]).versions['refresh/status'];
      say('reported');
    },
  };
  for (const s of RS_STEPS) {
    if (!DO[s.label]) throw new Error('no code for the step "' + s.label + '"');
    if ((await DO[s.label]()) === STOP) break;
  }
  return R;
}
/* outbox.md's settle check, on the saved messages (here: this run's capture, which its import would store) */
const capTime = m => {
  const [h, mi, ap] = m.t.match(/(\d+):(\d+) ([AP]M)$/).slice(1);
  const [y, mo, da] = m.d.split('-').map(Number);
  return new Date(y, mo - 1, da, (+h % 12) + (ap === 'PM' ? 12 : 0), +mi);
};
const settleFind = (r, msgs) =>
  msgs.find(
    m =>
      m.f === 'You' &&
      ((n, t) => !!n && (n === t || n.startsWith(t) || t.startsWith(n)))(m.r, r.to === 'You' ? 'yourself' : r.to) &&
      sq(m.b) === sq(r.text) &&
      capTime(m).getTime() >= Math.floor(Date.parse(r.queuedAt) / 60000) * 60000,
  );
/* the refresh steps that deal with replies, run in the order refresh/SKILL.md gives them (each found by its marker):
   the lock, the tab, Replies first, the scan (scan + capture: the steps full runs; the capture stands in for what the
   import stores) and step 8's settle check. order() may reorder them (a control case). */
async function refreshRun({ db, chrome, log, order = x => x }) {
  const R = { said: [] };
  R.meta = db.get('meta/chat').data;
  let held = db.get('refresh/status').version;
  const parts = [
    [
      '1. Set `refresh/status`',
      async () => {
        const w = db.batch([
          {
            op: 'set',
            path: 'refresh/status',
            v: { state: 'running', startedAt: new Date().toISOString(), step: 'scan', by: 'refresh 1' },
            if_version: held,
          },
        ]);
        held = w.versions['refresh/status'];
      },
    ],
    [
      '2. `tabs_context_mcp`',
      async () => {
        await chrome.tabs();
        await chrome.navigate(R.meta.chatUrl);
        R.hv = await chrome.js('document.documentElement.dataset.mcHelper');
        await cmd(chrome, log, 'selfcheck', {});
      },
    ],
    [
      '**Replies first**',
      async () => {
        const rows = db.query('outbox', ['queued', 'sending']);
        const approved = R.meta.outboxAuto === true ? rows.filter(r => r.data.state === 'queued') : [];
        if (approved.length) {
          await postRows(R, db, chrome, log, approved);
          await chrome.navigate(R.meta.chatUrl);
        }
      },
    ],
    [
      '3. Scan with',
      async () => {
        const stops = R.meta.anchorMids.slice().reverse();
        await cmd(chrome, log, 'scan', { stops, base: R.meta.lastI });
        await cmd(chrome, log, 'capture', { base: R.meta.lastI });
        R.cap = JSON.parse((await chrome.js('window.__capText')) || '{"msgs":[]}');
      },
    ],
    [
      '8. Handle the outbox',
      async () => {
        const w = [];
        for (const row of db.query('outbox', ['sending'])) {
          const m = settleFind(row.data, R.cap.msgs);
          if (m)
            w.push({
              op: 'update',
              path: row.id,
              v: { state: 'sent', sentMid: m.m, sentAt: capTime(m).toISOString() },
              if_version: row.version,
            });
        }
        if (w.length) db.batch(w);
        db.batch([
          {
            op: 'update',
            path: 'refresh/status',
            v: { state: 'done', finishedAt: new Date().toISOString() },
            if_version: held,
          },
        ]);
      },
    ],
  ].map(([m, fn]) => ({ m, at: RF.indexOf(m), fn }));
  for (const x of parts)
    if (x.at < 0 || RF.indexOf(x.m, x.at + 1) >= 0) throw new Error('refresh SKILL.md: no single "' + x.m + '"');
  for (const x of order(parts.sort((a, b) => a.at - b.at))) await x.fn();
  return R;
}
const iso = (base, minutes) => new Date(base.getTime() + minutes * 60000).toISOString();
const row = (to, i, text, queuedAt, state = 'queued') => ({
  i,
  mid: 'mid.$mock' + i,
  to,
  snip: 'Message number ' + i + ' about trail shoes and packs',
  text,
  state,
  queuedAt,
});
const SMETA = {
  kind: 'messenger-catchup',
  chatUrl: URL,
  outboxAuto: true,
  helperPost: false,
  lastI: 99,
  anchorMids: ['mid.$mock97', 'mid.$mock98', 'mid.$mock99'],
  tz: 'UTC',
};
const MULTI = 'Yes, still here.\n\nPick it up Friday?';
/* one case's database, Chrome and log, on a fresh mock */
const freshS = async (b, docs, m = {}) => {
  const { ctx, p } = await fresh(b);
  await mode(p, m);
  const log = [];
  const db = fakeDB(docs, log);
  const chrome = fakeChrome(p, log);
  const sent = () => p.evaluate(() => window.mockSent.slice());
  return { ctx, p, log, db, chrome, sent };
};
const browserCalls = log => log.filter(x => /^(tabs_context_mcp|navigate|javascript_tool|key |cmd )/.test(x));
sim('S: send replies: the file gives what the sims run', async b => {
  // the steps, literals and code the S cases take from the replies skill's files
  ok(
    JSON.stringify(RS_STEPS.map(s => s.label)) ===
      JSON.stringify([
        'Read the outbox',
        'Check approval',
        'Take the run lock',
        'Find the Messenger tab',
        'Post',
        'Release and report',
      ]),
    'S: the replies skill lists its six steps (' + RS_STEPS.map(s => s.label).join(' | ') + ')',
  );
  ok(
    !!LOCK && !!ERR && !!DONE && WINDOW === 20 && BR.length === 2 && OB.length === 3,
    "S: the lock, its error and release, the 20 minutes, the two bridge lines and outbox.md's three code blocks are all found (" +
      JSON.stringify([LOCK, ERR, DONE, WINDOW]) +
      ')',
  );
  ok(
    /only \*\*after this refresh's import\*\*/.test(RS_OUTBOX) &&
      RS_OUTBOX.includes('`f:"You"`, `r` matching the row\'s `to`') &&
      RS_OUTBOX.includes("`b` equal to the row's `text` (ignoring whitespace), dated after `queuedAt`"),
    "S: outbox.md's settle check, as settleFind runs it: after the import, f You, r matching to, b equal to text, after queuedAt",
  );
});
sim('S: send replies: nothing queued', async b => {
  // nothing queued: one read, then a line; only rows in sending: the same, and they stay for the next refresh
  let s = await freshS(b, {
    'meta/chat': SMETA,
    'refresh/status': { state: 'idle' },
    'outbox/r1': row('Ana', 110, 'Sounds good', iso(NOW, -90), 'sent'),
    'outbox/r2': row('Ben', 111, 'Maybe', iso(NOW, -80), 'cancelled'),
  });
  let R = await sendReplies(s);
  ok(
    JSON.stringify(s.log) === JSON.stringify(['query outbox', 'say no replies waiting']),
    'S: nothing queued: one read (query outbox), one line, no other call (' + JSON.stringify(s.log) + ')',
  );
  await s.ctx.close();
  s = await freshS(b, {
    'meta/chat': SMETA,
    'refresh/status': { state: 'idle' },
    'outbox/r1': row('Ana', 110, 'Sounds good', iso(NOW, -30), 'sending'),
  });
  R = await sendReplies(s);
  ok(
    s.log.length === 2 &&
      s.log[0] === 'query outbox' &&
      /next refresh settles/.test(R.said[0]) &&
      s.db.d['outbox/r1'].ver === 1,
    'S: only a row in sending: one read, a line saying the next refresh settles it, the row untouched (' +
      JSON.stringify(s.log) +
      ')',
  );
  await s.ctx.close();
});
/* the reply-check skill (F30 option C, step 1): its one read, with the state and limit its SKILL.md gives, then a stop
   or the replies skill's run */
const RC = fs.readFileSync(D + 'plugin/skills/reply-check/SKILL.md', 'utf8');
async function replyCheck(s) {
  const where = JSON.parse((RC.match(/`where` `(\[[^`]+\])`/) || [])[1]);
  const limit = +(RC.match(/`limit` (\d+)/) || [])[1];
  if (where[0] !== 'state' || where[1] !== '==' || limit !== 1) throw new Error('reply-check: no state query, limit 1');
  if (!s.db.query('outbox', [where[2]]).slice(0, limit).length) return s.log.push('say No replies waiting.'), null;
  s.log.push('hand over to replies');
  return sendReplies(s);
}
sim('S: reply check', { s: 15 }, async b => {
  // nothing queued (rows in sending, sent or cancelled only): one read and stop; a queued row: the replies skill posts it
  let s = await freshS(b, {
    'meta/chat': SMETA,
    'refresh/status': { state: 'idle' },
    'outbox/r0': row('Dee', 114, 'On my way', iso(NOW, -30), 'sending'),
    'outbox/r1': row('Ana', 110, 'Sounds good', iso(NOW, -90), 'sent'),
    'outbox/r2': row('Ben', 111, 'Maybe', iso(NOW, -80), 'cancelled'),
  });
  await replyCheck(s);
  ok(
    JSON.stringify(s.log) === JSON.stringify(['query outbox', 'say No replies waiting.']),
    'S: reply check, nothing queued: one read, one line, no other call (' + JSON.stringify(s.log) + ')',
  );
  await s.ctx.close();
  s = await freshS(b, {
    'meta/chat': SMETA,
    'refresh/status': { state: 'idle' },
    'outbox/r1': row('Ana', 110, 'Still have the stove?', iso(NOW, -2)),
  });
  await replyCheck(s);
  const sent = await s.sent();
  ok(
    s.log[0] === 'query outbox' &&
      s.log[1] === 'hand over to replies' &&
      s.log[2] === 'query outbox' &&
      sent.length === 1 &&
      sent[0].text === 'Still have the stove?' &&
      s.db.d['outbox/r1'].v.state === 'sent' &&
      s.db.d['refresh/status'].v.state === 'done',
    'S: reply check, a queued row: handed to the replies skill, which posts it and releases the lock (' +
      JSON.stringify(s.log.slice(0, 4)) +
      ', ' +
      JSON.stringify(sent) +
      ')',
  );
  await s.ctx.close();
});
sim('S: send replies: a refresh holds the lock', async b => {
  // a refresh's live lock: the Messenger tab is never touched and nothing is written
  let s = await freshS(b, {
    'meta/chat': SMETA,
    'refresh/status': {
      state: 'running',
      startedAt: new Date(Date.now() - 5 * 60000).toISOString(),
      step: 'scan',
      by: 'refresh 7',
    },
    'outbox/r1': row('Ana', 110, 'Sounds good', iso(NOW, -3)),
  });
  let R = await sendReplies(s);
  ok(
    JSON.stringify(s.log.slice(0, 3)) === JSON.stringify(['query outbox', 'get meta/chat', 'get refresh/status']) &&
      !browserCalls(s.log).length &&
      !s.log.some(x => x.startsWith('batch')) &&
      /refresh is running/.test(R.said[0]) &&
      s.db.d['outbox/r1'].v.state === 'queued' &&
      !(await s.sent()).length,
    'S: a live refresh lock: no browser call, no write, the row still queued, and a line saying the refresh posts it (' +
      JSON.stringify(s.log) +
      ')',
  );
  await s.ctx.close();
  // the Messenger tab open on another chat: not taken over; the lock taken is released as an error
  s = await freshS(b, {
    'meta/chat': Object.assign({}, SMETA, { chatUrl: URL + '?t=gear' }),
    'refresh/status': { state: 'idle' },
    'outbox/r1': row('Ana', 110, 'Sounds good', iso(NOW, -3)),
  });
  await s.p.goto(URL + '?t=other');
  R = await sendReplies(s);
  const st = s.db.d['refresh/status'].v;
  ok(
    JSON.stringify(browserCalls(s.log)) === JSON.stringify(['tabs_context_mcp']) &&
      st.state === 'error' &&
      st.message === 'Messenger tab is on another chat' &&
      s.db.d['outbox/r1'].v.state === 'queued',
    'S: a Messenger tab on another chat: only listed, never navigated or typed in; the lock ends as an error (' +
      JSON.stringify([browserCalls(s.log), st]) +
      ')',
  );
  await s.ctx.close();
});
sim('S: send replies: approved rows are posted', { s: 20 }, async b => {
  // outboxAuto on: both queued rows go out by outbox.md's three calls, oldest first; a stale lock is taken over
  const t0 = Date.now();
  const s = await freshS(b, {
    'meta/chat': SMETA,
    'refresh/status': {
      state: 'running',
      startedAt: new Date(Date.now() - 30 * 60000).toISOString(),
      step: 'scan',
      by: 'refresh 6',
    },
    'outbox/r0': row('Dee', 114, 'On my way', iso(NOW, -200), 'sending'),
    'outbox/r2': row('Ben', 111, 'Still have the stove?', iso(NOW, -2)),
    'outbox/r1': row('Ana', 110, MULTI, iso(NOW, -5)),
  });
  const R = await sendReplies(s);
  const sent = await s.sent();
  const r1 = s.db.d['outbox/r1'].v;
  const r2 = s.db.d['outbox/r2'].v;
  const st = s.db.d['refresh/status'].v;
  const writes = s.log.filter(x => x.startsWith('batch'));
  ok(
    sent.length === 2 &&
      sent[0].to === 'mid.$mock110' &&
      sent[0].text === MULTI &&
      sent[1].to === 'mid.$mock111' &&
      sent[1].text === 'Still have the stove?',
    'S: both approved replies went out, oldest first, each as a reply to its message, line breaks kept (' +
      JSON.stringify(sent) +
      ')',
  );
  ok(
    r1.state === 'sent' &&
      r1.sentMid === 'mid.$sent1' &&
      r2.state === 'sent' &&
      r2.sentMid === 'mid.$sent2' &&
      [r1, r2].every(
        r =>
          Date.parse(r.sentAt) >= NOW.getTime() - 1000 &&
          Date.parse(r.sentAt) <= NOW.getTime() + Date.now() - t0 + 1000,
      ),
    'S: each row written sent with the new message id and the clock time of its confirm (' +
      JSON.stringify([r1, r2]) +
      ')',
  );
  ok(
    JSON.stringify(writes) ===
      JSON.stringify([
        'batch set refresh/status running',
        'batch update outbox/r1 sending',
        'batch update outbox/r1 sent, update outbox/r2 sending',
        'batch update outbox/r2 sent',
        'batch update refresh/status done',
      ]) && s.db.ourSending === 1,
    "S: the lock, each row's sending before its Enter, a row's sent with the next row's sending, then the release; never two of this run's rows in sending (" +
      JSON.stringify(writes) +
      ')',
  );
  ok(
    s.log.indexOf('batch set refresh/status running') < s.log.indexOf('tabs_context_mcp') &&
      s.log.indexOf('batch update outbox/r1 sending') < s.log.indexOf('key Enter') &&
      st.state === 'done' &&
      !!st.finishedAt &&
      st.step === 'replies' &&
      st.by === 'send replies',
    'S: the lock is taken before the tab is touched and released as done, keeping step and by (' +
      JSON.stringify(st) +
      ')',
  );
  ok(
    s.db.d['outbox/r0'].ver === 1 && s.db.d['outbox/r0'].v.state === 'sending' && !s.log.includes('get chunks'),
    "S: a row an earlier run left in sending is left for the next refresh's settle check, and no chunk is read",
  );
  ok(R.said.length === 1, 'S: one report line (' + JSON.stringify(R.said) + ')');
  await s.ctx.close();
});
sim("S: send replies: with the helper's post", async b => {
  // helperPost on (helper 2.0+): the row's sending lands before post starts, and post's result settles it
  const s = await freshS(b, {
    'meta/chat': Object.assign({}, SMETA, { helperPost: true }),
    'refresh/status': { state: 'done' },
    'outbox/r1': row('Ana', 110, MULTI, iso(NOW, -5)),
  });
  await sendReplies(s);
  const r1 = s.db.d['outbox/r1'].v;
  const sent = await s.sent();
  ok(
    s.log.indexOf('batch update outbox/r1 sending') < s.log.indexOf('cmd post') &&
      !s.log.includes('key Enter') &&
      r1.state === 'sent' &&
      r1.sentMid === 'mid.$sent1' &&
      sent.length === 1 &&
      sent[0].text === MULTI,
    'S: with helperPost, the sending write, then one post, then sent with its mid (' +
      JSON.stringify([s.log.filter(x => /batch|cmd/.test(x)), r1]) +
      ')',
  );
  await s.ctx.close();
});
sim('S: send replies: unapproved rows are never posted', { s: 15 }, async b => {
  // outboxAuto off: "send replies" lists them and asks; nothing is locked, opened or sent until a yes to that exact text
  const docs = {
    'meta/chat': Object.assign({}, SMETA, { outboxAuto: false }),
    'refresh/status': { state: 'idle' },
    'outbox/r1': row('Ana', 110, 'Sounds good, Friday works', iso(NOW, -5)),
  };
  let s = await freshS(b, docs);
  let R = await sendReplies(s);
  ok(
    JSON.stringify(s.log.slice(0, 2)) === JSON.stringify(['query outbox', 'get meta/chat']) &&
      s.log.length === 3 &&
      /Ana/.test(R.said[0]) &&
      R.said[0].includes('Message number 110') &&
      R.said[0].includes('Sounds good, Friday works') &&
      s.db.d['refresh/status'].ver === 1 &&
      s.db.d['outbox/r1'].v.state === 'queued',
    'S: not approved: lists who it is to, their message and the exact reply, then stops: no lock, no browser call (' +
      JSON.stringify(s.log) +
      ')',
  );
  R = await sendReplies(Object.assign({}, s, { yes: ['Sounds good'] }));
  ok(
    !browserCalls(s.log).length && !(await s.sent()).length && s.db.d['outbox/r1'].v.state === 'queued',
    'S: a yes to other text approves nothing: still no browser call, nothing sent',
  );
  await s.ctx.close();
  s = await freshS(b, docs);
  R = await sendReplies(Object.assign({}, s, { yes: ['Sounds good, Friday works'] }));
  const sent = await s.sent();
  ok(
    sent.length === 1 && sent[0].text === 'Sounds good, Friday works' && s.db.d['outbox/r1'].v.state === 'sent',
    'S: a yes to that exact text: it goes out and is written sent (' + JSON.stringify(sent) + ')',
  );
  await s.ctx.close();
});
/* replies first: a reply from an earlier run whose confirm was lost (r0, in sending) is already in Messenger, and r1 is
   queued and approved */
const freshFirst = async b => {
  const s = await freshS(b, {
    'meta/chat': SMETA,
    'refresh/status': { state: 'done' },
    'outbox/r0': row('Ben', 111, 'Still have the stove?', iso(NOW, -10), 'sending'),
    'outbox/r1': row('Ana', 110, MULTI, iso(NOW, -5)),
  });
  await bridge(s.p, 'post', {
    mid: 'mid.$mock111',
    to: 'Ben',
    snip: 'Message number 111',
    text: 'Still have the stove?',
    helperPost: true,
  });
  return s;
};
sim('S: replies first in a refresh', { s: 25 }, async b => {
  // the refresh's own order: the reply goes out before the scan, so this run's capture holds it and step 8 settles
  const s = await freshFirst(b);
  const R = await refreshRun(s);
  const r0 = s.db.d['outbox/r0'].v;
  const r1 = s.db.d['outbox/r1'].v;
  const mine = R.cap.msgs.filter(m => m.f === 'You' && /^mid\.\$sent/.test(m.m));
  ok(
    s.log.indexOf('key Enter') > s.log.indexOf('cmd selfcheck') &&
      s.log.indexOf('key Enter') < s.log.indexOf('cmd scan'),
    'S: replies first: the reply is sent after selfcheck and before the scan starts (' +
      JSON.stringify(s.log.filter(x => /cmd|key Enter|navigate/.test(x))) +
      ')',
  );
  ok(
    r1.state === 'sent' &&
      r1.sentMid === 'mid.$sent2' &&
      mine.some(m => m.m === 'mid.$sent2' && sq(m.b) === sq(MULTI) && m.r === 'Ana'),
    "S: this run's capture holds the reply it posted, under the id its confirm gave (" +
      JSON.stringify(mine.map(m => [m.m, m.r, m.b])) +
      ')',
  );
  const asIfPending = settleFind(Object.assign({}, r1, { state: 'sending' }), R.cap.msgs);
  ok(
    asIfPending && asIfPending.m === r1.sentMid,
    "S: so a row the replies-first post left in sending is settled by the same run's step 8 (" +
      JSON.stringify(asIfPending && asIfPending.m) +
      ')',
  );
  ok(
    r0.state === 'sent' &&
      r0.sentMid === 'mid.$sent1' &&
      !!r0.sentAt &&
      s.log.indexOf('batch update outbox/r0 sent') > s.log.indexOf('cmd capture'),
    "S: an earlier run's row in sending is settled from the saved messages after the capture, never before the scan (" +
      JSON.stringify(r0) +
      ')',
  );
  await s.ctx.close();
});
sim('S: replies after the scan (control)', { s: 25 }, async b => {
  // the same run with Replies first moved after the scan: the capture misses the reply, so a pending row would wait
  const s = await freshFirst(b);
  const R = await refreshRun(
    Object.assign({}, s, {
      order: parts => {
        const k = parts.findIndex(x => x.m === '**Replies first**');
        const [rf] = parts.splice(k, 1);
        /* after the capture the tab shows COPY CAPTURE: back to the chat first, as step 5 does */
        const back = Object.assign({}, rf, { fn: async () => (await s.chrome.navigate(SMETA.chatUrl), rf.fn()) });
        parts.splice(parts.findIndex(x => x.m === '3. Scan with') + 1, 0, back);
        return parts;
      },
    }),
  );
  const r1 = s.db.d['outbox/r1'].v;
  ok(
    r1.state === 'sent' && !settleFind(Object.assign({}, r1, { state: 'sending' }), R.cap.msgs),
    "S (control): posted after the scan, the reply isn't in this run's capture, so the order the S case checks matters",
  );
  await s.ctx.close();
});

/* ---------- the runner: the cases above, SIM_JOBS at a time, each case's lines printed together when it ends ---------- */
const JOBS = Math.max(1, +process.env.SIM_JOBS || Math.max(4, 3 * os.cpus().length));
function pick(only) {
  if (!only) return CASES;
  const letters = /^[A-Z]+$/.test(only);
  const words = only.split(',').filter(Boolean);
  const want = new Set(CASES.filter(c => (letters ? only.includes(c.name[0]) : words.some(w => c.name.includes(w)))));
  for (const c of [...want]) for (const n of c.after) want.add(CASES.find(x => x.name === n));
  return CASES.filter(c => want.has(c));
}
async function main() {
  const t0 = Date.now();
  /* a promise a case left behind failing later fails the run, without taking the other cases' held lines with it */
  process.on('unhandledRejection', e => {
    console.log('FAIL unhandled rejection: ' + ((e && e.stack) || e));
    process.exitCode = 1;
  });
  const cases = pick(process.env.SIM_ONLY);
  const b = await chromium.launch();
  let free = JOBS;
  const waiting = [];
  const take = () => (free > 0 ? (free--, Promise.resolve()) : new Promise(r => waiting.push(r)));
  const give = () => (waiting.length ? waiting.shift()() : free++);
  const done = {};
  /* longest first, so the slowest cases don't start last; a case with "after" queues once those have ended */
  for (const c of cases.slice().sort((x, y) => y.s - x.s))
    done[c.name] = (async () => {
      await Promise.all(c.after.map(n => done[n]));
      await take();
      const lines = [];
      const start = Date.now();
      const secs = () => ((Date.now() - start) / 1000).toFixed(1) + ' s';
      const slow = setInterval(() => console.log('... ' + c.name + ' still running (' + secs() + ')'), 120000);
      try {
        await LINES.run(lines, () => c.fn(b));
      } catch (e) {
        lines.push('FAIL ' + c.name + ' crashed: ' + ((e && e.stack) || e));
        process.exitCode = 1;
      }
      clearInterval(slow);
      give();
      console.log('--- ' + c.name + ' (' + secs() + ')\n' + lines.join('\n'));
    })();
  await Promise.all(Object.values(done));
  if (SHARED.cap1 && SHARED.cap2 && SHARED.cap3)
    fs.writeFileSync(D + 'tests/out/sim_caps.json', JSON.stringify([SHARED.cap1, SHARED.cap2, SHARED.cap3]));
  if (SHARED.first && SHARED.backfill && SHARED.multi) {
    const { first, backfill, multi } = SHARED;
    fs.writeFileSync(D + 'tests/out/sim_cap_photos.json', JSON.stringify({ first, backfill, multi }));
  }
  await b.close();
  console.log(
    'sim: ' + cases.length + ' cases in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s, ' + JOBS + ' at a time',
  );
}
main();
