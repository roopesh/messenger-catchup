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
const { execFileSync, spawn } = require('child_process');
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
const BACKFILL = path.join(__dirname, 'out/sim_cap_photos.json'); /* sim section G: {first, backfill, multi} */
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
  /* update merges nested objects field by field and replaces arrays, as the real one does; {__delete__: true} at any
     depth removes that field */
  const plain = v => v != null && typeof v === 'object' && !Array.isArray(v);
  const merge = (a, b) => {
    const out = plain(a) ? clone(a) : {};
    Object.entries(b).forEach(([k, v]) => {
      if (plain(v) && v.__delete__ === true) delete out[k];
      else out[k] = plain(v) ? merge(out[k], v) : clone(v);
    });
    return out;
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
  /* fails: [{p, op, after?}]: the next matching write throws "unavailable" (after: let that many through first) */
  const failIf = (p, op) => {
    const k = fails.findIndex(f => f.p === p && f.op === op);
    if (k >= 0 && fails[k].after > 0) fails[k].after--;
    else if (k >= 0) {
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
        tooBig(p, merge(store.get(p), o));
        store.set(p, merge(store.get(p), o));
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
  /* Assets (assets.d.ts, contract 0.2.92). window.__up = {delayMs, script:{<call>: code | {hang: ms} | {delayMs: ms}},
     quota:{maxFiles, maxBytes}} scripts uploads by call number (0 = the first upload() call; retries count): a code
     rejects with {code}, {hang} answers only after ms (a late answer the page must ignore), {delayMs} slows that one.
     Over the quota (default 5,000 files, 1 GiB, as on claude.ai) an upload rejects quota_or_state. Ids are 32 hex
     characters; each upload is logged as {id, size, type, hash} (SHA-256 of the bytes), so a duplicate shows by hash.
     opts.assetUse {files, bytes} counts files stored before the test. __failUploadAt (older tests) fails the upload
     whose number of stored uploads equals it, with "unavailable". */
  let calls = 0;
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const quota = () => Object.assign({ maxFiles: 5000, maxBytes: 1 << 30 }, (window.__up || {}).quota);
  const usage = () => {
    const live = uploads.filter(u => !u.deleted);
    const pre = opts.assetUse || {};
    const q = quota();
    return {
      files: live.length + (pre.files || 0),
      bytes: live.reduce((n, u) => n + u.size, pre.bytes || 0),
      maxFiles: q.maxFiles,
      maxBytes: q.maxBytes,
    };
  };
  const assets = {
    upload: async (blob, o) => {
      const n = calls++;
      const U = window.__up || {};
      const s = (U.script || {})[n];
      if (window.__failUploadAt === uploads.length) {
        window.__failUploadAt = null;
        throw Object.assign(new Error('injected upload failure'), { code: 'unavailable' });
      }
      await pause(s && s.hang != null ? s.hang : s && s.delayMs != null ? s.delayMs : U.delayMs || 0);
      if (typeof s === 'string') throw Object.assign(new Error('scripted ' + s), { code: s });
      const u = usage();
      if (u.files + 1 > u.maxFiles || u.bytes + blob.size > u.maxBytes)
        throw Object.assign(new Error('quota'), { code: 'quota_or_state' });
      const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      const hash = [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
      const id = 'b10b' + String(uploads.length + 1).padStart(28, '0');
      uploads.push({ id, size: blob.size, type: o.type, hash, call: n });
      return { id, url: '/_blob/' + id, sizeBytes: blob.size, contentType: o.type };
    },
    list: async () => {
      if (opts.listReject) throw Object.assign(new Error('list unavailable'), { code: 'store_unavailable' });
      const live = uploads.filter(u => !u.deleted);
      return {
        assets: live.map(u => ({ id: u.id, url: '/_blob/' + u.id, contentType: u.type, sizeBytes: u.size })),
        usage: usage(),
      };
    },
    delete: async id => {
      const u = uploads.find(x => x.id === id && !x.deleted);
      if (u) u.deleted = true;
      return { deleted: !!u };
    },
  };
  if (opts.tune) window.__mcImportTune = opts.tune; /* the page's photo timings, shortened (R2 tests) */
  Object.entries(opts.leases || {}).forEach(([p, l]) => leases.set(p, l)); /* a lease another tab left behind */
  /* The real cap (sample.d.ts, SampleLimits.maxPromptBytes): every turn's content together, in UTF-8 bytes; over it the
     call rejects with prompt_too_large and nothing is sent. opts.promptMax is what limits() reports, opts.enforce what
     is enforced (lower = the runtime counts more strictly than it says); noLimits, limitsReject and limitsBogus break
     limits() the ways a page must survive. Each call is logged in __rt.sampleLog as {bytes, code}. */
  const PROMPT_MAX = opts.promptMax ?? 262144;
  const promptBytes = m =>
    typeof m === 'string'
      ? new TextEncoder().encode(m).length
      : m.reduce((n, t) => n + promptBytes(typeof t.content === 'string' ? t.content : JSON.stringify(t.content)), 0);
  const sampleLog = [];
  const capCheck = input => {
    const b = promptBytes(input);
    const over = b > (opts.enforce ?? PROMPT_MAX);
    sampleLog.push({ bytes: b, code: over ? 'prompt_too_large' : null });
    if (over) throw Object.assign(new Error('prompt too large: ' + b + ' bytes'), { code: 'prompt_too_large' });
  };
  async function sample(msgs, o) {
    samples.push(msgs);
    capCheck(msgs);
    const text = opts.answer || 'Ben offered one [#1]. Ana asked [#0, #2].';
    if (o && o.onText) o.onText({ text });
    return { text };
  }
  if (!opts.noLimits)
    sample.limits = async () => {
      if (opts.limitsHang) return new Promise(() => {});
      if (opts.limitsReject) throw Object.assign(new Error('limits unavailable'), { code: 'unavailable' });
      return { maxPromptBytes: opts.limitsBogus ? 'x' : PROMPT_MAX };
    };
  sample.json = async prompt => {
    samples.push(prompt);
    capCheck(prompt);
    if (opts.viewJson) return JSON.parse(JSON.stringify(opts.viewJson));
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
      const v = w.op === 'update' ? merge(store.get(w.p), w.v) : clone(w.v);
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
    sampleLog,
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
    /* another tab takes a lease (only possible once the holder's has lapsed, but tests take it outright) */
    steal: (p, holder, ms) => leases.set(p, { holder, exp: Date.now() + ms }),
    calls: () => calls,
    usage,
  };
  window.claude = {
    use: async n =>
      ({ db: opts.noDb ? null : { doc, collection }, assets: opts.noAssets ? null : assets, sample })[n] || null,
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
/* ctxOpts.clockAt (ms): install Playwright's clock at that time before the page loads (it keeps running; p.clock
   moves it on) */
async function open(seed, page = PAGE, ctxOpts) {
  const { clockAt, ...cOpts } = ctxOpts || {};
  const ctx = await browser.newContext(
    Object.assign(
      {
        viewport: { width: 1000, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/Los_Angeles',
      },
      cOpts,
    ),
  );
  if (clockAt != null) await ctx.clock.install({ time: clockAt });
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
/* The stored photo slots, merged here (independently of the page) from photos/index and the photos/b<start> blocks:
   byK[i][k] = "/_blob/<id>" | null (owed) | {e} (given up); stored(i) = message i's stored photos in slot order. */
async function photoState(p) {
  const all = await p.evaluate(() =>
    Object.fromEntries([...__rt.store].filter(([k]) => /^photos\//.test(k)).map(([k, v]) => [k.slice(7), v])),
  );
  const byK = {};
  const ix = all.index || {};
  const at = i => (byK[i] = byK[i] || {});
  Object.entries(ix.byI || {}).forEach(([i, l]) => !(ix.byK || {})[i] && l.forEach((v, k) => (at(i)[k] = v)));
  Object.entries(ix.byK || {}).forEach(([i, m]) => Object.assign(at(i), m));
  Object.keys(all)
    .filter(id => /^b\d+$/.test(id))
    .forEach(id =>
      Object.entries(all[id].byK || {}).forEach(([i, m]) =>
        Object.entries(m).forEach(([k, v]) => {
          if (typeof v === 'string' || !(k in at(i))) at(i)[k] = v;
        }),
      ),
    );
  const stored = i =>
    Object.keys(byK[i] || {})
      .sort((a, b) => a - b)
      .map(k => byK[i][k])
      .filter(v => typeof v === 'string');
  const owed = Object.entries(byK).flatMap(([i, m]) =>
    Object.entries(m)
      .filter(([, v]) => v === null)
      .map(([k]) => +i + '.' + k),
  );
  const gifs = new Set([].concat(...Object.values(all).map(d => d.gifs || [])));
  return { all, byK, stored, owed, gifs };
}
/* Fail the upload calls at these offsets from the next one (0 = the next call) with code */
const failCalls = (p, offs, code = 'store_unavailable') =>
  p.evaluate(
    ([o, c]) => {
      const n = __rt.calls();
      window.__up = Object.assign({}, window.__up, { script: Object.fromEntries(o.map(k => [n + k, c])) });
    },
    [offs, code],
  );
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
/* Paste like Claude does: a paste event on the page body (or another target). Returns the new refresh/lastImport once
   the import has finished (a record whose state isn't "uploading"), or null if the page ignored it. pasteFirst returns
   the first new record, whatever its state. */
const finished = v => v && v.state !== 'uploading';
async function paste(p, text, sel = 'body', ms = 10000) {
  const first = await pasteFirst(p, text, sel, ms);
  if (!first || finished(first)) return first;
  return until(p, () => (v => (v && v.state !== 'uploading' ? v : null))(__rt.get('refresh/lastImport')), null, ms);
}
async function pasteFirst(p, text, sel = 'body', ms = 10000) {
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
      return v && JSON.stringify(v) !== b && v.state !== 'uploading' ? v : null;
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
  const ph = await get(p, 'photos/b0');
  const up = await p.evaluate(() => __rt.uploads);
  ok(
    ph &&
      JSON.stringify(ph.byK['10']) === JSON.stringify({ 0: '/_blob/' + up[0].id }) &&
      JSON.stringify(ph.gifs) === '[5]' &&
      up.length === 1 &&
      up[0].size === Buffer.from(PNG, 'base64').length &&
      up[0].type === 'image/png' &&
      JSON.stringify(r.stored) === JSON.stringify([{ i: 10, k: 0, id: up[0].id }]) &&
      r.state === 'done',
    'photos: uploaded byte-identical size, photos/b0 holds the photo and the GIF, lastImport lists it in stored',
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
    r && r.ok && [...(await photoState(p)).gifs].join() === '201',
    'a capture with GIFs and no photos records the GIFs',
  );
  const P3 = [203, 204, 205].map(i => ({ i, k: 0, type: 'image/png', b64: PNG }));
  await failCalls(p, [1, 2]); /* the 2nd photo fails, and so does its one retry */
  r = await paste(p, JSON.stringify(cap(range(203, 205), { photos: P3 })));
  let ix = await photoState(p);
  ok(
    r &&
      r.fresh === 3 &&
      r.state === 'partial' &&
      /1 photo stored\. Photos: 1 of 3 stored; stopped at #204 \(store_unavailable\)\. Paste again/.test(r.msg) &&
      ix.stored(203).length === 1 &&
      !ix.stored(204).length,
    'upload fails at the 2nd photo: messages saved, the 1st photo indexed, told to paste again (' +
      (r && r.msg.slice(-90)) +
      ')',
  );
  const n0 = await p.evaluate(() => __rt.uploads.length);
  r = await paste(p, JSON.stringify(cap(range(203, 205), { photos: P3 })));
  ix = await photoState(p);
  ok(
    r &&
      r.ok &&
      /2 photos stored \(1 already stored\)/.test(r.msg) &&
      ix.stored(204).length === 1 &&
      ix.stored(205).length === 1 &&
      (await p.evaluate(() => __rt.uploads.length)) - n0 === 2,
    'paste again: only the 2 missing photos upload, all 3 indexed',
  );
  // B28: a capture that skips a photo slot, then a failed upload and a re-paste: no duplicate
  const PK = [
    { i: 206, k: 1, type: 'image/png', b64: PNG },
    { i: 206, k: 2, type: 'image/png', b64: PNG },
    { i: 207, k: 0, type: 'image/png', b64: PNG },
  ];
  await failCalls(p, [2, 3]);
  r = await paste(p, JSON.stringify(cap(range(206, 207), { photos: PK })));
  let n1 = await p.evaluate(() => __rt.uploads.length);
  r = await paste(p, JSON.stringify(cap(range(206, 207), { photos: PK })));
  ix = await photoState(p);
  ok(
    r &&
      r.ok &&
      (await p.evaluate(() => __rt.uploads.length)) - n1 === 1 &&
      ix.stored(206).length === 2 &&
      ix.stored(207).length === 1 &&
      typeof ix.byK['206']['1'] === 'string' &&
      typeof ix.byK['206']['2'] === 'string',
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
    (await p.$eval('#m30 .pics img', i => i.getAttribute('src'))) ===
      '/_blob/' + (await p.evaluate(() => __rt.uploads[0].id)) &&
      typeof ((await get(p, 'photos/b0')) || { byK: {} }).byK['30']?.['0'] === 'string',
    'messages: photo #30 shown from its uploaded blob, indexed in photos/b0 (P22)',
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
    /MESSAGES \(oldest first\):\n#\d+ \[/.test(prompt) && prompt.includes('Sam'),
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

/* R4: date-range mode worked the window out again for every message and citation (5-6 s per update at 6,400 messages).
   Counted, not timed: how often the window is worked out per full render, at two sizes. On a page without the cache
   (no winRange0) every winRange() call counts. */
async function speed() {
  const counts = [];
  for (const n of [1500, 6000]) {
    const S0 = JSON.parse(
      execFileSync('python3', [SYNTH, 'page', String(n), '1000'], { encoding: 'utf8', maxBuffer: 1 << 27 }),
    );
    const msgs = Object.values(S0.chunks).flatMap(c => c.msgs);
    const meta = Object.assign({}, META, {
      lastI: S0.last,
      lastMid: msgs[msgs.length - 1].m,
      anchorMids: msgs.slice(-3).map(m => m.m),
      markerMode: 'time',
      markerFrom: msgs[Math.floor(msgs.length / 2)].d + 'T00:00',
      lastRefresh: 'Wed Nov 11, 9:00 PM',
    });
    const seed = Object.assign(SEED(), { 'meta/chat': meta }, S0.new);
    Object.entries(S0.chunks).forEach(([k, v]) => (seed['chunks/' + k] = v));
    const p = await open(seed);
    await until(p, n => S.msgs && S.msgs.length === n && S.threading, n);
    const r = await p.evaluate(() => {
      let k = 0;
      const name = typeof window.winRange0 === 'function' ? 'winRange0' : 'winRange';
      const orig = window[name];
      window[name] = function () {
        k++;
        return orig.apply(this, arguments);
      };
      rerenderAll();
      const steady = k;
      const lo0 = windowStart();
      S.meta = Object.assign({}, S.meta, { markerFrom: S.msgs[S.msgs.length - 10].d + 'T00:00' });
      rerenderAll();
      return { steady, afterMeta: k - steady, lo0, lo1: windowStart(), last: S.msgs[S.msgs.length - 1].i };
    });
    counts.push(r.steady);
    ok(
      r.steady <= 2 && r.afterMeta <= 2,
      'R4: date-range mode at ' +
        n +
        ' messages works the window out ' +
        r.steady +
        ' time(s) per full render, ' +
        r.afterMeta +
        ' after the marker moves (was once per message and citation)',
    );
    ok(
      r.lo1 > r.lo0 && r.lo1 < r.last,
      'R4: moving the marker still moves the window (#' + r.lo0 + ' → #' + r.lo1 + ')',
    );
    await p.close();
  }
}

/* ---------- history: Ask, Views and range summaries over long histories (R4, F6) ----------
   One prompt budget measured in UTF-8 bytes against sample.limits(): the newest messages word for word, older ones as
   one line per conversation and then per day, back to the first stored message; a range summary too long for one call
   is refused. Small fake caps force every cut path with a few hundred messages; synth.py gives the scale. The
   assertions are about structure and the cap, never how many messages fit. */
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/* n messages from Oct 1, perDay a day between 7 AM and 11 PM, mock cast; o.body(i) for the text */
function hmsgs(n, o = {}) {
  const perDay = o.perDay || n;
  return Array.from({ length: n }, (_, i) => {
    const day = new Date(2026, 9, 1 + Math.floor(i / perDay), 12);
    const min = 7 * 60 + Math.floor(((i % perDay) * 16 * 60) / perDay);
    const h = Math.floor(min / 60);
    return {
      i,
      t:
        DOW[day.getDay()] +
        ' ' +
        (h % 12 || 12) +
        ':' +
        String(min % 60).padStart(2, '0') +
        ' ' +
        (h < 12 ? 'AM' : 'PM'),
      f: NAMES[i % 5],
      b: o.body ? o.body(i) : 'message ' + i + ' about the ridge trail and spare tent poles',
      m: 'mid.' + i,
      d: ymd(day),
    };
  });
}
/* Conversations of 10 messages, or (o.interleave) four sharing each block of 40, taking turns; o.long: the members of
   one long-running conversation (taken out of the others). Every third conversation is summarized. */
function hthreads(n, o = {}) {
  const convs = [],
    sums = [];
  const long = new Set(o.long || []);
  const add = (k, title, members) => {
    members = members.filter(i => !long.has(i));
    if (!members.length) return;
    convs.push({ id: 'c' + k, title, members });
    if (k % 3 === 0)
      sums.push({
        id: 'c' + k,
        tag: 'Gear talk',
        synopsis: [{ t: 'Bullet ' + k, refs: [members[0]] }],
        outcome: 'Outcome ' + k,
        key: [members[0], members[members.length - 1]],
      });
  };
  if (o.interleave)
    for (let blk = 0; blk * 40 < n; blk++)
      for (let j = 0; j < 4; j++)
        add(
          blk * 4 + j,
          'Thread ' + (blk * 4 + j) + ' about tents',
          range(blk * 40, Math.min(n, blk * 40 + 40) - 1, i => i).filter(i => i % 4 === j),
        );
  else
    for (let k = 0; k * 10 < n; k++)
      add(
        k,
        'Topic ' + k + ' about stoves',
        range(k * 10, Math.min(n, k * 10 + 10) - 1, i => i),
      );
  if (o.long) convs.push({ id: 'long', title: 'Long-running permit thread', members: o.long.slice() });
  return {
    threading: { convs, links: {}, to: n - 1, note: '' },
    summary: {
      version: 2,
      convs: sums.reverse(),
      open: [],
      answered: [],
      deals: [],
      mentions: [],
      toI: n - 1,
      generatedAt: 'now',
    },
  };
}
function hseed(msgs, o = {}) {
  const last = msgs[msgs.length - 1];
  const meta = Object.assign(
    {},
    META,
    { lastI: last.i, lastMid: last.m, anchorMids: msgs.slice(-3).map(m => m.m), markerMode: 'caught' },
    o.meta || {},
  );
  const seed = Object.assign(SEED(), { 'meta/chat': meta }, o.docs || {});
  for (let k = 0; k < msgs.length; k += 82)
    seed['chunks/c' + String(k).padStart(4, '0')] = { start: k, msgs: msgs.slice(k, k + 82) };
  if (o.threads) {
    const T = hthreads(msgs.length, o.threads === true ? {} : o.threads);
    seed['threading/current'] = T.threading;
    seed['summary/current'] = T.summary;
  }
  if (o.opts) seed.__opts = o.opts;
  return seed;
}
async function hopen(seed, n) {
  const p = await open(seed);
  HP.push(p);
  await until(p, n => S.msgs.length === n && S.threading, n, 120000);
  return p;
}
const lastSample = p => p.evaluate(() => __rt.samples[__rt.samples.length - 1]);
/* Ask one question; returns the calls it made ({bytes, code} each), the turns of the last one and the notes */
async function hask(p, q, all = false) {
  const n0 = await p.evaluate(() => __rt.sampleLog.length);
  await p.evaluate(
    ([q, all]) => {
      location.hash = '#ask';
      document.getElementById('ask-all').checked = all;
      document.getElementById('ask-in').value = q;
      document.getElementById('ask-go').click();
    },
    [q, all],
  );
  await until(
    p,
    n0 =>
      (__rt.sampleLog.length > n0 || document.getElementById('ask-note').textContent) &&
      !document.getElementById('ask-go').disabled,
    n0,
  );
  await sleep(100);
  return p.evaluate(n0 => {
    const ts = document.querySelectorAll('#chat .turn.assistant');
    const t = ts[ts.length - 1];
    const s = __rt.samples[__rt.samples.length - 1];
    return {
      calls: __rt.sampleLog.slice(n0),
      turns: Array.isArray(s) ? s : null,
      prompt: Array.isArray(s) ? s[0].content : s,
      note: (t && t.querySelector('.sent') && t.querySelector('.sent').textContent) || '',
      askNote: document.getElementById('ask-note').textContent,
      answer: (t && t.querySelector('.txt').textContent) || '',
    };
  }, n0);
}
/* The prompt's parts: the summary lines ([a, b, text]) and the word-for-word message numbers */
function parts(prompt) {
  const sec = name => {
    const m = prompt.match(new RegExp('\\n' + name + ' \\(oldest first\\):\\n([\\s\\S]*?)(?:\\n\\n|$)'));
    return m ? m[1].split('\n') : [];
  };
  const dig = sec('OLDER HISTORY').map(l => {
    const m = l.match(/^\[#(\d+)(?:–#(\d+))?/);
    return m ? [+m[1], +(m[2] ?? m[1]), l] : [NaN, NaN, l];
  });
  const raw = sec('MESSAGES').map(l => +((l.match(/^#(\d+) \[/) || [])[1] ?? NaN));
  return { dig, raw, newer: sec('NEWER HISTORY') };
}
/* The older messages no summary line accounts for: a day line or an ungrouped run covers its range, a conversation's
   line covers that conversation's members inside its range (found by title); a range-summary line covers nothing */
function uncovered(dig, convs, c) {
  const seen = new Set();
  for (const [a, b, l] of dig) {
    if (/\] [\d,]+ messages?(\.|, not grouped)/.test(l)) {
      for (let i = a; i <= b; i++) seen.add(i);
      continue;
    }
    const cv = convs.find(x => l.includes('] ' + x.title + ' (') || l.includes('] ' + x.title + ':'));
    if (cv) cv.members.forEach(i => i >= a && i <= b && seen.add(i));
  }
  return range(0, c - 1, i => i).filter(i => !seen.has(i));
}
const keysOf = dig =>
  dig.flatMap(([, , l]) => ((l.match(/ Key: (#\d+(?:, #\d+)*)/) || [])[1] || '').match(/\d+/g) || []).map(Number);
const contiguous = a => a.length > 0 && a.every((x, k) => k === 0 || x === a[k - 1] + 1);
const ascending = a => a.every((x, k) => k === 0 || x >= a[k - 1]);
const synthSeed = (n, block, args = [], meta = {}, layout = 'new') => {
  const S0 = JSON.parse(
    execFileSync('python3', [SYNTH, 'page', String(n), String(block), ...args], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    }),
  );
  const msgs = Object.values(S0.chunks).flatMap(c => c.msgs);
  const seed = Object.assign(
    SEED(),
    {
      'meta/chat': Object.assign({}, META, {
        lastI: S0.last,
        lastMid: msgs[msgs.length - 1].m,
        anchorMids: msgs.slice(-3).map(m => m.m),
        lastRefresh: 'Wed Nov 11, 9:00 PM',
        ...meta,
      }),
    },
    S0[layout],
  );
  Object.entries(S0.chunks).forEach(([k, v]) => (seed['chunks/' + k] = v));
  return { seed, msgs };
};
const HMARGIN = 4096;
/* each case runs on its own: a crash fails that case (on an older page, say) and the rest still run */
const HP = [];
async function hcase(name, fn) {
  try {
    await fn();
  } catch (e) {
    ok(false, name + ' crashed: ' + ((e && e.stack) || e).toString().split('\n').slice(0, 3).join(' '));
  }
  while (HP.length)
    await HP.pop()
      .context()
      .close()
      .catch(() => {});
}

async function history() {
  /* H1, H2: a full render reads each message a few times, and each conversation once, in every marker mode */
  await hcase('H1, H2', async () => {
    const reads = {};
    for (const n of [1500, 6000]) {
      const { seed, msgs } = synthSeed(n, 1000, [], { markerMode: 'time' });
      seed['meta/chat'].markerFrom = msgs[Math.max(0, n - 920)].d + 'T00:00';
      const p = await hopen(seed, n);
      const r = await p.evaluate(() => {
        const real = S.msgs;
        const count = (a, box) =>
          new Proxy(a, {
            get(t, k, rcv) {
              if (typeof k === 'string' && /^\d+$/.test(k)) box.n++;
              return Reflect.get(t, k, rcv);
            },
          });
        const render = meta => {
          const box = { n: 0 };
          S.meta = Object.assign({}, S.meta, meta);
          S.msgs = count(real, box);
          renderHeader();
          renderSummary();
          renderMessages();
          S.msgs = real;
          return box.n;
        };
        const N = real.length;
        const out = {
          time: render({}),
          caught: render({ markerMode: 'caught', caughtUpI: real[N - 151].i }),
          own: render({ markerMode: 'own', ownLastI: real[N - 40].i }),
        };
        /* a new threading object, so lookups that index it once per object are counted too */
        const box = { n: 0 };
        S.meta = Object.assign({}, S.meta, { markerMode: 'caught' });
        S.threading = Object.assign({}, S.threading, { convs: count(S.threading.convs, box) });
        renderHeader();
        renderSummary();
        renderMessages();
        out.convReads = box.n;
        out.convs = S.threading.convs.length;
        return out;
      });
      reads[n] = r;
      ok(
        r.time <= 12 * n && r.caught <= 20 * n && r.own <= 20 * n,
        'H1: a full render at ' +
          n +
          ' messages reads S.msgs ' +
          (r.time / n).toFixed(1) +
          '× per message in date-range mode, ' +
          (r.caught / n).toFixed(1) +
          '× caught, ' +
          (r.own / n).toFixed(1) +
          '× own (at most 12, 20, 20)',
      );
      ok(
        r.convReads <= 3 * r.convs,
        'H2: conversations are scanned ' +
          (r.convReads / r.convs).toFixed(1) +
          '× each per render at ' +
          n +
          ' messages (at most 3)',
      );
      await p.close();
    }
    const ratio = reads[6000].time / reads[1500].time;
    ok(
      ratio <= 5,
      'H1: 4× the messages, ' + ratio.toFixed(1) + '× the reads in date-range mode (linear: about 4; quadratic: 16)',
    );
  });

  /* H3: the window memo follows every change of S.msgs and S.meta */
  await hcase('H3', async () => {
    const msgs = hmsgs(200, { perDay: 50 });
    let p = await hopen(hseed(msgs.slice(0, 190), { meta: { markerMode: null } }), 190);
    /* brute force, from the same meta: the messages after lo (and through hi) */
    const brute = (all, mt) => {
      let lo = -1,
        hi = Infinity;
      if (mt.markerMode === 'time') {
        lo = all[0].i - 1;
        const ts = m => {
          const t = m.t.match(/^(\w{3})\s+(\d+):(\d+)\s*([AP]M)$/i);
          return m.d + 'T' + String((+t[2] % 12) + (/p/i.test(t[4]) ? 12 : 0)).padStart(2, '0') + ':' + t[3];
        };
        all.forEach(m => ts(m) < mt.markerFrom && (lo = m.i));
        if (mt.markerTo) {
          hi = lo;
          all.forEach(m => ts(m) <= mt.markerTo && (hi = m.i));
        }
      } else if (mt.markerMode === 'own') lo = mt.ownLastI;
      else lo = mt.caughtUpI ?? -1;
      return all.filter(m => m.i > lo && m.i <= hi).length;
    };
    const check = async (label, all) => {
      await sleep(300);
      const got = await p.evaluate(() => {
        location.hash = '#messages';
        document.getElementById('lay-flat').click();
        return {
          meta: S.meta,
          strip: +document.querySelector('#strip .stat .n').textContent,
          rows: document.querySelectorAll('#msgs .msg').length,
          inWin: S.msgs.filter(m => inWin(m.i)).length,
        };
      });
      const want = brute(all, got.meta);
      ok(
        got.strip === want && got.rows === want && got.inWin === want,
        'H3: ' +
          label +
          ': header, Messages and inWin agree with a count from scratch (' +
          [got.strip, got.rows, got.inWin, want].join(', ') +
          ')',
      );
    };
    const m0 = await get(p, 'meta/chat');
    await p.evaluate(
      m =>
        __rt.write(
          'meta/chat',
          Object.assign(m, { markerMode: 'time', markerFrom: '2026-10-02T12:00', markerTo: null }),
        ),
      m0,
    );
    await check('date range', msgs.slice(0, 190));
    await p.evaluate(
      m => __rt.write('meta/chat', Object.assign(m, { markerFrom: '2026-10-03T09:00', markerTo: '2026-10-04T15:00' })),
      await get(p, 'meta/chat'),
    );
    await check('marker moved, with an end', msgs.slice(0, 190));
    await p.evaluate(() => markCaughtUp());
    await check('Mark caught up', msgs.slice(0, 190));
    await p.evaluate(c => __rt.write('chunks/c0190', { start: 190, msgs: c }), msgs.slice(190));
    await until(p, () => S.msgs.length === 200);
    await check('a new chunk', msgs);
    await p.evaluate(
      m => __rt.write('meta/chat', Object.assign(m, { markerMode: 'own', ownLastI: 150 })),
      await get(p, 'meta/chat'),
    );
    await check('own mode', msgs);
    ok(p.errors.length === 0, 'H3: no page errors ' + JSON.stringify(p.errors));
    await p.close();
  });

  /* H4: nothing cut: today's prompt plus the "What you have" line */
  await hcase('H4', async () => {
    const p = await hopen(hseed(hmsgs(20), { meta: { markerMode: null } }), 20);
    const r = await hask(p, 'What was for sale?');
    const lines = await p.evaluate(() => S.msgs.map(lineFor).join('\n'));
    ok(
      r.calls.length === 1 &&
        r.prompt.endsWith('MESSAGES (oldest first):\n' + lines) &&
        !/OLDER HISTORY/.test(r.prompt) &&
        /- MESSAGES: every message in the catch-up window, #0 to #19, word for word/.test(r.prompt),
      'H4: a window that fits is sent whole: every line in order, no summaries, "What you have" names #0 to #19',
    );
    ok(r.note === 'Read #0–#19 word for word.', 'H4: the note under the answer: "' + r.note + '"');
    await p.close();
  });

  /* H5, H13, H14: "include older" at a small cap */
  await hcase('H5, H13, H14', async () => {
    const msgs = hmsgs(800, { perDay: 130 });
    const TH5 = { interleave: true, long: [50, 700] };
    const p = await hopen(
      hseed(msgs, {
        threads: TH5,
        meta: { caughtUpI: 769 },
        opts: { promptMax: 32768, answer: 'Ana sold the stove early on [#5].' },
        docs: {
          'qa/old1': {
            q: 'An old question',
            a: 'An old answer [#3].',
            at: '2026-10-01T10:00:00Z',
            scope: 'window',
            toI: 5,
          },
        },
      }),
      800,
    );
    const r = await hask(p, 'Who sold a stove?', true);
    const { dig, raw } = parts(r.prompt);
    const c = raw[0];
    ok(
      r.calls.length === 1 && r.calls[0].code === null && r.calls[0].bytes <= 32768 - HMARGIN,
      'H5: include older at a 32 KiB cap: one call of ' +
        (r.calls[0] || {}).bytes +
        ' bytes, within the cap less the margin',
    );
    ok(
      raw[raw.length - 1] === 799 && contiguous(raw) && c > 0 && c < 770,
      'H5: word for word is one run ending at the newest, #' + c + '–#799',
    );
    ok(
      r.prompt.includes('- MESSAGES: every message from #' + c + ' to #799') &&
        r.note.startsWith('Read #' + c + '–#799 word for word') &&
        r.note.includes('Older than #' + c + ': summaries only.'),
      'H5: the prompt and the note name the same cut, #' + c + ' ("' + r.note + '")',
    );
    const missing = uncovered(dig, hthreads(800, TH5).threading.convs, c);
    ok(
      dig.length > 0 && missing.length === 0,
      'H5: every message before #' +
        c +
        " is accounted for by a summary line: its conversation's, or a day line (" +
        dig.length +
        ' lines, conversations sharing blocks and one running #50–#700; ' +
        missing.length +
        ' missing: ' +
        missing.slice(0, 5) +
        ')',
    );
    ok(
      dig.length > 0 && dig.every(([, b]) => b < c) && keysOf(dig).every(i => i < c),
      "H5: no summary line or Key number reaches into the word-for-word part (the long conversation's line stops before #" +
        c +
        ')',
    );
    ok(ascending(dig.map(([a]) => a)) && dig[0][0] === 0, 'H5: summary lines run oldest first, from #0');
    ok(
      dig.some(([, , l]) => /Thread \d+ about tents \(Gear talk\): Outcome \d+/.test(l)) &&
        dig.some(([, , l]) => /no summary; \d+ messages from /.test(l)),
      'H5: conversation lines carry summary outcomes, or "no summary" with the count and names',
    );
    /* H14: what was sent is saved and listed */
    const qa = await until(p, () =>
      Object.entries(Object.fromEntries(__rt.store)).find(
        ([k, v]) => k.startsWith('qa/a') && v.q === 'Who sold a stove?',
      ),
    );
    const sent = qa && qa[1].sent;
    ok(
      sent && sent.from === c && sent.to === 799 && sent.sumFrom === 0 && sent.afterFrom === null,
      'H14: the qa row saves sent ' + JSON.stringify(sent) + ', the numbers the note gives',
    );
    const list = await p.textContent('#qa-list');
    ok(
      list.includes('all stored messages · #' + c + '–#799 word for word, older as summaries from #0') &&
        list.includes('An old question'),
      'H14: Earlier questions shows what was read, and an old row without sent still renders',
    );
    /* H13: a citation of a number only a summary line names opens it, with older messages shown */
    await p.click('#chat .turn.assistant a.cite');
    ok(
      await until(
        p,
        () =>
          location.hash === '#messages' &&
          document.getElementById('m5') &&
          !document.getElementById('msg-older').hidden,
      ),
      'H13: a citation into the summaries (#5) opens that message, with older messages switched on',
    );
    ok(p.errors.length === 0, 'H5: no page errors ' + JSON.stringify(p.errors));
    await p.close();
  });

  /* H6, H14: window-only Ask and Views on a window over the budget */
  await hcase('H6, H14', async () => {
    const msgs = hmsgs(800, { perDay: 100 });
    const p = await hopen(
      hseed(msgs, {
        threads: true,
        meta: { markerMode: 'time', markerFrom: '2026-10-02T00:00', markerTo: null },
        opts: { promptMax: 32768 },
      }),
      800,
    );
    const r = await hask(p, 'What happened?');
    const A = parts(r.prompt);
    await p.evaluate(() => {
      location.hash = '#views';
      document.getElementById('view-in').value = 'group by person';
      document.getElementById('view-go').click();
    });
    await until(
      p,
      () =>
        !document.getElementById('view-go').disabled &&
        /By person/.test(document.getElementById('view-out').textContent),
    );
    const vp = await lastSample(p);
    const V = parts(vp);
    const vlog = await p.evaluate(() => __rt.sampleLog[__rt.sampleLog.length - 1]);
    const vnote = await p.$eval('#view-out .sent', e => e.textContent).catch(() => '');
    for (const [what, X, bytes, note] of [
      ['Ask', A, r.calls[0] && r.calls[0].bytes, r.note],
      ['Views', V, vlog.bytes, vnote],
    ]) {
      const n = X.raw.length;
      ok(
        bytes <= 32768 - HMARGIN &&
          X.raw[n - 1] === 799 &&
          contiguous(X.raw) &&
          X.dig.length > 0 &&
          X.dig.every(([a]) => a >= 100) &&
          note.startsWith(
            'Your window has 700 messages: read the newest ' +
              n +
              ' word for word (#' +
              X.raw[0] +
              '–#799), the rest as summaries',
          ),
        'H6: ' +
          what +
          ' on a 700-message window: within the cap (' +
          bytes +
          '), the newest ' +
          n +
          ' word for word, summaries only from the window ("' +
          note +
          '")',
      );
    }
    ok(
      /the rest of the window, #100 to #/.test(vp),
      'H6: the Views prompt says the summaries are the rest of the window',
    );
    const view = await until(p, () => Object.values(Object.fromEntries(__rt.store)).find(v => v && v.kind === 'view'));
    ok(
      view && view.sent && view.sent.to === 799 && view.sent.sumFrom === 100,
      'H14: a built view saves sent too (' + JSON.stringify(view && view.sent) + ')',
    );
    ok(p.errors.length === 0, 'H6: no page errors ' + JSON.stringify(p.errors));
    await p.close();
  });

  /* H7: two levels reach #0; when even day lines don't fit, the prompt says where it stops */
  await hcase('H7', async () => {
    const msgs = hmsgs(800, { perDay: 134 });
    let p = await hopen(hseed(msgs, { threads: true, meta: { caughtUpI: 789 }, opts: { promptMax: 16384 } }), 800);
    let r = await hask(p, 'Anything about permits?', true);
    let { dig } = parts(r.prompt);
    const days = dig.filter(([, , l]) => /\] \d+ messages?\. (Busiest|Not grouped)/.test(l));
    const dayOk = days.every(([a, b, l]) => +l.match(/\] (\d+) message/)[1] === b - a + 1 && msgs[a].d === msgs[b].d);
    ok(
      days.length > 0 &&
        dig[0][0] === 0 &&
        /one line per conversation back to #\d+ \(Oct \d+\), and one line per day for everything before #\d+/.test(
          r.prompt,
        ),
      'H7: at 16 KiB, conversation lines then day lines (' + days.length + '), from #0, and the prompt says so',
    );
    ok(days.length > 0 && dayOk, "H7: each day line counts that day's stored messages, all of one date");
    await p.close();
    p = await hopen(
      hseed(hmsgs(800, { perDay: 10 }), { threads: true, meta: { caughtUpI: 789 }, opts: { promptMax: 9216 } }),
      800,
    );
    r = await hask(p, 'Anything about permits?', true);
    dig = parts(r.prompt).dig;
    const N = dig.length ? dig[0][0] : -1;
    ok(
      N > 0 &&
        r.calls[0].bytes <= 9216 - HMARGIN &&
        r.prompt.includes('- Nothing before #' + N + ' is included.') &&
        r.note.includes('summaries back to #' + N + '; nothing older.'),
      'H7: at 9 KiB even the day lines stop: "Nothing before #' +
        N +
        ' is included", the first summary line\'s number ("' +
        r.note +
        '")',
    );
    await p.close();
  });

  /* H8: where conversation lines come from, and the stretch before summary.fromI */
  await hcase('H8', async () => {
    const { seed, msgs } = synthSeed(
      400,
      1000,
      ['--from-i', '200', '--range-summary', '0', '120'],
      { markerMode: 'caught', caughtUpI: 389 },
      'old',
    );
    msgs.forEach(m => (m.d = ymd(new Date(2026, 9, 1 + Math.floor(m.i / 40), 12))));
    Object.keys(seed)
      .filter(k => k.startsWith('chunks/'))
      .forEach(k => seed[k].msgs.forEach(m => (m.d = msgs[m.i].d)));
    const th = seed['threading/current'];
    th.convs = th.convs
      .map(c => Object.assign(c, { members: c.members.filter(i => i >= 60) }))
      .filter(c => c.members.length);
    const sm = seed['summary/current'];
    const strConv = sm.convs[sm.convs.length - 1]; /* the oldest summarized conversation */
    Object.assign(strConv, { synopsis: 'A plain text synopsis about the lake trip stove.', outcome: '' });
    const rs = seed['rangeSummaries/r0_120'];
    seed['rangeSummaries/r2_110'] = Object.assign(JSON.parse(JSON.stringify(rs)), { fromI: 2, toI: 110 });
    seed.__opts = { promptMax: 24576 };
    const p = await hopen(seed, 400);
    const r = await hask(p, 'Who ran the strap order?', true);
    const { dig, raw } = parts(r.prompt);
    const check = await p.evaluate(
      ([dig, rawLo]) => {
        const text = dig.map(d => d[2]);
        const sum = new Map(S.summary.convs.map(c => [c.id, c]));
        const rs = new Map(S.rangeSums.r0_120.convs.map(c => [c.id, c]));
        const out = { summary: 0, range: 0, none: 0, bad: [], dup: [] };
        S.threading.convs.forEach(c => {
          const mem = c.members.filter(i => S.byI.has(i) && i < rawLo);
          if (!mem.length || mem[0] >= rawLo) return;
          const pre = '[#' + mem[0] + (mem.length > 1 ? '–#' + mem[mem.length - 1] : '');
          const ls = text.filter(l => l.startsWith(pre) && l.includes(trunc(c.title, 80)));
          if (ls.length !== 1) return ls.length > 1 && out.dup.push(c.id);
          const s = sum.get(c.id),
            g = rs.get(c.id);
          const want = sumText(s)
            ? (out.summary++, trunc(sumText(s), 160))
            : g
              ? (out.range++, g.outcome)
              : (out.none++, 'no summary; ');
          if (!ls[0].includes(want)) out.bad.push(c.id + ': ' + ls[0]);
        });
        return out;
      },
      [dig, raw[0]],
    );
    ok(
      check.summary > 0 && check.range > 0 && check.none > 0 && !check.bad.length && !check.dup.length,
      'H8: conversation lines come from the summary (' +
        check.summary +
        '), a range summary (' +
        check.range +
        ') or threading alone, "no summary" (' +
        check.none +
        ') ' +
        JSON.stringify(check.bad.slice(0, 2)),
    );
    ok(
      r.prompt.includes('A plain text synopsis about the lake trip stove.'),
      'H8: an old plain-text synopsis is used as it is',
    );
    const orphan = dig.filter(([, , l]) => l.includes('Orphan outcome: straps ordered'));
    ok(
      orphan.length === 1 &&
        orphan[0][0] === 12 &&
        orphan[0][1] === 100 &&
        / Group buy: Orphan outcome/.test(orphan[0][2]),
      'H8: a range-summary conversation threading lacks is placed by the numbers it cites, once, though two range summaries carry it (' +
        (orphan[0] || [])[2] +
        ')',
    );
    const low = dig.filter(([, b, l]) => b < 60 && /\] \d+ messages?[.,]/.test(l));
    ok(
      low.length > 0 &&
        low.every(([, , l]) => /not grouped/i.test(l)) &&
        (r.prompt.match(/Loose outcome/g) || []).length === 1,
      'H8: the stretch threading never reached (before #60) reads "not grouped" (' +
        low.map(x => x[2].slice(0, 40)).join(' | ') +
        ')',
    );
    ok(p.errors.length === 0, 'H8: no page errors ' + JSON.stringify(p.errors));
    await p.close();
  });

  /* H9: chat turns trimmed oldest pair first, the instructions kept; a question too long is never sent */
  await hcase('H9', async () => {
    const p = await hopen(
      hseed(hmsgs(20), {
        meta: { markerMode: null },
        opts: { promptMax: 65536, answer: 'Long answer [#1]. ' + 'x'.repeat(12000) },
      }),
      20,
    );
    const qs = ['first?', 'second?', 'third?', 'fourth?', 'fifth?'];
    const res = [];
    for (const q of qs) res.push(await hask(p, q));
    const fine = res.every((r, k) => {
      const t = r.turns;
      const users = t
        .slice(1)
        .filter(x => x.role === 'user')
        .map(x => x.content);
      const want = qs.slice(k + 1 - users.length, k + 1);
      return (
        r.calls.length === 1 &&
        r.calls[0].bytes <= 65536 &&
        t[0].role === 'user' &&
        t[0].content.startsWith('You are helping Sam') &&
        t[t.length - 1].content === qs[k] &&
        t.slice(1).every((x, j) => x.role === (j % 2 ? 'assistant' : 'user')) &&
        JSON.stringify(users) === JSON.stringify(want)
      );
    });
    ok(
      fine && res[1].turns.length === 4 && res[4].turns.length < 2 * 5,
      'H9: every call within the cap, the instructions first, the new question last, turns alternating, the oldest pairs dropped (' +
        res.map(r => r.turns.length).join(', ') +
        ' turns)',
    );
    const before = await p.evaluate(() => __rt.sampleLog.length);
    const big = await hask(p, 'Is this too long? ' + 'y'.repeat(40 * 1024));
    ok(
      big.calls.length === 0 &&
        (await p.evaluate(() => __rt.sampleLog.length)) === before &&
        /too long to send/.test(big.askNote),
      'H9: a 40 KiB question at a 64 KiB cap is never sent: "' + big.askNote + '"',
    );
    await p.close();
  });

  /* H10: bytes, not characters */
  await hcase('H10', async () => {
    const p = await hopen(
      hseed(hmsgs(300, { body: i => i + ' 🏕️⛺ 山の上で会いましょう、テントを持ってきて ' + '🔥'.repeat(5) }), {
        meta: { caughtUpI: 290 },
        opts: { promptMax: 16384 },
      }),
      300,
    );
    const r = await hask(p, 'Where do we meet?', true);
    const chars = r.turns.reduce((n, t) => n + t.content.length, 0);
    ok(
      r.calls.length === 1 &&
        r.calls[0].code === null &&
        r.calls[0].bytes <= 16384 - HMARGIN &&
        chars < 0.7 * r.calls[0].bytes,
      'H10: emoji and CJK are measured in UTF-8 bytes: ' +
        r.calls[0].bytes +
        ' bytes in ' +
        chars +
        ' characters, within 16 KiB',
    );
    await p.close();
  });

  /* H11, H12: limits() missing, failing or absurd; a stricter runtime; one retry */
  await hcase('H11, H12', async () => {
    const big = hmsgs(2000, {
      perDay: 460,
      body: i => 'message ' + i + ' ' + 'about the ridge trail permits and the spare tent poles '.repeat(2),
    });
    for (const [label, opts, lo, hi] of [
      ['limits() missing', { noLimits: true }, 200000, 262144 - HMARGIN],
      ['limits() rejecting', { limitsReject: true }, 200000, 262144 - HMARGIN],
      ['limits() answering nonsense', { limitsBogus: true }, 200000, 262144 - HMARGIN],
      ['a 50,000-byte cap', { promptMax: 50000 }, 30000, 50000 - HMARGIN],
    ]) {
      const p = await hopen(hseed(big, { threads: true, meta: { caughtUpI: 1969 }, opts }), 2000);
      const r = await hask(p, 'Permits?', true);
      const b = r.calls.length === 1 && r.calls[0].code === null ? r.calls[0].bytes : -1;
      ok(
        b > lo && b <= hi,
        'H11: ' + label + ': include older at 2,000 messages sends ' + b + ' bytes (' + lo + '–' + hi + ')',
      );
      await p.close();
    }
    {
      let p = await hopen(
        hseed(big, { threads: true, meta: { caughtUpI: 1969 }, opts: { enforce: 262144 - 20480 } }),
        2000,
      );
      let r = await hask(p, 'Permits?', true);
      ok(
        r.calls.length === 2 &&
          r.calls[0].code === 'prompt_too_large' &&
          r.calls[1].code === null &&
          r.calls[1].bytes < r.calls[0].bytes &&
          r.calls[1].bytes <= 262144 - 20480 &&
          /Ben offered one/.test(r.answer) &&
          r.note.includes('(sent a smaller set: the first was too large)'),
        'H12: a runtime stricter than it says: one retry, smaller (' +
          r.calls.map(c => c.bytes).join(' → ') +
          '), answered, and the note says so',
      );
      await p.close();
      p = await hopen(hseed(big, { threads: true, meta: { caughtUpI: 1969 }, opts: { enforce: 1024 } }), 2000);
      r = await hask(p, 'Permits?', true);
      ok(
        r.calls.length === 2 &&
          r.calls.every(c => c.code === 'prompt_too_large') &&
          /Too much to send at once, even trimmed/.test(r.askNote),
        'H12: refused twice: exactly 2 calls, never a third, and "' + r.askNote + '"',
      );
      await p.close();
    }
  });
}
/* history, continued: a section of its own, so the two halves run in parallel */
async function history2() {
  /* H5b: real membership at 2,000 messages, the two layouts a review measured missing messages with */
  await hcase('H5b', async () => {
    for (const [label, th, cap] of [
      ['four conversations sharing each block of 40', { interleave: true }, 65536],
      ['four conversations sharing each block of 40', { interleave: true }, 20480],
      ['four conversations sharing each block of 40', { interleave: true }, 28672],
      [
        'four conversations sharing each block of 40, and one running #50–#1900',
        { interleave: true, long: [50, 1900] },
        16384,
      ],
      ['blocks of 10 and one conversation running #50–#1900', { long: [50, 1900] }, 12288],
    ]) {
      const p = await hopen(
        hseed(hmsgs(2000, { perDay: 460 }), { threads: th, meta: { caughtUpI: 1969 }, opts: { promptMax: cap } }),
        2000,
      );
      const r = await hask(p, 'Permits?', true);
      const { dig, raw } = parts(r.prompt);
      const c = raw[0];
      const missing = uncovered(dig, hthreads(2000, th).threading.convs, c);
      ok(
        r.calls.length === 1 &&
          r.calls[0].code === null &&
          dig.length > 0 &&
          missing.length === 0 &&
          dig.every(([, b]) => b < c),
        'H5b: ' +
          label +
          ' at ' +
          cap / 1024 +
          ' KiB: each of the ' +
          c +
          ' older messages is in some line (' +
          missing.length +
          ' missing)',
      );
      await p.close();
    }
  });

  /* H7b: an ungrouped run cut short by the second pass ends on the date of its last message */
  await hcase('H7b', async () => {
    const msgs = hmsgs(800, { perDay: 100 });
    const p = await hopen(hseed(msgs, { meta: { caughtUpI: 789 }, opts: { promptMax: 32768 } }), 800);
    const r = await hask(p, 'Anything?', true);
    const { dig } = parts(r.prompt);
    const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dayOf = d => MONS[+d.slice(5, 7) - 1] + ' ' + +d.slice(8, 10);
    const span = (x, y) =>
      x === y
        ? dayOf(x)
        : dayOf(x).slice(0, 3) === dayOf(y).slice(0, 3)
          ? dayOf(x) + '–' + dayOf(y).slice(4)
          : dayOf(x) + '–' + dayOf(y);
    const runs = dig.filter(([, , l]) => /not grouped\.$/.test(l) && /messages, not grouped/.test(l));
    const bad = runs.filter(([a, b, l]) => !l.includes(', ' + span(msgs[a].d, msgs[b].d) + '] '));
    ok(
      runs.length > 0 && !bad.length,
      'H7b: an ungrouped run gives the dates of its own first and last message (' + (bad[0] || runs[0] || [])[2] + ')',
    );
    await p.close();
  });

  /* H9b: Views checks the request's length; a prompt whose fixed text can't fit is refused on the page, never sent;
     a second click while a question is on its way sends nothing more */
  await hcase('H9b', async () => {
    let p = await hopen(hseed(hmsgs(20), { meta: { markerMode: null }, opts: { promptMax: 65536 } }), 20);
    await p.evaluate(() => {
      location.hash = '#views';
      document.getElementById('view-in').value = 'Group by person ' + 'z'.repeat(40 * 1024);
      document.getElementById('view-go').click();
    });
    await until(
      p,
      () =>
        !document.getElementById('view-go').disabled &&
        /too long|By person/.test(
          document.getElementById('view-note').textContent + document.getElementById('view-out').textContent,
        ),
    );
    const vn = await p.textContent('#view-note');
    ok(
      (await p.evaluate(() => __rt.sampleLog.length)) === 0 && /That request is too long to send/.test(vn),
      'H9b: a 40 KiB view request at a 64 KiB cap is never sent: "' + vn + '"',
    );
    await p.close();
    p = await hopen(hseed(hmsgs(20), { meta: { markerMode: null }, opts: { promptMax: 9216 } }), 20);
    const r = await hask(p, 'Long? ' + 'q'.repeat(4500));
    ok(
      r.calls.length === 0 && /too long to send, even with the chat trimmed/.test(r.askNote),
      'H9b: at a 9 KiB cap a 4.5 KB question leaves no room for the instructions: refused on the page, no call ("' +
        r.askNote +
        '")',
    );
    await p.close();
    p = await hopen(hseed(hmsgs(20), { meta: { markerMode: null } }), 20);
    await p.evaluate(() => {
      location.hash = '#ask';
      document.getElementById('ask-in').value = 'Twice?';
      const b = document.getElementById('ask-go');
      b.click();
      b.click();
    });
    await sleep(1500);
    const n = await p.evaluate(() => [__rt.sampleLog.length, document.querySelectorAll('#chat .turn.user').length]);
    ok(
      n[0] === 1 && n[1] === 1,
      'H9b: two quick clicks on Ask send one question (' + n.join(' calls, ') + ' questions shown)',
    );
    await p.close();
  });

  /* H10b: cuts by code point: an emoji at a cut is never split into half a character */
  await hcase('H10b', async () => {
    const msgs = hmsgs(200, { perDay: 50 });
    Object.assign(msgs[195], { r: 'Ben', q: 'a'.repeat(119) + '🔥 tail', a: 'b'.repeat(239) + '🔥 more' });
    const title = 'c'.repeat(38) + '🔥' + 'c'.repeat(38) + '🔥 tail';
    const seed = hseed(msgs, { threads: true, meta: { caughtUpI: 189 }, opts: { promptMax: 12288 } });
    seed['threading/current'].convs[0].title = title;
    seed['summary/current'].convs.find(c => c.id === 'c0').outcome = 'd'.repeat(158) + '🔥 end';
    const p = await hopen(seed, 200);
    await hask(p, 'Emoji?', true);
    const r = await p.evaluate(t => {
      const s = __rt.samples[__rt.samples.length - 1][0].content;
      return {
        lone: /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s),
        title: s.includes(t.slice(0, 38) + '🔥'),
        quote: s.includes('a'.repeat(119) + '🔥'),
      };
    }, title);
    ok(
      !r.lone && r.title && r.quote,
      'H10b: titles, outcomes, quotes and link previews cut at an emoji keep it whole ' + JSON.stringify(r),
    );
    await p.close();
  });

  /* H11b, H12b: limits() overstating or understating the cap, or never answering; the retry follows what was sent */
  await hcase('H11b, H12b', async () => {
    const big = hmsgs(2000, {
      perDay: 460,
      body: i => 'message ' + i + ' ' + 'about the ridge trail permits and the spare tent poles '.repeat(2),
    });
    for (const [label, opts] of [
      ['limits() overstating the cap (1e9) against a real 256 KiB', { promptMax: 1e9, enforce: 262144 }],
      ['limits() answering a tiny number (100)', { promptMax: 100, enforce: 262144 }],
      ['limits() never answering', { limitsHang: true }],
    ]) {
      const p = await hopen(hseed(big, { threads: true, meta: { caughtUpI: 1969 }, opts }), 2000);
      const r = await hask(p, 'Permits?', true);
      const b = r.calls.length === 1 && r.calls[0].code === null ? r.calls[0].bytes : -1;
      ok(b > 200000 && b <= 262144 - HMARGIN, 'H11b: ' + label + ': one call of ' + b + ' bytes, within 262,144');
      await p.close();
    }
    /* a history smaller than the cap, refused by a stricter runtime: the retry must be smaller than what was sent */
    const small = big.slice(0, 1000);
    let p = await hopen(hseed(small, { threads: true, meta: { caughtUpI: 969 } }), 1000);
    const B = (await hask(p, 'Permits?', true)).calls[0].bytes;
    await p.close();
    p = await hopen(
      hseed(small, { threads: true, meta: { caughtUpI: 969 }, opts: { enforce: Math.floor(B * 0.9) } }),
      1000,
    );
    const r = await hask(p, 'Permits?', true);
    ok(
      r.calls.length === 2 &&
        r.calls[0].code === 'prompt_too_large' &&
        r.calls[1].code === null &&
        r.calls[1].bytes <= 0.8 * B,
      'H12b: everything fit in ' +
        B +
        ' bytes but the runtime took at most 90% of that: the retry sends ' +
        r.calls.map(c => c.bytes).join(' → '),
    );
    await p.close();
  });

  /* H14b, H13b: a date range with an end, older messages included: newer summaries are recorded as afterFrom, never
     as sumFrom; a citation into them says the message is after the window; their lines can't push the window out */
  await hcase('H14b, H13b', async () => {
    const msgs = hmsgs(3000, { perDay: 10 });
    const meta = { markerMode: 'time', markerFrom: '2026-10-11T00:00', markerTo: '2026-10-20T23:59' };
    let p = await hopen(hseed(msgs, { threads: true, meta, opts: { answer: 'A later sale [#250].' } }), 3000);
    const r = await hask(p, 'What sold?', true);
    const qa = await until(p, () => Object.values(Object.fromEntries(__rt.store)).find(v => v && v.q === 'What sold?'));
    const sent = qa && qa.sent;
    ok(
      sent &&
        sent.from === 0 &&
        sent.to === 199 &&
        sent.sumFrom === null &&
        sent.afterFrom === 200 &&
        r.note.includes('Newer than #199: summaries only.'),
      'H14b: all older messages word for word, newer ones summarized: sent ' +
        JSON.stringify(sent) +
        ' ("' +
        r.note +
        '")',
    );
    const list = await p.textContent('#qa-list');
    ok(
      list.includes('#0–#199 word for word, newer as summaries from #200') && !list.includes('older as summaries'),
      'H14b: Earlier questions says the summaries were of newer messages',
    );
    await p.click('#chat .turn.assistant a.cite');
    const older = await until(p, () => {
      const o = document.getElementById('msg-older');
      return o && !o.hidden && document.getElementById('m250') && o.textContent;
    });
    ok(
      /after your catch-up window/.test(older || ''),
      'H13b: a citation into the newer summaries says the message is after the window: "' + older + '"',
    );
    await p.close();
    p = await hopen(hseed(msgs, { threads: true, meta, opts: { promptMax: 16384 } }), 3000);
    const r2 = await hask(p, 'What sold?', true);
    const X = parts(r2.prompt);
    const newerB = X.newer.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
    ok(
      X.raw.includes(199) &&
        X.raw.length >= 20 &&
        newerB <= 0.1 * 16384 &&
        /Nothing after #\d+ is included/.test(r2.prompt),
      'H14b: at 16 KiB, 280 days of newer lines take ' +
        newerB +
        ' bytes (at most 10%) and the window stays word for word (' +
        X.raw.length +
        ' messages, to #199)',
    );
    await p.close();
  });

  /* B51: a view reply that says kind "idea" is still saved as a view, so it can't pose as a method idea */
  await hcase('B51', async () => {
    const p = await hopen(
      hseed(hmsgs(20), {
        meta: { markerMode: null },
        opts: { viewJson: { kind: 'idea', title: 'Sneaky', intro: 'x', sections: [] } },
      }),
      20,
    );
    await p.evaluate(() => {
      location.hash = '#views';
      document.getElementById('view-in').value = 'group by person';
      document.getElementById('view-go').click();
    });
    const v = await until(p, () => Object.values(Object.fromEntries(__rt.store)).find(v => v && v.title === 'Sneaky'));
    ok(
      v && v.kind === 'view',
      'B51: a built view is saved with kind "view" whatever the reply says (' + (v && v.kind) + ')',
    );
    await p.close();
  });

  /* H15 (a range summary too long for one call was refused) is gone since F18: see longRanges, which reads it in parts */

  /* H16: scale, counted: 25,000 messages (50,000 too with PERF=1) */
  await hcase('H16', async () => {
    for (const n of process.env.PERF ? [25000, 50000] : [25000]) {
      const { seed } = synthSeed(n, 1000, [], { markerMode: 'caught', caughtUpI: n - 151 });
      const p = await hopen(seed, n);
      await p.evaluate(() => {
        const real = S.msgs;
        window.__cnt = { lineFor: 0, reads: 0 };
        const orig = window.lineFor;
        window.lineFor = function () {
          __cnt.lineFor++;
          return orig.apply(this, arguments);
        };
        S.msgs = new Proxy(real, {
          get(t, k, rcv) {
            if (typeof k === 'string' && /^\d+$/.test(k)) __cnt.reads++;
            return Reflect.get(t, k, rcv);
          },
        });
      });
      const r = await hask(p, 'Who organized the group buy?', true);
      const cnt = await p.evaluate(() => __cnt);
      const { dig, raw } = parts(r.prompt);
      ok(
        r.calls.length === 1 &&
          r.calls[0].bytes <= 262144 - HMARGIN &&
          raw[raw.length - 1] === n - 1 &&
          contiguous(raw) &&
          dig[0][0] === 0,
        'H16: ' +
          n +
          ' messages, include older: ' +
          r.calls[0].bytes +
          ' bytes, #' +
          raw[0] +
          '–#' +
          (n - 1) +
          ' word for word, summaries from #0',
      );
      ok(
        cnt.lineFor <= raw.length + 2 && cnt.reads <= 4 * n,
        'H16: packing calls lineFor ' +
          cnt.lineFor +
          ' times for ' +
          raw.length +
          ' lines and reads S.msgs ' +
          (cnt.reads / n).toFixed(2) +
          '× per message (at most 4)',
      );
      await p.close();
    }
  });
}

/* ---------- digests: per-day digests in Ask's older history (F16) ----------
   catchup.py writes digests/m<YYYY-MM> {month, days:{day: {bullets:[{t, refs}], fromI, toI, n, at}}}; the page only
   reads them. A day line takes its digest when it covers the whole day the digest was written for; title-only day lines
   stay the floor, so every older message is still in some line, within the same budget. */
/* digest documents for the days of msgs that keep(k, day, ids) picks; make(k, ids) gives a day's bullets */
function hdigests(msgs, keep = () => true, make) {
  const by = new Map();
  msgs.forEach(m => (by.has(m.d) ? by.get(m.d).push(m.i) : by.set(m.d, [m.i])));
  const docs = {};
  [...by].forEach(([d, ids], k) => {
    if (!keep(k, d, ids)) return;
    const id = 'digests/m' + d.slice(0, 7);
    docs[id] = docs[id] || { month: d.slice(0, 7), days: {} };
    docs[id].days[d] = {
      bullets: make
        ? make(k, ids)
        : [
            { t: 'Ana sold a stove on day ' + k, refs: [ids[1], ids[2]] },
            { t: 'Ben asked about permits on day ' + k, refs: [ids[5]] },
          ],
      fromI: ids[0],
      toI: ids[ids.length - 1],
      n: ids.length,
      at: 'Thu Nov 12, 9:00 AM',
    };
  });
  return docs;
}
/* the day of each message and each day's first and last number */
function hdays(msgs) {
  const span = new Map();
  msgs.forEach(m => {
    const s = span.get(m.d);
    if (s) s[1] = m.i;
    else span.set(m.d, [m.i, m.i]);
  });
  return span;
}
/* the page has read n days' digests (an older page has no S.digests: go on, so its checks fail on what it sends) */
/* the summary lines that are a conversation's (not a day line, not an ungrouped run) */
const convLines = dig => dig.filter(([, , l]) => !/\] [\d,]+ messages?(\.|, not grouped)/.test(l));
const D3SMALL = 16384; /* conversation lines fit, no long digest does */
const D5CAP = 65536; /* conversation lines fit; the room over the floor is smaller than one digest */
const dgLoaded = (p, n) => until(p, n => !S.digests || S.digests.size === n, n);
const digestLines = dig => dig.filter(([, , l]) => /\] [\d,]+ messages?\. Digest: /.test(l));
const citedIn = l => (l.match(/\[#\d+(?:, #\d+)*\]/g) || []).flatMap(x => x.match(/\d+/g).map(Number));

async function digests() {
  /* D1: no digests: title-only day lines as before; digests written later are used by the next question, within the
     same cap, every older message still in a line, and the note and the saved row say so */
  await hcase('D1', async () => {
    const msgs = hmsgs(800, { perDay: 134 });
    const span = hdays(msgs);
    const p = await hopen(hseed(msgs, { threads: true, meta: { caughtUpI: 789 }, opts: { promptMax: 16384 } }), 800);
    let r = await hask(p, 'Anything about permits?', true);
    let { dig, raw } = parts(r.prompt);
    ok(
      dig.length > 0 &&
        digestLines(dig).length === 0 &&
        dig.some(([, , l]) => /\] \d+ messages\. Busiest: /.test(l)) &&
        !/Digest:|Day digests/.test(r.prompt + r.note),
      'D1: with no digests, the day lines are title-only as before ("Busiest: …") and nothing mentions digests',
    );
    await p.evaluate(docs => Object.entries(docs).forEach(([k, v]) => __rt.write(k, v)), hdigests(msgs));
    await dgLoaded(p, 6);
    const w0 = await p.evaluate(() => __rt.writes.length);
    r = await hask(p, 'Who sold a stove?', true);
    ({ dig, raw } = parts(r.prompt));
    const c = raw[0];
    const dl = digestLines(dig);
    ok(
      r.calls.length === 1 && r.calls[0].bytes <= 16384 - HMARGIN && dl.length > 0,
      'D1: with digests, ' +
        dl.length +
        ' day lines carry one, in one call of ' +
        r.calls[0].bytes +
        ' bytes (cap 16 KiB less the margin)',
    );
    ok(
      dl.every(([a, b, l]) => {
        const d = msgs[a].d,
          k = Math.floor(a / 134);
        const cites = citedIn(l.slice(l.indexOf('Digest: ')));
        return (
          span.get(d)[0] === a &&
          span.get(d)[1] === b &&
          l.includes('Ana sold a stove on day ' + k + ' [#' + (a + 1) + ', #' + (a + 2) + ']') &&
          l.includes(' | Ben asked about permits on day ' + k + ' [#' + (a + 5) + ']') &&
          cites.length === 3 &&
          cites.every(i => i >= a && i <= b)
        );
      }),
      "D1: each digest line spans its whole day and cites that day's messages after each bullet",
    );
    const missing = uncovered(dig, hthreads(800).threading.convs, c);
    ok(
      dig[0][0] === 0 && missing.length === 0 && dig.every(([, b]) => b < c),
      'D1: every message before #' + c + ' is still in a line (' + missing.length + ' missing), none reaches #' + c,
    );
    const n = dl.length,
      from = n ? dl[0][0] : -1,
      to = n ? dl[n - 1][1] : -1;
    const days = (a, b) => {
      if (a < 0) return '';
      const x = msgs[a].d.slice(5).split('-').map(Number),
        y = msgs[b].d.slice(5).split('-').map(Number);
      const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return x.join() === y.join()
        ? M[x[0] - 1] + ' ' + x[1]
        : M[x[0] - 1] + ' ' + x[1] + '–' + (x[0] === y[0] ? '' : M[y[0] - 1] + ' ') + y[1];
    };
    ok(
      r.prompt.includes(
        'The day lines from #' + from + ' to #' + to + ' that say Digest: carry a few bullets on that day',
      ) && r.note.includes(' Day digests for ' + n + ' day' + (n === 1 ? '' : 's') + ' (' + days(from, to) + ').'),
      'D1: "What you have" and the note say which day lines carry digests ("' + r.note + '")',
    );
    const qa = await until(p, () =>
      Object.entries(Object.fromEntries(__rt.store)).find(
        ([k, v]) => k.startsWith('qa/a') && v.q === 'Who sold a stove?',
      ),
    );
    const sent = qa && qa[1].sent;
    ok(
      sent &&
        sent.from === c &&
        sent.digests &&
        sent.digests.n === n &&
        sent.digests.from === from &&
        sent.digests.to === to,
      'D1: the qa row saves sent.digests ' + JSON.stringify(sent && sent.digests),
    );
    ok(
      (await p.textContent('#qa-list')).includes(', day digests #' + from + '–#' + to),
      'D1: Earlier questions says digests were used',
    );
    ok(
      !(await p.evaluate(w0 => __rt.writes.slice(w0).some(w => w.p.startsWith('digests/')), w0)),
      'D1: the page never writes digests',
    );
    ok(p.errors.length === 0, 'D1: no page errors ' + JSON.stringify(p.errors));
  });

  /* D2: a day without a digest, one written for another span, one citing only other days or unstored numbers, and
     one with a bad bullet: each falls back to title-only or keeps only what it may cite */
  await hcase('D2', async () => {
    const msgs = hmsgs(800, { perDay: 100 });
    const docs = hdigests(
      msgs,
      k => k !== 1,
      (k, ids) =>
        k === 2
          ? [{ t: 'Too early', refs: [ids[1]] }]
          : k === 4
            ? [{ t: 'Elsewhere', refs: [5, 99999] }]
            : k === 5
              ? [
                  { t: 'Mixed refs', refs: [5, ids[3], ids[3] + 1000] },
                  { t: 'No list', refs: 'x' },
                  { t: 7, refs: [ids[1]] },
                ]
              : k === 3
                ? [
                    { t: 'Plain\n day   3 end\u0001', refs: [ids[2]] },
                    { t: 'Long '.repeat(100), refs: [ids[3]] },
                  ]
                : [{ t: 'Plain day ' + k, refs: [ids[2]] }],
    );
    const d2 = msgs[200].d;
    docs['digests/m' + d2.slice(0, 7)].days[d2].fromI = 199; /* claims a day that started a message earlier */
    const p = await hopen(
      hseed(msgs, { threads: true, meta: { caughtUpI: 789 }, opts: { promptMax: 12288 }, docs }),
      800,
    );
    await dgLoaded(p, 7);
    const r = await hask(p, 'What happened?', true);
    const { dig } = parts(r.prompt);
    const dayLine = k => dig.find(([a, b, l]) => a === k * 100 && b === k * 100 + 99 && /\] 100 messages\./.test(l));
    const kinds = [0, 1, 2, 3, 4, 5].map(k => {
      const x = dayLine(k);
      return x ? (/Digest: /.test(x[2]) ? 'D' : /Busiest: |Not grouped/.test(x[2]) ? 'T' : '?') : '-';
    });
    ok(
      kinds.join('') === 'DTTDTD',
      'D2: days 0, 3 and 5 carry their digest; day 1 (none), 2 (written for another span) and 4 (cites nothing of its own) are title-only: ' +
        kinds.join(''),
    );
    const five = dayLine(5);
    ok(
      five && five[2].endsWith('100 messages. Digest: Mixed refs [#503]'),
      'D2: a bullet keeps only the numbers of its own day, and bullets with bad fields are left out: ' +
        (five && five[2]),
    );
    const three = dayLine(3);
    const long = 'Long '.repeat(100).trim().slice(0, 239) + '…';
    ok(
      three && three[2].endsWith('100 messages. Digest: Plain day 3 end [#302] | ' + long + ' [#303]'),
      'D2: a bullet is one line, its spaces collapsed, cut to 240 characters: ' + (three && three[2].slice(0, 90)),
    );
    /* the day the cut splits (#600 on, part of it in conversation lines) keeps its title-only line */
    const span = hdays(msgs);
    const split = dig.filter(([a, b, l]) => /\] [\d,]+ messages?\./.test(l) && span.get(msgs[a].d)[1] > b);
    ok(
      split.length === 1 && split[0][0] === 600 && !/Digest: /.test(split[0][2]),
      'D2: the day split by the cut is title-only, though it has a digest: ' + split.map(x => x[2].slice(0, 60)),
    );
    ok(r.calls.length === 1 && r.calls[0].bytes <= 12288 - HMARGIN, 'D2: one call within the cap');
    ok(p.errors.length === 0, 'D2: no page errors ' + JSON.stringify(p.errors));
  });

  /* D3: long digests at a small cap and a larger one: within the cap, and they never push older days out: the first line is the same
     as without digests (title-only lines are the floor) */
  await hcase('D3', async () => {
    const msgs = hmsgs(800, { perDay: 20 });
    const long = (k, ids) =>
      Array.from({ length: 8 }, (_, j) => ({
        t: ('Day ' + k + ' bullet ' + j + ' about the long ridge trail permits and the spare tent poles ')
          .repeat(3)
          .slice(0, 238),
        refs: ids.slice(j, j + 10),
      }));
    const first = {},
      convs = {};
    for (const [label, docs] of [
      ['without', {}],
      ['with', hdigests(msgs, () => true, long)],
    ]) {
      for (const cap of [D3SMALL, 32768]) {
        const p = await hopen(
          hseed(msgs, { threads: true, meta: { caughtUpI: 789 }, opts: { promptMax: cap }, docs }),
          800,
        );
        if (label === 'with') await dgLoaded(p, 40);
        const r = await hask(p, 'Anything about permits?', true);
        const { dig, raw } = parts(r.prompt);
        first[label + cap] = dig.length ? dig[0][0] : null;
        convs[label + cap] = convLines(dig).length;
        ok(
          r.calls.length === 1 && r.calls[0].bytes <= cap - HMARGIN,
          'D3: ' + label + ' digests at ' + cap + ': one call of ' + r.calls[0].bytes + ' bytes',
        );
        if (label === 'with') {
          const dl = digestLines(dig);
          /* at 16 KiB the digests' room (half the summaries' share) is smaller than one of these long ones */
          ok(
            (cap < 32768 || dl.length > 0) &&
              dl.every(([a, b, l]) => citedIn(l.slice(l.indexOf('Digest: '))).every(i => i >= a && i <= b)),
            'D3: at ' +
              cap +
              ', ' +
              dl.length +
              ' of ' +
              dig.filter(([, , l]) => /\] \d+ messages\./.test(l)).length +
              ' day lines carry a digest, each citing only its day',
          );
          const missing = first['without' + cap] === 0 ? uncovered(dig, hthreads(800).threading.convs, raw[0]) : [];
          ok(
            first['with' + cap] === first['without' + cap] && missing.length === 0,
            'D3: at ' +
              cap +
              ' the summaries start at #' +
              first['with' + cap] +
              ' with digests, #' +
              first['without' + cap] +
              ' without; ' +
              missing.length +
              ' messages missing',
          );
          /* no digest fits at 16 KiB: none holds room back from conversation lines */
          if (cap < 32768)
            ok(
              dl.length === 0 && convs['with' + cap] === convs['without' + cap] && convs['with' + cap] > 0,
              'D3: at ' +
                cap +
                ', with no digest fitting, ' +
                convs['with' + cap] +
                ' conversation lines, as without digests (' +
                convs['without' + cap] +
                ')',
            );
          /* every whole day before the cut that's newer than a digest line carries one too: newest day first */
          const span = hdays(msgs);
          const whole = dig.filter(([a, b, l]) => /\] [\d,]+ messages?\./.test(l) && span.get(msgs[a].d)[1] === b);
          const firstDg = whole.findIndex(([, , l]) => /Digest: /.test(l));
          ok(
            cap < 32768 ||
              (firstDg > 0 && whole.slice(firstDg).every(([, , l]) => /Digest: /.test(l)) && convs['with' + cap] > 0),
            'D3: at ' +
              cap +
              ', the digests are the newest ' +
              (firstDg < 0 ? 0 : whole.length - firstDg) +
              ' of ' +
              whole.length +
              ' whole day lines, beside ' +
              convs['with' + cap] +
              ' conversation lines',
          );
        }
        await p.close();
      }
    }
  });

  /* D6: the browser's zone changed between captures, so #150 is dated the day before #149. A day never goes back:
     #150 counts in Oct 2, as catchup.py counts it, and Oct 2's digest (#100-#199) is shown */
  await hcase('D6', async () => {
    const msgs = hmsgs(300, { perDay: 100 });
    msgs[150].d = msgs[0].d;
    const docs = hdigests(msgs.map((m, k) => (k === 150 ? Object.assign({}, m, { d: msgs[100].d }) : m)));
    const p = await hopen(hseed(msgs, { threads: true, docs }), 300);
    await dgLoaded(p, 3);
    const ls = await p.evaluate(() => (typeof dayLines === 'function' ? dayLines(0, 299) : []));
    ok(
      ls.length === 3 &&
        ls.every(l => l.dg) &&
        ls[1].text.startsWith('[#100–#199, Oct 2] 100 messages. Digest: Ana sold a stove on day 1'),
      'D6: a message dated back a day counts in the day before it, so each day keeps its digest: ' +
        ls.map(l => l.text.slice(0, 40)).join(' / '),
    );
    ok(p.errors.length === 0, 'D6: no page errors ' + JSON.stringify(p.errors));
  });

  /* D5: a digest that fits the digests' share but not the room left over the title-only floor holds nothing back:
     the conversation lines are the same as without digests */
  await hcase('D5', async () => {
    const msgs = hmsgs(800, { perDay: 8 });
    const mid = (k, ids) =>
      Array.from({ length: 3 }, (_, j) => ({
        t: ('Day ' + k + ' bullet ' + j + ' about the ridge trail permits ').repeat(4).slice(0, 200),
        refs: ids.slice(j, j + 3),
      }));
    const got = {};
    for (const [label, docs] of [
      ['without', {}],
      ['with', hdigests(msgs, () => true, mid)],
    ]) {
      const p = await hopen(
        hseed(msgs, { threads: true, meta: { caughtUpI: 789 }, opts: { promptMax: D5CAP }, docs }),
        800,
      );
      if (label === 'with') await dgLoaded(p, 100);
      const r = await hask(p, 'Anything about permits?', true);
      const { dig } = parts(r.prompt);
      got[label] = { convs: convLines(dig).length, digests: digestLines(dig).length, bytes: r.calls[0].bytes };
      await p.close();
    }
    ok(
      got.with.digests === 0 && got.with.convs === got.without.convs && got.with.convs > 0,
      'D5: no digest fits the room over the floor, and the conversation lines are as without digests: ' +
        JSON.stringify(got),
    );
  });

  /* D4: dayLines(fromI, toI), for other prompts that summarize a stretch by day */
  await hcase('D4', async () => {
    const msgs = hmsgs(300, { perDay: 100 });
    const p = await hopen(hseed(msgs, { threads: true, docs: hdigests(msgs, k => k === 1) }), 300);
    await dgLoaded(p, 1);
    const ls = await p.evaluate(() =>
      typeof dayLines === 'function' ? [dayLines(0, 299), dayLines(150, 299), dayLines(5, 3)] : [[], [], []],
    );
    ok(
      ls[0].length === 3 &&
        ls[0].map(l => (l.dg ? 'D' : 'T')).join('') === 'TDT' &&
        ls[0][1].a === 100 &&
        ls[0][1].b === 199 &&
        ls[0][1].text.startsWith('[#100–#199, Oct 2] 100 messages. Digest: Ana sold a stove on day 1 [#101, #102]') &&
        ls[0].every(l => l.kind === 'day' && l.bytes === new TextEncoder().encode(l.text).length + 1),
      'D4: dayLines gives a line per day, the digest where a day has one: ' +
        ls[0].map(l => l.text.slice(0, 40)).join(' / '),
    );
    ok(
      ls[1].length === 2 && !ls[1][0].dg && ls[1][0].a === 150 && ls[2].length === 0,
      'D4: a stretch starting mid-day gets that day title-only (the digest covers the whole day); an empty stretch, nothing',
    );
    ok(p.errors.length === 0, 'D4: no page errors ' + JSON.stringify(p.errors));
  });
}

/* ---------- R2: photos stored as they upload ----------
   Each photo is indexed (photos/b<start>) the moment it lands, refresh/lastImport says "uploading" with a heartbeat
   while they store, owed slots are on record (null, and meta/chat.photosOwed), every upload error code has its own
   handling, and asset usage is recorded with each import. Timings are shortened with __mcImportTune. */
const TUNE = { beatMs: 200, leaseMs: 1500, uploadTimeoutMs: 1500, retryMs: 100, rateWaitMs: 300 };
/* distinct bytes per slot, so a photo uploaded twice shows up as two uploads with the same hash */
const phB64 = (i, k, pad = 0) =>
  Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from(' #' + i + '.' + k + ' '), Buffer.alloc(pad, 0x2e)]).toString(
    'base64',
  );
const PH = (i, k = 0, pad = 0) => ({ i, k, type: 'image/png', b64: phB64(i, k, pad) });
const openR2 = (extra = {}, opts = {}) =>
  open(Object.assign(SEED(), extra, { __opts: Object.assign({ tune: TUNE }, opts) }));
const setUp = (p, up) => p.evaluate(u => (window.__up = u), up);
const uploads = p => p.evaluate(() => __rt.uploads);
const writesTo = (p, re) => p.evaluate(src => __rt.writes.filter(w => new RegExp(src).test(w.p)).map(w => w.p), re);
const imports = p => p.evaluate(() => __rt.writes.filter(w => w.p === 'refresh/lastImport').map(w => w.v));
const toastText = p => p.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
const SIX = [PH(2), PH(3), PH(5), PH(5, 1), PH(7), PH(8)];
const capSix = () => JSON.stringify(cap(range(0, 9), { photos: SIX }));
async function photos() {
  // P1, P2, P4: six photos at 300 ms each
  let p = await openR2();
  await setUp(p, { delayMs: 300 });
  let r = await pasteFirst(p, capSix());
  ok(
    r &&
      r.state === 'uploading' &&
      r.ok &&
      r.fresh === 10 &&
      JSON.stringify(r.chunks) === '["c0000"]' &&
      r.photos &&
      r.photos.total === 6 &&
      r.photos.done === 0 &&
      (await get(p, 'meta/chat')).lastI === 9 &&
      /IMPORT OK: 10 new messages.*Storing photos \d\/6… keep this tab open/.test(await toastText(p)),
    'P1: the first lastImport after a paste with photos is "uploading" (messages saved, photos 0/6), the toast says ' +
      'keep this tab open (' +
      JSON.stringify(r && { state: r.state, photos: r.photos }) +
      ')',
  );
  await until(p, () => __rt.uploads.length >= 3);
  let st = await photoState(p);
  let up = await uploads(p);
  const owedMid = (await get(p, 'meta/chat')).photosOwed;
  ok(
    up.length >= 3 &&
      up.every(u => Object.values(st.byK).some(m => Object.values(m).includes('/_blob/' + u.id))) &&
      st.owed.length +
        up.filter(u => Object.values(st.byK).some(m => Object.values(m).includes('/_blob/' + u.id))).length ===
        6 &&
      owedMid &&
      owedMid.fromI === 2 &&
      owedMid.toI === 8,
    'P2: mid-upload, every photo that landed is already indexed in photos/b0, the rest are owed (null), and ' +
      'meta/chat.photosOwed covers them (' +
      up.length +
      ' landed, owed ' +
      st.owed +
      ')',
  );
  r = await until(p, () => (v => (v && v.state !== 'uploading' ? v : null))(__rt.get('refresh/lastImport')));
  up = await uploads(p);
  st = await photoState(p);
  ok(
    r &&
      r.state === 'done' &&
      r.stored.length === 6 &&
      r.stored.every(s => up.some(u => u.id === s.id) && st.byK[s.i][s.k] === '/_blob/' + s.id) &&
      /6 photos stored\./.test(r.msg) &&
      (await get(p, 'meta/chat')).photosOwed === null &&
      !st.owed.length &&
      (await writesTo(p, '^photos/index$')).length === 0 &&
      (await p.evaluate(() => __rt.leases.get('refresh/importLock').exp - Date.now() <= 1100)),
    'P4: done: stored lists the 6 {i,k,id}, photosOwed cleared, lease let go, photos/index never written (' +
      (r && r.msg) +
      ')',
  );
  ok(
    (await imports(p)).filter(v => v.state === 'uploading').every((v, k, a) => !k || v.beat >= a[k - 1].beat) &&
      (await imports(p)).filter(v => v.state !== 'uploading').length === 1,
    'P4: lastImport goes uploading (heartbeats) then one closing record',
  );
  await p.close();
  // P3: one slow upload still beats, and the lease moves forward
  p = await openR2();
  await setUp(p, { script: { 0: { delayMs: 1200 } } });
  await pasteFirst(p, JSON.stringify(cap(range(0, 2), { photos: [PH(1)] })));
  const l0 = await p.evaluate(() => __rt.leases.get('refresh/importLock').exp);
  await sleep(700);
  const l1 = await p.evaluate(() => __rt.leases.get('refresh/importLock').exp);
  await until(p, () => (__rt.get('refresh/lastImport') || {}).state === 'done');
  const beats = (await imports(p)).filter(v => v.state === 'uploading').map(v => v.beat);
  ok(
    beats.length >= 4 && beats.every((b, k) => !k || b > beats[k - 1]) && l1 > l0,
    'P3: during one 1.2 s upload the heartbeat wrote ' +
      beats.length +
      ' rising beats and the import lease moved forward',
  );
  await p.close();
  // P5: the tab closes after 4 uploads, with the 5th in flight; that one still lands (late, never indexed), and a new
  // tab on the same store finishes the job: only the photo in flight is stored twice
  const TEN = range(0, 9, i => PH(i));
  const capTen = JSON.stringify(cap(range(0, 9), { photos: TEN }));
  p = await openR2();
  await setUp(p, { delayMs: 50, script: { 4: { hang: 800 }, 5: { hang: 1e9 } } });
  pasteFirst(p, capTen).catch(() => {});
  await until(p, () => Object.values((__rt.get('photos/b0') || { byK: {} }).byK).filter(m => m[0]).length === 4);
  const snap = await p.evaluate(() => ({ all: __rt.all(), leases: Object.fromEntries(__rt.leases) }));
  await until(p, () => __rt.uploads.length === 5); /* the photo in flight lands after the tab "closed" (the snapshot) */
  const hashesA = (await uploads(p)).map(u => u.hash);
  await p.context().close();
  const p2 = await openR2(Object.assign({}, snap.all), { leases: snap.leases });
  st = await photoState(p2);
  ok(
    st.owed.length === 6 &&
      [0, 1, 2, 3].every(i => st.stored(i).length === 1) &&
      snap.all['refresh/lastImport'].state === 'uploading' &&
      snap.all['meta/chat'].photosOwed.n === 10,
    'P5: after the tab closed: the 4 photos that landed are indexed, 6 owed, lastImport stuck at uploading',
  );
  const w5 = (await writesTo(p2, '^(photos|chunks|meta)/')).length;
  r = await paste(p2, capTen);
  ok(
    r &&
      !r.ok &&
      /Another import is running .*\(after \d{1,2}:\d\d:\d\d [AP]M\)\./.test(r.msg) &&
      (await writesTo(p2, '^(photos|chunks|meta)/')).length === w5,
    'P5: pasting before the closed tab’s lease lapses: "Another import is running", the lease’s end to the second, ' +
      'nothing written (' +
      (r && r.msg) +
      ')',
  );
  await sleep(1600);
  r = await paste(p2, capTen);
  up = await uploads(p2);
  st = await photoState(p2);
  ok(
    r &&
      r.state === 'done' &&
      up.length === 6 &&
      hashesA.length === 5 &&
      new Set(up.map(u => u.hash).concat(hashesA)).size === 10 &&
      up.filter(u => hashesA.includes(u.hash)).length === 1 &&
      up[0].hash === hashesA[4] &&
      range(0, 9, i => i).every(i => st.stored(i).length === 1) &&
      /Nothing new.*6 photos stored \(4 already stored\)/.test(r.msg),
    'P5: once it lapses, the same paste in the new tab uploads exactly the 6 owed photos; only the one in flight when ' +
      'the tab closed is stored twice; all 10 indexed (' +
      (r && r.msg) +
      ')',
  );
  await p2.close();
  // P6: a second paste in the same tab while photos upload changes nothing
  p = await openR2();
  await setUp(p, { delayMs: 300 });
  await pasteFirst(p, capSix());
  await p.evaluate(t => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, capSix());
  const t6 = await toastText(p);
  await until(p, () => (__rt.get('refresh/lastImport') || {}).state === 'done');
  await sleep(500);
  ok(
    /Still storing photos from the last paste \(\d\/6\)… keep this tab open/.test(t6) &&
      (await uploads(p)).length === 6 &&
      (await imports(p)).filter(v => v.state !== 'uploading').length === 1,
    'P6: a second paste while uploading: toast "Still storing photos from the last paste (n/6)", no second import, ' +
      '6 uploads (' +
      t6 +
      ')',
  );
  await p.close();
  // P7: a capture with no photos: one record, as before
  p = await openR2();
  r = await paste(p, JSON.stringify(cap(range(0, 2))));
  ok(
    r &&
      r.state === 'done' &&
      /^IMPORT OK: 3 new messages, #0–#2 \(chunks c0000\)\. Checksum and read-back OK\.$/.test(r.msg) &&
      (await imports(p)).length === 1 &&
      (await writesTo(p, '^photos/')).length === 0,
    'P7: messages only: a single "done" record with the same message as before, no photo writes (' + (r && r.msg) + ')',
  );
  await p.close();
  // P8: another tab takes the lease mid-upload (ours lapsed): nothing more is written
  p = await openR2();
  await setUp(p, { delayMs: 400 });
  await pasteFirst(p, capSix());
  await until(p, () => __rt.uploads.length >= 2);
  const before8 = await p.evaluate(() => {
    __rt.steal('refresh/importLock', 'other', 60000);
    return __rt.writes.filter(w => /^(photos|meta|refresh\/lastImport)/.test(w.p)).length;
  });
  await until(p, () => !S.importing && !S.pasting, null, 15000);
  await sleep(500);
  const after8 = (await writesTo(p, '^(photos|meta|refresh/lastImport)')).length;
  const note8 = await p.evaluate(() => document.getElementById('imp-note').textContent);
  st = await photoState(p);
  up = await uploads(p);
  ok(
    after8 === before8 &&
      (await get(p, 'refresh/lastImport')).state === 'uploading' &&
      up.length > st.stored(2).length + st.stored(3).length + st.stored(5).length + st.stored(7).length &&
      /another open copy of this page took over the import\. Paste again/.test(note8),
    'P8: lease taken mid-upload: no block, meta/chat or refresh/lastImport write after it (no heartbeat, no closing ' +
      'record: that record is the other tab’s), the photo in flight not indexed (' +
      note8 +
      ')',
  );
  await p.close();
  // P9: rate_limited once (waits, retries, done) and twice (partial)
  p = await openR2();
  await setUp(p, { script: { 1: 'rate_limited' } });
  r = await paste(p, capSix());
  ok(
    r && r.state === 'done' && (await uploads(p)).length === 6 && /6 photos stored\./.test(r.msg),
    'P9a: one rate_limited: waits, retries that photo, done with 6 uploads',
  );
  await p.close();
  p = await openR2();
  await setUp(p, { script: { 1: 'rate_limited', 2: 'rate_limited' } });
  r = await paste(p, capSix());
  st = await photoState(p);
  ok(
    r &&
      r.state === 'partial' &&
      r.stop === 'rate_limited' &&
      /Too many uploads right now: wait 2 minutes, then paste again/.test(r.msg) &&
      st.stored(2).length === 1 &&
      st.owed.length === 5 &&
      (await get(p, 'meta/chat')).photosOwed.n === 5,
    'P9b: rate_limited twice: partial, "wait 2 minutes", the first photo indexed, 5 owed (' + (r && r.msg) + ')',
  );
  await p.close();
  // P10: store_unavailable once (retried) and twice (partial; a re-paste finishes, no duplicate)
  p = await openR2();
  await setUp(p, { script: { 1: 'store_unavailable' } });
  r = await paste(p, capSix());
  ok(r && r.state === 'done' && (await uploads(p)).length === 6, 'P10a: one store_unavailable: retried once, done');
  await p.close();
  p = await openR2();
  await setUp(p, { script: { 1: 'store_unavailable', 2: 'store_unavailable' } });
  r = await paste(p, capSix());
  const r10 = r;
  r = await paste(p, capSix());
  up = await uploads(p);
  ok(
    r10 &&
      r10.state === 'partial' &&
      r10.stop === 'unavailable' &&
      /stopped at #3 \(store_unavailable\)\. Paste again to store the rest\./.test(r10.msg) &&
      r &&
      r.state === 'done' &&
      up.length === 6 &&
      new Set(up.map(u => u.hash)).size === 6,
    'P10b: store_unavailable twice: partial, "paste again"; the re-paste stores the rest with no duplicate (' +
      (r10 && r10.msg) +
      ')',
  );
  await p.close();
  // P11: storage full (the stand-in's file limit set to 3)
  p = await openR2();
  await setUp(p, { quota: { maxFiles: 3 } });
  r = await paste(p, capSix());
  st = await photoState(p);
  ok(
    r &&
      r.state === 'partial' &&
      r.stop === 'quota' &&
      r.usage &&
      r.usage.files === 3 &&
      r.usage.maxFiles === 3 &&
      /Photo uploads refused \(quota_or_state\): this page's photo storage is full \(3 files, .*\), or the page is unpublished or being deleted: 3 photos not stored\. Messages are saved\. Pasting again won't help; tell Claude\./.test(
        r.msg,
      ) &&
      !/paste again/i.test(r.msg) &&
      st.owed.length === 3,
    'P11: storage full: partial, stop "quota", usage recorded, the message says so and never "paste again" (' +
      (r && r.msg) +
      ')',
  );
  await p.close();
  // P12: too_large: given up for good, never retried
  p = await openR2();
  await setUp(p, { script: { 1: 'too_large' } });
  r = await paste(p, capSix());
  st = await photoState(p);
  const n12 = (await uploads(p)).length;
  const r12 = await paste(p, capSix());
  ok(
    r &&
      r.state === 'done' &&
      JSON.stringify(st.byK['3']) === '{"0":{"e":"too_large"}}' &&
      JSON.stringify(r.gaveUp) === '[{"i":3,"k":0,"e":"too_large"}]' &&
      /5 photos stored\. 1 photo couldn't be stored \(#3, too large\)\./.test(r.msg) &&
      n12 === 5 &&
      (await uploads(p)).length === 5 &&
      r12 &&
      /6 already stored/.test(r12.msg),
    'P12: too_large on #3: slot given up ({e}), the rest stored, done; a re-paste uploads nothing (' +
      (r && r.msg) +
      ')',
  );
  await p.close();
  // P13: an upload that hangs: the page's timeout stops it; the late answer is never indexed
  p = await openR2();
  await setUp(p, { script: { 1: { hang: 2500 } } });
  r = await paste(p, capSix());
  const w13 = (await writesTo(p, '^photos/')).length;
  await sleep(1500);
  ok(
    r &&
      r.state === 'partial' &&
      r.stop === 'timeout' &&
      /stopped at #3 \(timeout\)\. Paste again/.test(r.msg) &&
      (await uploads(p)).length === 2 &&
      (await writesTo(p, '^photos/')).length === w13 &&
      (await photoState(p)).owed.length === 5,
    'P13: a hung upload times out: partial, stop "timeout"; its late answer leaves one unindexed asset and no write (' +
      (r && r.msg) +
      ')',
  );
  r = await paste(p, capSix());
  st = await photoState(p);
  ok(
    r && r.state === 'done' && !st.owed.length && (await uploads(p)).length === 7,
    'P13: the re-paste stores the rest (one asset duplicated: the late one)',
  );
  await p.close();
}
/* photos, continued: a section of its own, so the two halves run in parallel */
async function photos2() {
  let p, r, st, up;
  // P14: messages #499 and #500 fall in two blocks; the page shows both and picks up a live block change
  p = await openR2();
  r = await paste(p, JSON.stringify(cap(range(0, 502), { photos: [PH(499), PH(500)] })));
  const b0 = await get(p, 'photos/b0');
  const b500 = await get(p, 'photos/b500');
  await p.evaluate(() => (location.hash = '#messages'));
  await p.evaluate(() => {
    document.getElementById('lay-flat') && document.getElementById('lay-flat').click();
  });
  const shown = await until(
    p,
    () => document.querySelector('#m499 .pics img') && document.querySelector('#m500 .pics img'),
  );
  ok(
    r &&
      r.state === 'done' &&
      b0 &&
      b0.start === 0 &&
      Object.keys(b0.byK).join() === '499' &&
      b500 &&
      b500.start === 500 &&
      Object.keys(b500.byK).join() === '500' &&
      !!shown,
    'P14: #499 lands in photos/b0 and #500 in photos/b500, and the Messages view shows both',
  );
  await p.evaluate(() => {
    const b = __rt.get('photos/b500') || { start: 500, byK: {}, gifs: [] };
    b.byK['501'] = { 0: '/_blob/' + 'f'.repeat(32) };
    __rt.write('photos/b500', b);
  });
  ok(
    !!(await until(p, () => document.querySelector('#m501 .pics img[src="/_blob/' + 'f'.repeat(32) + '"]'))),
    'P14: a live change to a block shows the new photo without a reload',
  );
  await p.close();
  // P15: an old photos/index is read (byI+byK, byI only), never written; a new slot goes to the block
  p = await openR2();
  await paste(p, JSON.stringify(cap(range(0, 9))));
  await p.evaluate(() =>
    __rt.write('photos/index', {
      byI: { 2: ['/_blob/old2'], 3: ['/_blob/old3'] },
      byK: { 2: { 0: '/_blob/old2' } },
      gifs: [4],
    }),
  );
  const wIdx = (await writesTo(p, '^photos/index$')).length;
  r = await paste(p, JSON.stringify(cap(range(0, 9), { photos: [PH(2), PH(3)] })));
  ok(
    r && /Nothing new.*0 photos stored \(2 already stored\)/.test(r.msg) && (await uploads(p)).length === 0,
    'P15a/b: photos in an old index (byI+byK, and byI only) count as stored: a re-paste uploads nothing (' +
      (r && r.msg) +
      ')',
  );
  r = await paste(p, JSON.stringify(cap(range(0, 9), { photos: [PH(2), PH(2, 1)] })));
  st = await photoState(p);
  await p.evaluate(() => (location.hash = '#messages'));
  const pics2 = await until(p, () => {
    const l = [...document.querySelectorAll('#m2 .pics img')].map(i => i.getAttribute('src'));
    return l.length === 2 ? l : null;
  });
  ok(
    r &&
      r.state === 'done' &&
      typeof (await get(p, 'photos/b0')).byK['2']['1'] === 'string' &&
      st.stored(2).length === 2 &&
      pics2 &&
      pics2[0] === '/_blob/old2' &&
      (await writesTo(p, '^photos/index$')).length === wIdx &&
      !!(await p.$('#m3 .pics img[src="/_blob/old3"]')),
    'P15c: slot 1 of a message whose slot 0 is in the old index goes to photos/b0, both show in slot order, and ' +
      'photos/index is never written',
  );
  await p.close();
  // P16a: a block of 500 messages with 4 photos each, at real id length, fits the 256 KiB cap
  p = await openR2();
  await paste(p, JSON.stringify(cap(range(0, 505))));
  await p.evaluate(() => {
    const byK = {};
    for (let i = 0; i < 499; i++) byK[i] = { 0: 0, 1: 1, 2: 2, 3: 3 };
    Object.values(byK).forEach(m => Object.keys(m).forEach(k => (m[k] = '/_blob/' + 'a'.repeat(32))));
    byK[499] = { 0: null, 1: null, 2: null, 3: null };
    __rt.write('photos/b0', { start: 0, byK, gifs: [] });
    return __rt.batch([
      {
        op: 'update',
        p: 'meta/chat',
        v: { photosOwed: { n: 4, fromI: 499, toI: 499, at: 'x' } },
        if_version: __rt.version('meta/chat'),
      },
    ]);
  });
  r = await paste(p, JSON.stringify(cap(range(495, 505), { photos: [0, 1, 2, 3].map(k => PH(499, k)) })));
  const size16 = await p.evaluate(() => new TextEncoder().encode(JSON.stringify(__rt.get('photos/b0'))).length);
  ok(
    r &&
      r.state === 'done' &&
      r.stored.length === 4 &&
      size16 < 262144 &&
      (await get(p, 'meta/chat')).photosOwed === null,
    'P16a: 500 messages × 4 photos in one block is ' + size16 + ' bytes, under the 256 KiB cap (' + (r && r.msg) + ')',
  );
  await p.close();
  // P16b: an old index near the cap doesn't stop an import with photos (2.6 rewrote it and went over)
  const big = { byI: {}, byK: {}, gifs: [] };
  for (let i = 0; JSON.stringify(big).length < 262000; i++) {
    big.byI[i + 1000] = ['/_blob/' + 'c'.repeat(32)];
    big.byK[i + 1000] = { 0: '/_blob/' + 'c'.repeat(32) };
  }
  p = await openR2({ 'photos/index': big });
  r = await paste(p, JSON.stringify(cap(range(0, 9), { photos: [PH(4)] })));
  ok(
    r && r.state === 'done' && r.stored.length === 1 && (await photoState(p)).stored(4).length === 1,
    'P16b: a photos/index within 150 bytes of the cap doesn’t stop an import with photos (' + (r && r.msg) + ')',
  );
  await p.close();
  // P17: an owed slot more than 300 messages behind the newest is given up and reported
  p = await openR2();
  await paste(p, JSON.stringify(cap(range(0, 20))));
  await p.evaluate(() => {
    __rt.write('photos/b0', { start: 0, byK: { 10: { 0: null } }, gifs: [] });
    __rt.batch([
      {
        op: 'update',
        p: 'meta/chat',
        v: { photosOwed: { n: 1, fromI: 10, toI: 10, at: 'x' } },
        if_version: __rt.version('meta/chat'),
      },
    ]);
  });
  r = await paste(p, JSON.stringify(cap(range(21, 500))));
  ok(
    r &&
      r.state === 'done' &&
      JSON.stringify((await get(p, 'photos/b0')).byK['10']) === '{"0":{"e":"gave-up"}}' &&
      JSON.stringify(r.gaveUp) === '[{"i":10,"k":0,"e":"gave-up"}]' &&
      (await get(p, 'meta/chat')).photosOwed === null &&
      /1 photo owed from earlier imports given up \(#10\): more than 300 messages old/.test(r.msg),
    'P17: an owed photo 490 messages behind is given up, listed in gaveUp, photosOwed cleared (' + (r && r.msg) + ')',
  );
  await p.close();
  // P18: backfill with the real helper's captures (sim: a first run with a photo on #30, then a scan from before it)
  if (!fs.existsSync(BACKFILL)) ok(false, 'P18: ' + path.relative(ROOT, BACKFILL) + ' missing: run tests/sim.js first');
  else {
    const B = JSON.parse(fs.readFileSync(BACKFILL, 'utf8'));
    p = await openR2();
    await failCalls(p, [0, 1]);
    r = await paste(p, JSON.stringify(B.first));
    const owed18 = (await get(p, 'meta/chat')).photosOwed;
    const n18 = (await uploads(p)).length;
    const r18 = await paste(p, JSON.stringify(B.backfill));
    st = await photoState(p);
    ok(
      r &&
        r.state === 'partial' &&
        owed18 &&
        owed18.n === 1 &&
        owed18.fromI === 30 &&
        r18 &&
        r18.state === 'done' &&
        r18.fresh === B.backfill.msgs.filter(m => m.i > B.first.msgs.length - 1).length &&
        r18.backfill === true &&
        (await uploads(p)).length - n18 === 1 &&
        st.stored(30).length === 1 &&
        (await get(p, 'meta/chat')).photosOwed === null,
      'P18: the backfill capture (from #30) imports the new messages and stores the owed photo once, backfill true (' +
        (r18 && r18.msg) +
        ')',
    );
    const drift = JSON.parse(JSON.stringify(B.backfill));
    drift.msgs = drift.msgs.slice(1).map((m, k) => Object.assign(m, { i: drift.msgs[0].i + k }));
    drift.sha = sha(JSON.stringify(drift.msgs));
    drift.photos = [];
    drift.phsha = sha('[]');
    const w18 = (await writesTo(p, '^(photos|chunks|meta)/')).length;
    r = await paste(p, JSON.stringify(drift));
    ok(
      r &&
        r.state === 'refused' &&
        /doesn't match the stored message/.test(r.msg) &&
        (await writesTo(p, '^(photos|chunks|meta)/')).length === w18,
      'P18: a backfill whose numbering drifted (a message deleted since) is refused, nothing written',
    );
    await p.close();
    // the multi-photo mock capture (a first run): every slot lands where the helper put it
    const M = B.multi;
    p = await openR2();
    r = await paste(p, JSON.stringify(M));
    st = await photoState(p);
    ok(
      r &&
        M.photos.length >= 6 &&
        M.photos.every(ph => typeof st.byK[ph.i][ph.k] === 'string') &&
        (r.photos || {}).total === M.photos.length,
      'P18: a sim capture with several photos per message stores every slot (' + M.photos.length + ' photos)',
    );
    await p.close();
  }
  // P19: a dry run reports what it would store, and writes nothing
  p = await openR2();
  await paste(p, JSON.stringify(cap(range(0, 9), { photos: [PH(2), PH(3)] })));
  const w19 = (await writesTo(p, '^(photos|chunks|meta)/')).length;
  const n19 = (await uploads(p)).length;
  r = await paste(p, JSON.stringify(cap(range(0, 11), { photos: SIX.concat([PH(11)]), dry: true })));
  ok(
    r &&
      r.dry &&
      /DRY RUN OK: 2 new messages.*7 photos verified, 5 to store \(2 already stored\), \d+ KB\. Nothing written\./.test(
        r.msg,
      ) &&
      (await writesTo(p, '^(photos|chunks|meta)/')).length === w19 &&
      (await uploads(p)).length === n19,
    'P19: a dry run says how many photos it would store, and writes and uploads nothing (' + (r && r.msg) + ')',
  );
  await p.close();
  // P20: a view that can't upload: messages saved, owed photos on record for a view that can
  p = await openR2({}, { noAssets: true });
  r = await paste(p, JSON.stringify(cap(range(0, 3), { photos: [PH(1), PH(2)] })));
  st = await photoState(p);
  ok(
    r &&
      r.ok &&
      r.state === 'partial' &&
      r.stop === 'no_assets' &&
      /Photos not stored: this view can't upload them/.test(r.msg) &&
      !/paste again/i.test(r.msg) &&
      st.owed.length === 2 &&
      (await get(p, 'meta/chat')).photosOwed.n === 2,
    'P20: no assets: partial, stop "no_assets", today’s text with no "paste again", both photos owed (' +
      (r && r.msg) +
      ')',
  );
  await p.close();
  // a block write refused once is retried; refused twice, the import stops ("index") and the messages stay saved
  p = await openR2();
  await p.evaluate(() => __rt.fails.push({ p: 'photos/b0', op: 'set' }));
  r = await paste(p, JSON.stringify(cap(range(0, 3), { photos: [PH(1)] })));
  ok(r && r.state === 'done' && r.stored.length === 1, 'a block write refused once is retried: done');
  await p.evaluate(() => __rt.fails.push({ p: 'photos/b0', op: 'update' }, { p: 'photos/b0', op: 'update' }));
  r = await paste(p, JSON.stringify(cap(range(0, 5), { photos: [PH(4)] })));
  ok(
    r &&
      r.state === 'partial' &&
      r.stop === 'index' &&
      r.ok &&
      r.fresh === 2 &&
      /Photos: 0 of 1 stored; stopped \(index write\)\. Paste again/.test(r.msg) &&
      (await uploads(p)).length === 1,
    'a block write refused twice: partial, stop "index", nothing uploaded, "paste again" (' + (r && r.msg) + ')',
  );
  await p.close();
  // a lab capture uploads its photos and indexes nothing
  p = await openR2();
  const lab = cap(range(0, 3), { photos: [PH(1), PH(2)] });
  lab.lab = true;
  r = await paste(p, JSON.stringify(lab));
  ok(
    r &&
      r.state === 'done' &&
      (await uploads(p)).length === 2 &&
      (await writesTo(p, '^photos/')).length === 0 &&
      /2 photos stored \(lab test, not linked\)/.test(r.msg),
    'a lab capture uploads its 2 photos and writes no photos/ document',
  );
  await p.close();
  // review of #42, 1: a tab that lost its lease never writes its stale copy of a block over another tab's slots
  p = await openR2({}, { tune: Object.assign({}, TUNE, { retryMs: 900 }) });
  await setUp(p, { delayMs: 300 });
  await pasteFirst(p, JSON.stringify(cap(range(0, 9), { photos: [PH(2), PH(3)] })));
  await p.evaluate(() => __rt.fails.push({ p: 'photos/b0', op: 'update' }, { p: 'photos/b0', op: 'set' }));
  await until(p, () => __rt.fails.length === 1); /* tab A's first photo write was refused; it waits to retry */
  const otherId = '/_blob/' + 'e'.repeat(32);
  await p.evaluate(id => {
    __rt.fails.length = 0;
    __rt.steal('refresh/importLock', 'tabB', 60000); /* A froze past its lease; tab B took over and indexed #8 */
    const b = __rt.get('photos/b0');
    b.byK['8'] = { 0: id };
    __rt.write('photos/b0', b);
  }, otherId);
  await until(p, () => !S.importing && !S.pasting, null, 15000);
  await sleep(300);
  st = await photoState(p);
  ok(
    st.byK['8'] && st.byK['8']['0'] === otherId && st.byK['2']['0'] === null,
    'review 1: a tab whose block write was refused, and whose lease another tab then took, never writes its stale ' +
      'block over the other tab’s slot #8 (' +
      JSON.stringify(st.byK) +
      ')',
  );
  await p.close();
  // a slot write merges into the block (update), so another tab's slots written meanwhile survive
  p = await openR2();
  await setUp(p, { delayMs: 300 });
  await pasteFirst(p, JSON.stringify(cap(range(0, 9), { photos: [PH(2), PH(3)] })));
  await p.evaluate(id => {
    const b = __rt.get('photos/b0');
    b.byK['9'] = { 0: id };
    b.gifs = [7];
    __rt.silent('photos/b0', b);
  }, otherId);
  r = await until(p, () => (v => (v && v.state !== 'uploading' ? v : null))(__rt.get('refresh/lastImport')));
  st = await photoState(p);
  ok(
    r &&
      r.state === 'done' &&
      (st.byK['9'] || {})['0'] === otherId &&
      st.stored(2).length === 1 &&
      st.stored(3).length === 1 &&
      [...st.gifs].join() === '7',
    'review 1: photos are indexed slot by slot: a slot (and a GIF) another writer added to the block meanwhile survive',
  );
  await p.close();
  // review 4: a failed photosOwed write doesn't fail an import whose messages are saved
  p = await openR2();
  await p.evaluate(() => __rt.fails.push({ p: 'meta/chat', op: 'update', after: 1 }));
  r = await paste(p, JSON.stringify(cap(range(0, 3), { photos: [PH(1)] })));
  ok(
    r && r.state === 'done' && r.stored.length === 1 && !/Import failed/.test(r.msg),
    'review 4: a refused meta/chat.photosOwed write leaves the import done, photo stored (' + (r && r.msg) + ')',
  );
  await p.close();
  // review 6: only store_unavailable is retried; upstream_error (maybe an unanswered call) and transform_error aren't
  for (const code of ['upstream_error', 'transform_error']) {
    p = await openR2();
    await setUp(p, { script: { 1: code } });
    r = await paste(p, capSix());
    const calls6 = await p.evaluate(() => __rt.calls());
    ok(
      r &&
        r.state === 'partial' &&
        r.stop === 'unavailable' &&
        calls6 === 2 &&
        new RegExp('stopped at #3 \\(' + code + '\\)\\. Paste again').test(r.msg),
      'review 6: ' + code + ' is not retried (it may have been stored): partial, "paste again" (' + calls6 + ' calls)',
    );
    await p.close();
  }
  // review 7: a paste while an Import-button run stores photos starts no second import
  p = await openR2();
  await setUp(p, { delayMs: 300 });
  await p.evaluate(t => {
    document.getElementById('imp').open = true;
    document.getElementById('imp-in').value = t;
    document.getElementById('imp-go').click();
  }, capSix());
  await until(p, () => (__rt.get('refresh/lastImport') || {}).state === 'uploading');
  await p.evaluate(t => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, capSix());
  const t7 = await toastText(p);
  await until(p, () => (__rt.get('refresh/lastImport') || {}).state === 'done');
  await sleep(800);
  up = await uploads(p);
  ok(
    /Still storing photos from the last paste/.test(t7) &&
      up.length === 6 &&
      new Set(up.map(u => u.hash)).size === 6 &&
      (await imports(p)).filter(v => v.state !== 'uploading').length === 1,
    'review 7: a paste during an Import-button run: "Still storing photos", one import, 6 uploads, no duplicate (' +
      up.length +
      ' uploads)',
  );
  await p.close();
  // review 8: photos upload oldest first; owed photos on #0-#2 (no backfill scan reaches them) are given up
  p = await openR2();
  await setUp(p, { script: { 1: 'store_unavailable', 2: 'store_unavailable' } });
  r = await paste(p, JSON.stringify(cap(range(0, 9), { photos: [PH(5), PH(1)] })));
  st = await photoState(p);
  ok(
    r && r.state === 'partial' && st.stored(1).length === 1 && st.owed.join() === '5.0',
    'review 8: photos upload oldest first (#1 before #5, whatever the capture’s order), so the newest stays owed',
  );
  await p.close();
  p = await openR2();
  await failCalls(p, [0, 1]);
  r = await paste(p, JSON.stringify(cap(range(0, 9), { photos: [PH(1)] })));
  const r8 = await paste(p, JSON.stringify(cap(range(10, 12))));
  ok(
    r &&
      r.state === 'partial' &&
      r8 &&
      r8.state === 'done' &&
      JSON.stringify(r8.gaveUp) === '[{"i":1,"k":0,"e":"no-backfill"}]' &&
      JSON.stringify((await get(p, 'photos/b0')).byK['1']) === '{"0":{"e":"no-backfill"}}' &&
      (await get(p, 'meta/chat')).photosOwed === null &&
      /couldn't be stored \(#1, too early in the chat to fetch again\)/.test(r8.msg),
    'review 8: a photo owed on #1 (no backfill can reach it) is given up by the next import, with the reason (' +
      (r8 && r8.msg) +
      ')',
  );
  await p.close();
  // review 12: a capture's own owed photos are never given up by that import, however old (a re-paste stores them)
  p = await openR2();
  await failCalls(p, [0, 1]);
  r = await paste(p, JSON.stringify(cap(range(0, 400), { photos: [PH(10)] })));
  st = await photoState(p);
  const r12b = await paste(p, JSON.stringify(cap(range(0, 400), { photos: [PH(10)] })));
  ok(
    r &&
      r.state === 'partial' &&
      !r.gaveUp.length &&
      st.owed.join() === '10.0' &&
      r12b &&
      r12b.state === 'done' &&
      (await photoState(p)).stored(10).length === 1,
    'review 12: a photo owed on #10 with lastI 400 stays owed in the capture that holds it, and its re-paste stores it',
  );
  await p.close();
  // asset usage: recorded with each import, a calm warning from 80% of either limit
  p = await openR2({}, { assetUse: { files: 3997, bytes: 1000 } });
  await sleep(300);
  ok(
    await p.evaluate(() => (document.getElementById('storage-st') || { hidden: true }).hidden),
    'usage: 3,997 of 5,000 files (79.9%): no warning',
  );
  r = await paste(p, JSON.stringify(cap(range(0, 9), { photos: [PH(1), PH(2), PH(3)] })));
  const m21 = await get(p, 'meta/chat');
  const warn = await until(p, () => {
    const s = document.getElementById('storage-st');
    return s && !s.hidden && s.textContent;
  });
  ok(
    r &&
      r.usage &&
      r.usage.files === 4000 &&
      r.usage.maxFiles === 5000 &&
      m21.assetUsage &&
      m21.assetUsage.files === 4000 &&
      m21.assetUsage.maxBytes === 1 << 30 &&
      /3 photos stored\. Photo storage is 80% full \(4,000 of 5,000 files\)\.$/.test(r.msg) &&
      /Photo storage is 80% full \(4,000 of 5,000 files\)\..*ask Claude to tidy up photo storage/.test(warn || ''),
    'usage: recorded in lastImport and meta/chat.assetUsage; at 80% the page shows a calm warning (' + warn + ')',
  );
  await p.close();
  p = await openR2({}, { assetUse: { files: 10, bytes: 900 * 1048576 } });
  ok(
    !!(await until(p, () =>
      /Photo storage is 87% full \(900\.0 MB of 1024\.0 MB\)/.test(
        (document.getElementById('storage-st') || {}).textContent,
      ),
    )),
    'usage: the byte limit counts too, and the warning shows on load from a fresh listing',
  );
  r = await paste(p, JSON.stringify(cap(range(0, 2))));
  ok(
    r && r.usage && r.usage.files === 10 && /Photo storage is 87% full/.test(r.msg),
    'usage: an import with no photos records it as well, and its message repeats the warning',
  );
  ok(p.errors.length === 0, 'photos: no page errors ' + JSON.stringify(p.errors));
  await p.close();
}

/* ---------- R15, R16 (helper 2.1): photos the helper couldn't get stay owed and are retried; slots by attachment id ----------
   A 2.1 capture adds aid (Messenger's attachment id) to each photo, and phfail / phskip: the photos it couldn't get and
   the ones it skipped. meta/chat.lastRefresh tells refresh runs apart. */
const KEYS = path.join(__dirname, 'out/sim_cap_keys.json'); /* sim section H: {loaded, lazy}, window #100-#119 */
/* a photo with an attachment id; its bytes name the id, so uploads show which photo went where */
const PHA = (i, k, aid) => ({
  i,
  k,
  aid,
  type: 'image/png',
  b64: Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from(' aid ' + aid)]).toString('base64'),
});
const hashOf = ph => sha(Buffer.from(ph.b64, 'base64'));
const cap21 = (msgs, photos, phfail = [], phskip = []) =>
  JSON.stringify(Object.assign(cap(msgs, { photos }), { phfail, phskip }));
const tryOf = async (p, i) => ((((await get(p, 'photos/b0')) || {}).tries || {})[i] || {})['0'];
const setRun = (p, run) =>
  p.evaluate(
    r => __rt.batch([{ op: 'update', p: 'meta/chat', v: { lastRefresh: r }, if_version: __rt.version('meta/chat') }]),
    run,
  );
async function photoKeys() {
  // K1 (R15): a photo the helper couldn't fetch is owed (null slot), with its id and one try
  let p = await openR2();
  await setRun(p, 'r1');
  let r = await paste(p, cap21(range(0, 9), [PHA(2, 0, '200')], [{ i: 5, k: 0, aid: '500', e: 'fetch' }]));
  let b = (await get(p, 'photos/b0')) || {};
  const owedK1 = (await get(p, 'meta/chat')).photosOwed;
  ok(
    r &&
      r.state === 'done' &&
      JSON.stringify((b.byK || {})['5']) === '{"0":null}' &&
      JSON.stringify(b.aids) === '{"2":{"0":"200"},"5":{"0":"500"}}' &&
      JSON.stringify(b.tries) === '{"5":{"0":{"n":1,"run":"r1"}}}' &&
      owedK1 &&
      owedK1.n === 1 &&
      owedK1.fromI === 5 &&
      JSON.stringify(r.owed) === '[{"i":5,"k":0}]' &&
      /1 photo Messenger didn't give \(#5\): still owed, the next refresh tries again\./.test(r.msg),
    'K1: a photo in phfail becomes an owed slot with its aid and one try; photosOwed counts it; the toast says so (' +
      JSON.stringify([b.byK, b.aids, b.tries, r && r.msg]) +
      ')',
  );
  // K2: a try per refresh run, not per paste; 2.1 captures that hold the message but not the photo count, an older
  // helper's capture (no phfail) and a capture without the message don't; the third run gives it up ("no-fetch")
  r = await paste(p, cap21(range(0, 9), [PHA(2, 0, '200')], [{ i: 5, k: 0, aid: '500', e: 'fetch' }]));
  const t1 = await tryOf(p, 5);
  await setRun(p, 'r2');
  await paste(p, cap21(range(3, 12), []));
  const t2 = (await tryOf(p, 5)) || {};
  await setRun(p, 'r3');
  await paste(p, JSON.stringify(cap(range(3, 13))));
  await setRun(p, 'r4');
  await paste(p, cap21(range(6, 14), []));
  const t4 = (await tryOf(p, 5)) || {};
  await setRun(p, 'r5');
  r = await paste(p, cap21(range(3, 15), [], [{ i: 5, k: 0, aid: '500', e: 'unloaded' }]));
  b = await get(p, 'photos/b0');
  ok(
    t1 &&
      t1.n === 1 &&
      t2.n === 2 &&
      t4.n === 2 &&
      r &&
      r.state === 'done' &&
      JSON.stringify((b.byK || {})['5']) === '{"0":{"e":"no-fetch"}}' &&
      JSON.stringify(r.gaveUp) === '[{"i":5,"k":0,"e":"no-fetch"}]' &&
      (await get(p, 'meta/chat')).photosOwed === null &&
      /couldn't be stored \(#5, Messenger didn't give it in 3 refreshes\)/.test(r.msg) &&
      (await uploads(p)).length === 1,
    'K2: tries count once per run (re-paste 1, absent 2, older helper 2, #5 not in the capture 2), the third ' +
      'failed run gives it ' +
      'up as "no-fetch", reported (' +
      JSON.stringify([t1, t2, t4, r && r.msg]) +
      ')',
  );
  await p.close();
  // K3: the retry that works stores the owed photo in its slot; a photo owed because its upload failed is no fetch try
  p = await openR2();
  await setRun(p, 'r1');
  await failCalls(p, [0, 1]);
  await paste(p, cap21(range(0, 9), [PHA(6, 0, '600')], [{ i: 5, k: 0, aid: '500', e: 'fetch' }]));
  await setRun(p, 'r2');
  r = await paste(p, cap21(range(3, 12), [PHA(5, 0, '500'), PHA(6, 0, '600')]));
  b = await get(p, 'photos/b0');
  const up3 = await uploads(p);
  ok(
    r &&
      r.state === 'done' &&
      typeof (b.byK['5'] || {})['0'] === 'string' &&
      typeof (b.byK['6'] || {})['0'] === 'string' &&
      (up3.find(u => '/_blob/' + u.id === b.byK['5']['0']) || {}).hash === hashOf(PHA(5, 0, '500')) &&
      JSON.stringify(b.tries) === '{"5":{"0":{"n":1,"run":"r1"}}}' &&
      (await get(p, 'meta/chat')).photosOwed === null,
    'K3: the next run brings the photo: stored in its slot, owed cleared; #6, owed after a failed upload, counted no ' +
      'fetch try (' +
      JSON.stringify([b.byK, b.tries]) +
      ')',
  );
  await p.close();
  // K4 (R16): a photo found by its id is never stored under another slot, even when the capture numbers it differently
  p = await openR2();
  await paste(p, cap21(range(0, 9), [PHA(4, 1, 'B'), PHA(4, 2, 'C')], [{ i: 4, k: 0, aid: 'A', e: 'unloaded' }]));
  r = await paste(p, cap21(range(0, 9), [PHA(4, 0, 'B')]));
  const n4 = (await uploads(p)).length;
  const slot0 = (await get(p, 'photos/b0')).byK['4']['0'];
  const r4 = await paste(p, cap21(range(0, 9), [PHA(4, 0, 'A'), PHA(4, 1, 'B'), PHA(4, 2, 'C')]));
  b = await get(p, 'photos/b0');
  const up4 = await uploads(p);
  const in4 = k => (up4.find(u => '/_blob/' + u.id === b.byK['4'][k]) || {}).hash;
  ok(
    r &&
      /0 photos stored \(1 already stored\)/.test(r.msg) &&
      n4 === 2 &&
      slot0 === null &&
      r4 &&
      r4.state === 'done' &&
      up4.length === 3 &&
      in4(0) === hashOf(PHA(4, 0, 'A')) &&
      in4(1) === hashOf(PHA(4, 1, 'B')) &&
      in4(2) === hashOf(PHA(4, 2, 'C')) &&
      JSON.stringify((b.aids || {})['4']) === '{"0":"A","1":"B","2":"C"}',
    'K4: photo B (stored in slot 1) arriving as slot 0 is matched by its id: not uploaded, slot 0 stays owed for A, ' +
      'which the next capture fills (' +
      JSON.stringify([r && r.msg, n4, b.byK['4']]) +
      ')',
  );
  await p.close();
  // K5: old slots stored by position (no id) keep working by k; new ones record their id; a slot holding another id is
  // never reused, so nothing is stored twice or in another photo's slot
  p = await openR2();
  await paste(p, JSON.stringify(cap(range(0, 9))));
  await p.evaluate(() => {
    __rt.write('photos/b0', { start: 0, byK: { 6: { 0: '/_blob/old60', 1: null } }, gifs: [] });
    __rt.batch([
      {
        op: 'update',
        p: 'meta/chat',
        v: { photosOwed: { n: 1, fromI: 6, toI: 6, at: 'x' } },
        if_version: __rt.version('meta/chat'),
      },
    ]);
  });
  r = await paste(p, cap21(range(0, 9), [PHA(6, 0, 'X0'), PHA(6, 1, 'X1')]));
  const b5 = await get(p, 'photos/b0');
  const n5 = (await uploads(p)).length;
  const r5 = await paste(p, cap21(range(0, 9), [PHA(6, 0, 'X1'), PHA(6, 1, 'Y')]));
  b = await get(p, 'photos/b0');
  const up5 = await uploads(p);
  ok(
    r &&
      r.state === 'done' &&
      n5 === 1 &&
      b5.byK['6']['0'] === '/_blob/old60' &&
      JSON.stringify((b5.aids || {})['6']) === '{"1":"X1"}' &&
      r5 &&
      r5.state === 'done' &&
      up5.length === 2 &&
      b.byK['6']['0'] === '/_blob/old60' &&
      (up5.find(u => '/_blob/' + u.id === b.byK['6']['1']) || {}).hash === hashOf(PHA(6, 1, 'X1')) &&
      (up5.find(u => '/_blob/' + u.id === b.byK['6']['2']) || {}).hash === hashOf(PHA(6, 1, 'Y')) &&
      JSON.stringify((b.aids || {})['6']) === '{"1":"X1","2":"Y"}' &&
      (await get(p, 'meta/chat')).photosOwed === null,
    'K5: an old slot 0 (no id) matches by k and is never rewritten; owed slot 1 takes X1 and records it; X1 seen ' +
      'again as slot 0 is found by id; Y arriving as slot 1 (X1’s) gets slot 2 (' +
      JSON.stringify([b.byK['6'], b.aids]) +
      ')',
  );
  await p.close();
  // K6: an older helper's capture (no ids, no phfail) meeting slots that have ids: by k, as before
  p = await openR2();
  await failCalls(p, [1, 2]);
  await paste(p, cap21(range(0, 9), [PHA(8, 0, 'a80'), PHA(8, 1, 'a81')]));
  r = await paste(p, JSON.stringify(cap(range(0, 9), { photos: [PH(8, 0), PH(8, 1)] })));
  const st6 = await photoState(p);
  ok(
    r && r.state === 'done' && st6.stored(8).length === 2 && (await uploads(p)).length === 2 && !st6.owed.length,
    'K6: an older helper’s capture fills the owed slot 1 by k and skips the stored slot 0 (' + (r && r.msg) + ')',
  );
  await p.close();
  // K7: a full block with an id on every slot still fits the 256 KiB cap (17-digit ids, as Messenger's)
  const byK7 = {};
  const aids7 = {};
  const h7 = {};
  for (let i = 0; i < 500; i++) {
    byK7[i] = {};
    aids7[i] = {};
    h7[i] = {};
    for (let k = 0; k < 4; k++) {
      byK7[i][k] = '/_blob/' + 'a'.repeat(32);
      aids7[i][k] = String(10000000000000000 + i * 4 + k);
      h7[i][k] = sha(i + '.' + k).slice(0, 12);
    }
  }
  const size7 = Buffer.byteLength(JSON.stringify({ start: 0, byK: byK7, aids: aids7, h: h7, gifs: [] }));
  ok(
    size7 < 262144,
    'K7: 500 messages × 4 photos with ids and hashes in one block is ' + size7 + ' bytes, under 256 KiB',
  );
  // K8: the real helper's captures (sim section H): the lazy capture leaves #104's first photo owed, and the capture
  // with every image loaded stores just that one
  if (!fs.existsSync(KEYS)) ok(false, 'K8: ' + path.relative(ROOT, KEYS) + ' missing: run tests/sim.js first');
  else {
    const K = JSON.parse(fs.readFileSync(KEYS, 'utf8'));
    p = await openR2();
    await paste(p, JSON.stringify(cap(range(0, 99))));
    r = await paste(p, JSON.stringify(K.lazy));
    const owed8 = (await photoState(p)).owed;
    const n8 = (await uploads(p)).length;
    const r8 = await paste(p, JSON.stringify(K.loaded));
    b = await get(p, 'photos/b0');
    ok(
      r &&
        r.state === 'done' &&
        owed8.join() === '104.0' &&
        r8 &&
        r8.state === 'done' &&
        (await uploads(p)).length - n8 === 1 &&
        Object.values(b.byK['104'] || {}).every(v => typeof v === 'string') &&
        JSON.stringify((b.aids || {})['104']) === '{"0":"921040","1":"921041","2":"921042"}',
      'K8: sim captures: #104’s unloaded photo is owed after the lazy capture, and the full capture uploads only it (' +
        JSON.stringify([owed8, r8 && r8.msg]) +
        ')',
    );
    await p.close();
  }
  /* the same bytes (tag) under another id */
  const PHX = (i, k, aid, tag) => Object.assign(PHA(i, k, tag), { aid });
  // K9: an id that changes between visits (unstable ids): the photo is found by its content hash, its slot takes the
  // new id, and it isn't uploaded again
  p = await openR2();
  await paste(p, cap21(range(0, 9), [PHX(3, 0, 'A1', 'same')]));
  await paste(p, cap21(range(0, 9), [PHX(3, 0, 'A2', 'same')]));
  r = await paste(p, cap21(range(0, 9), [PHX(3, 0, 'A3', 'same'), PHX(3, 1, 'A4', 'other')]));
  b = await get(p, 'photos/b0');
  ok(
    r &&
      r.state === 'done' &&
      (await uploads(p)).length === 2 &&
      Object.keys(b.byK['3']).join() === '0,1' &&
      JSON.stringify((b.aids || {})['3']) === '{"0":"A3","1":"A4"}' &&
      ((b.h || {})['3'] || {})['0'] === sha(PHX(3, 0, 'A1', 'same').b64).slice(0, 12),
    'K9: one photo seen as A1, A2, A3 stays one slot and one upload, its id updated; a different photo still gets ' +
      'its own slot (' +
      JSON.stringify([b.byK['3'], b.aids, b.h]) +
      ')',
  );
  await p.close();
  // K10: a phfail for a photo already stored never turns its slot back to owed
  p = await openR2();
  await paste(p, cap21(range(0, 9), [PHA(2, 0, '200')]));
  r = await paste(p, cap21(range(0, 9), [], [{ i: 2, k: 0, aid: '200', e: 'fetch' }]));
  st = await photoState(p);
  ok(
    r && r.state === 'done' && st.stored(2).length === 1 && !st.owed.length && !(r.retry || []).length,
    'K10: a phfail on a stored photo leaves it stored, nothing owed (' + JSON.stringify(st.byK) + ')',
  );
  await p.close();
  // K11: a photo whose slot k holds another photo's id gets the next free slot, even alone in its capture
  p = await openR2();
  await paste(p, cap21(range(0, 9), [PHA(6, 0, 'X0'), PHA(6, 1, 'X1')]));
  r = await paste(p, cap21(range(0, 9), [PHA(6, 1, 'Y')]));
  b = await get(p, 'photos/b0');
  ok(
    r &&
      r.state === 'done' &&
      (await uploads(p)).length === 3 &&
      typeof b.byK['6']['2'] === 'string' &&
      JSON.stringify((b.aids || {})['6']) === '{"0":"X0","1":"X1","2":"Y"}',
    'K11: Y arriving as slot 1, which holds X1, is stored in slot 2 (' + JSON.stringify([b.byK['6'], b.aids]) + ')',
  );
  await p.close();
  // K12: a skip on a slot the page doesn't hold stored (Claude's skip list was wrong): owed, counted as a try, and
  // listed in skipOwed; a skip on an unknown photo opens an owed slot for it (by id, beside another photo's slot)
  p = await openR2();
  await setRun(p, 'r1');
  await paste(p, cap21(range(0, 9), [PHA(6, 0, 'X0')], [{ i: 5, k: 0, aid: '500', e: 'fetch' }]));
  await setRun(p, 'r2');
  r = await paste(
    p,
    cap21(
      range(0, 9),
      [],
      [],
      [
        { i: 5, k: 0, aid: '500' },
        { i: 6, k: 0, aid: 'Z' },
      ],
    ),
  );
  b = await get(p, 'photos/b0');
  ok(
    r &&
      r.state === 'done' &&
      JSON.stringify(r.skipOwed) === '[{"i":5,"k":0},{"i":6,"k":1}]' &&
      ((b.tries || {})['5'] || {})['0'].n === 2 &&
      b.byK['6']['1'] === null &&
      ((b.aids || {})['6'] || {})['1'] === 'Z' &&
      (await get(p, 'meta/chat')).photosOwed.n === 2 &&
      /2 photos the helper skipped aren't stored here \(#5, #6\)/.test(r.msg),
    'K12: skips on an owed slot and on an unknown photo: both owed, listed in skipOwed, the owed one counted (' +
      JSON.stringify([r && r.skipOwed, b.byK, b.tries]) +
      ')',
  );
  await p.close();
  // K14: the id wins over bytes and position: the same id with other bytes (another size of the image) at another
  // place is the stored photo, not uploaded again
  p = await openR2();
  await paste(p, cap21(range(0, 9), [PHX(4, 0, 'A', 'v1'), PHX(4, 1, 'B', 'v1b')]));
  r = await paste(p, cap21(range(0, 9), [PHX(4, 0, 'B', 'v2')]));
  b = await get(p, 'photos/b0');
  ok(
    r &&
      /0 photos stored \(1 already stored\)/.test(r.msg) &&
      (await uploads(p)).length === 2 &&
      Object.keys(b.byK['4']).join() === '0,1',
    'K14: photo B with other bytes, arriving as slot 0, is matched by its id to slot 1: nothing uploaded (' +
      (r && r.msg) +
      ')',
  );
  await p.close();
  // K13: a capture with full's run id counts once for that run, even after the refresh wrote lastRefresh
  p = await openR2();
  await setRun(p, 'r1');
  const runCap = (msgs, run) =>
    JSON.stringify(Object.assign(JSON.parse(cap21(msgs, [], [{ i: 5, k: 0, aid: '500', e: 'fetch' }])), { run }));
  await paste(p, runCap(range(0, 9), 'run-a'));
  await setRun(p, 'r1-done');
  await paste(p, runCap(range(0, 9), 'run-a'));
  const k13a = await tryOf(p, 5);
  await paste(p, runCap(range(0, 9), 'run-b'));
  const k13b = await tryOf(p, 5);
  ok(
    k13a && k13a.n === 1 && k13a.run === 'run:run-a' && k13b && k13b.n === 2,
    'K13: the same run id pasted again after lastRefresh changed counts once; a new run id counts (' +
      JSON.stringify([k13a, k13b]) +
      ')',
  );
  await p.close();
}
/* P23: a 20 MB capture through a real clipboard and a real paste keystroke */
async function bigPaste() {
  const many = range(0, 199, i => i).map(i => PH(i, 0, 100 * 1024));
  const text = JSON.stringify(cap(range(0, 199), { photos: many }));
  const p = await openR2({}, {});
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:9917' });
  await p.evaluate(t => navigator.clipboard.writeText(t), text);
  await p.click('#h1');
  const t0 = Date.now();
  await p.keyboard.press('ControlOrMeta+V');
  const r = await until(
    p,
    () => (v => (v && v.state !== 'uploading' ? v : null))(__rt.get('refresh/lastImport')),
    null,
    60000,
  );
  const st = await photoState(p);
  ok(
    r && r.state === 'done' && r.photos.done === 200 && range(0, 199, i => i).every(i => st.stored(i).length === 1),
    'P23: a ' +
      (text.length / 1048576).toFixed(1) +
      ' MB capture pasted with a real keystroke: 200 messages and 200 photos stored in ' +
      ((Date.now() - t0) / 1000).toFixed(1) +
      ' s' +
      (r && r.state !== 'done' ? ' ' + r.msg : ''),
  );
  await p.close();
}

/* The stand-in itself: the runtime behaviors later tests rely on, checked once so a fixture change can't quietly make
   them pass */
async function standIn() {
  const p = await open(
    Object.assign(SEED(), {
      'x/doc': { a: 1, nest: { keep: 1, both: { k: 1 } }, arr: [1, 2, 3], gone: 1 },
      __opts: { promptMax: 1000 },
    }),
  );
  const r = await p.evaluate(async () => {
    const db = await claude.use('db');
    await db.doc('x/doc').update({ nest: { add: 2, both: { j: 2 } }, arr: [9], gone: { __delete__: true } });
    __rt.batch([{ op: 'update', p: 'x/doc', v: { nest: { viaBatch: 3 } }, if_version: __rt.version('x/doc') }]);
    const s = await claude.use('sample');
    const lim = await s.limits();
    const small = await s([{ role: 'user', content: 'é'.repeat(400) }]).then(
      () => 'ok',
      e => e.code,
    );
    const big = await s([{ role: 'user', content: 'é'.repeat(501) }]).then(
      () => 'ok',
      e => e.code,
    );
    return { doc: __rt.get('x/doc'), lim, small, big, log: __rt.sampleLog };
  });
  ok(
    JSON.stringify(r.doc) ===
      JSON.stringify({ a: 1, nest: { keep: 1, both: { k: 1, j: 2 }, add: 2, viaBatch: 3 }, arr: [9] }),
    'stand-in: update merges nested objects, replaces arrays and removes __delete__ fields, in page writes and in batches (' +
      JSON.stringify(r.doc) +
      ')',
  );
  ok(
    r.lim.maxPromptBytes === 1000 && r.small === 'ok' && r.big === 'prompt_too_large' && r.log[1].bytes === 1002,
    'stand-in: sample.limits() reports the cap, and a prompt over it in UTF-8 bytes (not characters) is refused',
  );
  await p.close();
  // assets: scripted codes by call number, a hung call that answers late, the quota, list() and delete()
  const q = await openR2({}, { assetUse: { files: 1, bytes: 10 } });
  const a = await q.evaluate(async () => {
    const as = await claude.use('assets');
    const blob = t => new Blob([t], { type: 'image/png' });
    window.__up = { script: { 1: 'rate_limited', 2: { hang: 300 } }, quota: { maxFiles: 4 } };
    const out = [];
    const t0 = Date.now();
    for (const t of ['a', 'b', 'c', 'a', 'd'])
      out.push(
        await as.upload(blob(t), { type: 'image/png' }).then(
          r => r.id,
          e => e.code,
        ),
      );
    const slow = Date.now() - t0 >= 300;
    const l = await as.list();
    const del = [await as.delete(out[0]), await as.delete(out[0])].map(d => d.deleted);
    const steal = (__rt.steal('refresh/importLock', 'other', 5000), __rt.leases.get('refresh/importLock').holder);
    return { out, slow, l, del, after: (await as.list()).usage, ups: __rt.uploads, steal };
  });
  ok(
    /^[0-9a-f]{32}$/.test(a.out[0]) &&
      a.out[1] === 'rate_limited' &&
      a.slow &&
      a.out[4] === 'quota_or_state' &&
      a.ups[0].hash === a.ups[2].hash &&
      a.ups[0].hash !== a.ups[1].hash &&
      a.l.usage.files === 4 &&
      a.l.usage.bytes === 13 &&
      a.l.usage.maxFiles === 4 &&
      a.l.usage.maxBytes === 1 << 30 &&
      a.l.assets.length === 3 &&
      a.del.join() === 'true,false' &&
      a.after.files === 3 &&
      a.steal === 'other',
    'stand-in: uploads follow __up (a code, a late answer, the file limit), ids are 32 hex, duplicates share a hash, ' +
      'list() reports usage with files stored before, delete() works once, steal() takes the lease (' +
      JSON.stringify(a.out) +
      ')',
  );
  await q.close();
  // the paste helpers: paste() waits for the import to finish, pasteFirst() returns its first record
  const w = await openR2();
  await setUp(w, { delayMs: 400 });
  const f = await pasteFirst(w, JSON.stringify(cap(range(0, 3), { photos: [PH(1)] })));
  await until(w, () => (__rt.get('refresh/lastImport') || {}).state === 'done');
  const g = await paste(w, JSON.stringify(cap(range(0, 4), { photos: [PH(4)] })));
  ok(
    f && f.state === 'uploading' && g && g.state === 'done' && /1 photo stored/.test(g.msg),
    'stand-in: pasteFirst() returns the "uploading" record, paste() the finished one',
  );
  await w.close();
}

/* F5: "update available" notices. Claude writes meta/chat.versions with every lastRefresh; the page compares it with
   its own PAGE_VERSION (read from the file, so these tests don't depend on the number) and pageVersion. */
const PV = (SRC.match(/const PAGE_VERSION\s*=\s*"([^"]+)"/) || [])[1] || '0.0';
const DAY = 864e5;
const iso = msAgo => new Date(Date.now() - msAgo).toISOString();
const LAST = 'Nov 20, 9:04 AM';
const metaWith = o => Object.assign({}, META, { pageVersion: PV, lastRefresh: LAST }, o);
const vers = o => Object.assign({ page: PV, helper: '2.0', refresh: LAST, browsers: {} }, o);
const withMeta = (meta, extra) => Object.assign(SEED(), { 'meta/chat': meta }, extra);
/* the visible notices' text, without their Dismiss buttons; null when the page has no notice area at all */
const noticeTexts = p =>
  p.evaluate(() => {
    const box = document.getElementById('upd');
    if (!box) return null;
    if (box.hidden) return [];
    return [...box.querySelectorAll('p')].map(x => {
      const c = x.cloneNode(true);
      c.querySelectorAll('button').forEach(b => b.remove());
      return c.textContent.replace(/\s+/g, ' ').trim();
    });
  });
/* how many show (-1: no notice area, as on pages before them) */
const nCount = async p => {
  const n = await noticeTexts(p);
  return n ? n.length : -1;
};
/* clicks Dismiss on the notice that contains `text` (the only one when omitted); false when there's none to click */
async function dismissNotice(p, text) {
  const loc = text ? p.locator('#upd p', { hasText: text }) : p.locator('#upd p');
  if ((await loc.count()) !== 1) return false;
  await loc.locator('button', { hasText: 'Dismiss' }).click();
  return true;
}
const noticeLinks = p =>
  p.evaluate(() =>
    [...document.querySelectorAll('#upd p a')].map(a => ({
      t: a.textContent,
      href: a.href,
      target: a.target,
      rel: a.rel,
    })),
  );
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/* the newest release tag whose page predates the notices (a page that ignores versions), or null */
function olderPage() {
  let tags = [];
  try {
    tags = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], { cwd: ROOT, encoding: 'utf8' }).split(
      /\s+/,
    );
  } catch (e) {}
  for (const t of tags.filter(Boolean)) {
    try {
      const src = execFileSync('git', ['show', t + ':plugin/skills/refresh/assets/page.html'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (!src.includes('updateNotices')) return { tag: t, page: SKELETON + src + '</body></html>' };
    } catch (e) {}
  }
  return null;
}
async function notices() {
  const none = async (seed, what, ctxOpts) => {
    const p = await open(seed, PAGE, ctxOpts);
    const n = await noticeTexts(p);
    ok(Array.isArray(n) && n.length === 0 && !p.errors.length, 'notices: ' + what + ' (' + JSON.stringify(n) + ')');
    await p.close();
  };
  /* U1: a page in step with its data says nothing */
  let p = await open(withMeta(metaWith({})));
  ok(
    (await p.evaluate(() => !!document.getElementById('upd') && document.getElementById('upd').hidden)) &&
      (await nCount(p)) === 0 &&
      !p.errors.length,
    'notices U1: pageVersion = PAGE_VERSION and no versions: the notice area is there, hidden and empty',
  );
  await p.close();
  /* U1b: an old seed without pageVersion */
  const noPv = metaWith({});
  delete noPv.pageVersion;
  await none(withMeta(noPv), 'U1b: meta/chat without pageVersion shows nothing');
  /* U2, U2b: an open tab older than the published page */
  for (const m of ['9.9', '10.0']) {
    p = await open(withMeta(metaWith({ pageVersion: m })));
    const n = await noticeTexts(p);
    ok(
      n &&
        n.length === 1 &&
        new RegExp(
          'older copy of the page \\(' + reEsc(PV) + '; the current one is ' + reEsc(m) + '\\)\\. Reload the tab',
        ).test(n[0]),
      'notices U2: pageVersion ' +
        m +
        ' > ' +
        PV +
        ' (number by number) says this tab is an older copy (' +
        JSON.stringify(n) +
        ')',
    );
    await p.close();
  }
  /* U3: a published page older than this one (its pageVersion write is pending), or the same version written short */
  await none(withMeta(metaWith({ pageVersion: '1.0' })), 'U3: pageVersion lower than PAGE_VERSION shows nothing');
  await none(withMeta(metaWith({ pageVersion: PV + '.0' })), 'U3: pageVersion "' + PV + '.0" equals ' + PV);
  /* U4: the last refresh's skill ships a newer page that isn't in place yet */
  p = await open(withMeta(metaWith({ refreshPhrase: 'catch me up', versions: vers({ page: '9.9' }) })));
  let n = await noticeTexts(p);
  ok(
    n && n.length === 1 && /^Page 9\.9 is ready\./.test(n[0]) && n[0].includes('“catch me up”'),
    'notices U4: versions.page newer than the page: "Page 9.9 is ready", with the refresh phrase (' +
      JSON.stringify(n) +
      ')',
  );
  await p.close();
  /* U5: an older skill that knows versions ran (it wrote a lower page) */
  p = await open(withMeta(metaWith({ versions: vers({ page: '1.0' }) })));
  n = await noticeTexts(p);
  let links = await noticeLinks(p);
  ok(
    n &&
      n.length === 1 &&
      /older copy of the Messenger Catch-up skill/.test(n[0]) &&
      /Update the plugin/.test(n[0]) &&
      /Customize › Plugins/.test(n[0]) &&
      /Claude Code: \/plugin\b/.test(n[0]) &&
      links.length === 1 &&
      links[0].href === 'https://github.com/roopesh/messenger-catchup#install' &&
      links[0].target === '_blank' &&
      /\bnoopener\b/.test(links[0].rel),
    'notices U5: versions.page below pageVersion: an older skill ran; update the plugin (claude.ai and Claude Code), with How to install (' +
      JSON.stringify([n, links]) +
      ')',
  );
  await p.close();
  /* U6: a skill from before versions ran: lastRefresh moved on without them */
  const c2 = metaWith({ versions: vers({ refresh: 'Nov 19, 8:00 PM' }) });
  p = await open(withMeta(c2));
  n = await noticeTexts(p);
  ok(
    n && n.length === 1 && /older copy of the Messenger Catch-up skill/.test(n[0]),
    'notices U6: lastRefresh differs from versions.refresh: an older skill ran (' + JSON.stringify(n) + ')',
  );
  await p.close();
  await none(withMeta(metaWith({ versions: vers({}) })), 'U6b: lastRefresh equals versions.refresh: nothing');
  const v6c = vers({});
  delete v6c.refresh;
  await none(
    withMeta(metaWith({ versions: v6c })),
    'U6c: versions without refresh (a republish, then the run stopped): nothing',
  );
  /* U7: not while a refresh is running (versions lands at its end); back by itself when it's done, or gone stale */
  p = await open(withMeta(c2, { 'refresh/status': { state: 'running', startedAt: iso(0), step: 'scan' } }));
  const quiet = (await nCount(p)) === 0;
  await p.evaluate(() => __rt.write('refresh/status', { state: 'done', finishedAt: new Date().toISOString() }));
  const back = await until(p, () => document.querySelectorAll('#upd p').length === 1, null, 3000);
  ok(
    quiet && back && !p.errors.length,
    'notices U7: hidden while a refresh runs, shown without a reload once it is done',
  );
  await p.close();
  await (async () => {
    const q = await open(withMeta(c2, { 'refresh/status': { state: 'running', startedAt: iso(30 * 60000) } }));
    const t = await noticeTexts(q);
    ok(
      t && t.length === 1,
      'notices U7: a "running" status 30 minutes old no longer hides it (' + JSON.stringify(t) + ')',
    );
    await q.close();
  })();
  /* U8: a helper below 1.5 can't update itself */
  p = await open(withMeta(metaWith({ versions: vers({ browsers: { Home: { helper: '1.1', at: iso(DAY) } } }) })));
  n = await noticeTexts(p);
  links = await noticeLinks(p);
  const inst = await p.evaluate(() => document.getElementById('us-install').href);
  ok(
    n &&
      n.length === 1 &&
      n[0].includes('Chrome “Home” ran helper 1.1') &&
      /can't update itself/.test(n[0]) &&
      links.length === 1 &&
      links[0].t === 'Install the userscript' &&
      links[0].href === inst &&
      links[0].target === '_blank' &&
      /\bnoopener\b/.test(links[0].rel),
    'notices U8: Chrome "Home" on helper 1.1: can\'t update itself; the link is the page\'s install link (' +
      JSON.stringify([n, links]) +
      ')',
  );
  await p.close();
  /* U8b, U9: from 1.5 on it updates itself, and a lag is flagged right away (the owner's call: no grace period) */
  for (const [h, at, kind] of [
    ['1.4', iso(DAY), 'D'],
    ['1.5', iso(0), 'E'],
    ['1.9', iso(DAY), 'E'],
    ['1.9', iso(60000), 'E'],
  ]) {
    p = await open(withMeta(metaWith({ versions: vers({ browsers: { 'Work Mac': { helper: h, at } } }) })));
    n = await noticeTexts(p);
    const good =
      kind === 'D'
        ? n && n.length === 1 && n[0].includes('ran helper ' + h + ", which can't update itself")
        : n &&
          n.length === 1 &&
          n[0].includes('Chrome “Work Mac” ran helper ' + h + '; the current one is 2.0') &&
          /Check for updates/.test(n[0]);
    ok(
      good,
      'notices U8b/U9: helper ' +
        h +
        ' read ' +
        Math.round((Date.now() - Date.parse(at)) / 60000) +
        ' min ago: notice ' +
        kind +
        ' (' +
        JSON.stringify(n) +
        ')',
    );
    await p.close();
  }
  for (const h of ['2.0', '2.1', '2', '2.0.0'])
    await none(
      withMeta(metaWith({ versions: vers({ browsers: { 'Work Mac': { helper: h, at: iso(DAY) } } }) })),
      'U9: helper ' + h + ' is not behind 2.0',
    );
  /* U10: no helper (Claude injected), or a version that can't be read */
  for (const h of ['none', '', 'dev', null])
    await none(
      withMeta(metaWith({ versions: vers({ browsers: { Home: { helper: h, at: iso(DAY) } } }) })),
      'U10: helper ' + JSON.stringify(h) + ' shows nothing',
    );
  const noH = vers({ browsers: { Home: { helper: '1.1', at: iso(DAY) } } });
  delete noH.helper;
  await none(withMeta(metaWith({ versions: noH })), 'U10: versions without helper shows nothing');
  await none(
    withMeta(metaWith({ versions: vers({ browsers: { Home: 'x', Work: null, Lab: { helper: '1.1' } } }) })),
    'U10: malformed browser entries (not an object, no at) show nothing',
  );
  await none(withMeta(metaWith({ versions: 'yes' })), 'U10: versions that is not an object shows nothing');
  /* U11: a Chrome not used in 30 days is left out */
  await none(
    withMeta(metaWith({ versions: vers({ browsers: { Home: { helper: '1.1', at: iso(31 * DAY) } } }) })),
    'U11: a Chrome last seen 31 days ago shows nothing',
  );
  /* U12: everything at once, in a fixed order: this tab, the older skill, then each Chrome by name */
  const all = () =>
    withMeta(
      metaWith({
        pageVersion: '9.9',
        versions: vers({
          browsers: { 'Work Mac': { helper: '1.9', at: iso(3600000) }, Home: { helper: '1.1', at: iso(2 * DAY) } },
        }),
      }),
    );
  p = await open(all());
  n = await noticeTexts(p);
  const dis = await p.evaluate(() =>
    [...document.querySelectorAll('#upd p')].map(x => x.querySelectorAll('button').length),
  );
  ok(
    n &&
      n.length === 4 &&
      /older copy of the page/.test(n[0]) &&
      /older copy of the Messenger Catch-up skill/.test(n[1]) &&
      /When Chrome “Home” was last used for a refresh \(\w{3} \d{1,2}\), it ran helper 1\.1/.test(n[2]) &&
      n[3].includes('At the last refresh, Chrome “Work Mac” ran helper 1.9') &&
      dis.every(k => k === 1),
    'notices U12: four at once, in order A, C, D (Home, used before), E (Work Mac, the last refresh), one Dismiss each (' +
      JSON.stringify(n) +
      ')',
  );
  const lightBg = await p.evaluate(() => {
    const x = document.querySelector('#upd p');
    return x ? getComputedStyle(x).backgroundColor : null;
  });
  await p.close();
  /* U13: Dismiss hides it in this browser, writes nothing, survives a reload, and a new version brings it back */
  p = await open(
    withMeta(
      metaWith({
        pageVersion: '9.9',
        versions: vers({ page: '9.9', browsers: { Home: { helper: '1.1', at: iso(DAY) } } }),
      }),
    ),
  );
  const w0 = await p.evaluate(() => __rt.writes.length);
  const clicked = await dismissNotice(p, 'older copy of the page');
  n = await noticeTexts(p);
  ok(
    clicked && n && n.length === 1 && n[0].includes('“Home”') && (await p.evaluate(() => __rt.writes.length)) === w0,
    'notices U13: Dismiss hides that notice only, and the page writes nothing to the database (' +
      JSON.stringify(n) +
      ')',
  );
  const clicked2 = await dismissNotice(p);
  ok(
    clicked2 && (await p.evaluate(() => document.getElementById('upd').hidden)) && (await nCount(p)) === 0,
    'notices U13: with every notice dismissed the area hides',
  );
  await p.reload();
  await p.waitForFunction(() => window.__rt && document.getElementById('window').textContent !== 'Loading the chat…');
  await p.waitForTimeout(300);
  ok((await nCount(p)) === 0, 'notices U13: still dismissed after a reload in the same browser');
  await p.evaluate(() => {
    const m = __rt.get('meta/chat');
    m.pageVersion = m.versions.page = '10.0';
    m.versions.helper = '2.1';
    __rt.write('meta/chat', m);
  });
  await until(p, () => document.querySelectorAll('#upd p').length === 2, null, 3000);
  n = await noticeTexts(p);
  ok(
    n && n.length === 2 && n[0].includes('the current one is 10.0') && n[1].includes('“Home” ran helper 1.1'),
    'notices U13: a new pageVersion and a new helper bring their notices back (' + JSON.stringify(n) + ')',
  );
  await p.close();
  /* U14: storage blocked (a private window): the notices still show, and Dismiss works for this page load */
  p = await open(withMeta(metaWith({ pageVersion: '9.9' })));
  await p.context().addInitScript(() => {
    const no = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    Storage.prototype.getItem = no;
    Storage.prototype.setItem = no;
  });
  await p.reload();
  await p.waitForFunction(() => window.__rt && document.getElementById('window').textContent !== 'Loading the chat…');
  await p.waitForTimeout(300);
  const blocked = await p.evaluate(() => {
    try {
      localStorage.getItem('x');
      return false;
    } catch (e) {
      return true;
    }
  });
  const shown = (await nCount(p)) === 1;
  const clicked3 = await dismissNotice(p);
  ok(
    blocked && shown && clicked3 && (await nCount(p)) === 0 && !p.errors.length,
    'notices U14: with localStorage throwing, the notice shows and Dismiss hides it, with no page errors (' +
      p.errors.join('; ') +
      ')',
  );
  await p.close();
  /* U14b: with site data blocked, Chrome throws on reading window.localStorage itself, not only on its methods */
  p = await open(withMeta(metaWith({ pageVersion: '9.9' })));
  await p.context().addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
  });
  await p.reload();
  await p.waitForFunction(() => window.__rt && document.getElementById('window').textContent !== 'Loading the chat…');
  await p.waitForTimeout(300);
  const getterThrows = await p.evaluate(() => {
    try {
      return !window.localStorage;
    } catch (e) {
      return true;
    }
  });
  const shownB = (await nCount(p)) === 1;
  const clicked4 = await dismissNotice(p);
  ok(
    getterThrows && shownB && clicked4 && (await nCount(p)) === 0 && !p.errors.length,
    'notices U14b: with the localStorage getter throwing, the notice shows and Dismiss hides it, with no page errors (' +
      p.errors.join('; ') +
      ')',
  );
  await p.close();
  /* U15: live: a republish elsewhere shows A without a reload, and it goes once the data matches again */
  p = await open(withMeta(metaWith({})));
  await p.evaluate(() => __rt.write('meta/chat', Object.assign(__rt.get('meta/chat'), { pageVersion: '9.9' })));
  const live = await until(p, () => document.querySelectorAll('#upd p').length === 1, null, 3000);
  await p.evaluate(pv => __rt.write('meta/chat', Object.assign(__rt.get('meta/chat'), { pageVersion: pv })), PV);
  const gone = await until(
    p,
    () => document.getElementById('upd') && document.getElementById('upd').hidden && !document.querySelector('#upd p'),
    null,
    3000,
  );
  ok(live && gone && !p.errors.length, 'notices U15: a pageVersion change shows and clears notice A live');
  await p.close();
  /* U16: a Chrome's name is data, shown as text */
  const evil = '<img src=x onerror="window.__x=1">';
  p = await open(withMeta(metaWith({ versions: vers({ browsers: { [evil]: { helper: '1.1', at: iso(DAY) } } }) })));
  await p.waitForTimeout(300);
  n = await noticeTexts(p);
  ok(
    n &&
      n.length === 1 &&
      n[0].includes('“' + evil + '”') &&
      (await p.evaluate(() => window.__x === undefined && !document.querySelector('#upd img'))),
    'notices U16: a browser name with markup shows as literal text and runs nothing',
  );
  await p.close();
  /* U17: phone width */
  p = await open(all(), PAGE, { viewport: { width: 390, height: 800 } });
  const fit = await p.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: innerWidth,
    right: Math.max(...[...document.querySelectorAll('#upd p')].map(x => x.getBoundingClientRect().right)),
    n: document.querySelectorAll('#upd p').length,
  }));
  ok(
    fit.n === 4 && fit.sw <= fit.iw && fit.right <= fit.iw,
    'notices U17: four notices at 390 px fit the width, no sideways scroll (' + JSON.stringify(fit) + ')',
  );
  await p.close();
  /* U18: dark mode uses the dark tokens */
  p = await open(all(), PAGE, { colorScheme: 'dark' });
  const dark = await p.evaluate(() => {
    const x = document.querySelector('#upd p');
    if (!x) return null;
    const probe = document.createElement('div');
    probe.style.cssText = 'background:var(--accent-soft);color:var(--fg)';
    document.body.append(probe);
    const want = getComputedStyle(probe);
    const got = getComputedStyle(x);
    return { bg: got.backgroundColor, fg: got.color, wantBg: want.backgroundColor, wantFg: want.color };
  });
  ok(
    dark && dark.bg === dark.wantBg && dark.fg === dark.wantFg && dark.bg !== lightBg,
    'notices U18: in dark mode a notice uses the dark --accent-soft and --fg (' + JSON.stringify([dark, lightBg]) + ')',
  );
  await p.close();
  /* U21: E (self-updating, behind) only for the Chrome of the last refresh: one used before has likely updated since */
  const two = browsers => withMeta(metaWith({ versions: vers({ browsers }) }));
  p = await open(two({ 'Work Mac': { helper: '1.9', at: iso(3600000) }, Home: { helper: '1.9', at: iso(3 * DAY) } }));
  n = await noticeTexts(p);
  ok(
    n && n.length === 1 && n[0].startsWith('At the last refresh, Chrome “Work Mac” ran helper 1.9;'),
    "notices U21: two Chromes behind on 1.9: E for the last refresh's only (" + JSON.stringify(n) + ')',
  );
  await p.close();
  /* U22: D (can't update itself) for a Chrome used before, worded with when it was last used */
  p = await open(two({ 'Work Mac': { helper: '2.0', at: iso(3600000) }, Home: { helper: '1.1', at: iso(3 * DAY) } }));
  n = await noticeTexts(p);
  const homeDay = await p.evaluate(
    at => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    iso(3 * DAY),
  );
  ok(
    n &&
      n.length === 1 &&
      n[0].startsWith(
        'When Chrome “Home” was last used for a refresh (' +
          homeDay +
          "), it ran helper 1.1, which can't update itself.",
      ),
    'notices U22: an older Chrome on 1.1: D, saying when it was last used (' + JSON.stringify(n) + ')',
  );
  await p.close();
  /* U23: "Chrome" is what a run with no browser name writes; it may be any named Chrome, so only the newest counts */
  await none(
    two({ 'Work Mac': { helper: '2.0', at: iso(3600000) }, Chrome: { helper: '1.1', at: iso(2 * DAY) } }),
    'U23: an older entry under the fallback name "Chrome" shows nothing',
  );
  p = await open(two({ Chrome: { helper: '1.1', at: iso(3600000) }, Home: { helper: '1.1', at: iso(2 * DAY) } }));
  n = await noticeTexts(p);
  ok(
    n && n.length === 1 && n[0].startsWith("At the last refresh, Chrome ran helper 1.1, which can't update itself."),
    'notices U23: the newest entry is "Chrome" and an older one ran the same helper: one notice, not two (' +
      JSON.stringify(n) +
      ')',
  );
  await p.close();
  p = await open(two({ Chrome: { helper: '2.0', at: iso(3600000) }, Home: { helper: '1.1', at: iso(2 * DAY) } }));
  n = await noticeTexts(p);
  ok(
    n && n.length === 1 && n[0].startsWith('When Chrome “Home” was last used'),
    'notices U23: the newest entry is "Chrome" on 2.0: an older Chrome on 1.1 still gets D (' + JSON.stringify(n) + ')',
  );
  await p.close();
  /* U19: no database in this view (signed out, a preview): nothing to compare, nothing shown */
  await none(Object.assign(all(), { __opts: { noDb: true } }), 'U19: no database: no notices, no errors');
  /* U20: a page from before the notices ignores versions */
  const old = olderPage();
  if (!old) console.log('SKIP notices U20: no release tag with a page from before the notices');
  else {
    p = await open(all(), old.page);
    const txt = await p.evaluate(() => document.getElementById('window').textContent);
    ok(
      !p.errors.length && !/can't load/.test(txt),
      'notices U20: the ' +
        old.tag +
        ' page renders data that has versions, with no page errors (' +
        p.errors.join('; ') +
        ')',
    );
    await p.close();
  }
}

/* ---------- F14: the schedule on the page ----------
   meta/chat.schedule and refresh/schedule (the refresh skill's references/scheduling.md), shown under the status line.
   The clock is fixed at Fri Nov 13 2026, 10:00 AM in Los Angeles (the browser's and the chat's zone). */
const T0 = Date.parse('2026-11-13T18:00:00Z');
const tAt = min => new Date(T0 + min * 60000).toISOString();
const HOURLY = { mode: 'chain', every: 60, hours: { from: '07:00', to: '23:00' }, tz: 'America/Los_Angeles' };
const schedSeed = (schedule, live, extra) =>
  withMeta(
    metaWith(schedule === undefined ? {} : { schedule }),
    Object.assign(live === undefined ? {} : { 'refresh/schedule': live }, extra),
  );
/* {line, warns} as shown ({line:'', warns:[]} when the area is hidden); null when the page has no schedule area */
const schedShown = p =>
  p.evaluate(() => {
    const b = document.getElementById('sched');
    if (!b) return null;
    if (b.hidden) return { line: '', warns: [] };
    const line = b.querySelector('.line');
    return { line: line ? line.textContent : '', warns: [...b.querySelectorAll('.warn')].map(x => x.textContent) };
  });
const sopen = (seed, ctxOpts) => open(seed, PAGE, Object.assign({ clockAt: T0 }, ctxOpts));
const STOP_TAIL = ' Ask Claude in chat to “refresh my catch-up”, and it offers to restart them.';
async function schedule() {
  /* one page per case: what it shows */
  const shows = async (seed, what, want, ctxOpts) => {
    const p = await sopen(seed, ctxOpts);
    const s = await schedShown(p);
    ok(
      s && s.line === want.line && JSON.stringify(s.warns) === JSON.stringify(want.warns || []) && !p.errors.length,
      'schedule: ' + what + ' (' + JSON.stringify([s, p.errors]) + ')',
    );
    await p.close();
  };
  /* S1: the summary and the next run */
  await shows(
    schedSeed(HOURLY, { armId: 'a', nextAt: tAt(5), misses: 0, problem: null }),
    'S1: a chain, hourly 7 AM–11 PM, due in 5 minutes: "Hourly, 7 AM–11 PM. Next refresh about 10:05 AM."',
    { line: 'Hourly, 7 AM–11 PM. Next refresh about 10:05 AM.' },
  );
  await shows(
    schedSeed({ mode: 'recurring', every: 120, tz: 'America/Los_Angeles' }),
    'S2: recurring every 2 hours with no hours and no refresh/schedule: "Every 2 hours, all day."',
    { line: 'Every 2 hours, all day.' },
  );
  await shows(
    schedSeed(
      { mode: 'chain', every: 30, hours: { from: '07:30', to: '22:00' } },
      { nextAt: tAt(26 * 60), lastRunAt: tAt(-4) },
    ),
    'S2b: every 30 minutes from 7:30 AM, next run tomorrow: the date is shown',
    { line: 'Every 30 minutes, 7:30 AM–10 PM. Next refresh about Nov 14, 12:00 PM.' },
  );
  await shows(
    schedSeed(
      { mode: 'manual', every: 60, tz: 'America/Los_Angeles' },
      { nextAt: tAt(5), misses: 4, problem: 'no scheduling tool in this app' },
    ),
    'S3: manual: "Refreshes only when you ask", and no next run, problem or misses',
    { line: 'Refreshes only when you ask.' },
  );
  /* S4: hours that wrap past midnight; 5 minutes early counts as inside */
  const night = { mode: 'chain', every: 60, hours: { from: '22:00', to: '06:00' }, tz: 'America/Los_Angeles' };
  await shows(
    schedSeed(night, { nextAt: null }),
    'S4: 10 PM–6 AM at 10 AM: summary, and no stopped warning outside the hours',
    { line: 'Hourly, 10 PM–6 AM.' },
  );
  for (const [h, when] of [
    [13, '11 PM'],
    [16, '2 AM'],
    [11 + 55 / 60, '9:55 PM'],
  ])
    await shows(
      schedSeed(night, { nextAt: null }),
      'S4: 10 PM–6 AM at ' + when + ', nothing armed: stopped (inside the wrapped hours, or 5 minutes early)',
      { line: 'Hourly, 10 PM–6 AM.', warns: ['Scheduled refreshes have stopped.' + STOP_TAIL] },
      { clockAt: T0 + h * 3600000 },
    );
  await shows(
    schedSeed(night, { nextAt: null }),
    'S4: 10 PM–6 AM at 9:54 PM (6 minutes early): not stopped',
    { line: 'Hourly, 10 PM–6 AM.' },
    { clockAt: T0 + (11 + 54 / 60) * 3600000 },
  );
  await shows(
    schedSeed(night, { nextAt: null }),
    'S4: 10 PM–6 AM at 6:00 AM (to is excluded): not stopped',
    { line: 'Hourly, 10 PM–6 AM.' },
    { clockAt: T0 + 20 * 3600000 },
  );
  /* S5: missing and odd values show nothing, with no errors */
  await shows(SEED(), 'S5: no meta/chat.schedule and no refresh/schedule: nothing', { line: '' });
  await shows(schedSeed(HOURLY), 'S5: a chain with no refresh/schedule document has nothing armed: stopped', {
    line: 'Hourly, 7 AM–11 PM.',
    warns: ['Scheduled refreshes have stopped.' + STOP_TAIL],
  });
  await shows(
    schedSeed(Object.assign({}, HOURLY, { mode: 'recurring' })),
    'S5: a recurring schedule with no refresh/schedule document: the summary only',
    { line: 'Hourly, 7 AM–11 PM.' },
  );
  /* S5c: "00:00"–"24:00" (either way round) is all day */
  for (const hours of [
    { from: '00:00', to: '24:00' },
    { from: '24:00', to: '00:00' },
  ])
    await shows(
      schedSeed(Object.assign({}, HOURLY, { hours }), { nextAt: tAt(5) }),
      'S5c: hours ' + hours.from + '–' + hours.to + ' read as all day',
      { line: 'Hourly, all day. Next refresh about 10:05 AM.' },
    );
  /* S5d: before meta/chat or refresh/schedule has loaded, nothing about the live state (scheduleView directly) */
  {
    const q = await sopen(SEED());
    const v = await q.evaluate(
      ([sc, at]) =>
        typeof scheduleView !== 'function'
          ? null
          : [
              scheduleView(null, { problem: 'no scheduling tool in this app', misses: 4 }, null, Date.now(), 'r'),
              scheduleView(undefined, { problem: 'x' }, null, Date.now(), 'r'),
              scheduleView({ tz: 'America/Los_Angeles', schedule: sc }, undefined, null, Date.now(), 'r'),
              scheduleView({ tz: 'America/Los_Angeles', schedule: sc }, null, null, Date.now(), 'r').warns.length,
            ],
      [HOURLY, T0],
    );
    const empty = JSON.stringify({ line: '', warns: [] });
    ok(
      v &&
        JSON.stringify(v[0]) === empty &&
        JSON.stringify(v[1]) === empty &&
        JSON.stringify(v[2]) === JSON.stringify({ line: 'Hourly, 7 AM–11 PM.', warns: [] }) &&
        v[3] === 1,
      'schedule S5d: no view while meta/chat is not loaded; refresh/schedule not loaded yet (undefined) warns nothing, missing (null) is stopped (' +
        JSON.stringify(v) +
        ')',
    );
    await q.close();
  }
  const odd = [
    ['"B"', 'B'],
    ['mode "A"', { mode: 'A', every: 60 }],
    ['every "often"', { mode: 'chain', every: 'often' }],
    ['every 0', { mode: 'chain', every: 0 }],
    ['every 45.5', { mode: 'chain', every: 45.5 }],
    ['hours "7-23"', { mode: 'chain', every: 60, hours: '7-23' }],
    ['hours 7am to x', { mode: 'chain', every: 60, hours: { from: '7am', to: 'x' } }],
    ['hours 25:00', { mode: 'chain', every: 60, hours: { from: '07:00', to: '25:00' } }],
    ['from = to', { mode: 'chain', every: 60, hours: { from: '07:00', to: '07:00' } }],
    ['tz "Mars/Base"', { mode: 'chain', every: 60, hours: { from: '7:00', to: 'x' }, tz: 'Mars/Base' }],
  ];
  /* (a run started 5 minutes ago, so a chain with nothing armed isn't "stopped" either) */
  for (const [what, sc] of odd)
    await shows(schedSeed(sc, { lastRunAt: tAt(-5) }), 'S5: schedule ' + what + ': nothing', { line: '' });
  await shows(
    schedSeed(HOURLY, { nextAt: 'soon', lastRunAt: tAt(-5), misses: '3', problem: 7 }),
    'S5: odd refresh/schedule fields (nextAt "soon", misses "3", problem 7): ignored',
    { line: 'Hourly, 7 AM–11 PM.' },
  );
  await shows(
    schedSeed(Object.assign({}, HOURLY, { tz: 'Mars/Base' }), { nextAt: tAt(5) }),
    "S5: an unknown tz falls back to meta/chat.tz (the chat's zone)",
    { line: 'Hourly, 7 AM–11 PM. Next refresh about 10:05 AM.' },
  );
  /* S6: Chain stopped (scheduling.md): inside the hours, nextAt missing or over 30 minutes past, no run going */
  await shows(
    schedSeed(HOURLY, { nextAt: tAt(-45), lastRunAt: tAt(-105) }),
    'S6: nextAt 45 minutes past: stopped, with when it was due',
    {
      line: 'Hourly, 7 AM–11 PM.',
      warns: ['Scheduled refreshes have stopped (the next run was due 9:15 AM).' + STOP_TAIL],
    },
  );
  await shows(
    schedSeed(HOURLY, { nextAt: '2026-11-12T17:55:00Z' }),
    'S6: nextAt yesterday: stopped, the date included',
    {
      line: 'Hourly, 7 AM–11 PM.',
      warns: ['Scheduled refreshes have stopped (the next run was due Nov 12, 9:55 AM).' + STOP_TAIL],
    },
  );
  for (const [what, live, extra] of [
    ['nextAt 20 minutes past', { nextAt: tAt(-20) }],
    ['a run started 10 minutes ago (lastRunAt)', { nextAt: tAt(-45), lastRunAt: tAt(-10) }],
    [
      'refresh/status running from 10 minutes ago',
      { nextAt: null },
      { 'refresh/status': { state: 'running', startedAt: tAt(-10), step: 'scan' } },
    ],
  ])
    await shows(schedSeed(HOURLY, live, extra), 'S6: ' + what + ': not stopped', { line: 'Hourly, 7 AM–11 PM.' });
  await shows(
    schedSeed(HOURLY, { nextAt: null }, { 'refresh/status': { state: 'running', startedAt: tAt(-25) } }),
    'S6: a "running" status 25 minutes old is no run going: stopped',
    { line: 'Hourly, 7 AM–11 PM.', warns: ['Scheduled refreshes have stopped.' + STOP_TAIL] },
  );
  await shows(
    schedSeed(Object.assign({}, HOURLY, { mode: 'recurring' }), { nextAt: null }),
    'S6: recurring with no nextAt: no stopped warning (that is for chains)',
    { line: 'Hourly, 7 AM–11 PM.' },
  );
  /* S7: overdue shows up as time passes, and goes when a new run is armed, without a reload */
  let p = await sopen(schedSeed(HOURLY, { nextAt: tAt(-29) }));
  const before = await schedShown(p);
  await p.clock.fastForward(120000);
  const late = await until(p, () => document.querySelectorAll('#sched .warn').length === 1, null, 3000);
  const lateS = await schedShown(p);
  await p.evaluate(at => __rt.write('refresh/schedule', { nextAt: at, misses: 0 }), tAt(62));
  const back = await until(p, () => !document.querySelector('#sched .warn'), null, 3000);
  const backS = await schedShown(p);
  ok(
    before &&
      before.line === 'Hourly, 7 AM–11 PM.' &&
      !before.warns.length &&
      late &&
      lateS.warns[0] === 'Scheduled refreshes have stopped (the next run was due 9:31 AM).' + STOP_TAIL &&
      back &&
      backS.line === 'Hourly, 7 AM–11 PM. Next refresh about 11:02 AM.' &&
      !p.errors.length,
    'schedule S7: nextAt 29 minutes past is quiet; 2 minutes later "stopped" appears, and goes once a run is armed (' +
      JSON.stringify([before, lateS, backS, p.errors]) +
      ')',
  );
  await p.close();
  /* S8: the problem sentence as text, never markup */
  const evil = '<img src=x onerror="window.__x=1"> no scheduling tool in this app';
  p = await sopen(schedSeed(HOURLY, { nextAt: null, problem: evil }));
  let s = await schedShown(p);
  ok(
    s &&
      s.warns.length === 1 &&
      s.warns[0] === 'Scheduled refreshes have stopped: ' + evil + '.' + STOP_TAIL &&
      (await p.evaluate(() => window.__x === undefined && !document.querySelector('#sched img'))),
    'schedule S8: a problem with markup shows literally and runs nothing (' + JSON.stringify(s) + ')',
  );
  await p.close();
  await shows(
    schedSeed(Object.assign({}, HOURLY, { mode: 'recurring' }), { problem: 'The task was cancelled.' }),
    'S8: a problem on a running recurring schedule: "hit a problem", the sentence as written',
    {
      line: 'Hourly, 7 AM–11 PM.',
      warns: [
        'Scheduled refreshes hit a problem: The task was cancelled. Claude reports it on the next refresh you ask for.',
      ],
    },
  );
  await shows(
    schedSeed(HOURLY, { nextAt: tAt(40), problem: 'The last follow-up failed' }),
    'S8: a problem on a chain that is armed (not stopped): reported, no restart offered',
    {
      line: 'Hourly, 7 AM–11 PM. Next refresh about 10:40 AM.',
      warns: [
        'Scheduled refreshes hit a problem: The last follow-up failed. Claude reports it on the next refresh you ask for.',
      ],
    },
  );
  /* S9: missed runs */
  const MISS = "The last 3 scheduled runs couldn't reach Chrome.";
  p = await sopen(schedSeed(HOURLY, { nextAt: tAt(50), misses: 3 }));
  s = await schedShown(p);
  ok(
    s && s.line.endsWith('Next refresh about 10:50 AM.') && s.warns.length === 1 && s.warns[0].startsWith(MISS),
    'schedule S9: misses 3: "' + MISS + '" (' + JSON.stringify(s) + ')',
  );
  await p.close();
  await shows(schedSeed(HOURLY, { nextAt: tAt(50), misses: 1 }), 'S9: misses 1: no line (a single miss is normal)', {
    line: 'Hourly, 7 AM–11 PM. Next refresh about 10:50 AM.',
  });
  await shows(
    schedSeed(Object.assign({}, HOURLY, { mode: 'recurring' }), { misses: 3 }),
    'S9: misses 3 on a recurring schedule: no line (misses count chain runs)',
    { line: 'Hourly, 7 AM–11 PM.' },
  );
  /* S9b: a refresh starting after load hides "stopped" at once, and it's back when the run is over */
  p = await sopen(schedSeed(HOURLY, { nextAt: null }));
  const was = await schedShown(p);
  await p.evaluate(() =>
    __rt.write('refresh/status', { state: 'running', startedAt: new Date().toISOString(), step: 'scan' }),
  );
  const hid = await until(p, () => !document.querySelector('#sched .warn'), null, 3000);
  await p.evaluate(() => __rt.write('refresh/status', { state: 'done', finishedAt: new Date().toISOString() }));
  const shown = await until(p, () => document.querySelectorAll('#sched .warn').length === 1, null, 3000);
  ok(
    was && was.warns.length === 1 && hid && shown && !p.errors.length,
    'schedule S9b: refresh/status turning "running" after load hides "stopped" without waiting for the timer, and "done" brings it back (' +
      JSON.stringify([was, !!hid, !!shown]) +
      ')',
  );
  await p.close();
  /* S9c: a wake-up outside the hours (it only arms the next one) isn't shown as the next refresh */
  await shows(
    schedSeed(HOURLY, { nextAt: tAt(13.5 * 60) }),
    'S9c: nextAt at 11:30 PM, outside 7 AM–11 PM: no next-refresh text',
    { line: 'Hourly, 7 AM–11 PM.' },
  );
  /* S10: the chat's time zone, labelled when it isn't the browser's */
  await shows(
    schedSeed(Object.assign({}, HOURLY, { tz: 'America/New_York' }), { nextAt: tAt(5) }),
    'S10: a New York schedule seen from Los Angeles: its times, labelled',
    { line: 'Hourly, 7 AM–11 PM (EST). Next refresh about 1:05 PM (EST).' },
  );
  /* S10b: the label is the zone's name at nextAt: across the March change it's EDT, while now is still EST */
  await shows(
    schedSeed(Object.assign({}, HOURLY, { tz: 'America/New_York' }), { nextAt: '2027-03-14T18:00:00Z' }),
    'S10b: a New York run due after daylight saving starts: its label from nextAt (EDT)',
    { line: 'Hourly, 7 AM–11 PM (EST). Next refresh about Mar 14, 2:00 PM (EDT).' },
    { clockAt: Date.parse('2027-03-13T18:00:00Z') },
  );
  /* S11: dark mode and phone width */
  const busy = () =>
    schedSeed(HOURLY, { nextAt: tAt(-45), misses: 5, problem: 'Error: ' + 'x'.repeat(160) + ' (send_later refused)' });
  p = await sopen(busy(), { viewport: { width: 390, height: 800 } });
  const fit = await p.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: innerWidth,
    right: Math.max(...[...document.querySelectorAll('#sched p')].map(x => x.getBoundingClientRect().right)),
    n: document.querySelectorAll('#sched p').length,
  }));
  ok(
    fit.n === 3 && fit.sw <= fit.iw && fit.right <= fit.iw,
    'schedule S11: summary, stopped and misses at 390 px fit the width, no sideways scroll (' +
      JSON.stringify(fit) +
      ')',
  );
  const colors = () =>
    p.evaluate(() => {
      const x = document.querySelector('#sched .warn'),
        l = document.querySelector('#sched .line');
      if (!x || !l) return null;
      const probe = document.createElement('div');
      probe.style.cssText = 'background:var(--warn-soft);color:var(--fg);border-color:var(--muted)';
      document.body.append(probe);
      const want = getComputedStyle(probe);
      return {
        bg: getComputedStyle(x).backgroundColor,
        fg: getComputedStyle(x).color,
        line: getComputedStyle(l).color,
        wantBg: want.backgroundColor,
        wantFg: want.color,
        wantLine: want.borderTopColor,
      };
    });
  const light = await colors();
  await p.close();
  p = await sopen(busy(), { colorScheme: 'dark' });
  const dark = await colors();
  ok(
    light &&
      dark &&
      dark.bg === dark.wantBg &&
      dark.fg === dark.wantFg &&
      dark.line === dark.wantLine &&
      dark.bg !== light.bg &&
      !p.errors.length,
    'schedule S11: dark mode uses the dark --warn-soft, --fg and --muted (' + JSON.stringify([light, dark]) + ')',
  );
  await p.close();
}

/* ---------- F19: claims on a deal ----------
   The Messages-view chat with a sale on "packs" (#30) and claims written by the refresh: names as the page shows them,
   first come first, each linking to its message; bad entries skipped. */
async function claims() {
  const V = viewSeed();
  V.msgs[32].fn = 'Ben Brooks';
  V.msgs[37].fn = 'Ben Ortiz'; /* two Bens: the one from #32 is shown with his full name */
  const deal = (conv, extra) =>
    Object.assign(
      {
        kind: 'sale',
        tag: 'For sale',
        conv,
        text: 'Pack, $40',
        refs: [V.th.convs.find(c => c.id === conv).members[0]],
      },
      extra,
    );
  V.sm.deals = [
    deal('packs', {
      claims: [
        { i: 54, who: 'Dee', n: 1 },
        { i: 35, who: 'Cy', n: 2 },
        null,
        'Ana',
        { i: '33', who: 'Ana' },
        { i: 34 },
        { who: 'Dee' },
        { i: -1, who: 'Dee' },
        { i: 36, who: '  ' },
        { i: 32, who: 'Ben' },
        { i: 53, who: 'DD', n: 'x' },
        { i: 1.5, who: 'Cy' },
      ],
    }),
    deal('lend'),
    deal('gone', { claims: [] }),
    deal('t6', { claims: [{ i: 52 }, null, 'x'] }),
    deal('t5', { claims: { i: 40, who: 'Ana' }, status: 'toString', statusAt: 39 }),
    /* F22 (A2): status "sold" | "pending" with statusAt */
    deal('t2', {
      status: 'pending',
      statusAt: 13,
      claims: [
        { i: 13, who: 'Cy' },
        { i: 16, who: 'Ben', n: 2 },
        { i: 25, who: 'Ana' },
      ],
    }),
    deal('t3', { status: 'sold', statusAt: 'x', claims: [{ i: 20, who: 'Ana' }] }),
    deal('t4', { status: 'SOLD', statusAt: 24, claims: [{ i: 26, who: 'Ben' }] }),
    deal('t0', { status: null, statusAt: 2, claims: [{ i: 3, who: 'Cy' }] }),
    deal('t1', { status: 'sold', statusAt: 8 }),
  ];
  const p = await open(SEED());
  await paste(p, JSON.stringify(cap(V.msgs)));
  await p.evaluate(
    ([th, sm]) => {
      const pi = __rt.get('people/index') || { people: {} };
      pi.people['Dee Diaz'] = { shown: ['DD'] };
      __rt.write('people/index', pi);
      __rt.write('threading/current', th);
      __rt.write('summary/current', sm);
      location.hash = '#summary';
    },
    [V.th, V.sm],
  );
  await until(p, () => document.querySelector('[data-conv="packs"] .callout.deal'));
  await p.waitForTimeout(200);
  const got = await p.evaluate(() => {
    const line = c => {
      const x = document.querySelector('[data-conv="' + c + '"] .callout.deal .claims');
      return x ? x.textContent : null;
    };
    const links = [...document.querySelectorAll('[data-conv="packs"] .callout.deal .claims a')].map(a => ({
      t: a.textContent,
      href: a.getAttribute('href'),
    }));
    return { packs: line('packs'), links, others: ['lend', 'gone', 't6', 't5'].map(line) };
  });
  ok(
    got.packs === 'Claimed: Ben Brooks, Cy (2), DD (Dee), Dee' &&
      JSON.stringify(got.links.map(a => a.t)) === JSON.stringify(['Ben Brooks', 'Cy', 'DD (Dee)', 'Dee']) &&
      got.links.every(a => a.href === '#messages'),
    'claims C1: first come first, names as shown elsewhere, "(n)" only above 1, bad entries skipped (' +
      JSON.stringify(got) +
      ')',
  );
  ok(
    !!got.packs && JSON.stringify(got.others) === JSON.stringify([null, null, null, null]),
    'claims C2: beside a deal with claims, no claims, an empty list, only bad entries, or not a list: no line (' +
      JSON.stringify(got.others) +
      ')',
  );
  /* C4 (F22): "Sold" or "Pending" beside the deal, linking to statusAt; claims after it say so; unknown values ignored */
  const sts = await p.evaluate(() =>
    ['t2', 't3', 't4', 't0', 't1', 't5', 'packs'].map(c => {
      const d = document.querySelector('[data-conv="' + c + '"] .callout.deal');
      const x = d && d.querySelector('.lab .dstat');
      const cl = d && d.querySelector('.claims');
      return [
        c,
        x ? x.tagName + ':' + x.textContent + ':' + (x.getAttribute('href') || '') : null,
        cl && cl.textContent,
      ];
    }),
  );
  const wantSts = [
    ['t2', 'A:Pending:#messages', 'Claimed: Cy, Ben (2) (after pending), Ana (after pending)'],
    ['t3', 'SPAN:Sold:', 'Claimed: Ana'],
    ['t4', null, 'Claimed: Ben'],
    ['t0', null, 'Claimed: Cy'],
    ['t1', 'A:Sold:#messages', null],
    ['t5', null, null],
    ['packs', null, 'Claimed: Ben Brooks, Cy (2), DD (Dee), Dee'],
  ];
  ok(
    JSON.stringify(sts) === JSON.stringify(wantSts),
    'claims C4: status shows "Pending"/"Sold" linking to statusAt (a plain label without one), claims after statusAt marked, unknown or null status ignored (' +
      JSON.stringify(sts) +
      ')',
  );
  const stClicked = await tryClick(p, '[data-conv="t2"] .callout.deal .lab a.dstat');
  const stOpen =
    stClicked &&
    (await until(p, () => {
      const d = document.querySelector('[data-conv="t2"] details.thr');
      return d && d.open && location.hash === '#summary' && d.querySelector('.msg[data-i="13"].flash');
    }));
  ok(
    !!stOpen && !p.errors.length,
    'claims C5: the "Pending" label opens its card\'s thread with statusAt (#13) highlighted',
  );
  /* C6: the card's header chip says "Sold" or "Pending" for a closed deal, the offer's tag otherwise */
  const chipsAt = await p.evaluate(() =>
    ['t1', 't2', 't3', 't4', 'packs'].map(c =>
      [...document.querySelectorAll('[data-conv="' + c + '"] .cv-head .chip.deal')].map(x => x.textContent).join('|'),
    ),
  );
  ok(
    JSON.stringify(chipsAt) === JSON.stringify(['Sold', 'Pending', 'Sold', 'For sale', 'For sale']),
    'claims C6: header chips follow the status (unknown status keeps the tag) (' + JSON.stringify(chipsAt) + ')',
  );
  /* C3: a claim in the card opens its thread at that message; one in another conversation goes to Messages */
  const c2 = await tryClick(p, '[data-conv="packs"] .callout.deal .claims a:nth-of-type(2)');
  const inCard =
    c2 &&
    (await until(p, () => {
      const d = document.querySelector('[data-conv="packs"] details.thr');
      return d && d.open && location.hash === '#summary' && d.querySelector('.msg[data-i="35"].flash');
    }));
  const c4 = await tryClick(p, '[data-conv="packs"] .callout.deal .claims a:nth-of-type(4)');
  const away =
    c4 &&
    !!(await until(
      p,
      () =>
        location.hash === '#messages' &&
        !document.getElementById('v-messages').hidden &&
        document.querySelector('#m54.flash'),
    ));
  ok(
    inCard && away && !p.errors.length,
    'claims C3: Cy (#35, in the card) opens its thread at #35, highlighted; Dee (#54, another conversation) goes to Messages with #54 highlighted (' +
      JSON.stringify([inCard, away, p.errors]) +
      ')',
  );
  await p.context().close();
}

/* Scripts the page's sample.json, one reply per call: a value; {__throw: code}; {__auto: true}, a range-summary reply
   made from the prompt (each conversation listed gets a bullet citing its first number and an outcome citing its last;
   one mention, one open question, the same deal in every part); {__wait: ms}, then the next reply (rejects cancelled
   when the call's signal aborts). The stand-in still checks the cap and logs each call first. Each call is kept in
   __json as {prompt, nums (the message numbers it sends), status (the range box's or Look deeper's line then)}. */
async function scriptJson(p, replies) {
  await p.evaluate(rs => {
    const orig = window.__origJson || (window.__origJson = S.sample.json);
    window.__json = window.__json || [];
    window.__replies = rs;
    /* a condense request (PART SUMMARIES): per conversation one bullet citing its block's first number, its open
       questions kept, key = its first numbers */
    const condensed = prompt => {
      const blocks = (prompt.split('PART SUMMARIES (one block per conversation):\n')[1] || '').split('\n\nCONV ');
      const out = { open: [], answered: [], deals: [], convs: [] };
      blocks.forEach(b => {
        const id = b.replace(/^CONV /, '').split(':')[0];
        const refs = (b.match(/#\d+/g) || []).map(x => +x.slice(1));
        out.convs.push({
          id,
          tag: 'Gear',
          synopsis: [{ t: id + ' condensed', refs: refs.slice(0, 2) }],
          outcome: id + ' condensed outcome',
          key: refs.slice(0, 3),
        });
        (b.match(/^open #\d+ \(to [^)]*\): .*$/gm) || []).forEach(l =>
          out.open.push({ conv: id, ask: +l.match(/#(\d+)/)[1], to: 'anyone', note: l.split('): ')[1] }),
        );
      });
      return out;
    };
    const auto = (prompt, add, big) => {
      if (/\nPART SUMMARIES \(one block per conversation\):\n/.test(prompt)) return condensed(prompt);
      const conv = (prompt.split('CONVERSATIONS (id: title: message numbers):\n')[1] || '').split('\n\n')[0];
      const convs = conv
        .split('\n')
        .filter(Boolean)
        .map(l => {
          const k = l.split(': ');
          return { id: k[0], members: k[k.length - 1].split(',').map(Number) };
        });
      const nums = ((prompt.split('\n\nMESSAGES:\n')[1] || '').match(/^#\d+/gm) || []).map(x => +x.slice(1));
      const first = convs[0];
      const ment = nums.find(i => i % 5 !== 2);
      const out = {
        mentions: [{ note: 'Mentioned at #' + ment, refs: [ment] }],
        mentionsNote: 'n/a',
        open: [{ conv: first.id, ask: first.members[0], to: 'anyone', note: 'Asked at #' + first.members[0] }],
        answered: [],
        deals: [
          { kind: 'sale', tag: 'For sale', conv: 'a', text: 'Stove for $40', refs: [nums.find(i => i % 2 === 0)] },
        ],
        convs: convs.map(c => ({
          id: c.id,
          tag: 'Gear',
          synopsis: [
            { t: c.id + ' bullet from #' + c.members[0] + (big ? ' ' + 'x'.repeat(big) : ''), refs: [c.members[0]] },
          ],
          outcome: c.id + ' as of #' + c.members[c.members.length - 1],
          key: [c.members[0], c.members[c.members.length - 1]],
        })),
      };
      Object.entries(add || {}).forEach(([f, v]) => (out[f] = out[f].concat(v)));
      return out;
    };
    S.sample.json = async (prompt, o) => {
      const st = document.querySelector('#v-summary .rangebox .range-st, #chat .deeper:last-child .note');
      const nums = ((String(prompt).split('\n\nMESSAGES:\n')[1] || '').match(/^#\d+/gm) || []).map(x => +x.slice(1));
      __json.push({ prompt, nums, status: st ? st.textContent : '' });
      await orig(prompt, o);
      let r = __replies.length ? __replies.shift() : { __auto: true };
      if (r && r.__wait) {
        const ms = r.__wait;
        await new Promise((res, rej) => {
          const t = setTimeout(res, ms);
          if (o && o.signal)
            o.signal.addEventListener('abort', () => {
              clearTimeout(t);
              rej(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
            });
        });
        r = __replies.length ? __replies.shift() : { __auto: true };
      }
      if (r && r.__throw) throw Object.assign(new Error(r.__throw), { code: r.__throw });
      return r && r.__auto ? auto(prompt, r.add, r.big || window.__big) : r;
    };
  }, replies);
}

/* ---------- deeper: Look deeper under an answer that rested on summaries (F17) ---------- */
/* Presses the newest Look deeper and waits for it to settle; returns the calls it made and what it showed */
async function deepPress(p) {
  const n0 = await p.evaluate(() => __rt.sampleLog.length);
  const s0 = await p.evaluate(() => __rt.samples.length);
  await p.evaluate(() => [...document.querySelectorAll('#chat .deeper button')].pop().click());
  await until(p, () => {
    const r = [...document.querySelectorAll('#chat .deeper')].pop();
    const b = r.querySelector('button');
    return (b.hidden || !b.disabled) && !/^Step/.test(r.querySelector('.note').textContent);
  });
  await sleep(100);
  return p.evaluate(
    ([n0, s0]) => {
      const r = [...document.querySelectorAll('#chat .deeper')].pop();
      const t = [...document.querySelectorAll('#chat .turn.assistant')].pop();
      const sent = __rt.samples.slice(s0);
      const last = sent.filter(Array.isArray).pop();
      return {
        calls: __rt.sampleLog.slice(n0),
        plain: sent.filter(Array.isArray).length,
        json: sent.filter(x => !Array.isArray(x)).length,
        status: r.querySelector('.note').textContent,
        hidden: r.querySelector('button').hidden,
        prompt: last ? last[0].content : null,
        turns: last ? last.length : 0,
        note: (t.querySelector('.sent') || {}).textContent || '',
        answer: t.querySelector('.txt').textContent,
      };
    },
    [n0, s0],
  );
}
const DEEP_Q = 'Who sold a stove?';
async function deepOpen(opts = {}, digests = false) {
  const msgs = hmsgs(800, { perDay: 130 });
  const p = await hopen(
    hseed(msgs, {
      docs: digests ? hdigests(msgs) : {},
      threads: { interleave: true, long: [50, 700] },
      meta: { caughtUpI: 769 },
      opts: Object.assign({ promptMax: 32768, answer: 'From a summary: Ana sold the stove early on [#5].' }, opts),
    }),
    800,
  );
  const r = await hask(p, DEEP_Q, true);
  const rawLo = +((r.note.match(/^Read #(\d+)–#799/) || [])[1] ?? NaN);
  return { p, r, rawLo };
}
async function deeper() {
  /* D1: the button shows only under an answer that rested on summaries */
  await hcase('D1', async () => {
    let p = await hopen(hseed(hmsgs(20), { meta: { markerMode: null } }), 20);
    await hask(p, 'What was for sale?');
    ok(!(await p.$('#chat .deeper')), 'D1: an answer that read everything word for word has no Look deeper button');
    await p.close();
    const o = await deepOpen();
    p = o.p;
    const b = await p.$('#chat .turn.assistant .deeper button');
    ok(
      !!b && (await b.textContent()) === 'Look deeper' && o.r.note.includes('summaries only') && o.r.calls.length === 1,
      'D1: an answer whose note says "summaries only" has a Look deeper button, and nothing more was sent (' +
        o.r.calls.length +
        ' call)',
    );
    await p.close();
  });

  /* D2: step 1 picks a stretch; step 2 sends it word for word with the question; saved with sent */
  await hcase('D2', async () => {
    const { p, rawLo } = await deepOpen();
    await scriptJson(p, [{ stretches: [{ from: 100, to: 160, focus: 130, why: 'the stove sale' }] }]);
    const d = await deepPress(p);
    const j = await p.evaluate(() => __json[0]);
    const lines = await p.evaluate(() => S.msgs.slice(0, 800).map(lineFor));
    ok(
      d.json === 1 && d.plain === 1 && d.calls.every(c => c.code === null),
      'D2: two plain requests, one sample.json then one sample, and nothing else (' + JSON.stringify(d.calls) + ')',
    );
    ok(
      j.prompt.includes('QUESTION: ' + DEEP_Q) &&
        j.prompt.includes('FIRST ANSWER:\nFrom a summary: Ana sold the stove early on [#5].') &&
        /\nSUMMARY LINES \(oldest first; each starts with the message numbers it covers\):\n\[#0/.test(j.prompt) &&
        j.prompt.includes('"stretches"') &&
        j.prompt.includes('#' + rawLo + ' to #799') &&
        /^Step 1 of 2/.test(j.status),
      'D2: step 1 carries the question, the first answer and the summary lines, names what was read, asks for JSON, and the line says "' +
        j.status +
        '"',
    );
    ok(
      d.turns === 1 &&
        d.prompt.includes('QUESTION: ' + DEEP_Q) &&
        d.prompt.includes('MESSAGES #100 to #160 (oldest first):\n' + lines.slice(100, 161).join('\n')) &&
        !d.prompt.includes(lines[99]) &&
        !d.prompt.includes(lines[161]) &&
        d.calls[1].bytes <= 32768 - HMARGIN,
      'D2: step 2 sends #100–#160 word for word, every line in order and nothing either side, with the question, in ' +
        (d.calls[1] || {}).bytes +
        ' bytes',
    );
    ok(
      d.note.startsWith('Looked deeper: read #100–#160 (Oct 1–2) word for word.') &&
        !/too long/.test(d.note) &&
        d.hidden &&
        d.answer === 'From a summary: Ana sold the stove early on #5.',
      'D2: the new answer shows, the note says "' + d.note + '", and the button goes',
    );
    const qa = await until(p, () =>
      Object.values(Object.fromEntries(__rt.store)).find(v => v && v.q === 'Who sold a stove?' && v.scope === 'deeper'),
    );
    ok(
      qa &&
        JSON.stringify(qa.sent) ===
          JSON.stringify({ from: 100, to: 160, stretches: [[100, 160]], wanted: [[100, 160]] }),
      'D2: saved in qa with scope "deeper" and sent ' + JSON.stringify(qa && qa.sent),
    );
    ok(
      (await p.textContent('#qa-list')).includes('looked deeper · #100–#160 word for word'),
      'D2: Earlier questions says it looked deeper, and what it read',
    );
    ok(p.errors.length === 0, 'D2: no page errors ' + JSON.stringify(p.errors));
    await p.close();
  });

  /* D3, D4: malformed replies, nothing named, or only what was already read: no second request */
  await hcase('D3, D4', async () => {
    const { p, rawLo } = await deepOpen();
    const cases = [
      ['plain text', 'Read #100 to #160.', /couldn't be read/],
      ['stretches not a list', { stretches: 'all of it' }, /couldn't be read/],
      ['numbers that are not numbers', { stretches: [{ from: 'abc', to: null }, 7] }, /couldn't be read/],
      ['no stretches key', { pick: [100, 160] }, /couldn't be read/],
      ['invalid_json from the runtime', { __throw: 'invalid_json' }, /couldn't be read/],
      ['an empty list', { stretches: [] }, /found no stretch/],
      [
        'only what was read word for word',
        { stretches: [{ from: rawLo + 5, to: 799 }] },
        /already read word for word, so/,
      ],
      ['only numbers that are not stored', { stretches: [{ from: 5000, to: 6000 }] }, /aren't stored/],
    ];
    for (const [label, reply, want] of cases) {
      await scriptJson(p, [reply]);
      const d = await deepPress(p);
      ok(
        d.json === 1 && d.plain === 0 && want.test(d.status) && !d.hidden,
        'D3: ' + label + ': no second request, the button stays, and "' + d.status + '"',
      );
    }
    ok(p.errors.length === 0, 'D3: no page errors ' + JSON.stringify(p.errors));
    await p.close();
  });

  /* D5: clamped to stored messages, outside what was read, and to the budget around its focus */
  await hcase('D5', async () => {
    const { p, rawLo } = await deepOpen();
    await scriptJson(p, [
      {
        stretches: [
          { from: -50, to: 999999, focus: 200 },
          { from: '#120', to: '#130' },
        ],
      },
    ]);
    const d = await deepPress(p);
    const m = (d.prompt || '').match(/MESSAGES #(\d+) to #(\d+) \(oldest first\):\n([\s\S]*)$/);
    const nums = m ? (m[3].match(/^#\d+/gm) || []).map(x => +x.slice(1)) : [];
    const qa = await until(p, () => Object.values(Object.fromEntries(__rt.store)).find(v => v && v.scope === 'deeper'));
    ok(
      !!m &&
        contiguous(nums) &&
        nums.includes(200) &&
        nums[0] > 0 &&
        nums[nums.length - 1] < rawLo - 1 &&
        d.calls[1].bytes <= 32768 - HMARGIN &&
        (d.prompt.match(/\nMESSAGES #/g) || []).length === 1,
      'D5: from -50 to 999999 becomes #0–#' +
        (rawLo - 1) +
        ' (stored, before the word-for-word part); too long, it goes in as #' +
        nums[0] +
        '–#' +
        nums[nums.length - 1] +
        ' around #200 within the cap (' +
        (d.calls[1] || {}).bytes +
        ' bytes); #120–#130 is inside it and not sent twice',
    );
    ok(
      d.note.includes('#0–#' + (rawLo - 1) + ' was too long to send whole: read the part around #200 that fits.') &&
        qa &&
        JSON.stringify(qa.sent.wanted) === JSON.stringify([[0, rawLo - 1]]) &&
        JSON.stringify(qa.sent.stretches) === JSON.stringify([[nums[0], nums[nums.length - 1]]]),
      'D5: the note says so ("' + d.note + '"), and sent keeps what was wanted and what was read',
    );
    await p.close();
  });

  /* D6: prompt_too_large on step 2: one retry with 80% of the bytes, as Ask does */
  await hcase('D6', async () => {
    const { p } = await deepOpen({ enforce: 24000 });
    await scriptJson(p, [{ stretches: [{ from: 0, to: 400, focus: 200 }] }]);
    const d = await deepPress(p);
    const big = d.calls.filter((c, k) => k > 0);
    ok(
      d.json === 1 &&
        big.length === 2 &&
        big[0].code === 'prompt_too_large' &&
        big[1].code === null &&
        big[1].bytes <= Math.floor(big[0].bytes * 0.8) &&
        d.note.endsWith('(sent a smaller set: the first was too large)'),
      'D6: refused once, sent again smaller (' +
        big.map(c => c.bytes + ' ' + c.code).join(', ') +
        '): "' +
        d.note +
        '"',
    );
    await p.close();
  });

  /* D7: progress and Stop during step 2 */
  await hcase('D7', async () => {
    const { p } = await deepOpen();
    await scriptJson(p, [{ stretches: [{ from: 100, to: 160 }] }]);
    await p.evaluate(() => {
      const o = S.sample;
      const w = (m, opt) =>
        new Promise((res, rej) => {
          const t = setTimeout(() => o(m, opt).then(res, rej), 5000);
          opt.signal.addEventListener('abort', () => {
            clearTimeout(t);
            rej(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
          });
        });
      w.json = o.json;
      w.limits = o.limits;
      S.sample = w;
    });
    await p.evaluate(() => [...document.querySelectorAll('#chat .deeper button')].pop().click());
    const step2 = await until(p, () => {
      const t = [...document.querySelectorAll('#chat .deeper')].pop().querySelector('.note').textContent;
      return /^Step 2 of 2/.test(t) && !document.getElementById('ask-stop').hidden && t;
    });
    const turns0 = await p.evaluate(() => document.querySelectorAll('#chat .turn.assistant').length);
    await p.click('#ask-stop');
    const st = await until(p, () => {
      const t = [...document.querySelectorAll('#chat .deeper')].pop().querySelector('.note').textContent;
      return !/^Step/.test(t) && t;
    });
    await sleep(200);
    const r = await p.evaluate(() => ({
      turns: document.querySelectorAll('#chat .turn.assistant').length,
      saved: Object.values(Object.fromEntries(__rt.store)).filter(v => v && v.scope === 'deeper').length,
      enabled:
        !document.getElementById('ask-go').disabled &&
        ![...document.querySelectorAll('#chat .deeper button')].pop().disabled,
    }));
    ok(
      !!step2 && step2.includes('#100–#160') && st === 'Stopped.' && r.turns === turns0 - 1 && !r.saved && r.enabled,
      'D7: "' +
        step2 +
        '", then Stop: "' +
        st +
        '", the empty answer goes, nothing is saved, and Ask and the button work again',
    );
    await p.close();
  });

  /* D8: with per-day digests (F16), step 1 sees the digest lines Ask sent; a citation in the deeper answer opens its
     message, loading its day (F15) */
  await hcase('D8', async () => {
    const { p, r } = await deepOpen({ promptMax: 16384 }, true);
    await scriptJson(p, [{ stretches: [{ from: 100, to: 160 }] }]);
    await deepPress(p);
    const j = await p.evaluate(() => __json[__json.length - 1].prompt);
    const dg = (r.prompt.match(/^\[#\d+(?:–#\d+)?, [A-Z][a-z]{2} \d+\] [\d,]+ messages\. Digest: .*$/gm) || []).slice(
      0,
      3,
    );
    ok(
      dg.length > 0 && dg.every(l => j.includes(l)),
      'D8: step 1 carries the digest day lines Ask sent (' +
        dg.length +
        ' checked, e.g. "' +
        (dg[0] || '').slice(0, 80) +
        '")',
    );
    await p.evaluate(() =>
      [...document.querySelectorAll('#chat .turn.assistant')].pop().querySelector('a.cite').click(),
    );
    ok(
      await until(p, () => location.hash === '#messages' && document.getElementById('m5')),
      'D8: a citation in the deeper answer (#5, before the window) opens that message',
    );
    ok(p.errors.length === 0, 'D8: no page errors ' + JSON.stringify(p.errors));
    await p.close();
  });
}

/* D9: step 2's budget is shared: the most relevant stretch goes in whole, the next one gets what's left */
async function deeperBudget() {
  await hcase('D9', async () => {
    const { p, rawLo } = await deepOpen();
    await scriptJson(p, [
      {
        stretches: [
          { from: 450, to: 500 },
          { from: 0, to: 400, focus: 100 },
        ],
      },
    ]);
    const d = await deepPress(p);
    const lines = await p.evaluate(() => S.msgs.slice(0, 501).map(lineFor));
    ok(
      rawLo > 501 &&
        d.prompt.includes('MESSAGES #450 to #500 (oldest first):\n' + lines.slice(450, 501).join('\n')) &&
        d.note.includes('#0–#400 was too long to send whole: read the part around #100 that fits.') &&
        !d.note.includes('#450–#500 was too long') &&
        d.calls[1].bytes <= 32768 - HMARGIN,
      'D9: #450–#500 (named first) is sent whole and #0–#400 is cut to what is left, within the cap (' +
        (d.calls[1] || {}).bytes +
        ' bytes): "' +
        d.note +
        '"',
    );
    await p.close();
  });
}

/* ---------- longRanges: a range summary longer than one request, in parts (F18) ---------- */
/* 600 messages today with longer lines; conversations a (even numbers), b (odd, before #300) and c (odd, from #300);
   the saved summary starts at #300, so a window from today's start asks for a span summary of #0–#599 */
function lrSeed(n, opts, links = {}) {
  const msgs = range(0, n - 1, i =>
    mk(i, { b: 'message ' + i + ' about the ridge trail, tent poles and a spare stove' }),
  );
  const half = n >> 1;
  const TH = {
    convs: [
      { id: 'a', title: 'Stoves', members: range(0, n - 1, i => i).filter(i => i % 2 === 0) },
      { id: 'b', title: 'Tents', members: range(0, half - 1, i => i).filter(i => i % 2 === 1) },
      { id: 'c', title: 'Packs', members: range(half, n - 1, i => i).filter(i => i % 2 === 1) },
    ],
    links,
    to: n - 1,
    note: '',
  };
  const SM = {
    version: 2,
    convs: [{ id: 'a', tag: '', synopsis: [{ t: 'Later part', refs: [half] }], outcome: '', key: [half] }],
    open: [],
    answered: [],
    deals: [],
    mentions: [],
    fromI: half,
    toI: n - 1,
    generatedAt: 'now',
  };
  return hseed(msgs, {
    meta: { markerMode: 'time', markerFrom: ymd(TODAY) + 'T00:00', markerTo: null },
    docs: { 'threading/current': TH, 'summary/current': SM },
    opts,
  });
}
async function lrOpen(opts, n = 600, links) {
  const p = await hopen(lrSeed(n, opts, links), n);
  const box = await until(p, () => {
    const b = document.querySelector('#v-summary .rangebox');
    return b && b.querySelector('button') && b.textContent;
  });
  return { p, box, k: +((box || '').match(/reads it in (\d+) parts/) || [])[1] || 1 };
}
const lrStatus = p =>
  p.evaluate(() => (document.querySelector('#v-summary .rangebox .range-st') || {}).textContent || '');
const lrDoc = (p, n = 600) => get(p, 'rangeSummaries/r0_' + (n - 1));
async function lrRun(p, replies, done) {
  await scriptJson(p, replies);
  await p.click('#v-summary .rangebox button.primary');
  return until(p, done, null, 60000);
}
/* every message of the span sent once, in order, in parts each within the cap */
function lrCover(calls, n, lim) {
  const all = calls.flatMap(c => c.nums);
  return (
    all.length === n &&
    all.every((x, k) => x === k) &&
    calls.every(c => c.nums.length > 0 && contiguous(c.nums)) &&
    calls.every(c => new TextEncoder().encode(c.prompt).length <= lim)
  );
}
async function longRanges() {
  /* L1: a long span gets the button and says how many parts; nothing is sent before it's pressed */
  await hcase('L1', async () => {
    const { p, box, k } = await lrOpen({ promptMax: 24576 });
    ok(
      k >= 3 &&
        /This span has 600 messages \(Fri 9:00 AM to Fri 6:59 PM\), more than Claude can read at once/.test(box) &&
        !/Pick a shorter span/.test(box) &&
        (await p.evaluate(() => __rt.sampleLog.length)) === 0,
      'L1: a 600-message span at a 24 KiB cap offers the button, read in ' +
        k +
        ' parts, with no call yet: "' +
        box.slice(0, 220) +
        '…"',
    );
    await p.close();
  });

  /* L2: parts under the cap, progress, and the merge */
  await hcase('L2', async () => {
    const { p, k } = await lrOpen({ promptMax: 24576 });
    const doc = await lrRun(p, [], () => __rt.get('rangeSummaries/r0_599'));
    const calls = await p.evaluate(() => __json);
    ok(
      calls.length === k && lrCover(calls, 600, 24576 - HMARGIN),
      'L2: ' +
        k +
        ' requests, each within the cap less the margin, sending every message of #0–#599 once, in order (' +
        calls.map(c => c.nums[0] + '–' + c.nums[c.nums.length - 1]).join(', ') +
        ')',
    );
    ok(
      calls.every((c, x) => c.status === 'Writing part ' + (x + 1) + ' of ' + k + '… keep this tab open.'),
      'L2: progress says "Writing part n of ' +
        k +
        '" for each part (' +
        calls.map(c => c.status.slice(0, 22)).join(' | ') +
        ')',
    );
    const ids = doc.convs.map(c => c.id);
    const a = doc.convs.find(c => c.id === 'a') || {};
    const firstA = calls.map(c => c.nums.find(i => i % 2 === 0));
    ok(
      JSON.stringify(ids) === '["a","b","c"]' &&
        JSON.stringify(a.synopsis.map(x => x.t)) === JSON.stringify(firstA.map(i => 'a bullet from #' + i)) &&
        a.outcome === 'a as of #598' &&
        JSON.stringify(a.key) === JSON.stringify(firstA),
      'L2: conversations joined by id in order (' +
        ids +
        "); a has one bullet per part, in order, the last outcome, and key numbers that are each part's first pick " +
        JSON.stringify(a.key),
    );
    const b = doc.convs.find(c => c.id === 'b');
    const c = doc.convs.find(c => c.id === 'c');
    const partsWith = f => calls.filter(x => x.nums.some(f)).length;
    ok(
      b.synopsis.length === partsWith(i => i % 2 && i < 300) &&
        c.synopsis.length === partsWith(i => i % 2 && i >= 300) &&
        b.outcome === 'b as of #299' &&
        c.outcome === 'c as of #599',
      'L2: b and c, each in the parts that hold them, keep one bullet per part (' +
        b.synopsis.length +
        ', ' +
        c.synopsis.length +
        ')',
    );
    ok(
      doc.deals.length === 1 &&
        JSON.stringify(doc.deals[0].refs) === JSON.stringify(firstA) &&
        doc.mentions.length === k &&
        ascending(doc.mentions.map(m => m.refs[0][0])) &&
        doc.open.length === new Set(doc.open.map(o => o.ask)).size &&
        doc.open.length === k,
      "L2: the same deal in every part is one deal with every part's number; " +
        doc.mentions.length +
        ' mentions in order; open questions without repeats',
    );
    ok(
      doc.by === 'page' && doc.version === 2 && doc.fromI === 0 && doc.toI === 599 && doc.parts === k,
      'L2: saved as one summary of #0–#599 (by page, version 2, parts ' + doc.parts + ')',
    );
    ok(
      (await until(p, () => !document.querySelector('#v-summary .rangebox'))) &&
        /a as of #598/.test(await p.textContent('#v-summary')),
      'L2: the merged summary replaces the box and renders',
    );
    ok(p.errors.length === 0, 'L2: no page errors ' + JSON.stringify(p.errors));
    await p.close();
  });

  /* L3: a part that fails once is tried again */
  await hcase('L3', async () => {
    const { p, k } = await lrOpen({ promptMax: 24576 });
    const doc = await lrRun(p, [{ __auto: true }, { __throw: 'unavailable' }], () => __rt.get('rangeSummaries/r0_599'));
    const calls = await p.evaluate(() => __json);
    ok(
      doc &&
        doc.parts === k &&
        calls.length === k + 1 &&
        JSON.stringify(calls[1].nums) === JSON.stringify(calls[2].nums),
      'L3: part 2 failed once and was sent again, the same messages; ' +
        calls.length +
        ' requests for ' +
        k +
        ' parts, saved',
    );
    await p.close();
  });

  /* L4: a part that fails twice: the span is named, nothing is saved, and Write the rest goes on from it */
  await hcase('L4', async () => {
    const { p, k } = await lrOpen({ promptMax: 24576 });
    const st = await lrRun(p, [{ __auto: true }, { __throw: 'unavailable' }, { __throw: 'unavailable' }], () => {
      const t = (document.querySelector('#v-summary .rangebox .range-st') || {}).textContent || '';
      return /failed twice/.test(t) && t;
    });
    const calls = await p.evaluate(() => __json);
    const p2 = calls[1].nums;
    const btn = await p.textContent('#v-summary .rangebox button.primary');
    ok(
      calls.length === 3 &&
        st.startsWith('Part 2 of ' + k + ', #' + p2[0] + '–#' + p2[p2.length - 1] + ' (') &&
        st.includes("failed twice (unavailable), so that span isn't summarized.") &&
        st.includes('Part 1 is done but not saved') &&
        btn === 'Write the rest' &&
        !(await lrDoc(p)),
      'L4: "' + st + '", button "' + btn + '", and nothing saved',
    );
    await p.evaluate(() => (__json.length = 0));
    const doc = await lrRun(p, [], () => __rt.get('rangeSummaries/r0_599'));
    const more = await p.evaluate(() => __json);
    ok(
      doc &&
        more.length === k - 1 &&
        more[0].nums[0] === p2[0] &&
        doc.parts === k &&
        JSON.stringify(doc.convs.find(c => c.id === 'a').synopsis[0].t) === '"a bullet from #0"',
      'L4: Write the rest sends parts 2–' +
        k +
        ' only (' +
        more.length +
        ' requests, from #' +
        (more[0] || { nums: [] }).nums[0] +
        ') and saves the whole span, part 1 included',
    );
    await p.close();
  });

  /* L5: Stop mid-run: nothing half-written is saved, and no more requests go */
  await hcase('L5', async () => {
    const { p, k } = await lrOpen({ promptMax: 24576 });
    await scriptJson(p, [{ __auto: true }, { __wait: 5000 }]);
    await p.click('#v-summary .rangebox button.primary');
    await until(
      p,
      () => __json.length === 2 && !document.querySelector('#v-summary .rangebox button.secondary').hidden,
    );
    await p.click('#v-summary .rangebox button.secondary');
    const st = await until(p, () => {
      const t = (document.querySelector('#v-summary .rangebox .range-st') || {}).textContent || '';
      return /^Stopped/.test(t) && t;
    });
    await sleep(300);
    const r = await p.evaluate(() => ({
      calls: __json.length,
      saved: [...__rt.store.keys()].filter(x => x.startsWith('rangeSummaries/')),
    }));
    ok(
      st ===
        'Stopped at part 2 of ' +
          k +
          '. Part 1 is done but not saved: the summary is saved only once every part is done. Press Write the rest to go on.' &&
        r.calls === 2 &&
        r.saved.length === 0,
      'L5: "' + st + '"; ' + r.calls + ' requests and no rangeSummaries document',
    );
    await p.close();
  });

  /* L6: no cap on parts */
  await hcase('L6', async () => {
    const { p, k } = await lrOpen({ promptMax: 9000 });
    const doc = await lrRun(p, [], () => __rt.get('rangeSummaries/r0_599'));
    const calls = (await p.evaluate(() => __json)).filter(c => !/\nPART SUMMARIES/.test(c.prompt));
    ok(
      k >= 20 && doc && doc.parts === k && calls.length === k && lrCover(calls, 600, 9000 - HMARGIN),
      'L6: at a 9,000-byte cap the span takes ' + k + ' parts, every one sent and merged',
    );
    await p.close();
  });

  /* L7: prompt_too_large (the runtime counts more strictly than it says): what's left is split again at 80% */
  await hcase('L7', async () => {
    const { p, k } = await lrOpen({ promptMax: 24576, enforce: 18000 });
    const doc = await lrRun(p, [], () => __rt.get('rangeSummaries/r0_599'));
    const r = await p.evaluate(() => ({ json: __json, log: __rt.sampleLog }));
    const ok2 = r.json.filter((c, x) => r.log[x].code === null && !/\nPART SUMMARIES/.test(c.prompt));
    ok(
      doc &&
        r.log.filter(c => c.code === 'prompt_too_large').length === 1 &&
        r.log[0].code === 'prompt_too_large' &&
        lrCover(ok2, 600, 18000) &&
        doc.parts === ok2.length &&
        ok2[0].nums.length < r.json[0].nums.length,
      'L7: refused once, then what was left split again smaller (part 1: ' +
        (ok2[0] || { nums: [] }).nums.length +
        ' messages, from ' +
        r.json[0].nums.length +
        '; ' +
        doc.parts +
        ' parts, ' +
        k +
        ' before), each within what the runtime takes, covering the span',
    );
    await p.close();
  });

  /* L8: a span that fits is still one request, saved without a parts count */
  await hcase('L8', async () => {
    const { p, box } = await lrOpen({}, 100);
    const doc = await lrRun(p, [], () => __rt.get('rangeSummaries/r0_99'));
    ok(
      /All 100 messages in this span/.test(box) &&
        doc &&
        doc.parts === undefined &&
        (await p.evaluate(() => __json.length)) === 1,
      'L8: a 100-message span at the full cap: one request, saved without parts',
    );
    await p.close();
  });
}

/* longRanges2: the review's cases (release C): questions across parts, links that answer, special ids, a merge too big
   to save (condensed), a failed save shown, and new messages arriving during a run */
async function longRanges2() {
  /* L9: an open question answered in a later part, and the links that do or don't answer one (F18 review 3, 5, 8) */
  await hcase('L9', async () => {
    /* #10, #20, #30, #40 are Ana's questions in part 1. #231 (Ben) replies to #30; #235 (Ana) replies to her own #20;
       #240 (Ana) continues #40, and so (by type alone) does #241 (Ben): only Ben's reply answers. Part 2 answers #10
       from its messages. */
    const links = { 231: [30, 'r'], 235: [20, 'r'], 240: [40, 'c'], 241: [40, 'c'] };
    const { p, k } = await lrOpen({ promptMax: 24576 }, 600, links);
    const q = n => ({ conv: 'a', ask: n, to: 'anyone', note: 'Q' + n });
    const doc = await lrRun(
      p,
      [
        { __auto: true, add: { open: [q(10), q(20), q(30), q(40)] } },
        {
          __auto: true,
          add: { answered: [{ conv: 'a', ask: 10, answer: 'Answered in part 2', refs: [250] }] },
        },
        {
          __auto: true,
          add: {
            convs: [
              { id: 'constructor', tag: 'x', synopsis: [{ t: 'odd', refs: [400] }], outcome: '', key: [400] },
              { id: '__proto__', tag: 'x', synopsis: [{ t: 'odd', refs: [400] }], outcome: '', key: [400] },
            ],
            open: [{ conv: 'constructor', ask: 400, to: 'anyone', note: 'odd' }],
            deals: [{ kind: 'sale', tag: '', conv: 'hasOwnProperty', text: 'odd', refs: [400] }],
          },
        },
      ],
      () => __rt.get('rangeSummaries/r0_599'),
    );
    const calls = await p.evaluate(() => __json);
    ok(
      k === 4 &&
        /\nEARLIER OPEN QUESTIONS \(conversation: number: question\):\n(.*\n)*a: #10: Q10\n/.test(calls[1].prompt) &&
        !/EARLIER OPEN QUESTIONS/.test(calls[0].prompt),
      "L9: part 2's request carries part 1's open questions (a: #10: Q10), part 1's none",
    );
    const asks = doc ? doc.open.map(o => o.ask) : [];
    ok(
      doc &&
        !asks.includes(10) &&
        doc.answered.some(a => a.ask === 10 && a.answer === 'Answered in part 2' && a.conv === 'a'),
      'L9: #10, asked in part 1 and answered in part 2, is answered, not open (open ' + JSON.stringify(asks) + ')',
    );
    ok(
      doc && !asks.includes(30) && asks.includes(20) && asks.includes(40),
      "L9: Ben's reply to #30 answers it; Ana replying to her own #20, or a continues link to #40, doesn't (open " +
        JSON.stringify(asks) +
        ')',
    );
    ok(
      doc &&
        JSON.stringify(doc.convs.map(c => c.id)) === '["a","b","c"]' &&
        !asks.includes(400) &&
        doc.deals.every(d => d.conv === 'a') &&
        p.errors.length === 0,
      'L9: conversation ids "constructor", "__proto__" and "hasOwnProperty" from a reply are dropped, not crashed on (' +
        JSON.stringify(p.errors) +
        ')',
    );
    await p.close();
  });

  /* L10: a merge too big to save is condensed under the 256 KiB document limit (F18 review 1) */
  await hcase('L10', async () => {
    const { p, k } = await lrOpen({ promptMax: 9000 });
    await p.evaluate(() => (window.__big = 6000));
    const doc = await lrRun(p, [], () => __rt.get('rangeSummaries/r0_599'));
    const r = await p.evaluate(() => ({
      calls: __json.map(c => ({ join: /\nPART SUMMARIES/.test(c.prompt), status: c.status })),
      bytes: new TextEncoder().encode(JSON.stringify(__rt.get('rangeSummaries/r0_599') || null)).length,
    }));
    const joins = r.calls.filter(c => c.join);
    ok(
      k > 20 &&
        doc &&
        doc.condensed === true &&
        doc.parts === k &&
        r.bytes <= 262144 &&
        JSON.stringify(doc.convs.map(c => [c.id, c.synopsis[0].t])) ===
          '[["a","a condensed"],["b","b condensed"],["c","c condensed"]]' &&
        joins.length >= 1 &&
        r.calls.length === k + joins.length &&
        joins.every(c => /^Joining the \d+ parts into one summary/.test(c.status)),
      'L10: ' +
        k +
        ' parts with long bullets are condensed in ' +
        joins.length +
        ' more requests ("' +
        (joins[0] || {}).status +
        '") and saved in ' +
        r.bytes +
        ' bytes',
    );
    await p.close();
  });

  /* L11: a save that fails is shown, the summary stays on screen, and Save it again saves it (F18 review 1) */
  await hcase('L11', async () => {
    const { p } = await lrOpen({ promptMax: 24576 });
    await p.evaluate(() => __rt.fails.push({ p: 'rangeSummaries/r0_599', op: 'set' }));
    const t = await lrRun(p, [], () => {
      const v = document.getElementById('v-summary').textContent;
      return /Written, but not saved/.test(v) && v;
    });
    ok(
      !!t &&
        t.includes("Written, but not saved (unavailable). It's shown until this page reloads.") &&
        /a as of #598/.test(t) &&
        !(await lrDoc(p)),
      'L11: a failed save says "Written, but not saved (unavailable)…" and the summary is shown',
    );
    await p.click('text=Save it again');
    const doc = await until(p, () => __rt.get('rangeSummaries/r0_599'));
    ok(
      !!doc && (await until(p, () => !/Written, but not saved/.test(document.getElementById('v-summary').textContent))),
      'L11: Save it again saves it and the warning goes',
    );
    await p.close();
  });

  /* L12: new messages arrive during a run of a window with no end (F18 review 2) */
  await hcase('L12', async () => {
    const { p } = await lrOpen({ promptMax: 24576 });
    await scriptJson(p, [{ __auto: true }, { __wait: 3000 }]);
    await p.click('#v-summary .rangebox button.primary');
    await until(p, () => __json.length === 2);
    await p.evaluate(m => __rt.write('chunks/c9600', { start: 600, msgs: [m] }), mk(600, { b: 'a newer message' }));
    const box = await until(p, () => {
      const b = document.querySelector('#v-summary .rangebox');
      return S.msgs.length === 601 && b && b.textContent;
    });
    const btns = await p.evaluate(() =>
      [...document.querySelectorAll('#v-summary .rangebox button')].map(b => [b.textContent, b.hidden, b.disabled]),
    );
    ok(
      /Writing a summary for #0–#599 \(Fri 9:00 AM to Fri 6:59 PM\)…/.test(box) &&
        /Writing part 2 of 4/.test(box) &&
        JSON.stringify(btns) === '[["Stop",false,false]]',
      'L12: with a new message the box shows the run for #0–#599 with Stop, not an idle button (' +
        String(box).slice(0, 120) +
        '…, ' +
        JSON.stringify(btns) +
        ')',
    );
    const doc = await until(p, () => __rt.get('rangeSummaries/r0_599'), null, 30000);
    const v = await until(p, () => {
      const t = document.getElementById('v-summary').textContent;
      return /This summary covers #0–#599/.test(t) && t;
    });
    ok(
      !!doc &&
        !!v &&
        v.includes("It doesn't include the 1 newer message after #599.") &&
        /a as of #598/.test(v) &&
        (await p.$('text=Write it again through #600')) !== null,
      'L12: once written, the window (#0–#600) uses the summary of #0–#599 and says what it leaves out',
    );
    await p.close();
  });
}

/* ---------- olderByDay: "Show older messages" by day (F15) ----------
   With Show older on, the Messages tab holds the window and the day before it; an edge near the top of the screen loads
   the previous day (an IntersectionObserver) and keeps the message on screen where it was. Counted, never timed: rows
   drawn (.msg[id] and msgRow calls). synth.py writes about 460 messages a day from 7 AM Sep 1, so a day is far taller
   than the screen and one scroll to the top loads exactly one day. The browser's own scroll anchoring is off (Safari has
   none), so the page has to keep the place itself. */
const OP = [];
async function ocase(name, fn) {
  try {
    await fn();
  } catch (e) {
    ok(false, name + ' crashed: ' + ((e && e.stack) || e).toString().split('\n').slice(0, 3).join(' '));
  }
  while (OP.length)
    await OP.pop()
      .context()
      .close()
      .catch(() => {});
}
/* meta(msgs): what to add to meta/chat */
async function oopen(n, meta, ctx) {
  const { seed, msgs } = synthSeed(n, 1000);
  Object.assign(seed['meta/chat'], meta(msgs));
  const p = await open(seed, PAGE, ctx);
  OP.push(p);
  await until(p, n => S.msgs.length === n && S.threading, n, 120000);
  await p.addStyleTag({ content: '* { overflow-anchor: none !important; }' });
  await p.evaluate(() => {
    location.hash = '#messages';
    scrollTo(0, 0);
  });
  await p.waitForTimeout(200);
  return { p, msgs };
}
const oRows = p => p.evaluate(() => document.querySelectorAll('#msgs .msg[id]').length);
/* day d: the index of its first and last message, and how many */
function oDay(msgs, d) {
  const a = msgs.findIndex(m => m.d === d);
  let b = a;
  while (b + 1 < msgs.length && msgs[b + 1].d === d) b++;
  return { a, b, n: b - a + 1 };
}
/* (after scrolling to y, when given) the first message row or conversation on screen below the tabs and the toolbar
   when it sticks: a selector and its height on screen. Taken in the same task as the scroll, before any day loads. */
const oSpot = (p, y) =>
  p.evaluate(y => {
    if (y != null) scrollTo(0, y);
    const v = document.getElementById('v-messages');
    const tb = v.querySelector('.toolbar').getBoundingClientRect();
    const sticks = getComputedStyle(v.querySelector('.toolbar')).position === 'sticky';
    const top = Math.max(document.querySelector('nav.tabs').getBoundingClientRect().bottom, sticks ? tb.bottom : 0);
    for (const x of document.querySelectorAll('#msgs .msg[id], #msgs details.conv > summary')) {
      const r = x.getBoundingClientRect();
      if (r.height > 0 && r.bottom > top && r.top < innerHeight)
        return {
          key: x.id ? '#' + x.id : '#msgs details.conv[data-conv="' + x.parentElement.dataset.conv + '"] > summary',
          y: Math.round(r.top),
        };
    }
    return null;
  }, y);
const oY = (p, key) =>
  p.evaluate(k => {
    const x = document.querySelector(k);
    return x ? Math.round(x.getBoundingClientRect().top) : null;
  }, key);
/* count msgRow calls from now on (window.__rows) */
const oCount = p =>
  p.evaluate(() => {
    window.__rows = 0;
    if (!window.__wrapped) {
      const o = window.msgRow;
      window.msgRow = function () {
        window.__rows++;
        return o.apply(this, arguments);
      };
      window.__wrapped = true;
    }
  });
/* scroll to the top and wait for the next day (or 3 s); then a moment more, in case another loads */
async function oUp(p) {
  const r0 = await oRows(p);
  const spot = await oSpot(p, 0);
  await until(p, r0 => document.querySelectorAll('#msgs .msg[id]').length !== r0, r0, 3000);
  await p.waitForTimeout(400);
  const r1 = await oRows(p);
  return { r0, r1, spot, y: spot && (await oY(p, spot.key)), made: await p.evaluate(() => window.__rows) };
}
/* the threaded layout's conversations: none twice, in order of their first message shown, and every row once */
const oConvs = p =>
  p.evaluate(() => {
    const ids = [...document.querySelectorAll('#msgs > details.conv:not([data-conv="_rest"])')];
    const firsts = ids.map(d => Math.min(...[...d.querySelectorAll('.msg[id]')].map(x => +x.id.slice(1))));
    const rows = [...document.querySelectorAll('#msgs .msg[id]')].map(x => x.id);
    return {
      convs: ids.map(d => d.dataset.conv),
      unique: new Set(ids.map(d => d.dataset.conv)).size === ids.length,
      sorted: firsts.every((x, k) => k === 0 || x > firsts[k - 1]),
      rowsOnce: new Set(rows).size === rows.length,
      rows: rows.sort().join(),
    };
  });
const lastTwoDays = n => msgs => ({ markerMode: 'time', markerFrom: msgs[n - 920].d + 'T00:00' });

async function olderByDay() {
  /* O1: at 6,400 and 25,000 messages, Show older draws the window and the day before it, nothing more */
  await ocase('O1', async () => {
    for (const n of [6400, 25000]) {
      const { p, msgs } = await oopen(n, lastTwoDays(n));
      const wa = msgs.findIndex(m => m.d === msgs[n - 920].d);
      const prev = oDay(msgs, msgs[wa - 1].d);
      const win = await oRows(p);
      await oCount(p);
      await p.click('#msg-all');
      await p.waitForTimeout(600);
      const got = await oRows(p);
      const made = await p.evaluate(() => window.__rows);
      ok(
        win === n - wa && got === n - prev.a && made < 1.2 * got,
        'F15 O1: at ' +
          n +
          ' messages Show older draws the window (' +
          (n - wa) +
          ') and the day before it (' +
          prev.n +
          '): ' +
          got +
          ' rows, ' +
          made +
          ' msgRow calls with context lines (was every stored message)',
      );
      await OP.pop().context().close();
    }
  });

  /* O2: each scroll to the top adds the previous day, keeps the message on screen in place and loads nothing more */
  await ocase('O2', async () => {
    const n = 6400;
    const { p, msgs } = await oopen(n, lastTwoDays(n));
    await p.click('#lay-flat');
    await p.click('#msg-all');
    await p.waitForTimeout(500);
    const res = [];
    for (let k = 0; k < 2; k++) {
      await oCount(p);
      const r = await oUp(p);
      const d = oDay(msgs, msgs[Math.max(0, n - r.r0 - 1)].d);
      res.push({ added: r.r1 - r.r0, day: d.n, made: r.made, dy: r.y == null ? null : r.y - r.spot.y });
    }
    ok(
      res.every(r => r.added === r.day && r.made === r.day),
      'F15 O2: in the timeline, each scroll to the top loads one more day, drawing only that day ' +
        JSON.stringify(res),
    );
    ok(
      res.every(r => r.dy != null && Math.abs(r.dy) <= 3),
      'F15 O2: the message on screen stays put as a day is added above it (moved ' +
        res.map(r => r.dy).join(', ') +
        ' px)',
    );
    ok(
      (await p.evaluate(() => scrollY)) > 2000 && !(await p.$('#msgs > .edge.top:not(.more)')),
      'F15 O2: after loading, the reader is still deep in the page, with more days above',
    );
    ok(p.errors.length === 0, 'F15 O2: no page errors ' + JSON.stringify(p.errors));
  });

  /* O3: the threaded layout: a day added at the top redraws only the conversations it touches, every message shows
     once, conversations stay in order, and a full redraw (new data) shows the same */
  await ocase('O3', async () => {
    const n = 6400;
    const { p, msgs } = await oopen(n, lastTwoDays(n));
    await p.click('#lay-thread');
    await p.click('#msg-all');
    await p.waitForTimeout(500);
    const res = [];
    for (let k = 0; k < 2; k++) {
      await oCount(p);
      const r = await oUp(p);
      const d = oDay(msgs, msgs[Math.max(0, n - r.r0 - 1)].d);
      res.push({ added: r.r1 - r.r0, day: d.n, made: r.made, dy: r.y == null ? null : r.y - r.spot.y });
    }
    const c1 = await oConvs(p);
    ok(
      res.every(r => r.added === r.day && r.made <= 2 * r.day),
      'F15 O3: threaded, each scroll to the top adds one day, redrawing only what it touches ' + JSON.stringify(res),
    );
    ok(
      res.every(r => r.dy != null && Math.abs(r.dy) <= 3),
      'F15 O3: threaded, the conversation or message on screen stays put (moved ' +
        res.map(r => r.dy).join(', ') +
        ' px)',
    );
    await p.evaluate(() => renderMessages());
    const c2 = await oConvs(p);
    ok(
      c1.unique && c1.sorted && c1.rowsOnce && c1.convs.join() === c2.convs.join() && c1.rows === c2.rows,
      'F15 O3: threaded, conversations show once each, in order, every message once, and a full redraw shows the same ' +
        JSON.stringify([c1.unique, c1.sorted, c1.rowsOnce, c1.convs.length, c2.convs.length]),
    );
    ok(p.errors.length === 0, 'F15 O3: no page errors ' + JSON.stringify(p.errors));
  });

  /* O4: a jump to a message that isn't loaded loads its day; next to the span it joins it; a filter searches everything */
  await ocase('O4', async () => {
    const n = 6400;
    const { p, msgs } = await oopen(n, lastTwoDays(n));
    const wa = msgs.findIndex(m => m.d === msgs[n - 920].d);
    const t = msgs[n - 10 * 460].i;
    const td = oDay(msgs, msgs[n - 10 * 460].d);
    await p.evaluate(t => goMsg(t), t);
    await p.waitForTimeout(600);
    const j = await p.evaluate(
      ([t, wa]) => {
        const x = document.getElementById('m' + t);
        const r = x && x.getBoundingClientRect();
        return {
          shown: !!x && r.top >= 0 && r.bottom <= innerHeight,
          banner: !document.getElementById('msg-older').hidden,
          win: !!document.getElementById('m' + wa),
        };
      },
      [t, msgs[wa].i],
    );
    const rows = await oRows(p);
    ok(
      j.shown && j.banner && !j.win && rows === td.n,
      'F15 O4: a jump to #' +
        t +
        ' (10 days back) loads its day only (' +
        rows +
        ' rows, the day has ' +
        td.n +
        ') and shows it ' +
        JSON.stringify(j),
    );
    await p.fill('#msg-q', '#5');
    await p.waitForTimeout(400);
    const f = await p.evaluate(() => [
      !!document.getElementById('m5'),
      document.querySelectorAll('#msgs .msg[id]').length,
    ]);
    await p.fill('#msg-q', '');
    await p.waitForTimeout(400);
    ok(
      f[0] && f[1] < 100 && (await oRows(p)) >= td.n && (await p.$('#m' + t)),
      'F15 O4: the filter searches every stored message (#5 found, ' +
        f[1] +
        ' rows), and clearing it brings the loaded days back',
    );
    await p.click('#msg-older button.link');
    await p.waitForTimeout(300);
    const back = await oRows(p);
    await p.click('#msg-all');
    await p.waitForTimeout(500);
    const r0 = await oRows(p);
    const a0 = n - r0;
    const prev = oDay(msgs, msgs[a0 - 1].d);
    const t2 = msgs[prev.b - 5].i; /* late in that day, so the reader isn't near its top */
    await p.evaluate(t => goMsg(t), t2);
    await p.waitForTimeout(600);
    ok(
      back === n - wa &&
        (await oRows(p)) === r0 + prev.n &&
        (await p.evaluate(i => !!document.getElementById('m' + i), msgs[wa].i)),
      'F15 O4: Back to my window shows the window (' +
        back +
        '); a jump into the day just before the loaded days adds that day to them (' +
        r0 +
        ' + ' +
        prev.n +
        ')',
    );
    ok(p.errors.length === 0, 'F15 O4: no page errors ' + JSON.stringify(p.errors));
  });

  /* O5: turning Show older on and off keeps the message on screen; off is the window only (the timeline) */
  await ocase('O5', async () => {
    const n = 6400;
    const { p, msgs } = await oopen(n, lastTwoDays(n));
    const wa = msgs.findIndex(m => m.d === msgs[n - 920].d);
    await p.click('#lay-flat');
    /* the toolbar just under the tabs, the window's first messages below it */
    await p.evaluate(() => {
      const t = document.querySelector('#v-messages .toolbar');
      scrollTo(
        0,
        scrollY + t.getBoundingClientRect().top - document.querySelector('nav.tabs').getBoundingClientRect().bottom,
      );
    });
    const s0 = await oSpot(p);
    await p.click('#msg-all');
    await p.waitForTimeout(500);
    const y1 = await oY(p, s0.key);
    const on = await oRows(p);
    await p.evaluate(i => document.getElementById('m' + i).scrollIntoView({ block: 'center' }), msgs[wa + 200].i);
    const s2 = await oSpot(p);
    await p.click('#msg-all');
    await p.waitForTimeout(400);
    const off = await p.evaluate(() => ({
      edges: document.querySelectorAll('#msgs .edge').length,
      older: document.getElementById('v-messages').classList.contains('older'),
    }));
    const y3 = await oY(p, s2.key);
    ok(
      s0.key === '#m' + msgs[wa].i && Math.abs(y1 - s0.y) <= 3 && on > n - wa,
      'F15 O5: turning Show older on keeps ' +
        s0.key +
        " (the window's first) where it was (" +
        s0.y +
        ' → ' +
        y1 +
        ')',
    );
    ok(
      (await oRows(p)) === n - wa && !off.edges && !off.older && y3 != null && Math.abs(y3 - s2.y) <= 3,
      'F15 O5: turning it off shows the window only, with no edges, and keeps ' +
        s2.key +
        ' in place (' +
        s2.y +
        ' → ' +
        y3 +
        ')',
    );
    ok(p.errors.length === 0, 'F15 O5: no page errors ' + JSON.stringify(p.errors));
  });

  /* O6: scrolling up to the first stored message ends with a calm "Start of stored history" line, and loads no more */
  await ocase('O6', async () => {
    const n = 1500;
    const { p } = await oopen(n, () => ({ markerMode: 'caught', caughtUpI: n - 50 }));
    await p.click('#msg-all');
    await p.waitForTimeout(500);
    for (let k = 0; k < 6 && !(await p.$('#msgs > .edge.top:not(.more)')); k++) await oUp(p);
    const top = await p.evaluate(() => {
      const e = document.querySelector('#msgs > .edge.top');
      return e && { text: e.textContent, first: e === document.getElementById('msgs').firstElementChild };
    });
    const r = await oUp(p);
    ok(
      top && top.first && /^Start of stored history · Sep 1$/.test(top.text) && r.r0 === n && r.r1 === n,
      'F15 O6: at the first stored message the top says "' + (top && top.text) + '" and nothing more loads',
    );
    ok(
      /Loaded from Sep 1, the start of stored history\./.test(await p.textContent('#msg-note')),
      'F15 O6: the note says the start of stored history is loaded',
    );
  });

  /* O7: a date range with an end: the next day after it loads at the bottom */
  await ocase('O7', async () => {
    const n = 1500;
    const { p, msgs } = await oopen(n, msgs => ({
      markerMode: 'time',
      markerFrom: msgs[400].d + 'T00:00',
      markerTo: msgs[400].d + 'T23:59',
    }));
    const d1 = oDay(msgs, msgs[400].d),
      d2 = oDay(msgs, msgs[d1.b + 1].d);
    await p.click('#msg-all');
    await p.waitForTimeout(500);
    const r0 = await oRows(p);
    const bot = !!(await p.$('#msgs > .edge.bot.more'));
    await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await until(p, r0 => document.querySelectorAll('#msgs .msg[id]').length !== r0, r0, 3000);
    await p.waitForTimeout(300);
    const r1 = await oRows(p);
    ok(
      r0 === d1.b + 1 && bot && r1 === r0 + d2.n,
      'F15 O7: a one-day range shows it and the day before (' +
        r0 +
        '); scrolling to the bottom loads the next day (' +
        (r1 - r0) +
        ' of ' +
        d2.n +
        ')',
    );
  });

  /* O8: at phone width: no sideways scroll, and the toolbar stays under the tabs so Show older can be turned off */
  await ocase('O8', async () => {
    const n = 1500;
    const { p } = await oopen(n, () => ({ markerMode: 'caught', caughtUpI: n - 50 }), {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await p.tap('#msg-all');
    await p.waitForTimeout(500);
    await p.evaluate(() => scrollTo(0, scrollY + 3000));
    await p.waitForTimeout(200);
    const r = await p.evaluate(() => ({
      sw: document.documentElement.scrollWidth <= innerWidth,
      gap: Math.round(
        document.querySelector('#v-messages .toolbar').getBoundingClientRect().top -
          document.querySelector('nav.tabs').getBoundingClientRect().bottom,
      ),
    }));
    await p.tap('#msg-all');
    await p.waitForTimeout(300);
    ok(
      r.sw && Math.abs(r.gap) <= 2 && !(await p.$('#msgs .edge')) && (await oRows(p)) === 49,
      'F15 O8: at phone width nothing scrolls sideways, the toolbar sits under the tabs (' +
        r.gap +
        ' px), and tapping Show older there turns it off',
    );
    ok(p.errors.length === 0, 'F15 O8: no page errors ' + JSON.stringify(p.errors));
  });

  /* O9: dark mode: the start line and the sticky toolbar use the dark colors */
  await ocase('O9', async () => {
    const n = 1500;
    const { p, msgs } = await oopen(n, msgs => ({ markerMode: 'time', markerFrom: msgs[400].d + 'T00:00' }), {
      colorScheme: 'dark',
    });
    await p.click('#msg-all');
    await p.waitForTimeout(500);
    const c = await p.evaluate(() => {
      const e = document.querySelector('#msgs > .edge.top:not(.more)');
      return {
        line: e && getComputedStyle(e).color,
        bar: getComputedStyle(document.querySelector('#v-messages .toolbar')).backgroundColor,
        bg: getComputedStyle(document.body).backgroundColor,
      };
    });
    ok(
      c.line === 'rgb(163, 166, 152)' && c.bar === 'rgb(25, 26, 23)',
      'F15 O9: in dark mode the start line is muted and the toolbar dark ' + JSON.stringify(c),
    );
  });

  /* O10: a run of bubbles across midnight, where one loaded day meets the next, is one block whether the day was added by
     scrolling or drawn in a full redraw: Ana at 11:58 and 11:59 PM, then 12:00 and 12:01 AM (added above); Cy the same
     across the next midnight (added below, a date range with an end). In the timeline and in "Not grouped yet". */
  const days = ['2026-10-05', '2026-10-06', '2026-10-07'],
    dow = ['Mon', 'Tue', 'Wed'];
  const mid = [];
  const say = (k, h, mi, f) =>
    mid.push(
      mk(mid.length, {
        t: dow[k] + ' ' + (h % 12 || 12) + ':' + String(mi).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM'),
        d: days[k],
        f,
        b: 'bubble ' + mid.length,
      }),
    );
  for (let k = 0; k < 3; k++) {
    if (k === 1) [0, 1].forEach(mi => say(1, 0, mi, 'Ana'));
    if (k === 2) [0, 1].forEach(mi => say(2, 0, mi, 'Cy'));
    for (let j = 0; j < 10; j++) say(k, 8 + j, 0, j % 2 ? 'Dee' : 'Ben');
    if (k === 0) [58, 59].forEach(mi => say(0, 23, mi, 'Ana'));
    if (k === 1) [58, 59].forEach(mi => say(1, 23, mi, 'Cy'));
  }
  /* the rows of the timeline and of "Not grouped yet": each block or single row as its message numbers */
  const shape = p =>
    p.evaluate(() =>
      [...document.querySelectorAll('#msgs > .grp, #msgs > .msg[id], #msgs .msgs > .grp, #msgs .msgs > .msg[id]')]
        .map(e => (e.id ? e.id : [...e.querySelectorAll(':scope > .msg[id]')].map(x => x.id).join('+')))
        .join(' '),
    );
  const midOpen = async (meta, threaded) => {
    const p = await open(SEED(), PAGE);
    OP.push(p);
    await paste(p, JSON.stringify(cap(mid)));
    await p.evaluate(
      ([meta, th]) => {
        __rt.write('meta/chat', Object.assign({}, __rt.get('meta/chat'), meta));
        /* one conversation on the middle day, so the rest go to "Not grouped yet" */
        if (th) __rt.write('threading/current', { convs: [th], links: {}, to: -1, note: '' });
        location.hash = '#messages';
      },
      [meta, threaded ? { id: 'plans', title: 'Plans', members: [16, 17] } : null],
    );
    await until(p, () => S.meta && S.meta.markerMode && S.msgs.length === 38);
    await p.waitForTimeout(200);
    if (!threaded) await p.click('#lay-flat');
    else await p.click('#lay-thread');
    await p.click('#msg-all');
    if (threaded) await p.evaluate(() => (document.querySelector('details.conv[data-conv="_rest"]').open = true));
    /* scroll to whichever end still has a day to load */
    for (let k = 0; k < 6; k++) {
      const more = await p.evaluate(() => {
        const t = document.querySelector('#msgs > .edge.top.more'),
          b = document.querySelector('#msgs > .edge.bot.more');
        if (t) scrollTo(0, 0);
        else if (b) scrollTo(0, document.documentElement.scrollHeight);
        return !!(t || b);
      });
      if (!more) break;
      await p.waitForTimeout(300);
    }
    const inc = await shape(p);
    await p.evaluate(() => renderMessages());
    return { p, inc, full: await shape(p) };
  };
  await ocase('O10', async () => {
    const res = [];
    for (const threaded of [false, true]) {
      const up = await midOpen({ markerMode: 'caught', caughtUpI: 25 }, threaded);
      const down = await midOpen(
        { markerMode: 'time', markerFrom: days[1] + 'T00:00', markerTo: days[1] + 'T23:59' },
        threaded,
      );
      res.push(up, down);
      ok(
        up.inc === up.full && / m10\+m11\+m12\+m13 /.test(' ' + up.full + ' '),
        'F15 O10: ' +
          (threaded ? '"Not grouped yet"' : 'the timeline') +
          ': a day added above joins the run across midnight as a full redraw does (#10–#13) [' +
          up.inc +
          '] vs [' +
          up.full +
          ']',
      );
      ok(
        down.inc === down.full && / m24\+m25\+m26\+m27 /.test(' ' + down.full + ' '),
        'F15 O10: ' +
          (threaded ? '"Not grouped yet"' : 'the timeline') +
          ': a day added below joins the run across midnight as a full redraw does (#24–#27) [' +
          down.inc +
          '] vs [' +
          down.full +
          ']',
      );
    }
    ok(
      res.every(r => !r.p.errors.length),
      'F15 O10: no page errors ' + JSON.stringify(res.map(r => r.p.errors)),
    );
  });

  /* O11: the toolbar stays right under the tabs when their height changes after it first stuck (a late font, a turn of
     the phone) */
  await ocase('O11', async () => {
    const n = 1500;
    const { p } = await oopen(n, () => ({ markerMode: 'caught', caughtUpI: n - 50 }));
    await p.click('#msg-all');
    await p.waitForTimeout(400);
    const gap = () =>
      p.evaluate(() => {
        scrollTo(0, 2000);
        return Math.round(
          document.querySelector('#v-messages .toolbar').getBoundingClientRect().top -
            document.querySelector('nav.tabs').getBoundingClientRect().bottom,
        );
      });
    const g0 = await gap();
    await p.evaluate(() => document.querySelectorAll('nav.tabs a').forEach(a => (a.style.fontSize = '1.8rem')));
    await p.waitForTimeout(300);
    const g1 = await gap();
    await p.evaluate(() => document.querySelectorAll('nav.tabs a').forEach(a => (a.style.fontSize = '')));
    await p.setViewportSize({ width: 700, height: 800 });
    await p.waitForTimeout(300);
    const g2 = await gap();
    ok(
      [g0, g1, g2].every(g => Math.abs(g) <= 2),
      'F15 O11: the sticky toolbar stays under the tabs as they grow and shrink back (gaps ' +
        [g0, g1, g2].join(', ') +
        ' px)',
    );
  });
}

const SECTIONS = {
  importer,
  robustness,
  pipeline,
  variants,
  ranges,
  layouts,
  names,
  messagesView,
  speed,
  photos,
  photos2,
  photoKeys,
  bigPaste,
  standIn,
  history,
  history2,
  digests,
  notices,
  schedule,
  claims,
  deeper,
  deeperBudget,
  longRanges,
  longRanges2,
  olderByDay,
};
/* The sections run in parallel, each in its own node process with its own browser, PAGE_JOBS at a time (default: the
   CPU count); a section's lines are printed together under a "--- name (seconds)" header when it ends. PAGE_JOBS=1
   runs them one by one in this process, as before. To add a section: write async function mySection() and add it to
   SECTIONS. It runs alongside the others, so it may share nothing with them but files it only reads. A long section
   can be split in two at a case boundary (photos and photos2, history and history2): close the function and open the
   next. */
const PAGE_JOBS = Math.max(1, +process.env.PAGE_JOBS || os.cpus().length);
/* the slowest sections first, so they don't start last */
const SLOW_FIRST = [
  'photos',
  'layouts',
  'photos2',
  'notices',
  'history2',
  'history',
  'olderByDay',
  'messagesView',
  'pipeline',
];
async function inProcess(names) {
  browser = await chromium.launch();
  try {
    for (const k of names) await SECTIONS[k]();
  } catch (e) {
    ok(false, 'crashed: ' + ((e && e.stack) || e));
  }
  await browser.close();
}
async function inParallel(names) {
  const t0 = Date.now();
  const rank = k => (SLOW_FIRST.includes(k) ? SLOW_FIRST.indexOf(k) : SLOW_FIRST.length);
  const queue = names.slice().sort((a, b) => rank(a) - rank(b));
  const one = k =>
    new Promise(done => {
      const start = Date.now();
      const env = Object.assign({}, process.env, { PAGE_SECTION: k });
      const child = spawn(process.execPath, [__filename], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', d => (out += d));
      child.stderr.on('data', d => (out += d));
      child.on('exit', (code, sig) => {
        const secs = ((Date.now() - start) / 1000).toFixed(1);
        process.stdout.write('--- ' + k + ' (' + secs + ' s)\n' + out.replace(/([^\n])$/, '$1\n'));
        if (code !== 0 && !/^FAIL /m.test(out)) console.log('FAIL ' + k + ' exited with ' + (sig || 'code ' + code));
        if (code !== 0) process.exitCode = 1;
        done();
      });
    });
  const worker = async () => {
    while (queue.length) await one(queue.shift());
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_JOBS, queue.length) }, worker));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('page: ' + names.length + ' sections in ' + secs + ' s, ' + PAGE_JOBS + ' at a time');
}
/* ONLY=messagesView,names runs just those sections (e.g. to check new tests against an older page); a name also
   picks the sections it begins (ONLY=photos runs photos and photos2). PAGE_SECTION is one section, for the runner. */
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const WANT = process.env.PAGE_SECTION
  ? [process.env.PAGE_SECTION]
  : Object.keys(SECTIONS).filter(k => !ONLY.length || ONLY.some(o => k.startsWith(o)));
(process.env.PAGE_SECTION || PAGE_JOBS === 1 || WANT.length === 1 ? inProcess : inParallel)(WANT);
