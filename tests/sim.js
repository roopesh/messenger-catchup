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
