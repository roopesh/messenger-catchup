/* Page tests: assets/page.html in headless Chromium with a stand-in claude.ai runtime (in-memory db, assets, sample).
   Covers the importer (every check), the real pipeline (sim captures -> page import -> scripts/catchup.py -> render),
   catch-up markers, date entry, outbox, Ask Claude, Views and known bugs.
   Run from the repo root after tests/sim.js (it writes tests/out/sim_caps.json): node tests/page.test.js
   known() marks a docs/BACKLOG.md bug as a KNOWN line that doesn't fail the run; FIXED? means one now passes. None open right now. */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
/* PAGE_FILE: test another copy, e.g. an older page. The page is stored without the document skeleton; the Artifact tool
   adds this exact one when it publishes, so the test adds it too (older copies that already carry it are served as is). */
const SRC = fs.readFileSync(process.env.PAGE_FILE || path.join(ROOT, 'plugin/skills/refresh/assets/page.html'), 'utf8');
const SKELETON =
  '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#fff;color:#000}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style></head><body>';
const PAGE = /^<!doctype/i.test(SRC) ? SRC : SKELETON + SRC + '</body></html>';
const URL = 'http://localhost:9917/catchup';
const CATCHUP = path.join(ROOT, 'plugin/skills/refresh/scripts/catchup.py');
const CAPS = path.join(__dirname, 'out/sim_caps.json');
const ok = (c, msg) => {
  console.log((c ? 'PASS ' : 'FAIL ') + msg);
  if (!c) process.exitCode = 1;
};
const known = (c, msg) =>
  console.log(c ? 'FIXED? ' + msg + ' (passes now: update the test and docs/BACKLOG.md)' : 'KNOWN ' + msg);
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const NAMES = ['Ana', 'Ben', 'You', 'Cy', 'Dee'];
const TODAY = new Date();
const ymd = d =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
function mk(i, extra) {
  const h = 9 + Math.floor(i / 60),
    mi = i % 60;
  return Object.assign(
    {
      i,
      t: 'Fri ' + (h % 12 || 12) + ':' + String(mi).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM'),
      f: NAMES[i % 5],
      b: 'message ' + i,
      m: 'mid.' + i,
      d: ymd(TODAY),
    },
    extra || {},
  );
}
function cap(msgs, o = {}) {
  const photos = o.photos || [];
  const c = {
    kind: o.kind || 'mc-capture',
    base: o.base ?? (msgs.length ? msgs[0].i - 1 : -1),
    anchor: 'x',
    count: msgs.length,
    sha: sha(JSON.stringify(msgs)),
    msgs,
    gifs: o.gifs || [],
    photos,
    phsha: o.phsha || sha(JSON.stringify(photos)),
  };
  if (o.dry) c.dry = true;
  return c;
}
const range = (a, b, f) => Array.from({ length: b - a + 1 }, (_, k) => (f ? f(a + k) : mk(a + k)));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/* Stand-in for the claude.ai artifact runtime. Runs before the page script. */
function runtime(seed) {
  const opts = (seed && seed.__opts) || {};
  if (seed) delete seed.__opts;
  const store = new Map(),
    subs = new Map(),
    writes = [],
    uploads = [],
    samples = [],
    leases = new Map(),
    fails = [],
    vers = new Map();
  const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
  /* The real limits (runtime contract 0.2.92 and the ArtifactData tool): a document holds at most 262,144 bytes of
     JSON; a batch (Claude's writes) takes 1-50 writes, each document once, at most 1 MiB, every existing document pinned
     with the version last read, all or nothing. */
  const DOC_MAX = 262144,
    BATCH_MAX = 50,
    BODY_MAX = 1 << 20;
  const bytes = o => new TextEncoder().encode(JSON.stringify(o)).length;
  const tooBig = (p, o) => {
    if (bytes(o) > DOC_MAX)
      throw Object.assign(new Error(p + ' is ' + bytes(o) + ' bytes, over 256 KiB'), { code: 'invalid_argument' });
  };
  const bump = p => vers.set(p, (vers.get(p) || 0) + 1);
  const sub = (k, cb) => {
    if (!subs.has(k)) subs.set(k, []);
    subs.get(k).push(cb);
  };
  const docSnap = p => {
    const v = store.get(p);
    return { exists: v !== undefined, id: p.split('/').pop(), data: () => clone(v) };
  };
  const collSnap = c => ({
    docs: [...store.keys()]
      .filter(k => k.split('/')[0] === c && k.split('/').length === 2)
      .sort()
      .map(k => ({ id: k.split('/')[1], data: () => clone(store.get(k)) })),
  });
  const notify = p =>
    setTimeout(() => {
      (subs.get('d:' + p) || []).forEach(cb => cb(docSnap(p)));
      const c = p.split('/')[0];
      (subs.get('c:' + c) || []).forEach(cb => cb(collSnap(c)));
    }, 0);
  const failIf = (p, op) => {
    const k = fails.findIndex(f => f.p === p && f.op === op);
    if (k >= 0) {
      fails.splice(k, 1);
      throw Object.assign(new Error('injected failure'), { code: 'unavailable' });
    }
  };
  function doc(p) {
    const ref = {
      get: async () => docSnap(p),
      set: async o => {
        failIf(p, 'set');
        tooBig(p, o);
        store.set(p, clone(o));
        bump(p);
        writes.push({ p, op: 'set', v: clone(o) });
        notify(p);
      },
      update: async o => {
        failIf(p, 'update');
        if (!store.has(p)) throw Object.assign(new Error('missing ' + p), { code: 'invalid_argument' });
        tooBig(p, Object.assign(clone(store.get(p)), clone(o)));
        store.set(p, Object.assign(clone(store.get(p)), clone(o)));
        bump(p);
        writes.push({ p, op: 'update', v: clone(o) });
        notify(p);
      },
      acquire: async o => {
        const now = Date.now(),
          l = leases.get(p);
        if (l && l.exp > now && l.holder !== o.holder)
          return { acquired: false, expiresAt: new Date(l.exp).toISOString() };
        const exp = now + (o.ttlMs || 30000);
        leases.set(p, { holder: o.holder, exp });
        return { acquired: true, version: 1, expiresAt: new Date(exp).toISOString(), holder: o.holder };
      },
      onSnapshot: cb => {
        sub('d:' + p, cb);
        setTimeout(() => cb(docSnap(p)), 0);
        return () => {};
      },
    };
    if (opts.noAcquire) delete ref.acquire; /* an older runtime contract */
    return ref;
  }
  let auto = 0;
  const query = (c, ord, lim) => ({
    orderBy: (f, d) => query(c, { f, d: d || 'asc' }, lim),
    limit: n => query(c, ord, n),
    get: async () => {
      let docs = collSnap(c).docs;
      if (ord)
        docs = docs.slice().sort((a, b) => {
          const x = a.data()[ord.f],
            y = b.data()[ord.f];
          return (x < y ? -1 : x > y ? 1 : 0) * (ord.d === 'desc' ? -1 : 1);
        });
      if (lim) docs = docs.slice(0, lim);
      return { docs, size: docs.length, empty: !docs.length };
    },
    onSnapshot: cb => {
      sub('c:' + c, cb);
      setTimeout(() => cb(collSnap(c)), 0);
      return () => {};
    },
  });
  const collection = c =>
    Object.assign(query(c), {
      doc: id => doc(c + '/' + id),
      add: async o => {
        const id = 'a' + ++auto;
        await doc(c + '/' + id).set(o);
        return { id };
      },
    });
  const assets = {
    upload: async (blob, o) => {
      if (window.__failUploadAt === uploads.length) {
        window.__failUploadAt = null;
        throw Object.assign(new Error('injected upload failure'), { code: 'unavailable' });
      }
      const id = 'blob' + (uploads.length + 1);
      uploads.push({ id, size: blob.size, type: o.type });
      return { id, sizeBytes: blob.size, contentType: o.type };
    },
  };
  async function sample(msgs, o) {
    samples.push(msgs);
    const text = 'Ben offered one [#1]. Ana asked [#0, #2].';
    if (o && o.onText) o.onText({ text });
    return { text };
  }
  sample.json = async prompt => {
    samples.push(prompt);
    return {
      title: 'By person',
      intro: 'Grouped by who posted.',
      sections: [{ heading: 'Ben', tag: 'open', summary: 'Sells things [#1].', refs: [1] }],
    };
  };
  Object.entries(seed || {}).forEach(([p, v]) => {
    tooBig(p, v);
    store.set(p, clone(v));
    bump(p);
  });
  /* Claude's ArtifactData batch: [{op:'set'|'update'|'delete', p, v, if_version}] -> throws, writing nothing, if refused */
  function batch(ws) {
    const no = m => {
      throw Object.assign(new Error('batch refused: ' + m), { code: 'refused' });
    };
    if (ws.length < 1 || ws.length > BATCH_MAX) no(ws.length + ' writes (1-50)');
    if (new Set(ws.map(w => w.p)).size !== ws.length) no('a document twice');
    if (bytes(ws) > BODY_MAX) no(bytes(ws) + ' bytes, over 1 MiB');
    const next = ws.map(w => {
      if (store.has(w.p) && w.if_version == null) no(w.p + ' exists: needs if_version');
      if (w.if_version != null && (!store.has(w.p) || vers.get(w.p) !== w.if_version)) no(w.p + ' changed');
      if (w.op === 'delete') return null;
      const v = w.op === 'update' ? Object.assign(clone(store.get(w.p)), clone(w.v)) : clone(w.v);
      if (bytes(v) > DOC_MAX) no(w.p + ' is ' + bytes(v) + ' bytes, over 256 KiB');
      return v;
    });
    ws.forEach((w, k) => {
      if (next[k] === null) store.delete(w.p);
      else store.set(w.p, next[k]);
      bump(w.p);
      writes.push({ p: w.p, op: w.op, v: clone(w.v) });
      notify(w.p);
    });
  }
  window.__rt = {
    store,
    writes,
    uploads,
    samples,
    leases,
    fails,
    batch,
    version: p => vers.get(p),
    versions: () => Object.fromEntries(vers),
    silent: (p, v) => {
      tooBig(p, v);
      store.set(p, clone(v));
      bump(p);
    },
    write: (p, v) => doc(p).set(v),
    del: p => {
      store.delete(p);
      bump(p);
      notify(p);
    },
    get: p => clone(store.get(p)),
    all: () => Object.fromEntries([...store].map(([k, v]) => [k, clone(v)])),
  };
  window.claude = {
    use: async n => ({ db: { doc, collection }, assets: opts.noAssets ? null : assets, sample })[n] || null,
  };
}
const META = {
  kind: 'messenger-catchup',
  pageVersion: '1.1',
  thread: '4242',
  chatUrl: 'https://www.facebook.com/messages/e2ee/t/4242',
  threadName: 'Trail Crew',
  shortName: 'Trail',
  ownerName: 'Sam',
  ownerAliases: ['Sam', 'Sammy'],
  topic: 'gear',
  outboxAuto: false,
  refreshPhrase: 'refresh my catch-up',
  tz: 'America/Los_Angeles',
  helper: 'inject',
  chunkSize: 82,
  lastI: -1,
  anchorMids: [],
  markerMode: null,
};
const SEED = () => ({
  'meta/chat': Object.assign({}, META),
  'threading/current': { convs: [], links: {}, to: -1, note: '' },
  'summary/current': { version: 2, convs: [], open: [], answered: [], deals: [], mentions: [], toI: -1 },
  'photos/index': { byI: {}, gifs: [] },
  'refresh/status': { state: 'idle' },
});

let browser;
async function open(seed, page = PAGE, ctxOpts) {
  const ctx = await browser.newContext(
    Object.assign(
      {
        viewport: { width: 1000, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/Los_Angeles',
      },
      ctxOpts,
    ),
  );
  await ctx.route('https://fonts.googleapis.com/**', r => r.abort());
  await ctx.route(URL, r => r.fulfill({ body: page, contentType: 'text/html; charset=utf-8' }));
  await ctx.addInitScript(runtime, seed);
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', e => p.errors.push(e.message));
  await p.goto(URL);
  await p.waitForFunction(() => window.__rt && document.getElementById('window').textContent !== 'Loading the chat…');
  await p.waitForTimeout(200);
  return p;
}
const get = (p, k) => p.evaluate(k => __rt.get(k) ?? null, k);
const nWrites = (p, re) => p.evaluate(src => __rt.writes.filter(w => new RegExp(src).test(w.p)).length, re);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(p, fn, arg, ms = 10000) {
  const t = Date.now();
  for (;;) {
    const v = await p.evaluate(fn, arg);
    if (v) return v;
    if (Date.now() - t > ms) return null;
    await sleep(100);
  }
}
/* Paste like Claude does: a paste event on the page body (or another target). Returns the new refresh/lastImport, or null if the page ignored it. */
async function paste(p, text, sel = 'body', ms = 10000) {
  const before = JSON.stringify(await get(p, 'refresh/lastImport'));
  await p.evaluate(
    ([t, s]) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      document
        .querySelector(s)
        .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    [text, sel],
  );
  return until(
    p,
    b => {
      const v = __rt.get('refresh/lastImport');
      return v && JSON.stringify(v) !== b ? v : null;
    },
    before,
    ms,
  );
}
async function viaButton(p, text) {
  const before = JSON.stringify(await get(p, 'refresh/lastImport'));
  await p.evaluate(t => {
    document.getElementById('imp').open = true;
    document.getElementById('imp-in').value = t;
    document.getElementById('imp-go').click();
  }, text);
  return until(
    p,
    b => {
      const v = __rt.get('refresh/lastImport');
      return v && JSON.stringify(v) !== b ? v : null;
    },
    before,
  );
}

/* ---------- 1. importer ---------- */
async function importer() {
  const p = await open(SEED());
  ok(
    (await p.title()) === 'Trail Catch-up' && (await p.textContent('#h1')) === 'Trail Catch-up',
    'boot: title and heading come from meta/chat',
  );
  ok((await p.textContent('#eyebrow')).includes('Trail Crew'), 'boot: eyebrow shows the thread name');
  ok((await p.textContent('#window')).includes('No messages stored yet'), 'boot: empty store message');
  let r = await paste(p, JSON.stringify(cap(range(1, 3))));
  ok(
    r && !r.ok && /Gap|must start at #0/.test(r.msg) && !(await get(p, 'chunks/c0000')),
    'first import that does not start at #0 is refused (' + (r && r.msg) + ')',
  );
  // first import: 120 messages, crosses the 82-message chunk size, one photo, one GIF
  const first = range(0, 119, i => mk(i, i === 10 ? { p: '777', b: '' } : {}));
  r = await paste(p, JSON.stringify(cap(first, { photos: [{ i: 10, k: 0, type: 'image/png', b64: PNG }], gifs: [5] })));
  ok(r && r.ok && r.src === 'paste' && r.fresh === 120, 'first import by paste: ok, 120 new (' + (r && r.msg) + ')');
  ok(
    r && /IMPORT OK: 120 new messages, #0–#119 \(chunks c0000, c0082\)/.test(r.msg) && /1 photo stored/.test(r.msg),
    'first import: message names both chunks and the photo',
  );
  ok(
    await until(p, () => {
      const t = document.getElementById('toast');
      return t && !t.hidden && /IMPORT OK/.test(t.textContent);
    }),
    'first import: toast shown',
  );
  const c0 = await get(p, 'chunks/c0000'),
    c82 = await get(p, 'chunks/c0082');
  ok(
    c0 && c0.start === 0 && c0.msgs.length === 82 && c82 && c82.start === 82 && c82.msgs.length === 38,
    'chunks: c0000 holds 82, c0082 holds 38',
  );
  ok(
    c0.msgs[10].p === '777' && c0.msgs[10].b === '' && !('pi' in c0.msgs[0]),
    'chunks: fields kept, empty ones dropped, b kept as ""',
  );
  let m = await get(p, 'meta/chat');
  ok(
    m.lastI === 119 &&
      m.lastMid === 'mid.119' &&
      JSON.stringify(m.anchorMids) === JSON.stringify(['mid.117', 'mid.118', 'mid.119']) &&
      m.lastT === first[119].t,
    'meta/chat: lastI, lastMid, lastT, anchorMids updated',
  );
  ok(m.ownLastI === 117 && m.ownLastMid === 'mid.117', 'meta/chat: ownLastI = your newest message');
  const ph = await get(p, 'photos/index');
  const up = await p.evaluate(() => __rt.uploads);
  ok(
    ph &&
      JSON.stringify(ph.byI['10']) === '["/_blob/blob1"]' &&
      JSON.stringify(ph.gifs) === '[5]' &&
      up.length === 1 &&
      up[0].size === Buffer.from(PNG, 'base64').length &&
      up[0].type === 'image/png',
    'photos: uploaded byte-identical size, photos/index and gifs updated',
  );
  // same capture again
  let w0 = await nWrites(p, '^chunks/');
  r = await paste(p, JSON.stringify(cap(first, { photos: [{ i: 10, k: 0, type: 'image/png', b64: PNG }] })));
  ok(
    r && r.ok && /Nothing new/.test(r.msg) && (await nWrites(p, '^chunks/')) === w0,
    'same capture again: "Nothing new", no chunk writes',
  );
  // overlap + new
  r = await paste(p, JSON.stringify(cap(range(117, 130))));
  ok(
    r &&
      r.ok &&
      r.fresh === 11 &&
      (await get(p, 'chunks/c0082')).msgs.length === 49 &&
      (await get(p, 'meta/chat')).lastI === 130,
    'overlapping capture #117–#130: 11 new, appended to c0082',
  );
  // rejections: nothing written for any of them
  const bad = [
    [
      'tampered message',
      () => {
        const c = cap(range(131, 133));
        c.msgs[0].b = 'changed';
        return c;
      },
      /Checksum mismatch/,
    ],
    [
      'photo checksum',
      () => cap(range(131, 132), { photos: [{ i: 131, k: 0, type: 'image/png', b64: PNG }], phsha: '0'.repeat(64) }),
      /Photo checksum mismatch/,
    ],
    ['gap after the store', () => cap(range(132, 134)), /Gap: the capture starts at #132 but the store ends at #130/],
    ['numbers not consecutive', () => cap([mk(131), mk(133)]), /aren't consecutive at #133/],
    [
      'overlap disagrees with the store',
      () => cap(range(129, 131, i => mk(i, i === 129 ? { m: 'mid.other' } : {}))),
      /#129 doesn't match the stored message/,
    ],
    ['missing date', () => cap([Object.assign(mk(131), { d: undefined })]), /#131 is missing a field/],
    ['date in the wrong format', () => cap([mk(131, { d: '11/06/2026' })]), /#131 is missing a field/],
    [
      'photo with a bad type',
      () => cap(range(131, 131), { photos: [{ i: 131, k: 0, type: 'text/plain', b64: PNG }] }),
      /Photo for #131 is malformed/,
    ],
    [
      'photo for a message not in the capture',
      () => cap(range(131, 131), { photos: [{ i: 500, k: 0, type: 'image/png', b64: PNG }] }),
      /Photo for #500 is malformed/,
    ],
  ];
  for (const [name, mkCap, re] of bad) {
    const w = await nWrites(p, '^(chunks|meta|photos)/');
    r = await paste(p, JSON.stringify(mkCap()));
    ok(
      r && !r.ok && re.test(r.msg) && (await nWrites(p, '^(chunks|meta|photos)/')) === w,
      'refused, nothing written: ' + name + ' (' + (r && r.msg) + ')',
    );
  }
  r = await paste(p, JSON.stringify(cap(range(131, 132), { dry: true })));
  ok(
    r && r.ok && r.dry && /DRY RUN OK: 2 new messages/.test(r.msg) && (await get(p, 'meta/chat')).lastI === 130,
    'dry run: every check, nothing written',
  );
  ok((await paste(p, 'hello there', undefined, 800)) === null, 'plain text paste is ignored');
  ok(
    (await paste(p, JSON.stringify(cap(range(131, 132), { kind: 'cc-capture' })), undefined, 800)) === null,
    'old cc-capture kind is ignored on paste',
  );
  r = await viaButton(p, JSON.stringify(cap(range(131, 132), { kind: 'cc-capture' })));
  ok(r && !r.ok && /isn't a catch-up capture/.test(r.msg), 'old cc-capture kind refused by the Import button');
  r = await viaButton(p, '{not json');
  ok(r && !r.ok && /not valid JSON/.test(r.msg), 'Import button: invalid JSON refused');
  ok(
    (await paste(p, JSON.stringify(cap(range(131, 132))), '#ask-in', 800)) === null,
    'paste into a text box is not treated as an import',
  );
  r = await viaButton(p, JSON.stringify(cap(range(131, 132))));
  ok(
    r && r.ok && r.src === 'button' && r.fresh === 2 && (await p.inputValue('#imp-in')) === '',
    'Import button: valid capture imported, box cleared',
  );
  ok((await get(p, 'meta/chat')).lastI === 132, 'store ends at #132 after all of the above');
  ok(p.errors.length === 0, 'importer: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
}

/* ---------- 1b. R1: lease, fresh reads, half-finished imports ---------- */
const lastImp = p => get(p, 'refresh/lastImport');
async function robustness() {
  let p = await open(SEED());
  // meta/chat update fails after the chunk was saved and read back
  await p.evaluate(() => __rt.fails.push({ p: 'meta/chat', op: 'update' }));
  let r = await paste(p, JSON.stringify(cap(range(0, 9))));
  ok(
    r &&
      !r.ok &&
      /injected failure/.test(r.msg) &&
      (await get(p, 'chunks/c0000')).msgs.length === 10 &&
      (await get(p, 'meta/chat')).lastI === -1,
    'half-finished: chunk saved, meta/chat not updated (' + (r && r.msg) + ')',
  );
  const w0 = await nWrites(p, '^meta/chat$');
  r = await paste(p, JSON.stringify(cap(range(20, 22))));
  ok(
    r &&
      !r.ok &&
      /Gap/.test(r.msg) &&
      (await nWrites(p, '^meta/chat$')) === w0 &&
      (await get(p, 'meta/chat')).lastI === -1,
    'half-finished + a refused capture: the repair is not written either ("Nothing saved" stays true)',
  );
  r = await paste(p, JSON.stringify(cap(range(0, 9), { dry: true })));
  ok(
    r && r.ok && /^Would repair: #0–#9 \(chunk c0000\)/.test(r.msg) && (await get(p, 'meta/chat')).lastI === -1,
    'dry run reports the repair it would make, writes nothing',
  );
  r = await paste(p, JSON.stringify(cap(range(0, 9))));
  let m = await get(p, 'meta/chat');
  ok(
    r &&
      r.ok &&
      /^REPAIRED: #0–#9 \(chunk c0000\).*Nothing new/.test(r.msg) &&
      r.repaired &&
      r.repaired.to === 9 &&
      JSON.stringify(r.chunks) === '["c0000"]',
    're-paste: REPAIRED #0–#9, nothing new, names the chunk (' + (r && r.msg) + ')',
  );
  ok(
    m.lastI === 9 &&
      m.lastMid === 'mid.9' &&
      JSON.stringify(m.anchorMids) === '["mid.7","mid.8","mid.9"]' &&
      m.ownLastI === 7 &&
      m.ownLastMid === 'mid.7',
    're-paste: meta/chat counters repaired (lastI, anchorMids, ownLastI)',
  );
  r = await paste(p, JSON.stringify(cap(range(10, 12))));
  ok(
    r && r.ok && r.fresh === 3 && !r.repaired && (await get(p, 'meta/chat')).lastI === 12,
    'after the repair, the next capture imports normally',
  );
  // second chunk write fails during a rollover
  r = await paste(p, JSON.stringify(cap(range(13, 79))));
  ok(r && r.ok && (await get(p, 'meta/chat')).lastI === 79, 'filled to #79');
  await p.evaluate(() => __rt.fails.push({ p: 'chunks/c0082', op: 'set' }));
  r = await paste(p, JSON.stringify(cap(range(80, 85))));
  ok(
    r &&
      !r.ok &&
      (await get(p, 'chunks/c0000')).msgs.length === 82 &&
      !(await get(p, 'chunks/c0082')) &&
      (await get(p, 'meta/chat')).lastI === 79,
    'rollover interrupted: c0000 filled to #81, c0082 missing, lastI still #79',
  );
  r = await paste(p, JSON.stringify(cap(range(80, 85))));
  m = await get(p, 'meta/chat');
  ok(
    r &&
      r.ok &&
      /^REPAIRED: #80–#81 \(chunk c0000\).*IMPORT OK: 4 new messages, #82–#85 \(chunks c0000, c0082\)/.test(r.msg),
    're-paste: repairs #80–#81 and imports #82–#85 into a new chunk (' + (r && r.msg) + ')',
  );
  ok(
    m.lastI === 85 &&
      JSON.stringify(m.anchorMids) === '["mid.83","mid.84","mid.85"]' &&
      (await get(p, 'chunks/c0082')).msgs.length === 4,
    'rollover repaired: lastI #85, anchors, c0082 holds 4',
  );
  // counters ahead of the saved messages
  await p.evaluate(() => {
    const m = __rt.get('meta/chat');
    m.lastI = 90;
    __rt.silent('meta/chat', m);
  });
  let w = await nWrites(p, '^(chunks|meta)/');
  r = await paste(p, JSON.stringify(cap(range(86, 88))));
  ok(
    r &&
      !r.ok &&
      /lastI \(#90\) is ahead of the newest saved message \(#85\)/.test(r.msg) &&
      (await nWrites(p, '^(chunks|meta)/')) === w,
    'meta/chat ahead of the chunks: refused with what to fix, nothing written',
  );
  await p.evaluate(() => {
    const m = __rt.get('meta/chat');
    m.lastI = 85;
    __rt.silent('meta/chat', m);
  });
  // another open copy of the page holds the import lease
  await p.evaluate(() => __rt.leases.set('refresh/importLock', { holder: 'other-tab', exp: Date.now() + 60000 }));
  w = await nWrites(p, '^(chunks|meta)/');
  r = await paste(p, JSON.stringify(cap(range(86, 88))));
  ok(
    r &&
      !r.ok &&
      r.lock === 'busy' &&
      /Another import is running/.test(r.msg) &&
      (await nWrites(p, '^(chunks|meta)/')) === w,
    'lease held by another copy: refused, nothing written',
  );
  await p.evaluate(() => __rt.leases.delete('refresh/importLock'));
  r = await paste(p, JSON.stringify(cap(range(86, 88))));
  ok(r && r.ok && r.lock === 'held' && r.fresh === 3, 'lease free again: import goes through and holds the lease');
  // the page's snapshot is stale: the store moved on without telling it
  await p.evaluate(
    ([a, b]) => {
      const c = __rt.get('chunks/c0082');
      c.msgs.push(...a);
      __rt.silent('chunks/c0082', c);
      const m = __rt.get('meta/chat');
      Object.assign(m, b);
      __rt.silent('meta/chat', m);
    },
    [range(89, 91), { lastI: 91, lastMid: 'mid.91', anchorMids: ['mid.89', 'mid.90', 'mid.91'] }],
  );
  ok(
    await p.evaluate(() => !document.querySelector('#cov').textContent.includes('#91')),
    'stale snapshot set up: the page still shows the old end',
  );
  r = await paste(p, JSON.stringify(cap(range(90, 93))));
  const c82 = await get(p, 'chunks/c0082');
  ok(
    r &&
      r.ok &&
      r.fresh === 2 &&
      (await get(p, 'meta/chat')).lastI === 93 &&
      c82.msgs.map(x => x.i).join() ===
        range(82, 93)
          .map(x => x.i)
          .join(),
    'stale snapshot: fresh reads used, overlap checked against the store, #92–#93 appended with nothing lost',
  );
  ok(
    await p.evaluate(() => {
      const l = __rt.leases.get('refresh/importLock');
      return l && l.exp - Date.now() <= 1100;
    }),
    "the import lease is let go after an import (1 s left), so another tab needn't wait 2 minutes",
  );
  ok(p.errors.length === 0, 'robustness: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
  // B14: a repaired range spanning several chunks names all of them
  p = await open(SEED());
  await p.evaluate(() => __rt.fails.push({ p: 'meta/chat', op: 'update' }));
  r = await paste(p, JSON.stringify(cap(range(0, 199))));
  ok(
    r && !r.ok && (await get(p, 'chunks/c0164')) && (await get(p, 'meta/chat')).lastI === -1,
    'big first import stopped before meta/chat: c0000, c0082, c0164 saved',
  );
  r = await paste(p, JSON.stringify(cap(range(0, 199))));
  ok(
    r &&
      r.ok &&
      /^REPAIRED: #0–#199 \(chunks c0000, c0082, c0164\)/.test(r.msg) &&
      JSON.stringify(r.chunks) === '["c0000","c0082","c0164"]',
    'repair over 3 chunks names every chunk Claude must fetch (' + (r && r.msg.slice(0, 60)) + ')',
  );
  // B17: GIFs recorded without photos; a failed upload keeps what landed, and a re-paste finishes without duplicates
  r = await paste(p, JSON.stringify(cap(range(200, 202), { gifs: [201] })));
  ok(
    r && r.ok && JSON.stringify((await get(p, 'photos/index')).gifs) === '[201]',
    'a capture with GIFs and no photos records the GIFs',
  );
  const P3 = [203, 204, 205].map(i => ({ i, k: 0, type: 'image/png', b64: PNG }));
  await p.evaluate(() => {
    window.__failUploadAt = __rt.uploads.length + 1;
  });
  r = await paste(p, JSON.stringify(cap(range(203, 205), { photos: P3 })));
  let ix = (await get(p, 'photos/index')).byI;
  ok(
    r &&
      r.fresh === 3 &&
      /1 photo stored\. Photos: upload failed at #204 .*paste again/.test(r.msg) &&
      ix['203'] &&
      !ix['204'],
    'upload fails at the 2nd photo: messages saved, the 1st photo indexed, told to paste again (' +
      (r && r.msg.slice(-90)) +
      ')',
  );
  const n0 = await p.evaluate(() => __rt.uploads.length);
  r = await paste(p, JSON.stringify(cap(range(203, 205), { photos: P3 })));
  ix = (await get(p, 'photos/index')).byI;
  ok(
    r &&
      r.ok &&
      /2 photos stored \(1 already stored\)/.test(r.msg) &&
      ix['204'] &&
      ix['205'] &&
      (await p.evaluate(() => __rt.uploads.length)) - n0 === 2,
    'paste again: only the 2 missing photos upload, all 3 indexed',
  );
  // B28: a capture that skips a photo slot, then a failed upload and a re-paste: no duplicate
  const PK = [
    { i: 206, k: 1, type: 'image/png', b64: PNG },
    { i: 206, k: 2, type: 'image/png', b64: PNG },
    { i: 207, k: 0, type: 'image/png', b64: PNG },
  ];
  await p.evaluate(() => {
    window.__failUploadAt = __rt.uploads.length + 2;
  });
  r = await paste(p, JSON.stringify(cap(range(206, 207), { photos: PK })));
  let n1 = await p.evaluate(() => __rt.uploads.length);
  r = await paste(p, JSON.stringify(cap(range(206, 207), { photos: PK })));
  ix = await get(p, 'photos/index');
  ok(
    r &&
      r.ok &&
      (await p.evaluate(() => __rt.uploads.length)) - n1 === 1 &&
      ix.byI['206'].length === 2 &&
      ix.byI['207'].length === 1 &&
      ix.byK['206']['1'] &&
      ix.byK['206']['2'],
    'B28: slot 0 missing, upload fails, paste again: only #207 uploads, #206 keeps 2 photos (no duplicate)',
  );
  // B25 groundwork: unconfirmed and sending replies stay listed until resolved
  await p.evaluate(() => {
    const old = new Date(Date.now() - 3 * 864e5).toISOString();
    __rt.write('outbox/u1', {
      i: 205,
      mid: 'mid.205',
      to: 'Ana',
      snip: 'message 205',
      text: 'see you there',
      state: 'unconfirmed',
      queuedAt: old,
      error: 'Sent? Not found in the chat afterwards.',
    });
    __rt.write('outbox/s1', {
      i: 204,
      mid: 'mid.204',
      to: 'Dee',
      snip: 'message 204',
      text: 'ok',
      state: 'sending',
      queuedAt: old,
    });
  });
  ok(
    await until(p, () => {
      const t = document.getElementById('v-summary').textContent;
      return /not confirmed/.test(t) && /Sent\? Not found/.test(t) && /sending…/.test(t);
    }),
    'outbox: 3-day-old unconfirmed and sending replies are still shown, with the note',
  );
  // B36: failed/unconfirmed replies can be dismissed; the header says they need a look
  ok(
    await until(p, () => /2 need a look/.test(document.getElementById('v-summary').textContent)),
    'outbox header: "2 need a look" for the unconfirmed and sending rows',
  );
  await p.evaluate(() => {
    const b = [...document.querySelectorAll('#v-summary .item.ob button')].find(x => x.textContent === 'Dismiss');
    b.click();
  });
  ok(
    await until(
      p,
      () =>
        __rt.get('outbox/u1').state === 'dismissed' &&
        !/not confirmed/.test(document.getElementById('v-summary').textContent),
    ),
    'Dismiss sets state dismissed and the row leaves the list',
  );
  ok(p.errors.length === 0, 'photos/repair: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
  // B37: a view that can't upload says so, without "paste again"
  p = await open(Object.assign(SEED(), { __opts: { noAssets: true } }));
  r = await paste(p, JSON.stringify(cap(range(0, 1), { photos: [{ i: 1, k: 0, type: 'image/png', b64: PNG }] })));
  ok(
    r && r.ok && r.fresh === 2 && /Photos not stored: this view can't upload/.test(r.msg) && !/paste again/.test(r.msg),
    'no upload capability: messages saved, photos not, and no endless "paste again" (' + (r && r.msg.slice(-80)) + ')',
  );
  await p.context().close();
  // a runtime without acquire() still imports (older contract)
  p = await open(Object.assign(SEED(), { __opts: { noAcquire: true } }));
  r = await paste(p, JSON.stringify(cap(range(0, 2))));
  ok(
    r && r.ok && r.lock === 'unsupported',
    'runtime without acquire(): imports without a lease (' + (r && r.lock) + ')',
  );
  await p.context().close();
}

/* ---------- 2. real pipeline: sim captures -> page import -> catchup.py -> render ---------- */
/* What Claude's ArtifactData reads put in an out_dir: chunks, meta/chat and the whole threading and summary collections */
function exportDb(all, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(all)) {
    if (/^(chunks\/|meta\/chat$|threading\/|summary\/)/.test(k)) {
      fs.mkdirSync(path.join(dir, path.dirname(k)), { recursive: true });
      fs.writeFileSync(path.join(dir, k + '.json'), JSON.stringify(v));
    }
  }
  fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true });
}
/* catchup.py with a small block size, so a short test history spans several block documents */
const PYDRV =
  'import importlib.util,sys\n' +
  's=importlib.util.spec_from_file_location("catchup",sys.argv[1]);c=importlib.util.module_from_spec(s)\n' +
  's.loader.exec_module(c);c.BLOCK=int(sys.argv[2]);getattr(c,sys.argv[3])(*sys.argv[4:])';
const PIPE_BLOCK = 20;
const py = (...a) => execFileSync('python3', ['-c', PYDRV, CATCHUP, String(PIPE_BLOCK), ...a], { encoding: 'utf8' });
/* Step 7 as SKILL.md has Claude do it: the manifest's batches in order (pins from step 5's read, meta/chat and
   refresh/status added to the last), then the cleanup. The runtime refuses what ArtifactData would. */
async function writeManifest(p, out, seen) {
  const man = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  for (const [k, bt] of man.batches.entries()) {
    const ws = bt.map(e => {
      const w = { op: e.op, p: e.collection + '/' + e.doc_id, v: JSON.parse(fs.readFileSync(e.file_path, 'utf8')) };
      if (e.pin) w.if_version = seen[w.p];
      return w;
    });
    if (k === man.batches.length - 1)
      ws.push(
        { op: 'update', p: 'meta/chat', v: { lastRefresh: 'Wed Nov 11, 9:00 PM' }, if_version: seen['meta/chat'] },
        { op: 'update', p: 'refresh/status', v: { state: 'done' }, if_version: seen['refresh/status'] },
      );
    await p.evaluate(ws => __rt.batch(ws), ws);
  }
  for (const g of man.cleanup) {
    const ws = g
      .map(e => ({ op: 'delete', p: e.collection + '/' + e.doc_id }))
      .filter(w => seen[w.p] != null)
      .map(w => Object.assign(w, { if_version: seen[w.p] }));
    if (ws.length) await p.evaluate(ws => __rt.batch(ws), ws);
  }
  return man;
}
const sortKeys = o =>
  Array.isArray(o)
    ? o.map(sortKeys)
    : o && typeof o === 'object'
      ? Object.fromEntries(
          Object.keys(o)
            .sort()
            .map(k => [k, sortKeys(o[k])]),
        )
      : o;
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function specFor(n, msgs, convOf) {
  const conv = m => {
    if (m.pi != null && convOf[m.pi]) return convOf[m.pi];
    return Math.floor(m.i / 10) % 2 ? 'packs1' : 'trail1';
  };
  const join = {};
  msgs.forEach(m => {
    const c = conv(m);
    convOf[m.i] = c;
    (join[c] = join[c] || []).push(m.i);
  });
  const s = { join, bullets: {} };
  Object.entries(join).forEach(([c, ids]) => {
    s.bullets[c] = [[ids.length + ' new messages in this conversation', [ids[0]]]];
  });
  if (n === 1) {
    s.newconvs = [
      { id: 'trail1', title: 'Trail shoes', tag: 'For sale', outcome: 'Still deciding', key: [] },
      { id: 'packs1', title: 'Packs' },
    ];
    s.deals = [
      { kind: 'sale', tag: 'For sale', conv: 'trail1', text: 'Trail shoes, size 10, $60', refs: [join.trail1[0]] },
    ];
    s.open = [{ conv: 'packs1', ask: join.packs1[join.packs1.length - 1], to: 'anyone', note: 'Nobody answered yet' }];
  }
  if (n === 2) {
    const o = (s._closed = Object.keys(convOf)
      .map(Number)
      .filter(i => convOf[i] === 'packs1' && i < msgs[0].i)
      .pop());
    s.closeOpen = [o];
    s.answered = [{ conv: 'packs1', ask: o, answer: 'Answered later', refs: [] }];
    delete s._closed;
  }
  const you = msgs.filter(m => /^you$/i.test(m.r || ''));
  if (you.length) s.mentions = [{ note: 'Replied to you', refs: you.map(m => [m.i]) }];
  return s;
}
async function pipeline() {
  if (!fs.existsSync(CAPS)) {
    ok(false, 'pipeline: ' + path.relative(ROOT, CAPS) + ' missing: run tests/sim.js first (npm test does)');
    return;
  }
  const caps = JSON.parse(fs.readFileSync(CAPS, 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-pipe-'));
  const work = path.join(tmp, 'work');
  const p = await open(SEED());
  exportDb(await p.evaluate(() => __rt.all()), path.join(tmp, 'seed'));
  ok(
    /bootstrap ok: 0 messages/.test(py('bootstrap', work, path.join(tmp, 'seed'))),
    'pipeline: bootstrap from the seeded page',
  );
  const convOf = {};
  let n = 0;
  let lastRun;
  for (const c of caps) {
    n++;
    const r = await paste(p, JSON.stringify(c));
    ok(r && r.ok && r.fresh === c.count, 'pipeline import ' + n + ': ' + (r && r.msg));
    const run = path.join(tmp, 'run' + n);
    exportDb(await p.evaluate(() => __rt.all()), run);
    const seen = await p.evaluate(() => __rt.versions());
    const spec = path.join(tmp, 'spec' + n + '.json');
    fs.writeFileSync(spec, JSON.stringify(specFor(n, c.msgs, convOf)));
    let out;
    try {
      out = py('build', work, run, spec);
    } catch (e) {
      out = String(e.stdout || '') + String(e.stderr || e);
    }
    ok(
      /build ok: #\d+-#\d+/.test(out),
      'pipeline build ' + n + ': ' + (out.match(/build ok[^\n]*/) || [out.trim().split('\n').pop()])[0],
    );
    let man = null;
    try {
      man = await writeManifest(p, path.join(run, 'out'), seen);
    } catch (e) {
      ok(false, 'pipeline write ' + n + ': ' + e.message);
    }
    if (man) ok(true, 'pipeline write ' + n + ': ' + man.batches.flat().length + ' documents, as the manifest lists');
    lastRun = run;
  }
  await p.waitForTimeout(400);
  const total = caps.reduce((a, c) => a + c.count, 0);
  const th = await p.evaluate(() => S.threading);
  const sm = await p.evaluate(() => S.summary);
  const stored = await p.evaluate(() => __rt.all());
  ok(
    stored['threading/current'].layout === 2 &&
      stored['threading/current'].blocks.length === 3 &&
      stored['threading/current'].blocks.every(b => stored['threading/' + b]) &&
      Object.keys(stored).filter(k => /^(threading|summary)\/b/.test(k)).length ===
        stored['threading/current'].blocks.length + stored['summary/current'].blocks.length,
    'pipeline: the block layout is stored (3 threading blocks of ' + PIPE_BLOCK + ' messages), no unused blocks left',
  );
  ok(
    same(th, JSON.parse(fs.readFileSync(path.join(lastRun, 'out/merged/threading.json'), 'utf8'))) &&
      same(sm, JSON.parse(fs.readFileSync(path.join(lastRun, 'out/merged/summary.json'), 'utf8'))),
    "pipeline: the page's merge of the stored documents equals catchup.py's built state",
  );
  ok(total === 57 && (await get(p, 'meta/chat')).lastI === 56, 'pipeline: 3 imports, 57 messages stored (#0–#56)');
  ok(
    th.links['33'] && th.links['33'][0] === 30 && th.links['33'][1] === 'r',
    'pipeline: photo reply #33 linked to #30 from the clicked Messenger link',
  );
  ok(
    [77, 84, 91, 98, 105, 112, 119].map(x => x - 70).every(i => th.links[i] && th.links[i][1] === 'rq'),
    'pipeline: 7 quote-matched text replies kept as rq',
  );
  // names: helper 1.6 reads each sender's full name from their avatar; the page keeps people/index and names people
  // by the owner's rule (first name; full name when two share it; "nickname (name)")
  const pi = (await get(p, 'people/index')) || { people: {} };
  const P = pi.people;
  ok(
    P['Ben Brooks'] &&
      P['Ben Ortiz'] &&
      P['Cy Chen'] &&
      P['Cy Chen'].shown.includes('Captain Cy') &&
      P['Cy Chen'].shown.includes('Cy') &&
      !Object.values(P).some(x => x.shown.includes('You')),
    'names: people/index maps full names to the names shown, a nickname included (' + Object.keys(P).join(', ') + ')',
  );
  const who = await p.evaluate(() =>
    [0, 1, 2, 31, 38].map(i => (document.querySelector('#m' + i + ' .who') || {}).textContent),
  );
  ok(
    JSON.stringify(who) === JSON.stringify(['Ana', 'Ben Brooks', 'You', 'Ben Ortiz', 'Captain Cy (Cy)']),
    'names: first name; full name for the two Bens; "Captain Cy (Cy)" for a nickname (' + who.join(' | ') + ')',
  );
  // summary tab
  const strip = await p.$$eval('#strip .stat', s => s.map(x => x.textContent));
  ok(strip[0] === '57new messages', 'header: 57 new messages (' + strip[0] + ')');
  const cards = await p.$$eval('#v-summary article.cv', a => a.map(x => x.dataset.conv));
  ok(
    cards.length === 2 && cards.includes('trail1') && cards.includes('packs1'),
    'summary: one card per conversation (' + cards + ')',
  );
  const chips = await p.$$eval('#v-summary .seg.filt button', b => b.map(x => x.textContent));
  ok(
    chips.join('|') === 'All (2)|Open questions (0)|Deals & sales (1)|Answered (1)',
    'summary: filter counts (' + chips.join('|') + ')',
  );
  ok(
    await p.$eval(
      '#v-summary',
      v => /Trail shoes, size 10, \$60/.test(v.textContent) && /Answered later/.test(v.textContent),
    ),
    'summary: deal and answered call-outs rendered in their cards',
  );
  const needs = await p.$$eval('#v-summary .item.mention .snip', s => s.length);
  ok(
    needs === (sm.mentions[0] || { refs: [] }).refs.length && needs > 0,
    'summary: "Needs you" lists every reply to you (' + needs + ')',
  );
  ok(
    (await p.$$eval('#v-summary article.cv[data-conv="trail1"] button.bul', b => b.length)) === 0,
    "summary: a bullet citing the deal's message is hidden (the deal call-out covers it)",
  );
  ok(
    (await p.$$eval('#v-summary article.cv[data-conv="packs1"] button.bul', b => b.length)) === 3,
    'summary: packs1 shows its 3 bullets, one per build',
  );
  await p.click('#v-summary article.cv[data-conv="packs1"] button.bul');
  ok(
    await until(p, () => {
      const d = document.querySelector('article.cv[data-conv="packs1"] details.thr');
      return d && d.open && d.querySelector('.msg.flash');
    }),
    'summary: a bullet opens its thread and highlights its messages',
  );
  await p.click('#v-summary .seg.filt button:nth-child(3)');
  ok(
    (await p.$$eval('#v-summary article.cv', a => a.map(x => x.dataset.conv))).join() === 'trail1',
    'summary: Deals filter shows only the card with the deal',
  );
  await p.click('#v-summary .seg.filt button:nth-child(1)');
  // messages tab, threaded
  await p.evaluate(() => {
    location.hash = '#messages';
  });
  await p.waitForTimeout(150);
  ok(
    (await p.$$eval('#msgs details.conv', d => d.length)) === 2 && (await p.$('#msgs .legend')),
    'messages: threaded view with 2 conversations and a legend',
  );
  ok(
    await p.$eval('#m33', r => !!r.closest('.kids') && /reply to #30/.test(r.textContent)),
    'messages: #33 nested under its parent with "reply to #30"',
  );
  ok(
    (await p.$eval('#m30 .pics img', i => i.getAttribute('src'))) === '/_blob/blob1',
    'messages: photo #30 shown from its uploaded blob',
  );
  const href = await p.$eval('#m40 a.replylink', a => a.href);
  ok(
    href.startsWith(META.chatUrl + '#mcjump=') && href.includes(encodeURIComponent('mid.$mock110')),
    'messages: Reply in Messenger uses the stored e2ee chatUrl + #mcjump=<mid>',
  );
  await p.click('#lay-flat');
  ok((await p.$$eval('#msgs .msg', r => r.length)) === 57, 'messages: timeline shows all 57');
  await p.fill('#msg-q', 'Message number 75 ');
  await p.waitForTimeout(300);
  ok((await p.$$eval('#msgs .msg', r => r.length)) === 1, 'messages: filter by text finds exactly one');
  await p.fill('#msg-q', '');
  await p.waitForTimeout(250);
  // markers
  await p.evaluate(() => {
    location.hash = '#summary';
  });
  await p.click('#caught');
  ok(
    await until(p, () => {
      const m = __rt.get('meta/chat');
      return m.markerMode === 'caught' && m.caughtUpI === 56;
    }),
    'marker: Mark caught up saves caughtUpI = newest, mode caught',
  );
  ok(
    await until(
      p,
      () =>
        document.querySelector('#strip .stat .n').textContent === '0' &&
        /You're caught up through #56/.test(document.getElementById('v-summary').textContent),
    ),
    'marker: window empty, "You\'re caught up"',
  );
  const ownI = (await get(p, 'meta/chat')).ownLastI;
  await p.click('#marker input[value="own"]');
  ok(
    await until(
      p,
      o =>
        __rt.get('meta/chat').markerMode === 'own' &&
        document.querySelector('#strip .stat .n').textContent === String(56 - o),
      ownI,
    ),
    'marker: "since your last message" shows the ' + (56 - ownI) + ' after #' + ownI,
  );
  // date entry regression (EXPERIMENTS.md §6): no save and no rebuild while typing; one save after the pause
  const from = '#marker input[aria-label="From"]';
  await p.waitForTimeout(300);
  const before = await nWrites(p, '^meta/chat$');
  await p.click(from);
  await p.waitForTimeout(300);
  const handle = await p.evaluateHandle(() => document.activeElement);
  ok(await handle.evaluate((e, s) => e.matches(s), from), 'date entry: the From box has focus');
  await p.keyboard.press('ArrowLeft');
  await p.keyboard.press('ArrowLeft');
  await p.keyboard.press('ArrowLeft');
  await p.keyboard.press('ArrowLeft');
  await p.keyboard.press('ArrowLeft');
  const want = ymd(TODAY) + 'T09:15';
  const [Y, M, D] = ymd(TODAY).split('-');
  await p.keyboard.type(M + D + Y + '0915A', { delay: 60 });
  ok(
    await handle.evaluate(e => e.isConnected && document.activeElement === e),
    'date entry: the box was not rebuilt while typing',
  );
  ok((await nWrites(p, '^meta/chat$')) === before, 'date entry: nothing saved while typing');
  ok((await handle.inputValue()) === want, 'date entry: box holds ' + want + ' (' + (await handle.inputValue()) + ')');
  await p.waitForTimeout(1900);
  const ws = await p.evaluate(() => __rt.writes.filter(w => w.p === 'meta/chat' && 'markerFrom' in w.v));
  ok(
    ws.length === 1 && ws[0].v.markerFrom === want && ws[0].v.markerMode === 'time',
    'date entry: exactly one save after the pause, with the typed value',
  );
  await p.keyboard.press('Tab');
  await p.waitForTimeout(300);
  ok(/Catch-up window: /.test(await p.textContent('#window')), 'date entry: header shows the date window');
  // outbox
  await p.click('#marker input[value="own"]');
  await p.evaluate(() => {
    location.hash = '#messages';
  });
  await p.click('#lay-flat');
  await p.waitForTimeout(200);
  const ri = 56;
  await p.hover('#m' + ri + ' .who'); /* a message's actions show on hover (v1.19) */
  await p.click('#m' + ri + ' button.rh');
  await p.fill('#m' + ri + ' .compose textarea', 'on my way');
  await p.click('#m' + ri + ' .compose button.primary');
  const ob = await until(p, () => {
    const k = [...__rt.store.keys()].find(k => k.startsWith('outbox/'));
    return k ? Object.assign({ id: k }, __rt.get(k)) : null;
  });
  ok(
    ob &&
      ob.i === ri &&
      ob.mid === 'mid.$mock126' &&
      ob.text === 'on my way' &&
      ob.state === 'queued' &&
      ob.to === 'Ben' &&
      ob.queuedAt,
    'outbox: Reply here queues {i, mid, to, text, state:queued}',
  );
  ok(
    await until(
      p,
      i =>
        /reply queued/.test(document.querySelector('#m' + i).textContent) &&
        !document.querySelector('#m' + i + ' .compose'),
      ri,
    ),
    'outbox: the row shows a "reply queued" chip once saved',
  );
  await p.evaluate(() => {
    location.hash = '#summary';
  });
  ok(
    await until(
      p,
      () =>
        /Your replies/.test(document.getElementById('v-summary').textContent) &&
        /1 queued/.test(document.getElementById('v-summary').textContent),
    ),
    'outbox: "Your replies · 1 queued" on Summary',
  );
  await p.click('#v-summary .item.ob button.link');
  ok(await until(p, id => __rt.get(id).state === 'cancelled', ob.id), 'outbox: Cancel this reply sets state cancelled');
  // ask + views (stub sample)
  await p.evaluate(() => {
    location.hash = '#ask';
  });
  await p.fill('#ask-in', 'What was for sale?');
  await p.click('#ask-go');
  ok(
    await until(p, () => document.querySelectorAll('#chat .turn.assistant a.cite').length === 3),
    'ask: answer rendered with [#n] citations as links',
  );
  const prompt = await p.evaluate(() => __rt.samples[0][0].content);
  ok(
    /MESSAGES:\n#\d+ \[/.test(prompt) && prompt.includes('Sam'),
    'ask: prompt carries the owner name and the window messages',
  );
  ok(
    await until(p, () => [...__rt.store.keys()].some(k => k.startsWith('qa/'))),
    'ask: question and answer saved to qa',
  );
  await p.click('#chat a.cite');
  ok(
    await until(p, () => location.hash === '#messages' && document.querySelector('.msg.flash')),
    'ask: a citation jumps to the message',
  );
  await p.evaluate(() => {
    location.hash = '#views';
  });
  await p.fill('#view-in', 'group by person');
  await p.click('#view-go');
  ok(
    await until(
      p,
      () =>
        /By person/.test(document.getElementById('view-out').textContent) &&
        [...__rt.store.keys()].some(k => k.startsWith('views/')),
    ),
    'views: built view rendered and saved',
  );
  ok(p.errors.length === 0, 'pipeline: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ---------- 3. config variants and known bugs ---------- */
async function variants() {
  let p = await open(Object.assign(SEED(), { 'meta/chat': Object.assign({}, META, { outboxAuto: true }) }));
  ok(
    /posts it in Messenger/.test(await p.textContent('[data-outbox-mode]')),
    'outboxAuto on: Refreshing text says Claude posts replies on its next run',
  );
  await paste(p, JSON.stringify(cap(range(0, 4))));
  await p.evaluate(() => {
    location.hash = '#messages';
  });
  await p.waitForTimeout(200);
  await p.hover('#m4 .who');
  await p.click('#m4 button.rh');
  await p.fill('#m4 .compose textarea', 'hi');
  await p.evaluate(() => {
    window.__seen = [];
    new MutationObserver(ms =>
      ms.forEach(m => {
        const t = m.target.textContent || '';
        if (/^Queued\./.test(t)) __seen.push(t);
      }),
    ).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await p.click('#m4 .compose button.primary');
  const seen = await until(p, () => __seen[0]);
  ok(!!seen, 'outbox: "Queued…" confirmation shown (briefly, before the row re-renders)');
  ok(
    seen && !/and confirm/.test(seen) && /Claude posts it on its next run/.test(seen),
    'B9: with auto-posting on, "Queued" says Claude posts it (' + seen + ')',
  );
  await p.context().close();
  // B8: malformed and non-web links in a message
  p = await open(SEED());
  await paste(
    p,
    JSON.stringify(
      cap(
        range(0, 4, i =>
          mk(i, i === 2 ? { l: ['not a url', 'javascript:alert(1)', 'https://example.com/pack?id=1'] } : {}),
        ),
      ),
    ),
  );
  await p.evaluate(() => {
    location.hash = '#messages';
  });
  await p.waitForTimeout(300);
  ok(
    (await p.$$eval('#msgs .msg', r => r.length)) === 5 && p.errors.length === 0,
    'B8: a malformed link no longer breaks the Messages render (' + p.errors.length + ' page errors)',
  );
  const ls = await p.$$eval('#m2 .sub a:not(.replylink)', as =>
    as.filter(a => !/Open photo/.test(a.textContent)).map(a => [a.textContent, a.getAttribute('href')]),
  );
  ok(
    JSON.stringify(ls) ===
      JSON.stringify([
        ['not a url', null],
        ['javascript:alert(1)', null],
        ['example.com', 'https://example.com/pack?id=1'],
      ]),
    'links: only http(s) URLs are clickable; others show as text (' + JSON.stringify(ls) + ')',
  );
  await p.context().close();
  // B7: a mention of message #0
  p = await open(SEED());
  await paste(p, JSON.stringify(cap(range(0, 4))));
  await p.evaluate(() => {
    __rt.write('threading/current', {
      convs: [{ id: 'a', title: 'A', members: [0, 1, 2, 3, 4] }],
      links: {},
      to: 4,
      note: '',
    });
    __rt.write('summary/current', {
      version: 2,
      convs: [{ id: 'a', tag: '', synopsis: [], outcome: '', key: [] }],
      open: [],
      answered: [],
      deals: [],
      mentions: [{ note: 'Ana named you', refs: [[0]] }],
      toI: 4,
      generatedAt: 'now',
    });
  });
  await p.waitForTimeout(300);
  ok(
    /message 0/.test(await p.$eval('#v-summary .item.mention', e => e.textContent).catch(() => '')),
    'B7: a mention of #0 renders with its text',
  );
  ok(p.errors.length === 0, 'variants: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
}

/* ---------- 4. range summaries and the status line ----------
   Pages carried over from the original chat have a summary with fromI (catchup.py keeps it), so rewinding before it
   by date asks Claude, via this page, for a summary of just that span and saves it in rangeSummaries/r<lo>_<hi>. */
async function ranges() {
  const TH = {
    convs: [{ id: 'a', title: 'Packs', members: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }],
    links: {},
    to: 9,
    note: '',
  };
  const SM = {
    version: 2,
    convs: [{ id: 'a', tag: '', synopsis: [{ t: 'Later part', refs: [5] }], outcome: '', key: [5] }],
    open: [],
    answered: [],
    deals: [],
    mentions: [],
    fromI: 5,
    toI: 9,
    generatedAt: 'now',
  };
  let p = await open(SEED());
  await paste(p, JSON.stringify(cap(range(0, 9))));
  await p.evaluate(
    ([t, s]) => {
      __rt.write('threading/current', t);
      __rt.write('summary/current', s);
    },
    [TH, SM],
  );
  await p.waitForTimeout(200);
  ok(
    !(await p.$('#v-summary .rangebox')) && /Later part/.test(await p.textContent('#v-summary')),
    'range: in caught mode the saved summary shows, no range box',
  );
  ok(
    /ask Claude in chat to “refresh my catch-up”/.test(await p.textContent('#refresh-st')),
    'status line: tells you to ask Claude in chat to refresh',
  );
  ok(!(await p.$('#refresh-btn')), 'C1: no Refresh button in the page (removed; refreshes are asked for in chat)');
  await p.evaluate(d => {
    const m = __rt.get('meta/chat');
    __rt.write('meta/chat', Object.assign(m, { markerMode: 'time', markerFrom: d + 'T00:00', markerTo: null }));
  }, ymd(TODAY));
  const box = await until(p, () => {
    const b = document.querySelector('#v-summary .rangebox');
    return b && b.textContent;
  });
  ok(
    box && /All 10 messages in this span/.test(box) && /only covers #5 onward/.test(box),
    'range: a date window before fromI offers a summary for that span (' + (box || '').slice(0, 60) + '…)',
  );
  await p.click('#v-summary .rangebox button.primary');
  const rs = await until(p, () => __rt.get('rangeSummaries/r0_9'));
  ok(
    rs && rs.by === 'page' && rs.fromI === 0 && rs.toI === 9 && rs.version === 2,
    'range: the button saves rangeSummaries/r0_9 (by page, #0–#9)',
  );
  ok(
    await p.evaluate(() => /MESSAGES:\n#0 \[/.test(__rt.samples[__rt.samples.length - 1])),
    "range: the prompt carries the span's messages",
  );
  ok(
    await until(p, () => !document.querySelector('#v-summary .rangebox')),
    "range: once written, the span's summary replaces the box",
  );
  ok(p.errors.length === 0, 'range: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
  // a span summarized before: shown straight away
  p = await open(
    Object.assign(SEED(), {
      'meta/chat': Object.assign({}, META, { markerMode: 'time', markerFrom: ymd(TODAY) + 'T00:00' }),
      'threading/current': TH,
      'summary/current': SM,
      'rangeSummaries/r0_9': {
        version: 2,
        by: 'page',
        fromI: 0,
        toI: 9,
        convs: [{ id: 'a', tag: '', synopsis: [{ t: 'Whole span', refs: [0] }], outcome: '', key: [0] }],
        open: [],
        answered: [],
        deals: [],
        mentions: [],
        generatedAt: 'then',
      },
    }),
  );
  await paste(p, JSON.stringify(cap(range(0, 9))));
  ok(
    await until(
      p,
      () =>
        /Whole span/.test(document.getElementById('v-summary').textContent) &&
        !document.querySelector('#v-summary .rangebox'),
    ),
    'range: a saved span summary renders without asking again',
  );
  await p.context().close();
}

/* ---------- 4b. the block layout (v1.17, BACKLOG B43) ----------
   One synthetic history (tests/synth.py, mock cast) stored both ways: the old single documents and the block layout
   catchup.py writes (blocks of 10 messages here, so it has archived conversations and many blocks). */
const SYNTH = path.join(__dirname, 'synth.py');
/* Every message row as [number, text, photos]: a page that lays rows out differently (v1.19 groups a person's bubbles
   into one block and adds context lines) still shows the same messages. */
const rowsOf = (p, sel) =>
  p.$$eval(sel + ' .msg', rs =>
    rs.map(r => [
      (r.querySelector('.n') || {}).textContent,
      (r.querySelector('.body') || {}).textContent || '',
      r.querySelectorAll('.pics img').length,
    ]),
  );
async function texts(p) {
  const t = {};
  const sig = {};
  await p.evaluate(() => {
    location.hash = '#summary';
  });
  await p.waitForTimeout(150);
  t.strip = await p.textContent('#strip');
  const openAll = sel => p.$$eval(sel + ' details', ds => ds.forEach(d => (d.open = true))); /* threads build on open */
  await openAll('#v-summary');
  await p.waitForTimeout(300);
  t.summary = await p.$eval('#v-summary', e => e.innerText);
  sig.summaryCards = await p.$eval('#v-summary', e => {
    const hid = [...e.querySelectorAll('.msgs, .ctx')];
    hid.forEach(x => (x.style.display = 'none'));
    const s = e.innerText;
    hid.forEach(x => (x.style.display = ''));
    return s;
  });
  sig.summaryRows = await rowsOf(p, '#v-summary');
  await p.evaluate(() => {
    location.hash = '#messages';
  });
  await p.waitForTimeout(150);
  await openAll('#msgs');
  await p.waitForTimeout(100);
  t.thread = await p.$eval('#msgs', e => e.innerText);
  sig.threadRows = await rowsOf(p, '#msgs');
  await p.click('#lay-flat');
  await p.waitForTimeout(100);
  t.flat = await p.$eval('#msgs', e => e.innerText);
  sig.flatRows = await rowsOf(p, '#msgs');
  await p.click('#lay-thread');
  await p.waitForTimeout(100);
  sig.strip = t.strip;
  Object.defineProperty(t, 'sig', { value: sig }); /* not enumerable: same(t, t') still compares the full texts */
  return t;
}
async function layouts() {
  const S0 = JSON.parse(
    execFileSync('python3', [SYNTH, 'page', '120', '10'], { encoding: 'utf8', maxBuffer: 1 << 26 }),
  );
  const msgs = Object.values(S0.chunks).flatMap(c => c.msgs);
  const meta = Object.assign({}, META, {
    lastI: S0.last,
    lastMid: msgs[msgs.length - 1].m,
    anchorMids: msgs.slice(-3).map(m => m.m),
    markerMode: 'time',
    markerFrom: msgs[0].d + 'T00:00',
    lastRefresh: 'Wed Nov 11, 9:00 PM',
  });
  const base = Object.assign(SEED(), { 'meta/chat': meta });
  Object.entries(S0.chunks).forEach(([k, v]) => (base['chunks/' + k] = v));
  delete base['threading/current'];
  delete base['summary/current'];
  const oldSeed = Object.assign({}, base, S0.old);
  const newSeed = Object.assign({}, base, S0.new);
  const nBlocks = Object.keys(S0.new).filter(k => /\/b/.test(k)).length;
  const sumBlocks = Object.keys(S0.new).filter(k => /^summary\/b/.test(k));
  ok(
    nBlocks > 15 && sumBlocks.length > 3 && S0.new['summary/current'].activeFrom === 100,
    'layout: the synthetic history spans ' +
      nBlocks +
      ' block documents, ' +
      sumBlocks.length +
      ' of them summary archives',
  );
  // the old layout renders exactly as the last release's page renders it
  const pOld = await open(oldSeed);
  const tOld = await texts(pOld);
  ok(
    /\S/.test(tOld.summary) && tOld.summary.includes('Newest activity first') && tOld.thread.length > 1000,
    'layout: the old single documents render (summary cards and threads)',
  );
  let tag = null;
  try {
    tag = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], { cwd: ROOT, encoding: 'utf8' }).split(
      '\n',
    )[0];
  } catch (e) {}
  if (tag) {
    const rel = execFileSync('git', ['show', tag + ':plugin/skills/refresh/assets/page.html'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const relPage = /^<!doctype/i.test(rel) ? rel : SKELETON + rel + '</body></html>';
    const pRel = await open(oldSeed, relPage);
    const tRel = await texts(pRel);
    ok(
      same(tRel.sig, tOld.sig) && tOld.sig.threadRows.length > 100,
      'layout: on the old layout this page shows what ' +
        tag +
        "'s page shows (header, summary cards, and every message's number, text and photos in the summary threads, " +
        'threaded and timeline)',
    );
    await pRel.context().close();
  } else console.log('SKIP layout: no release tag to compare the old layout against');
  // the block layout renders the same content as the same history in the old layout
  const pNew = await open(newSeed);
  const tNew = await texts(pNew);
  for (const k of ['strip', 'summary', 'thread', 'flat'])
    ok(
      tNew[k] === tOld[k],
      'layout: block layout and old layout render the same ' + k + ' text (' + tNew[k].length + ' chars)',
    );
  ok(
    same(
      await pNew.evaluate(() => [S.threading, S.summary]),
      await pOld
        .evaluate(() => [S.threading, S.summary])
        .then(([t, s]) => [
          Object.assign({}, t, {
            convs: t.convs.slice().sort((a, b) => Math.floor(a.members[0] / 10) - Math.floor(b.members[0] / 10)),
          }),
          s,
        ]),
    ),
    "layout: the page's merge of the blocks equals the old single documents",
  );
  // archived conversations are visible and searchable
  const sb = sumBlocks.find(k => (S0.new[k].convs || []).length);
  const arch = S0.new[sb].convs[0];
  const th = S0.old['threading/current'];
  const mem = th.convs.find(c => c.id === arch.id).members;
  await pNew.evaluate(() => {
    location.hash = '#summary';
  });
  await pNew.waitForTimeout(150);
  ok(
    !!(await pNew.$('#v-summary article.cv[data-conv="' + arch.id + '"]')),
    'layout: an archived conversation (' + arch.id + ', from ' + sb.split('/')[1] + ') has its card',
  );
  await pNew.evaluate(() => {
    location.hash = '#messages';
  });
  await pNew.waitForTimeout(150);
  ok(
    !!(await pNew.$('#msgs details.conv[data-conv="' + arch.id + '"] #m' + mem[0])),
    'layout: the archived conversation shows in the Messages tab with its messages',
  );
  const words = msgs[mem[0]].b;
  await pNew.fill('#msg-q', words);
  await pNew.waitForTimeout(300);
  ok(!!(await pNew.$('#msgs #m' + mem[0])), 'layout: searching finds a message in an archived conversation');
  await pNew.fill('#msg-q', '');
  await pNew.waitForTimeout(250);
  // a live change to one block document re-renders (a link fixed in place)
  const tb = Object.keys(S0.new).find(k => {
    const d = S0.new[k];
    return /^threading\/b/.test(k) && Object.values(d.members || {}).some(m => m.length >= 3);
  });
  const doc = JSON.parse(JSON.stringify(S0.new[tb]));
  const [cid, ms] = Object.entries(doc.members).find(([, m]) => m.length >= 3);
  const child = ms[ms.length - 1],
    parent = ms[0];
  doc.links[child] = [parent, 'r'];
  await pNew.evaluate(([k, d]) => __rt.write(k, d), [tb, doc]);
  ok(
    await until(
      pNew,
      ([c, p]) => {
        const r = document.querySelector('#m' + c);
        return r && new RegExp('reply to #' + p + '\\b').test(r.textContent);
      },
      [child, parent],
    ),
    'layout: editing one threading block live shows the new link (#' +
      child +
      ' replies to #' +
      parent +
      ', ' +
      cid +
      ')',
  );
  // ...and the way catchup.py changes a block: a new document, then `current` names it, then the old one goes
  const sdoc = JSON.parse(JSON.stringify(S0.new[sb]));
  sdoc.convs[0] = Object.assign({}, sdoc.convs[0], { outcome: 'Settled: Ben sold it to Dee' });
  const nid = sb.split('/')[1].replace(/-.*/, '-0000beef');
  const cur = JSON.parse(JSON.stringify(S0.new['summary/current']));
  cur.blocks = cur.blocks.map(b => (b === sb.split('/')[1] ? nid : b));
  await pNew.evaluate(
    ([sb, nid, sdoc, cur]) => {
      __rt.write('summary/' + nid, sdoc);
      __rt.write('summary/current', cur);
      __rt.del(sb);
    },
    [sb, nid, sdoc, cur],
  );
  await pNew.evaluate(() => {
    location.hash = '#summary';
  });
  ok(
    await until(
      pNew,
      id => {
        const a = document.querySelector('#v-summary article.cv[data-conv="' + id + '"]');
        return a && /Settled: Ben sold it to Dee/.test(a.textContent);
      },
      arch.id,
    ),
    'layout: a replaced summary block (new document, current switched, old one deleted) re-renders the archived card',
  );
  // an over-size write is refused, as the database refuses it
  const err = await pNew.evaluate(() =>
    __rt
      .write('threading/huge', { x: 'y'.repeat(262144) })
      .then(() => null)
      .catch(e => e.code),
  );
  ok(err === 'invalid_argument', 'runtime: a document over 256 KiB is refused (' + err + ')');
  const refused = await pNew.evaluate(() => {
    const out = [];
    for (const ws of [
      Array.from({ length: 51 }, (_, k) => ({ op: 'set', p: 'x/n' + k, v: {} })),
      Array.from({ length: 6 }, (_, k) => ({ op: 'set', p: 'x/m' + k, v: { b: 'z'.repeat(200000) } })),
      [{ op: 'set', p: 'summary/current', v: {} }],
    ])
      try {
        __rt.batch(ws);
        out.push('accepted');
      } catch (e) {
        out.push(e.message.replace(/:.*/, ''));
      }
    return out;
  });
  ok(
    refused.join() === 'batch refused,batch refused,batch refused' && !(await get(pNew, 'x/n0')),
    'runtime: batches over 50 writes or 1 MiB, and unpinned writes to existing documents, are refused',
  );
  ok(pNew.errors.length === 0 && pOld.errors.length === 0, 'layout: no page errors ' + JSON.stringify(pNew.errors));
  await pNew.context().close();
  await pOld.context().close();
  // a block `current` names that never arrives is reported; one a moment late isn't (review of #31, finding 4)
  const lateId = sumBlocks.find(k => k !== sb);
  const lateSeed = Object.assign({}, newSeed);
  delete lateSeed[lateId];
  const pLate = await open(lateSeed);
  await pLate.waitForTimeout(1000);
  await pLate.evaluate(([k, v]) => __rt.write(k, v), [lateId, S0.new[lateId]]);
  await pLate.waitForTimeout(6500);
  const note = await pLate.$('#layout-st');
  ok(
    !!note && (await note.evaluate(e => e.hidden)),
    'layout: a block that arrives a moment after current shows no notice',
  );
  await pLate.evaluate(k => __rt.del(k), lateId);
  ok(
    await until(
      pLate,
      () => {
        const e = document.getElementById('layout-st');
        return e && !e.hidden && /didn't load \(1 document missing\)/.test(e.textContent);
      },
      null,
      9000,
    ),
    'layout: a block current names that stays missing is reported on the page, not silently dropped',
  );
  ok(pLate.errors.length === 0, 'layout: no page errors with a block missing ' + JSON.stringify(pLate.errors));
  await pLate.context().close();
}

/* ---------- 5. names from the importer's side ---------- */
async function names() {
  const p = await open(SEED());
  await paste(
    p,
    JSON.stringify(
      cap([mk(0), mk(1, { fn: 'Ben Brooks' }), mk(2, { fn: 'Me Myself' }), mk(3, { fn: 'x'.repeat(90) }), mk(4)]),
    ),
  );
  const c = await get(p, 'chunks/c0000');
  ok(
    c.msgs[1].fn === 'Ben Brooks' && !('fn' in c.msgs[2]) && !('fn' in c.msgs[3]),
    'names: fn stored; dropped on your own messages and when over 80 characters',
  );
  let P = (await get(p, 'people/index')).people;
  ok(
    JSON.stringify(P) === JSON.stringify({ 'Ben Brooks': { shown: ['Ben'], firstI: 1, lastI: 1 } }),
    'names: people/index written from the import (' + JSON.stringify(P) + ')',
  );
  await p.evaluate(() => {
    const d = __rt.get('people/index');
    d.people['Ana Alvarez'] = { shown: ['Ana'] }; /* as Claude's one-time scan writes it: no positions */
    d.scannedAt = '2026-11-07T10:00:00Z';
    __rt.write('people/index', d);
  });
  await paste(
    p,
    JSON.stringify(
      cap([mk(5, { fn: 'Ana Alvarez' }), mk(6, { fn: 'Ben Ortiz' }), mk(7), mk(8, { fn: 'Taylor Moss' })]),
    ),
  );
  P = (await get(p, 'people/index')).people;
  const pd = await get(p, 'people/index');
  ok(
    P['Ben Brooks'] && P['Ben Ortiz'] && P['Taylor Moss'].shown[0] === 'Cy' && pd.scannedAt,
    'names: a later import adds people and keeps scannedAt',
  );
  ok(
    P['Ana Alvarez'].firstI === 5 && P['Ana Alvarez'].lastI === 5,
    'names: an entry from the one-time scan (no positions) gets them on import (' +
      JSON.stringify(P['Ana Alvarez']) +
      ')',
  );
  await p.evaluate(() => {
    location.hash = '#messages';
  });
  await p.waitForTimeout(300);
  const who = await p.evaluate(() =>
    [0, 1, 6, 8, 11].map(i => (document.querySelector('#m' + i + ' .who') || {}).textContent),
  );
  ok(
    JSON.stringify(who.slice(0, 4)) === JSON.stringify(['Ana', 'Ben Brooks', 'Ben Ortiz', 'Cy (Taylor)']),
    'names: two Bens get full names, a nickname gets "(first name)" (' + who.join(' | ') + ')',
  );
  await p.fill('#msg-q', 'ortiz');
  await p.waitForTimeout(300);
  ok((await p.$$eval('#msgs .msg', r => r.length)) === 1, 'names: the filter finds people by full name');
  ok(p.errors.length === 0, 'names: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
}

/* ---------- 6. the Messages view (v1.19: B39, B40, B42) ----------
   60 messages in 11 conversations. "packs" holds Ana's text and the photo she sent a minute later (#30, #31, a
   continues link), Ben's reply to the photo and Ana's two-bubble answer; "gap" has Ana again 8 minutes later; "diff"
   has a continues link between two senders; "lend" starts with Dee's reply to #30, which is in "packs"; "gone" starts
   with Ben's reply to a message that isn't stored (from before the history, so no link). */
const SWATCH =
  'data:image/svg+xml,' +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='150'><rect width='200' height='150' fill='#8a9a5b'/><circle cx='70' cy='60' r='26' fill='#d8dcc8'/></svg>",
  );
const PACK_TEXT =
  'Selling my old pack, $40. Barely used, all buckles work. It has a rain cover, two side pockets and a hip belt that fits most sizes. I can bring it to the trailhead on Saturday morning, or you can pick it up near the park.';
function viewSeed() {
  const ov = {
    30: { f: 'Ana', b: PACK_TEXT },
    31: { f: 'Ana', b: '', p: 'att31' },
    32: { f: 'Ben', b: 'Is it still available?', r: 'Ana' },
    33: { f: 'Ana', b: 'Yes, still here', r: 'Ben', q: 'Is it still available?' },
    34: { f: 'Ana', b: 'Can meet Saturday at the trailhead' },
    35: { f: 'Cy', b: 'Nice pack' },
    36: { f: 'Ana', b: 'Anyone hiking Sunday?' },
    37: { f: 'Ben', b: 'Who has a stove I can borrow?' },
    38: { f: 'Cy', b: 'Mine is broken, sorry' },
    44: { f: 'Ana', b: 'Leaving at 8 if so' },
    50: { f: 'Dee', b: 'I can lend you mine instead', r: 'Ana', q: 'Selling my old pack, $40. Barely used' },
    51: { f: 'Ana', b: 'Thanks Dee, that works', r: 'Dee', q: 'I can lend you mine instead' },
    58: {
      f: 'Ben',
      b: 'I still have mine, want it?',
      r: 'Dee',
      q: 'Anyone selling a tent? Mine tore',
      pmid: 'mid.old7',
    },
  };
  const msgs = range(0, 59, i => mk(i, ov[i]));
  const conv = (id, title, members) => ({ id, title, members });
  const th = {
    convs: [
      conv(
        't0',
        'Trail conditions',
        range(0, 5, i => i),
      ),
      conv(
        't1',
        'Water filters',
        range(6, 11, i => i),
      ),
      conv(
        't2',
        'Boots',
        range(12, 17, i => i),
      ),
      conv(
        't3',
        'Permits',
        range(18, 23, i => i),
      ),
      conv(
        't4',
        'Car pool',
        range(24, 29, i => i),
      ),
      conv(
        'packs',
        'Pack for sale',
        range(30, 35, i => i),
      ),
      conv('gap', 'Sunday hike', [36, 44]),
      conv('diff', 'Stove', [37, 38]),
      conv(
        't5',
        'Maps',
        range(39, 49, i => i).filter(i => i !== 44),
      ),
      conv('lend', 'Borrowing a pack', [50, 51]),
      conv(
        't6',
        'Snacks',
        range(52, 57, i => i),
      ),
      conv('gone', 'Tent', [58, 59]),
    ],
    links: {
      31: [30, 'c'],
      32: [31, 'rg'],
      33: [32, 'r'],
      34: [33, 'c'],
      38: [37, 'c'],
      44: [36, 'c'],
      50: [30, 'rq'],
      51: [50, 'r'],
    },
    to: 59,
    note: '',
  };
  const sm = {
    version: 2,
    convs: th.convs.map(c => ({ id: c.id, tag: '', synopsis: [], outcome: '', key: [] })),
    open: [],
    answered: [],
    deals: [],
    mentions: [],
    toI: 59,
    generatedAt: 'now',
  };
  return { msgs, th, sm };
}
async function viewPage(o = {}) {
  const V = viewSeed();
  const p = await open(SEED(), PAGE, o.ctx);
  await paste(p, JSON.stringify(cap(V.msgs)));
  await p.evaluate(
    ([th, sm, u]) => {
      __rt.write('threading/current', th);
      __rt.write('summary/current', sm);
      __rt.write('photos/index', { byI: { 31: [u] }, gifs: [] });
      location.hash = '#messages';
    },
    [V.th, V.sm, SWATCH],
  );
  await until(p, () => document.querySelector('#m31 .pics img') && document.querySelector('#msgs details.conv'));
  await p.waitForTimeout(150);
  return p;
}
const topOf = (p, sel) =>
  p.evaluate(s => {
    const n = document.querySelector(s);
    const r = n && n.getBoundingClientRect();
    return r && r.height ? Math.round(r.top) : null;
  }, sel);
const opacity = (p, sel) => p.$eval(sel, e => getComputedStyle(e).opacity).catch(() => null);
const txt = (p, sel) => p.$eval(sel, e => e.textContent).catch(() => '');
const tryClick = (p, sel) =>
  p.click(sel, { timeout: 3000 }).then(
    () => true,
    () => false,
  );
async function messagesView() {
  // B42: a person's bubbles sent close together are one block
  let p = await viewPage();
  const blk = await p.evaluate(() => {
    const a = document.querySelector('#m30'),
      b = document.querySelector('#m31'),
      g = a && a.parentElement;
    return {
      same: !!g && g === b.parentElement && g.classList.contains('grp'),
      who: g ? [...g.querySelectorAll('.who')].map(x => x.textContent) : [],
      nums: g ? [...g.querySelectorAll('.n')].map(x => x.textContent) : [],
      photo: !!(b && b.querySelector('.pics img')),
      label: b ? /continues/.test(b.textContent) : true,
    };
  });
  ok(
    blk.same && blk.who.join() === 'Ana' && blk.nums.join() === '#30,#31' && blk.photo && !blk.label,
    'B42: text and the photo a minute later render as one block with one header, both numbers kept (' +
      JSON.stringify(blk) +
      ')',
  );
  ok(
    await p.evaluate(() => {
      const r = document.querySelector('#m32');
      return (
        !!r.closest('.kids') &&
        r.closest('.kids').previousElementSibling === document.querySelector('#m30').parentElement
      );
    }),
    'B42: a reply to the second bubble nests under the block',
  );
  const apart = await p.evaluate(() =>
    ['#m36', '#m44', '#m37', '#m38'].map(s => {
      const r = document.querySelector(s);
      return !r.closest('.grp') && !!r.querySelector('.who');
    }),
  );
  ok(
    apart.every(Boolean),
    'B42: a gap of 8 minutes, or a different sender, still gives separate rows with their own header (' + apart + ')',
  );
  await p.click('#msgs details.conv[data-conv="packs"] > summary');
  await p.mouse.move(5, 5);
  await p.waitForTimeout(250);
  const hid = [await opacity(p, '#m30 .acts'), await opacity(p, '#m31 .acts')];
  await p.hover('#m31 .pics');
  await p.waitForTimeout(250);
  const shown = [await opacity(p, '#m30 .acts'), await opacity(p, '#m31 .acts')];
  ok(
    hid.join() === '0,0' && shown.join() === '0,1',
    "B42: a bubble's actions are hidden until you hover that bubble (before " + hid + ', hovering #31 ' + shown + ')',
  );
  await p.mouse.move(5, 5);
  await p.evaluate(() => {
    const a = document.querySelector('#m30 .acts a.replylink');
    if (a) a.focus();
  });
  await p.waitForTimeout(250);
  ok(
    (await opacity(p, '#m30 .acts')) === '1' && (await opacity(p, '#m31 .acts')) === '0',
    "B42: keyboard focus on a bubble's action shows that bubble's actions",
  );
  ok(
    /Open photo/.test(await txt(p, '#m31 .acts')) &&
      /Reply in Messenger/.test(await txt(p, '#m31 .acts')) &&
      !/Open photo/.test(await txt(p, '#m30 .acts')),
    'B42: each bubble keeps its own actions (the photo bubble has Open photo)',
  );
  await p.evaluate(() => document.activeElement.blur());
  await p.waitForTimeout(250);
  const rowsHid = await p.evaluate(() => {
    const rows = [...document.querySelectorAll('#msgs details.conv[open] .msg')];
    return {
      n: rows.length,
      hidden: rows.filter(r => {
        const a = r.querySelector(':scope > .c > .acts');
        return a && getComputedStyle(a).opacity === '0' && /Reply in Messenger/.test(a.textContent);
      }).length,
      chips: !!document.querySelector('#m35 .acts .chip'),
    };
  });
  await p.hover('#m35 .body');
  await p.waitForTimeout(250);
  const single = await opacity(p, '#m35 .acts');
  ok(
    rowsHid.n > 20 && rowsHid.hidden === rowsHid.n && single === '1',
    'every message row hides its actions until you hover it (' +
      rowsHid.hidden +
      ' of ' +
      rowsHid.n +
      ' hidden; hovering the single message #35: ' +
      single +
      ')',
  );
  await p.mouse.move(5, 5);
  await p.evaluate(() => {
    const b = document.querySelector('#m34 .acts button.rh');
    if (b) b.focus();
  });
  await p.keyboard.press('Tab');
  await p.waitForTimeout(250);
  const kb = await p.evaluate(() => {
    const a = document.activeElement;
    const acts = document.querySelector('#m35 > .c > .acts');
    return {
      inRow: !!(acts && acts.contains(a)),
      shown: acts ? getComputedStyle(acts).opacity : null,
      ring: a ? getComputedStyle(a).outlineStyle : null,
    };
  });
  ok(
    kb.inRow && kb.shown === '1' && kb.ring !== 'none',
    "Tab reaches the next message's actions, shows them, and the focus ring is visible (" + JSON.stringify(kb) + ')',
  );
  await p.hover('#m31 .pics');
  await p.click('#m31 button.rh');
  await p.fill('#m31 .compose textarea', 'Still have it?');
  await p.mouse.move(5, 5);
  await p.waitForTimeout(250);
  ok(
    await p.$eval('#m31 .compose', c => {
      const r = c.getBoundingClientRect();
      return r.width > 200 && r.height > 40 && getComputedStyle(c).opacity === '1';
    }),
    '"Reply here"\'s composer stays open and visible when the pointer leaves the message',
  );
  await p.click('#m31 .compose button.primary');
  const ob = await until(p, () => {
    const k = [...__rt.store.keys()].find(k => k.startsWith('outbox/'));
    return k ? __rt.get(k) : null;
  });
  ok(
    ob && ob.i === 31 && ob.mid === 'mid.31' && ob.to === 'Ana',
    'B42: Reply here on the second bubble queues a reply to #31 (' +
      JSON.stringify(ob && { i: ob.i, mid: ob.mid }) +
      ')',
  );
  await tryClick(p, '#m32 a.lk');
  ok(
    await until(p, () => {
      const n = document.querySelector('#m31.flash');
      const r = n && n.getBoundingClientRect();
      return r && r.top >= 0 && r.bottom <= innerHeight;
    }),
    'B42: the #31 link on the reply jumps to the second bubble',
  );
  await p.fill('#msg-q', '#31');
  await p.waitForTimeout(300);
  const s31 = await p.evaluate(() => ({
    convs: [...document.querySelectorAll('#msgs details.conv')].map(d => d.dataset.conv),
    has: !!document.querySelector('#m31'),
  }));
  await p.fill('#msg-q', 'old pack');
  await p.waitForTimeout(300);
  const s30 = await p.evaluate(() => !!document.querySelector('#m30'));
  ok(
    s31.has && s31.convs.join() === 'packs' && s30,
    'B42: search finds each bubble (#31 by number, #30 by text) (' + JSON.stringify(s31) + ')',
  );
  await p.click('#lay-flat');
  await p.fill('#msg-q', '');
  await p.waitForTimeout(300);
  const flat = await p.evaluate(() => {
    const g = n => (document.querySelector('#m' + n) || {}).parentElement;
    return {
      pair: g(30) === g(31) && g(30).classList.contains('grp'),
      answer: g(33) === g(34) && g(33).classList.contains('grp'),
      apart: [36, 44, 37, 38, 35, 50].every(n => !document.querySelector('#m' + n).closest('.grp')),
      rows: document.querySelectorAll('#msgs .msg').length,
    };
  });
  ok(
    flat.pair && flat.answer && flat.apart && flat.rows === 60,
    'B42: the timeline groups the same bubbles and keeps all 60 rows (' + JSON.stringify(flat) + ')',
  );
  await p.fill('#msg-q', '#31');
  await p.waitForTimeout(300);
  ok(
    (await p.$$eval('#msgs .msg', r => r.map(x => x.id))).join() === 'm31',
    'B42: in the timeline, search by number finds the second bubble alone',
  );
  await p.fill('#msg-q', '');
  await p.click('#lay-thread');
  // B40: the conversation that starts with a reply to #30 (in "packs") shows #30 first
  const ctxOf = sel =>
    p.evaluate(s => {
      const c = document.querySelector(s);
      return (
        c && {
          text: c.textContent,
          first: c.previousElementSibling && c.previousElementSibling.tagName,
          who: [...c.querySelectorAll('.who')].map(x => x.textContent),
          body: [...c.querySelectorAll('.body')].map(x => x.textContent),
          imgs: [...c.querySelectorAll('.pics img')].map(x => x.getAttribute('src')),
          time: (c.querySelector('.msg .t') || {}).textContent,
          ids: [...c.querySelectorAll('[id]')].length,
        }
      );
    }, sel);
  const cx = await ctxOf('#msgs details.conv[data-conv="lend"] > .ctx');
  ok(
    cx && cx.first === 'SUMMARY' && /Show #30/.test(cx.text) && /Pack for sale/.test(cx.text),
    'B40: a conversation that starts with a reply to another conversation shows that message first (' +
      JSON.stringify(cx && { first: cx.first, text: cx.text.slice(0, 80) }) +
      ')',
  );
  ok(
    cx &&
      cx.who.join() === 'Ana' &&
      cx.body.join() === PACK_TEXT &&
      cx.time === 'Fri 9:30 AM' &&
      cx.imgs.join() === SWATCH &&
      cx.ids === 0,
    "B40: the context block shows the message itself: Ana's full text, the time, and the photo she sent with it as " +
      'one block (' +
      JSON.stringify(cx && { who: cx.who, len: cx.body.map(b => b.length), imgs: cx.imgs.length, ids: cx.ids }) +
      ')',
  );
  const gone = await ctxOf('#msgs details.conv[data-conv="gone"] > .ctx');
  ok(
    gone &&
      /isn.t stored/.test(gone.text) &&
      /Dee/.test(gone.text) &&
      /Anyone selling a tent\? Mine tore/.test(gone.text) &&
      (await p.$eval('#msgs details.conv[data-conv="gone"] > .ctx a', a => a.href).catch(() => '')).includes(
        'mcjump=mid.old7',
      ),
    "B40: a parent that isn't stored shows what the reply says about it and says it isn't stored (" +
      JSON.stringify(gone && gone.text) +
      ')',
  );
  ok(
    !(await p.$('#msgs details.conv[data-conv="packs"] > .ctx')) &&
      !(await p.$('#msgs details.conv[data-conv="t1"] > .ctx')),
    'B40: conversations that start on their own get no context line',
  );
  await p.evaluate(() => {
    document.querySelector('#msgs details.conv[data-conv="packs"]').open = false;
    document.querySelector('#msgs details.conv[data-conv="lend"]').open = true;
  });
  await tryClick(p, '#msgs details.conv[data-conv="lend"] > .ctx button.link');
  ok(
    await until(p, () => {
      const n = document.querySelector('#m30.flash');
      const r = n && n.getBoundingClientRect();
      return r && r.height && r.top >= 0 && r.bottom <= innerHeight && n.closest('details').open;
    }),
    "B40: the context line's Show #30 jumps to #30 in its own conversation",
  );
  await p.evaluate(() => {
    location.hash = '#summary';
  });
  await p.waitForTimeout(200);
  ok(
    (await p.$$eval('#v-summary article.cv[data-conv="lend"] .ctx .body', b => b.map(x => x.textContent))).join() ===
      PACK_TEXT && !!(await p.$('#v-summary article.cv[data-conv="lend"] .ctx .pics img')),
    "B40: the summary's card shows the context block too, text and photo",
  );
  await p.click('#v-summary article.cv[data-conv="packs"] details.thr > summary');
  await p.waitForTimeout(200);
  const thr = await p.evaluate(() => {
    const t = document.querySelector('#v-summary article.cv[data-conv="packs"] details.thr');
    const a = t.querySelector('.msg[data-i="30"]'),
      b = t.querySelector('.msg[data-i="31"]');
    return (
      !!a &&
      a.parentElement === b.parentElement &&
      a.parentElement.classList.contains('grp') &&
      a.parentElement.querySelectorAll('.who').length === 1
    );
  });
  ok(thr, 'B42: the summary\'s "Show the thread" shows the same block');
  ok(p.errors.length === 0, 'messages view: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();

  // B42 on a phone: no hover, so tapping a bubble shows its actions; nothing scrolls sideways
  p = await viewPage({ ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
  await p.evaluate(() => {
    document.querySelector('#msgs details.conv[data-conv="packs"]').open = true;
  });
  await p.waitForTimeout(150);
  const width = s => p.$eval(s, e => Math.round(e.getBoundingClientRect().width)).catch(() => null);
  const w0 = await width('#m31 .acts');
  await p.tap('#m31 .pics', { position: { x: 5, y: 5 } }).catch(() => p.tap('#m31 .n'));
  await p.waitForTimeout(150);
  const lb = await p.$('#lb');
  if (lb) await p.click('#lb .bar button');
  await p.tap('#m31 .n');
  await p.waitForTimeout(150);
  const w1 = await width('#m31 .acts');
  ok(
    w0 != null && w0 <= 1 && w1 > 100,
    "B42: on a phone a bubble's actions are hidden until you tap it (width " + w0 + ' → ' + w1 + ')',
  );
  const s0 = await width('#m35 .acts');
  await p.tap('#m35 .body');
  await p.waitForTimeout(150);
  const s1 = await width('#m35 .acts');
  ok(
    s0 != null && s0 <= 1 && s1 > 100 && (await width('#m31 .acts')) <= 1,
    "on a phone a single message's actions are hidden until you tap it, and tapping it hides the last one's (width " +
      s0 +
      ' → ' +
      s1 +
      ')',
  );
  ok(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'B42: at phone width the Messages view has no sideways scroll',
  );
  ok(p.errors.length === 0, 'messages view (phone): no page errors ' + JSON.stringify(p.errors));
  await p.context().close();

  // B39: queuing a reply keeps the reader's conversation open and its message where it was
  p = await viewPage({ ctx: { viewport: { width: 1000, height: 700 } } });
  /* Safari has no scroll anchoring of its own (CSS overflow-anchor), so the page must keep the place itself */
  await p.addStyleTag({ content: '* { overflow-anchor: none !important; }' });
  await p.click('#msgs details.conv[data-conv="t4"] > summary'); /* the fifth: closed by default */
  await p.click('#msgs details.conv[data-conv="t1"] > summary'); /* one of the first four: the reader closes it */
  await p.evaluate(() => {
    const r = document.querySelector('#m26').getBoundingClientRect();
    scrollBy(0, r.top - 260);
  });
  await p.hover('#m26 .who');
  await p.click('#m26 button.rh');
  await p.fill('#m26 .compose textarea', 'I can drive');
  const y0 = await topOf(p, '#m26');
  await p.click('#m26 .compose button.primary');
  await until(p, () => /reply queued/.test(document.querySelector('#m26').textContent));
  await p.waitForTimeout(200);
  const st1 = await p.evaluate(() => ({
    t4: document.querySelector('details.conv[data-conv="t4"]').open,
    t1: document.querySelector('details.conv[data-conv="t1"]').open,
    compose: !!document.querySelector('#m26 .compose'),
  }));
  const y1 = await topOf(p, '#m26');
  ok(
    st1.t4 && !st1.t1 && !st1.compose && y0 != null && Math.abs(y1 - y0) <= 2,
    'B39: after Queue reply the conversation stays open (and the one closed stays closed), and #26 stays put (y ' +
      y0 +
      ' → ' +
      y1 +
      ', ' +
      JSON.stringify(st1) +
      ')',
  );
  // ...a refresh's chunk arriving
  await paste(p, JSON.stringify(cap(range(60, 64))));
  await until(p, () => document.querySelector('#m64'));
  await p.waitForTimeout(200);
  const y2 = await topOf(p, '#m26');
  const st2 = await p.evaluate(() => [
    document.querySelector('details.conv[data-conv="t4"]').open,
    document.querySelector('details.conv[data-conv="t1"]').open,
  ]);
  ok(
    st2.join() === 'true,false' && y2 != null && Math.abs(y2 - y0) <= 2,
    'B39: after a new chunk arrives the conversations stay as the reader left them and #26 stays put (y ' +
      y0 +
      ' → ' +
      y2 +
      ')',
  );
  // ...and the threading build that follows, which also makes the text above the list longer
  await p.evaluate(() => {
    const t = __rt.get('threading/current');
    t.convs.find(c => c.id === 't6').members.push(60, 61, 62, 63, 64);
    t.to = 64;
    t.note = 'Reply links read straight from Messenger. '.repeat(12);
    __rt.write('threading/current', t);
  });
  await until(p, () => /straight from Messenger/.test(document.getElementById('msg-note').textContent));
  await p.waitForTimeout(200);
  const y3 = await topOf(p, '#m26');
  ok(
    (await p.$eval('details.conv[data-conv="t4"]', d => d.open)) && y3 != null && Math.abs(y3 - y0) <= 2,
    'B39: after a threading update that adds lines above, #26 stays put (y ' + y0 + ' → ' + y3 + ')',
  );
  ok(p.errors.length === 0, 'B39: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
}

const SECTIONS = { importer, robustness, pipeline, variants, ranges, layouts, names, messagesView };
(async () => {
  browser = await chromium.launch();
  try {
    /* ONLY=messagesView,names runs just those sections (e.g. to check new tests against an older page) */
    for (const [k, f] of Object.entries(SECTIONS))
      if (!process.env.ONLY || process.env.ONLY.split(',').includes(k)) await f();
  } catch (e) {
    ok(false, 'crashed: ' + ((e && e.stack) || e));
  }
  await browser.close();
})();
