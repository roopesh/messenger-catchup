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
  /* returns the unsubscribe function, as the real onSnapshot does (F1 tests count the live listeners) */
  const sub = (k, cb) => {
    if (!subs.has(k)) subs.set(k, []);
    subs.get(k).push(cb);
    return () => {
      const l = subs.get(k) || [];
      if (l.indexOf(cb) >= 0) l.splice(l.indexOf(cb), 1);
    };
  };
  const docSnap = p => {
    const v = store.get(p);
    return { exists: v !== undefined, id: p.split('/').pop(), data: () => clone(v) };
  };
  /* opts.getPage n: a get() of a photos collection (photos, or an added chat's KEY_photos) holds at most n documents, in id order,
     as a runtime that lists in pages would; opts.snapPage n: so does its listener's snapshot (other collections are
     listed whole) */
  const collSnap = (c, cap) => ({
    docs: [...store.keys()]
      .filter(k => k.split('/')[0] === c && k.split('/').length === 2)
      .sort()
      .slice(0, (/(^|_)photos$/.test(c) && cap) || Infinity)
      .map(k => ({ id: k.split('/')[1], data: () => clone(store.get(k)) })),
  });
  const colGets = []; /* each collection get(), by collection */
  const notify = p =>
    setTimeout(() => {
      (subs.get('d:' + p) || []).forEach(cb => cb(docSnap(p)));
      const c = p.split('/')[0];
      (subs.get('c:' + c) || []).forEach(cb => cb(collSnap(c, opts.snapPage)));
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
  /* opts.snapFail: ['c:<collection>' | 'd:<path>']: that listener calls its error callback instead of ever answering */
  const snapFail = (k, err) => {
    if (!(opts.snapFail || []).includes(k)) return false;
    setTimeout(() => err && err(Object.assign(new Error('injected listener failure'), { code: 'unavailable' })), 0);
    return true;
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
      /* idempotent, as the real one is (db.d.ts DocumentRef.delete) */
      delete: async () => {
        failIf(p, 'delete');
        store.delete(p);
        bump(p);
        writes.push({ p, op: 'delete' });
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
      onSnapshot: (cb, err) => {
        if (snapFail('d:' + p, err)) return () => {};
        const un = sub('d:' + p, cb);
        setTimeout(() => cb(docSnap(p)), 0);
        return un;
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
      colGets.push(c);
      let docs = collSnap(c, opts.getPage).docs;
      if (ord)
        docs = docs.slice().sort((a, b) => {
          const x = a.data()[ord.f],
            y = b.data()[ord.f];
          return (x < y ? -1 : x > y ? 1 : 0) * (ord.d === 'desc' ? -1 : 1);
        });
      if (lim) docs = docs.slice(0, lim);
      return { docs, size: docs.length, empty: !docs.length };
    },
    onSnapshot: (cb, err) => {
      if (snapFail('c:' + c, err)) return () => {};
      const un = sub('c:' + c, cb);
      setTimeout(() => cb(collSnap(c, opts.snapPage)), 0);
      return un;
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
     whose number of stored uploads equals it, with "unavailable".
     Day packs (R13): every upload keeps its bytes, and fetch("/_blob/<id>") serves them (with the upload's type) as
     claude.ai serves a page's assets on its own origin, 404 once deleted; each such fetch is logged in __rt.fetches.
     opts.blobs {id: {type, b64}} are files stored before the test. window.__up.mangle (a number) changes one character
     of a photo inside the next that many full packs uploaded, as a store that altered bytes would; __up.delFail
     (a number) makes that many assets.delete calls reject, with __up.delCode (default store_unavailable, which the
     page tries again later; not_uploader is a refusal that won't go away); __up.blobFail [ids] answers those fetches
     with 500. opts.listGhosts [ids]: files list() still shows (and its usage counts) though they're gone, as when
     Cleanup or another copy deleted them just before; every assets.delete call is logged in __rt.deletes. */
  const blobs = new Map(),
    fetches = [],
    deletes = [];
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
      let keep = blob;
      if (U.mangle > 0 && o.type === 'application/json') {
        const j = JSON.parse(await blob.text());
        if (j.kind === 'full') {
          U.mangle--;
          const b = j.items[0].b64;
          j.items[0].b64 = (b[0] === 'A' ? 'B' : 'A') + b.slice(1);
          keep = new Blob([JSON.stringify(j)], { type: o.type });
        }
      }
      blobs.set(id, keep);
      return { id, url: '/_blob/' + id, sizeBytes: blob.size, contentType: o.type };
    },
    list: async () => {
      if (opts.listReject) throw Object.assign(new Error('list unavailable'), { code: 'store_unavailable' });
      const live = uploads.filter(u => !u.deleted);
      const ghosts = (opts.listGhosts || []).map(id => ({
        id,
        url: '/_blob/' + id,
        contentType: 'image/png',
        sizeBytes: 1,
      }));
      const u = usage();
      return {
        assets: live
          .map(u => ({ id: u.id, url: '/_blob/' + u.id, contentType: u.type, sizeBytes: u.size }))
          .concat(ghosts),
        usage: Object.assign(u, { files: u.files + ghosts.length }),
      };
    },
    delete: async id => {
      deletes.push(id);
      const U = window.__up || {};
      if (U.delFail > 0) {
        U.delFail--;
        throw Object.assign(new Error('scripted delete failure'), { code: U.delCode || 'store_unavailable' });
      }
      const u = uploads.find(x => x.id === id && !x.deleted);
      if (u) u.deleted = true;
      return { deleted: !!u };
    },
  };
  Object.entries(opts.blobs || {}).forEach(([id, b]) => {
    const bin = atob(b.b64);
    const u8 = Uint8Array.from(bin, c => c.charCodeAt(0));
    uploads.push({ id, size: u8.length, type: b.type, hash: b.sha || null, call: -1 });
    blobs.set(id, new Blob([u8], { type: b.type }));
  });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (u, o) => {
    const url = new URL(typeof u === 'string' ? u : u.url, location.href);
    const m = /^\/_blob\/([^/#?]+)$/.exec(url.pathname);
    if (!m) return realFetch(u, o);
    const id = m[1];
    fetches.push(id);
    await pause(0);
    if (((window.__up || {}).blobFail || []).includes(id)) return new Response('error', { status: 500 });
    const up = uploads.find(x => x.id === id && !x.deleted);
    if (!up || !blobs.has(id)) return new Response('not found', { status: 404 });
    return new Response(blobs.get(id), {
      status: 200,
      headers: { 'content-type': up.type || 'application/octet-stream' },
    });
  };
  if (opts.tune) window.__mcImportTune = opts.tune; /* the page's photo timings, shortened (R2 tests) */
  if (opts.packTune) window.__mcPackTune = opts.packTune; /* the day packs' timings and sizes (R13 tests) */
  if (opts.up) window.__up = opts.up; /* uploads scripted from the start (R13 tests) */
  if (opts.undoMs) window.__mcUndoMs = opts.undoMs; /* the saved questions' undo delay, shortened (F26 tests) */
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
  /* F32: opts.tools makes limits() report page tools; a call that passes tools then plays window.__toolPlan, rounds of
     {say, calls: [{name, input}]}, the way the real runtime does: each round's text joins the answer after a blank
     line (onText sees it grow), its calls run concurrently, and what each returned or threw is logged in
     __rt.toolLog. opts.toolsUnavailable rejects such a call tools_unavailable, as a view without tools does. */
  const toolLog = [];
  async function playTools(o) {
    if (opts.toolsUnavailable) throw { code: 'tools_unavailable', message: 'this view cannot run page tools' };
    let text = '';
    for (const r of window.__toolPlan || []) {
      if (r.say) {
        text += (text ? '\n\n' : '') + r.say;
        if (o.onText) o.onText({ text, delta: r.say });
        await new Promise(res => setTimeout(res, 0));
      }
      if (r.calls)
        await Promise.all(
          r.calls.map(async c => {
            const t = o.tools.find(x => x.name === c.name);
            try {
              const out = await t.execute(c.input, { signal: new AbortController().signal });
              toolLog.push({ name: c.name, input: c.input, out: typeof out === 'string' ? out : JSON.stringify(out) });
            } catch (e) {
              toolLog.push({ name: c.name, input: c.input, err: String((e && e.message) || e) });
            }
          }),
        );
    }
    return text;
  }
  /* opts.sampleError: every request rejects with it ({code, message}, or a code), as a declined consent does */
  const sampleErr = () => {
    const e = window.__sampleError !== undefined ? window.__sampleError : opts.sampleError;
    if (e) throw typeof e === 'string' ? { code: e, message: 'refused: ' + e } : e;
  };
  async function sample(msgs, o) {
    samples.push(msgs);
    capCheck(msgs);
    sampleErr();
    if (o && o.tools) {
      if (o.cache !== false && o.cache !== undefined)
        throw { code: 'invalid_request', message: 'cache passed with tools' };
      const text = await playTools(o);
      return { text, truncated: false };
    }
    const text = opts.answer || 'Ben offered one [#1]. Ana asked [#0, #2].';
    if (o && o.onText) o.onText({ text });
    return { text };
  }
  if (!opts.noLimits)
    sample.limits = async () => {
      if (opts.limitsHang) return new Promise(() => {});
      if (opts.limitsReject) throw Object.assign(new Error('limits unavailable'), { code: 'unavailable' });
      return Object.assign(
        { maxPromptBytes: opts.limitsBogus ? 'x' : PROMPT_MAX },
        opts.tools ? { tools: { maxCount: 16 } } : {},
      );
    };
  sample.json = async (prompt, o) => {
    samples.push(prompt);
    capCheck(prompt);
    sampleErr();
    /* with tools, the final round's text is the JSON (narration in earlier rounds is ignored, as the runtime does) */
    if (o && o.tools) {
      const text = await playTools(o);
      const plan = window.__toolPlan || [];
      return JSON.parse(plan[plan.length - 1].say);
    }
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
    toolLog,
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
    fetches,
    deletes,
    colGets,
    /* a stored file's bytes as base64 (R13 tests read packs and originals) */
    blob: async id => {
      const b = blobs.get(id);
      if (!b) return null;
      const u8 = new Uint8Array(await b.arrayBuffer());
      let s = '';
      for (let k = 0; k < u8.length; k += 32768) s += String.fromCharCode.apply(null, u8.subarray(k, k + 32768));
      return btoa(s);
    },
    blobText: async id => (blobs.has(id) ? blobs.get(id).text() : null),
    /* the live listeners, by 'c:<collection>' or 'd:<path>' (F1) */
    listeners: () => Object.fromEntries([...subs].filter(([, l]) => l.length).map(([k, l]) => [k, l.length])),
  };
  /* user.can("data.write") (user.d.ts): opts.canWrite true/false, or null (not told) by default (F1) */
  const user = { can: async n => (n === 'data.write' ? (opts.canWrite ?? null) : null) };
  /* Like claude.ai's artifact viewer, a same-page #hash link doesn't navigate the page (the viewer takes the hash onto its
     own address), so no hashchange reaches it: every test runs with this unless opts.hashLinks (v1.26.1). */
  if (!opts.hashLinks)
    addEventListener(
      'click',
      e => {
        const a = e.target && e.target.closest && e.target.closest('a[href^="#"]');
        if (a) e.preventDefault();
      },
      true,
    );
  window.claude = {
    use: async n =>
      ({ db: opts.noDb ? null : { doc, collection }, assets: opts.noAssets ? null : assets, sample, user })[n] || null,
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
  await ctx.addInitScript(flashRecorder);
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', e => p.errors.push(e.message));
  await p.goto(URL);
  await p.waitForFunction(() => window.__rt && document.getElementById('window').textContent !== 'Loading the chat…');
  await p.waitForTimeout(200);
  return p;
}
/* The page highlights a message it jumps to for 2.2 s (class "flash"). A check that tried to catch the class raced that
   timer on a busy runner (B40, Nov 22), so every element that gains it is marked data-flashed for good, and checks
   look for the mark. flashReset clears the marks just before the click under test, so an earlier jump can't pass it. */
function flashRecorder() {
  const mark = n => n.nodeType === 1 && n.classList.contains('flash') && n.setAttribute('data-flashed', '');
  new MutationObserver(rs =>
    rs.forEach(r => {
      if (r.type === 'attributes') mark(r.target);
      else
        r.addedNodes.forEach(n => {
          mark(n);
          if (n.querySelectorAll) n.querySelectorAll('.flash').forEach(mark);
        });
    }),
  ).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
}
/* Pause the page's clock (installed with clockAt) so no page timer fires until p.clock.runFor or resume. pauseAt needs
   a time ahead of the running clock: 1 s ahead (timers due in that second fire on the way), read again and tried again
   if the clock got there first. */
async function clockPause(p) {
  for (let k = 0; ; k++)
    try {
      await p.clock.pauseAt((await p.evaluate(() => Date.now())) + 1000);
      return;
    } catch (e) {
      if (k >= 4 || !/to the past/.test(String(e))) throw e;
    }
}
const flashReset = p =>
  p.evaluate(() => document.querySelectorAll('[data-flashed]').forEach(n => n.removeAttribute('data-flashed')));
/* Opens or closes a Messages conversation as a reader's click on its summary does: the page remembers it (S.convOpen)
   through a redraw for new data. Setting open alone isn't remembered, and on a busy runner a redraw for data that
   arrived late undid it before the next click (B40, the suite run three at a time, Nov 22). */
const convSet = (p, conv, open) =>
  p.evaluate(
    ([c, o]) => {
      S.convOpen.set(c, o);
      const d = document.querySelector('#msgs details.conv[data-conv="' + c + '"]');
      if (d) d.open = o;
      return !!d;
    },
    [conv, open],
  );
const convIds = p => p.evaluate(() => [...document.querySelectorAll('#msgs details.conv')].map(d => d.dataset.conv));
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
    __rt.write('outbox/t1', {
      i: 203,
      mid: 'mid.203',
      to: 'Cy',
      snip: 'message 203',
      text: 'just went out',
      state: 'sent',
      queuedAt: old,
      sentAt: new Date(Date.now() - 36e5).toISOString(),
    });
  });
  ok(
    await until(p, () => {
      const t = document.getElementById('v-summary').textContent;
      return /not confirmed/.test(t) && /Sent\? Not found/.test(t) && /sending…/.test(t);
    }),
    'outbox: 3-day-old unconfirmed and sending replies are still shown, with the note',
  );
  ok(
    await p.evaluate(() => {
      const t = document.getElementById('v-summary').textContent;
      const c = document.querySelector('#v-summary .item.ob');
      return !/just went out/.test(t) && !/Sent in the last day/.test(t) && getComputedStyle(c).paddingTop === '8px';
    }),
    'B58: a reply sent an hour ago leaves Your replies, and the reply cards are compact',
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
  /* on Playwright's clock (running), so the date entry below can pass its 1.5 s save pause without racing it */
  const p = await open(SEED(), PAGE, { clockAt: Date.now() });
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
  // by the owner's rule (B59: "Fullname (Nickname)" wherever the full name is known)
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
    JSON.stringify(who) === JSON.stringify(['Ana Alvarez', 'Ben Brooks', 'You', 'Ben Ortiz', 'Cy Chen (Captain Cy)']),
    'names (B59): full names, "Cy Chen (Captain Cy)" for a nickname (' + who.join(' | ') + ')',
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
  await flashReset(p);
  await p.click('#v-summary article.cv[data-conv="packs1"] button.bul');
  ok(
    await until(p, () => {
      const d = document.querySelector('article.cv[data-conv="packs1"] details.thr');
      return d && d.open && d.querySelector('.msg[data-flashed]');
    }),
    'summary: a bullet opens its thread and highlights its messages',
  );
  // B62: a Needs you snippet opens its conversation's thread in place, under the item, not in Messages; a thread
  // opens in one place at a time (the card's closes, and back); the card head has no reply row of its own
  const hash62 = await p.evaluate(() => location.hash);
  await p.evaluate(() => document.querySelectorAll('#v-summary article.cv details.thr').forEach(d => (d.open = true)));
  await flashReset(p);
  await p.click('#v-summary .item.mention .snip');
  const n62 = await until(p, () => {
    const d = document.querySelector('#v-summary .item.mention details.thr');
    const f = d && d.open && d.querySelector('.msg[data-flashed]');
    if (!f) return null;
    const i = +f.dataset.i;
    const card = [...document.querySelectorAll('#v-summary article.cv')].find(a =>
      a.querySelector('details.thr .msg[data-i="' + i + '"]'),
    );
    const cardThr = card && card.querySelector('details.thr');
    return { i, conv: card ? card.dataset.conv : null, cardOpen: cardThr ? cardThr.open : null, hash: location.hash };
  });
  ok(
    n62 && n62.hash === hash62 && n62.conv && n62.cardOpen === false,
    'B62: a Needs you snippet opens its thread under the item (#' +
      (n62 && n62.i) +
      ' highlighted), stays on Summary, and closes that thread in its card (' +
      JSON.stringify(n62) +
      ')',
  );
  if (n62 && n62.conv) {
    /* a redraw (new data, a tab click) rebuilds Summary off the page: the hosts it registers still close each other */
    await p.evaluate(() => renderSummary());
    await p.click('#v-summary article.cv[data-conv="' + n62.conv + '"] details.thr > summary');
    ok(
      await until(
        p,
        conv => {
          const c = document.querySelector('#v-summary article.cv[data-conv="' + conv + '"] details.thr');
          const n = document.querySelector('#v-summary .item.mention details.thr');
          return c.open && !n.open;
        },
        n62.conv,
      ),
      "B62: after a redraw, opening the card's thread closes it under Needs you",
    );
  }
  // an item whose messages are in two conversations names each thread
  await p.evaluate(() => {
    const sm = S.summary;
    const a = sm.convs.map(c => convMembers(c.id).find(i => inWin(i)));
    sm.mentions = sm.mentions.concat([{ note: 'two places', refs: a.slice(0, 2).map(i => [i]) }]);
    renderSummary();
  });
  const two62 = await p.$$eval('#v-summary .item.mention', its =>
    its
      .filter(d => /two places/.test(d.textContent))
      .flatMap(d => [...d.querySelectorAll('details.thr > summary')].map(x => x.textContent)),
  );
  const t62 = await p.evaluate(() => S.summary.convs.slice(0, 2).map(c => convTitle(c.id)));
  ok(
    two62.length === 2 && two62.every((x, k) => x.startsWith('Show the thread: ' + t62[k] + ' (')),
    'B62: an item citing two conversations names each thread (' + two62.join(' | ') + ')',
  );
  await p.evaluate(() => {
    S.summary.mentions = S.summary.mentions.filter(x => x.note !== 'two places');
    renderSummary();
  });
  ok(
    (await p.$$eval('#v-summary article.cv .cv-head .cv-act', a => a.length)) === 0 &&
      !(await p.$eval('#v-summary', v => v.textContent.includes('to the latest message'))),
    'B62: no reply row in the card heads (each message in the thread has its own)',
  );
  await p.evaluate(() => document.querySelectorAll('#v-summary details.thr').forEach(d => (d.open = false)));
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
  await msgFilter(p, 'Message number 75 ');
  ok((await p.$$eval('#msgs .msg', r => r.length)) === 1, 'messages: filter by text finds exactly one');
  await msgFilter(p, '');
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
  /* the captured messages' day (sim.js dates them the day it ran), not today: a time window from 09:15 holds them all */
  const day = caps[caps.length - 1].msgs.at(-1).d;
  const want = day + 'T09:15';
  const [Y, M, D] = day.split('-');
  /* the keys go in with the clock paused: the save waits 1.5 s after the last key, a timer fixed waits raced */
  await clockPause(p);
  await p.keyboard.type(M + D + Y + '0915A', { delay: 60 });
  ok(
    await handle.evaluate(e => e.isConnected && document.activeElement === e),
    'date entry: the box was not rebuilt while typing',
  );
  ok((await nWrites(p, '^meta/chat$')) === before, 'date entry: nothing saved while typing');
  ok((await handle.inputValue()) === want, 'date entry: box holds ' + want + ' (' + (await handle.inputValue()) + ')');
  await p.clock.runFor(1600);
  await p.clock.resume();
  await until(p, () => __rt.writes.some(w => w.p === 'meta/chat' && 'markerFrom' in w.v), null, 5000);
  const ws = await p.evaluate(() => __rt.writes.filter(w => w.p === 'meta/chat' && 'markerFrom' in w.v));
  ok(
    ws.length === 1 && ws[0].v.markerFrom === want && ws[0].v.markerMode === 'time',
    'date entry: exactly one save after the pause, with the typed value',
  );
  await p.keyboard.press('Tab');
  await p.waitForTimeout(300);
  ok(/Catch-up window: /.test(await p.textContent('#window')), 'date entry: header shows the date window');
  /* the save above set mode "time" while the From box kept the focus (Tab stays inside it): the radios show it, and a
     click on one from there lands. Both used to fail: "own" still looked picked so clicking it changed nothing, and the
     blur rebuilt the box between mousedown and mouseup, taking the radio from under the pointer */
  ok(
    (await p.$eval(from, e => e === document.activeElement)) &&
      (await p.$eval('#marker input[value="time"]', r => r.checked)) &&
      !(await p.$eval('#marker input[value="own"]', r => r.checked)),
    'date entry: the radios show "Date range" while the From box has the focus',
  );
  await p.click('#marker input[value="own"]');
  await p.waitForTimeout(300);
  ok(
    (await get(p, 'meta/chat')).markerMode === 'own' && (await p.$eval('#marker input[value="own"]', r => r.checked)),
    'date entry: "Since your last message" clicked from the From box takes',
  );
  // a date typed and not yet saved (the 1.5 s pause) doesn't override a radio clicked straight after it
  await p.click('#marker input[value="caught"]');
  await p.waitForTimeout(300);
  await p.click(from);
  await p.keyboard.press('ArrowLeft');
  await p.keyboard.press('ArrowLeft');
  await p.keyboard.press('ArrowLeft');
  await p.keyboard.press('ArrowLeft');
  await p.keyboard.press('ArrowLeft');
  await p.keyboard.type(M + D + Y + '1030A', { delay: 20 });
  await p.click('#marker input[value="own"]');
  await p.waitForTimeout(1900);
  const mc = await get(p, 'meta/chat');
  ok(
    mc.markerMode === 'own' && mc.markerFrom === want,
    'date entry: a radio clicked before the pause wins, the unsaved date is dropped (' +
      mc.markerMode +
      ', ' +
      mc.markerFrom +
      ')',
  );
  // outbox
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
  // F35: "@" and letters in a reply suggest the chat's posters; a pick writes "@Full Name " and the row lists it in mentions
  await p.evaluate(() => {
    location.hash = '#messages';
  });
  const mi = ri;
  await p.waitForSelector('#m' + mi);
  await p.hover('#m' + mi);
  await p.click('#m' + mi + ' button.rh:text-is("Reply here")');
  await p.click('#m' + mi + ' .compose textarea');
  await p.keyboard.type('thanks @', { delay: 10 });
  const allSug = await until(p, i => document.querySelectorAll('#m' + i + ' .compose .sug [role="option"]').length, mi);
  await p.keyboard.type('Be', { delay: 10 });
  const sugBe = await p.$$eval('#m' + mi + ' .compose .sug [role="option"]', os =>
    os.map(o => [o.textContent, o.getAttribute('aria-selected')]),
  );
  await p.keyboard.press('Enter');
  await p.keyboard.type('see you', { delay: 10 });
  const tv = await p.$eval('#m' + mi + ' .compose textarea', t => t.value);
  await p.click('#m' + mi + ' .compose button.primary');
  const mo = await until(p, () => {
    const k = [...__rt.store.keys()].find(
      k => k.startsWith('outbox/') && __rt.get(k).text && /^thanks @/.test(__rt.get(k).text),
    );
    return k ? __rt.get(k) : null;
  });
  ok(
    allSug > 1 &&
      sugBe.length >= 1 &&
      sugBe.every(x => /Be/.test(x[0])) &&
      sugBe[0][1] === 'true' &&
      mo &&
      mo.text === tv &&
      Array.isArray(mo.mentions) &&
      mo.mentions.length === 1 &&
      tv === 'thanks @' + mo.mentions[0] + ' see you',
    'F35: "@" suggests posters, "@Be" narrows to Ben, Enter writes "@Full Name " and the row carries mentions (' +
      JSON.stringify([allSug, sugBe, tv, mo && mo.mentions]) +
      ')',
  );
  // F36: Attach photo adds a thumbnail; Queue stores the photo in the asset store and lists its id in photos
  const PNG1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await p.hover('#m' + mi);
  await p.click('#m' + mi + ' button.rh:text-is("Reply here")');
  await p.setInputFiles('#m' + mi + ' .compose input[type="file"]', [
    { name: 'a.png', mimeType: 'image/png', buffer: PNG1 },
    { name: 'b.png', mimeType: 'image/png', buffer: PNG1 },
  ]);
  const nThumbs = await p.$$eval('#m' + mi + ' .compose .rpic img', x => x.length);
  await p.click('#m' + mi + ' .compose .rpic button'); /* remove the first */
  await p.fill('#m' + mi + ' .compose textarea', 'the pack, as promised');
  await p.click('#m' + mi + ' .compose button.primary');
  const po = await until(p, () => {
    const k = [...__rt.store.keys()].find(k => k.startsWith('outbox/') && (__rt.get(k).photos || []).length);
    return k ? __rt.get(k) : null;
  });
  ok(
    nThumbs === 2 &&
      po &&
      po.text === 'the pack, as promised' &&
      po.photos.length === 1 &&
      /^[0-9a-f]{32}$/.test(po.photos[0]),
    'F36: two photos attached, one removed; Queue stores the other and the row lists its asset id (' +
      JSON.stringify([nThumbs, po]) +
      ')',
  );
  await p.hover('#m' + mi);
  await p.click('#m' + mi + ' button.rh:text-is("Reply here")');
  await p.click('#m' + mi + ' .compose button.primary');
  const empty = await p.$eval('#m' + mi + ' .compose .note:last-child', n => n.textContent).catch(() => '');
  await p.setInputFiles('#m' + mi + ' .compose input[type="file"]', [
    { name: 'c.png', mimeType: 'image/png', buffer: PNG1 },
  ]);
  await p.click('#m' + mi + ' .compose button.primary');
  const po2 = await until(p, () => {
    const k = [...__rt.store.keys()].find(
      k => k.startsWith('outbox/') && __rt.get(k).text === '' && (__rt.get(k).photos || []).length === 1,
    );
    return k ? __rt.get(k) : null;
  });
  ok(
    /Type a reply or add a photo first/.test(empty) && po2,
    'F36: Queue with nothing says so; a photo alone queues a reply with empty text (' +
      JSON.stringify([empty, !!po2]) +
      ')',
  );
  // F37: React opens a picker under the message; an emoji queues {kind:"react", emoji}; "Other emoji" takes one emoji
  const xi = ri;
  await p.hover('#m' + xi);
  await p.click('#m' + xi + ' button.rh:text-is("React")');
  await p.click('#m' + xi + ' .rxpick button.rx');
  const rx1 = await until(
    p,
    i => {
      const k = [...__rt.store.keys()].find(
        k => k.startsWith('outbox/') && __rt.get(k).kind === 'react' && __rt.get(k).i === i,
      );
      return k ? Object.assign({ id: k }, __rt.get(k)) : null;
    },
    xi,
  );
  ok(
    rx1 && rx1.emoji === '👍' && rx1.state === 'queued' && rx1.mid && rx1.to && rx1.queuedAt && !rx1.text,
    'F37: React › 👍 queues {kind:"react", emoji:"👍", i, mid, to, state:queued} (' + JSON.stringify(rx1) + ')',
  );
  ok(
    await until(
      p,
      i =>
        /👍 queued/.test(document.querySelector('#m' + i).textContent) &&
        !document.querySelector('#m' + i + ' .rxpick'),
      xi,
    ),
    'F37: the picker closes and the message shows "👍 queued"',
  );
  await p.hover('#m' + xi);
  await p.click('#m' + xi + ' button.rh:text-is("React")');
  await p.fill('#m' + xi + ' .rxpick input', 'ok');
  await p.press('#m' + xi + ' .rxpick input', 'Enter');
  const bad = await p.$eval('#m' + xi + ' .rxpick .note', n => n.textContent);
  await p.fill('#m' + xi + ' .rxpick input', '🔥');
  await p.press('#m' + xi + ' .rxpick input', 'Enter');
  const rx2 = await until(
    p,
    i =>
      [...__rt.store.keys()].some(
        k =>
          k.startsWith('outbox/') && __rt.get(k).kind === 'react' && __rt.get(k).emoji === '🔥' && __rt.get(k).i === i,
      ),
    xi,
  );
  ok(/one emoji/.test(bad) && rx2, 'F37: "Other emoji" refuses text and queues one emoji (' + bad + ')');
  await p.evaluate(() => {
    location.hash = '#summary';
  });
  ok(
    await until(
      p,
      () =>
        /Your replies and reactions/.test(document.getElementById('v-summary').textContent) &&
        /🔥 on .*'s “/.test(document.getElementById('v-summary').textContent) &&
        !/👍 on /.test(document.getElementById('v-summary').textContent),
    ),
    'F37/F38: Summary lists the queued reaction under "Your replies and reactions"; 🔥 replaced the queued 👍',
  );
  ok((await p.evaluate(id => __rt.get(id).state, rx1.id)) === 'cancelled', 'F38: picking 🔥 cancelled the queued 👍');
  const cx = await p.$$('#v-summary .item.ob button.link:text-is("Cancel this reaction")');
  await cx[cx.length - 1].click();
  ok(
    await until(p, () =>
      [...__rt.store.keys()].some(
        k =>
          k.startsWith('outbox/') &&
          __rt.get(k).kind === 'react' &&
          __rt.get(k).emoji === '🔥' &&
          __rt.get(k).state === 'cancelled',
      ),
    ),
    'F37: Cancel this reaction sets state cancelled',
  );
  // F38: a reaction already in Messenger shows as "👍 You"; the picker highlights it; tapping it queues its removal
  await p.evaluate(
    ([i, mid]) =>
      __rt.write('outbox/r1000', {
        kind: 'react',
        i,
        mid,
        to: 'Ben',
        snip: 'x',
        emoji: '👍',
        remove: false,
        state: 'sent',
        queuedAt: '2026-11-01T10:00:00.000Z',
        sentAt: '2026-11-01T10:05:00.000Z',
        sentMid: mid,
      }),
    [xi, rx1.mid],
  );
  await p.evaluate(() => {
    location.hash = '#messages';
  });
  const chipOf = i => p.$eval('#m' + i + ' .pt', x => x.textContent).catch(() => '');
  ok(
    await until(p, i => /👍 You/.test(document.querySelector('#m' + i + ' .pt').textContent), xi),
    'F38: "👍 You" under the message',
  );
  const openPick = async () => {
    await p.hover('#m' + xi);
    await p.click('#m' + xi + ' button.rh:text-is("React")');
    return p.$$eval('#m' + xi + ' .rxpick button.rx', bs =>
      bs.filter(b => b.classList.contains('on') && b.getAttribute('aria-pressed') === 'true').map(b => b.textContent),
    );
  };
  const reacts = () =>
    p.evaluate(
      i =>
        [...__rt.store.keys()]
          .filter(
            k =>
              k.startsWith('outbox/') &&
              __rt.get(k).kind === 'react' &&
              __rt.get(k).i === i &&
              __rt.get(k).state === 'queued',
          )
          .map(k => (__rt.get(k).remove ? '-' : '+') + __rt.get(k).emoji),
      xi,
    );
  let on = await openPick();
  await p.click('#m' + xi + ' .rxpick button.rx.on');
  await p.waitForTimeout(300);
  const r1 = await reacts();
  const c1 = await chipOf(xi);
  ok(
    JSON.stringify(on) === '["👍"]' && JSON.stringify(r1) === '["-👍"]' && /removing 👍/.test(c1),
    'F38: the picker highlights 👍; tapping it queues {emoji:"👍", remove:true}; the message says "removing 👍" (' +
      JSON.stringify([on, r1, c1]) +
      ')',
  );
  on = await openPick();
  await p.click('#m' + xi + ' .rxpick button.rx:text-is("😂")');
  await p.waitForTimeout(300);
  const r2 = await reacts();
  ok(
    !on.length && JSON.stringify(r2) === '["+😂"]' && /😂 queued/.test(await chipOf(xi)),
    'F38: nothing highlighted while the removal waits; picking 😂 cancels the removal and queues 😂 (' +
      JSON.stringify([on, r2]) +
      ')',
  );
  on = await openPick();
  await p.click('#m' + xi + ' .rxpick button.rx.on');
  await p.waitForTimeout(300);
  const r3 = await reacts();
  ok(
    JSON.stringify(on) === '["😂"]' && JSON.stringify(r3) === '["-👍"]',
    'F38: tapping the queued 😂 cancels it, and your 👍 in Messenger is queued for removal (one reaction each, as in Messenger) (' +
      JSON.stringify([on, r3]) +
      ')',
  );
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
  await flashReset(p);
  await p.click('#chat a.cite');
  ok(
    await until(p, () => location.hash === '#messages' && document.querySelector('.msg[data-flashed]')),
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
        /Grouped by who posted/.test(document.getElementById('view-out').textContent) &&
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
  /* B62 (v1.51.0): a Needs you item's thread opens in place, and only one place shows a thread: open the cards' */
  await p.$$eval('#v-summary details:not(.item.mention details)', ds => ds.forEach(d => (d.open = true)));
  await p.waitForTimeout(300);
  t.summary = await p.$eval('#v-summary', e => e.innerText);
  sig.summaryCards = await p.$eval('#v-summary', e => {
    /* .thr-close: new in v1.27.0; Needs you threads new and the card heads' reply row gone in v1.51.0 (B62) */
    const hid = [...e.querySelectorAll('.msgs, .ctx, .thr-close, .item.mention details.thr, .cv-head .cv-act')];
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
    /* B64 (v1.53.0): replies nest with no depth limit, so a reply past level 3 now sits under its own parent: the same
       rows, some in another order, in the summary threads and the threaded view */
    const rowsAnyOrder = sig =>
      Object.assign({}, sig, {
        summaryRows: sig.summaryRows.map(r => JSON.stringify(r)).sort(),
        threadRows: sig.threadRows.map(r => JSON.stringify(r)).sort(),
      });
    ok(
      same(rowsAnyOrder(tRel.sig), rowsAnyOrder(tOld.sig)) && tOld.sig.threadRows.length > 100,
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
  await msgFilter(pNew, words);
  ok(!!(await pNew.$('#msgs #m' + mem[0])), 'layout: searching finds a message in an archived conversation');
  await msgFilter(pNew, '');
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
    JSON.stringify(who.slice(0, 4)) === JSON.stringify(['Ana Alvarez', 'Ben Brooks', 'Ben Ortiz', 'Taylor Moss (Cy)']),
    'names (B59): full names, a nickname as "Taylor Moss (Cy)" (' + who.join(' | ') + ')',
  );
  await msgFilter(p, 'ortiz');
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
  if (o.tweak) o.tweak(V);
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
/* Types into the Messages filter and waits until the page has redrawn for that text (it waits 150 ms after the last
   key, then draws), instead of a fixed wait that a busy runner can outlast: F15 O4 failed that way on Nov 22, the list
   not yet drawn again 400 ms after the filter was cleared. */
async function msgFilter(p, q) {
  await p.evaluate(() => {
    if (!window.__mfWrapped) {
      const f = window.renderMessages;
      window.renderMessages = function () {
        const r = f.apply(this, arguments);
        window.__mfDrawn = { n: ((window.__mfDrawn || {}).n || 0) + 1, q: document.getElementById('msg-q').value };
        return r;
      };
      window.__mfWrapped = true;
    }
    window.__mfAt = (window.__mfDrawn || {}).n || 0;
  });
  await p.fill('#msg-q', q);
  ok(
    await until(p, q => window.__mfDrawn && window.__mfDrawn.n > window.__mfAt && window.__mfDrawn.q === q, q),
    'the Messages filter drew the list for "' + q + '"',
  );
}
const opacity = (p, sel) => p.$eval(sel, e => getComputedStyle(e).opacity).catch(() => null);
/* each selector's computed opacity once they all read want (strings), or what they read when that didn't happen in
   5 s: the page fades a bubble's actions over 0.12 s, which a fixed 250 ms wait raced on a busy runner (B42, Nov 22) */
async function opacities(p, sels, want) {
  await until(
    p,
    ([ss, w]) =>
      ss.every((x, k) => {
        const e = document.querySelector(x);
        return e && getComputedStyle(e).opacity === w[k];
      }),
    [sels, want],
    5000,
  );
  return Promise.all(sels.map(x => opacity(p, x)));
}
const txt = (p, sel) => p.$eval(sel, e => e.textContent).catch(() => '');
/* a click that may not land, reported as true or false, never a crash; it waits as long as until() does, and a
   case that needs the click asserts it, so a click lost on a busy runner fails as that, not as a wrong result */
const tryClick = (p, sel) =>
  p.click(sel, { timeout: 10000 }).then(
    () => true,
    () => false,
  );
/* B64: replies nest with no depth limit, each level a colored rail that folds its branch; at phone width a branch past
   the sixth level opens on its own ("Continue this thread"); a conversation's sections show as headings. Maps (t5) is
   made an 8-level chain: 39 > 40 > 41 > 42 > 43 > 45 > 46 > 47, and 39 > 48 > 49. */
async function deepThreads() {
  const tweak = V => {
    Object.assign(V.th.links, {
      40: [39, 'i'],
      41: [40, 'r'],
      42: [41, 'i'],
      43: [42, 'r'],
      45: [43, 'i'],
      46: [45, 'r'],
      47: [46, 'i'],
      48: [39, 'i'],
      49: [48, 'r'],
    });
    V.th.convs.find(c => c.id === 't5').sections = [
      [48, 'Printing'],
      [39, 'Which map'],
    ];
  };
  const p = await viewPage({ tweak });
  await p.evaluate(() => (document.querySelector('#msgs details.conv[data-conv="t5"]').open = true));
  await until(p, () => document.querySelector('#m47'));
  const depthOf = n => p.$eval(n, r => [...document.querySelectorAll('.kids')].filter(k => k.contains(r)).length);
  const deep = [await depthOf('#m39'), await depthOf('#m43'), await depthOf('#m47'), await depthOf('#m49')];
  ok(
    deep.join() === '0,4,7,2',
    'B64: replies nest with no depth limit: #39 level 1, #43 level 5, #47 level 8, #49 level 3 (' + deep + ')',
  );
  const secs = await p.$$eval('#msgs details.conv[data-conv="t5"] .sec', hs =>
    hs.map(h => [h.textContent, h.nextElementSibling && h.nextElementSibling.id]),
  );
  const others = await p.$$eval('#msgs .sec', hs => hs.length);
  ok(
    JSON.stringify(secs) ===
      JSON.stringify([
        ['Which map · 8', 'm39'],
        ['Printing · 2', 'm48'],
      ]) && others === 2,
    'B64: sections show as headings over the message each starts, with their message counts; conversations without ' +
      'sections show none (' +
      JSON.stringify(secs) +
      ', ' +
      others +
      ' in all)',
  );
  // fold the branch under #40 by its rail (6 replies), then show it again from the note, and by the keyboard
  const vis = s => p.$eval(s, r => !!r.offsetParent);
  const railSel = '#msgs .kids[data-d="2"]:has(#m41) > .rail';
  const before = [
    await p.$eval(railSel, b => [b.getAttribute('aria-expanded'), b.getAttribute('aria-label')]),
    await vis('#m47'),
  ];
  await p.click(railSel);
  const shut = await p.$eval(railSel, b => {
    const k = b.parentElement;
    return [
      b.getAttribute('aria-expanded'),
      k.querySelector(':scope > .fold-note').textContent,
      !!document.querySelector('#m41').offsetParent,
    ];
  });
  await p.click('#msgs .kids[data-d="2"]:has(#m41) > .fold-note');
  const back = await vis('#m47');
  await p.focus(railSel);
  await p.keyboard.press('Enter');
  const kb = await p.$eval(railSel, b => b.getAttribute('aria-expanded'));
  await p.keyboard.press('Space');
  const kb2 = await p.$eval(railSel, b => b.getAttribute('aria-expanded'));
  ok(
    before[0][0] === 'true' &&
      /^Fold 6 replies/.test(before[0][1]) &&
      before[1] &&
      shut[0] === 'false' &&
      shut[1] === '6 replies folded' &&
      !shut[2] &&
      back &&
      kb === 'false' &&
      kb2 === 'true',
    'B64: a rail folds its branch ("6 replies folded"), the note shows it again, and the keyboard works it (' +
      JSON.stringify([before, shut, back, kb, kb2]) +
      ')',
  );
  const deskCont = await p.$$eval('#msgs .cont', bs => bs.filter(b => !!b.offsetParent).length);
  // at phone width: levels 7 and on wait behind "Continue this thread", which shows that branch with a trail back
  await p.setViewportSize({ width: 375, height: 800 });
  await p.waitForTimeout(100);
  const ph = [await vis('#m45'), await vis('#m46')];
  const cont = await p.$eval('#msgs .cont', b => [b.textContent, !!b.offsetParent]);
  await p.click('#msgs .cont');
  const rr = await p.evaluate(() => ({
    m46: !!document.querySelector('#m46').offsetParent,
    m39: !!document.querySelector('#m39').offsetParent,
    trail: (document.querySelector('.reroot .crumbs') || {}).textContent,
  }));
  await p.click('.reroot .crumbs button');
  const after = [
    await vis('#m39'),
    await vis('#m46'),
    !(await p.$('.reroot')),
    await p.$eval('#m45', r => !!r.closest('.kids[data-d="5"]')),
  ];
  ok(
    deskCont === 0 &&
      ph[0] &&
      !ph[1] &&
      cont[0] === 'Continue this thread (2 more) →' &&
      cont[1] &&
      rr.m46 &&
      !rr.m39 &&
      /‹ Whole thread › \S+ #39 › \S+ #40 › \S+ #41 › \S+ #42 › \S+ #43 › \S+ #45$/.test(rr.trail) &&
      after[0] &&
      !after[1] &&
      after[2] &&
      after[3],
    'B64: at phone width level 7 waits behind "Continue this thread (2 more)", which shows the branch on its own with ' +
      'a trail back, and "Whole thread" puts it back (none on a wide screen) (' +
      JSON.stringify([deskCont, ph, cont, rr, after]) +
      ')',
  );
  await p.context().close();
}
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
  const hid = await opacities(p, ['#m30 .acts', '#m31 .acts'], ['0', '0']);
  await p.hover('#m31 .pics');
  const shown = await opacities(p, ['#m30 .acts', '#m31 .acts'], ['0', '1']);
  ok(
    hid.join() === '0,0' && shown.join() === '0,1',
    "B42: a bubble's actions are hidden until you hover that bubble (before " + hid + ', hovering #31 ' + shown + ')',
  );
  await p.mouse.move(5, 5);
  await p.evaluate(() => {
    const a = document.querySelector('#m30 .acts a.replylink');
    if (a) a.focus();
  });
  ok(
    (await opacities(p, ['#m30 .acts', '#m31 .acts'], ['1', '0'])).join() === '1,0',
    "B42: keyboard focus on a bubble's action shows that bubble's actions",
  );
  ok(
    /Open photo/.test(await txt(p, '#m31 .acts')) &&
      /Reply in Messenger/.test(await txt(p, '#m31 .acts')) &&
      !/Open photo/.test(await txt(p, '#m30 .acts')),
    'B42: each bubble keeps its own actions (the photo bubble has Open photo)',
  );
  await p.evaluate(() => document.activeElement.blur());
  await until(
    p,
    () =>
      [...document.querySelectorAll('#msgs details.conv[open] .msg > .c > .acts')].every(
        a => getComputedStyle(a).opacity === '0',
      ),
    null,
    5000,
  );
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
  const single = (await opacities(p, ['#m35 .acts'], ['1']))[0];
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
    const b = [...document.querySelectorAll('#m34 .acts button.rh')].pop(); /* its last action (React, F37) */
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
  await flashReset(p);
  ok(await tryClick(p, '#m32 a.lk'), 'B42: the #31 link on the reply can be clicked');
  ok(
    await until(p, () => {
      const n = document.querySelector('#m31[data-flashed]');
      const r = n && n.getBoundingClientRect();
      return r && r.top >= 0 && r.bottom <= innerHeight;
    }),
    'B42: the #31 link on the reply jumps to the second bubble',
  );
  await msgFilter(p, '#31');
  const s31 = await p.evaluate(() => ({
    convs: [...document.querySelectorAll('#msgs details.conv')].map(d => d.dataset.conv),
    has: !!document.querySelector('#m31'),
  }));
  await msgFilter(p, 'old pack');
  const s30 = await p.evaluate(() => !!document.querySelector('#m30'));
  ok(
    s31.has && s31.convs.join() === 'packs' && s30,
    'B42: search finds each bubble (#31 by number, #30 by text) (' + JSON.stringify(s31) + ')',
  );
  await p.click('#lay-flat');
  await msgFilter(p, '');
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
  await msgFilter(p, '#31');
  ok(
    (await p.$$eval('#msgs .msg', r => r.map(x => x.id))).join() === 'm31',
    'B42: in the timeline, search by number finds the second bubble alone',
  );
  await msgFilter(p, '');
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
  await convSet(p, 'packs', false);
  await convSet(p, 'lend', true);
  /* new data redraws the list (threading written again, unchanged): what the reader opened and closed stays */
  await p.evaluate(() => {
    document.querySelector('#msgs details.conv[data-conv="lend"]').__before = true;
    __rt.write('threading/current', __rt.get('threading/current'));
  });
  ok(
    await until(p, () => {
      const l = document.querySelector('#msgs details.conv[data-conv="lend"]'),
        k = document.querySelector('#msgs details.conv[data-conv="packs"]');
      return l && !l.__before && l.open && k && !k.open;
    }),
    'B40: a redraw for new data keeps "lend" open and "packs" closed',
  );
  await flashReset(p);
  ok(
    await tryClick(p, '#msgs details.conv[data-conv="lend"] > .ctx button.link'),
    "B40: the context line's Show #30 can be clicked",
  );
  const jumped = await until(p, () => {
    const n = document.querySelector('#m30[data-flashed]');
    const r = n && n.getBoundingClientRect();
    return r && r.height && r.top >= 0 && r.bottom <= innerHeight && n.closest('details').open;
  });
  const at30 = await p.evaluate(() => {
    const n = document.querySelector('#m30');
    const r = n && n.getBoundingClientRect();
    return (
      n && {
        flashed: n.hasAttribute('data-flashed'),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        vh: innerHeight,
        open: n.closest('details').open,
        conv: n.closest('details').dataset.conv,
        hash: location.hash,
      }
    );
  });
  ok(jumped, "B40: the context line's Show #30 jumps to #30 in its own conversation (" + JSON.stringify(at30) + ')');
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
  const thrBox = await p.evaluate(() => {
    const t = document.querySelector('#v-summary article.cv[data-conv="packs"] details.thr');
    const m = t.querySelector('.msgs');
    const c = t.lastElementChild;
    return {
      full: m.scrollHeight <= m.clientHeight + 1 && getComputedStyle(m).overflowY === 'visible',
      close: c.matches('button.thr-close') && c.textContent === 'Close the thread',
    };
  });
  ok(
    thrBox.full && thrBox.close,
    'TH1: an open thread shows at full length, ending in "Close the thread" ' + JSON.stringify(thrBox),
  );
  await p.click('#v-summary article.cv[data-conv="packs"] details.thr button.thr-close');
  await p.waitForTimeout(100);
  ok(
    await p.$eval(
      '#v-summary article.cv[data-conv="packs"] details.thr',
      d => !d.open && d.querySelector('summary').textContent.startsWith('Show the thread'),
    ),
    'TH2: "Close the thread" closes it, and the top control reads "Show the thread" again',
  );
  /* TH3: what the conversation replies to sits above the summary while the thread is closed, and the open thread starts
     with it (one copy, moved) */
  const LEND = '#v-summary article.cv[data-conv="lend"]';
  const where = () =>
    p.$eval(LEND, a => {
      const cx = a.querySelectorAll('.ctx');
      const t = a.querySelector('details.thr');
      return {
        n: cx.length,
        inThread: !!cx[0] && t.contains(cx[0]) && cx[0].nextElementSibling === t.querySelector(':scope > .msgs'),
        aboveThread:
          !!cx[0] && !t.contains(cx[0]) && !!(cx[0].compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
  const closed0 = await where();
  await p.click(LEND + ' details.thr > summary');
  await p.waitForTimeout(150);
  const opened = await where();
  await p.click(LEND + ' details.thr > summary');
  await p.waitForTimeout(150);
  const closed1 = await where();
  ok(
    closed0.n === 1 && closed0.aboveThread && opened.n === 1 && opened.inThread && closed1.aboveThread,
    'TH3: the earlier message shows above the summary, and the open thread starts with it ' +
      JSON.stringify([closed0, opened, closed1]),
  );
  /* TH4: when that earlier message is itself a Messenger reply, the message it answers shows first, photo included */
  await p.evaluate(() => {
    S.byI.get(30).pi = 31 - 5; /* #26, in "Car pool" */
    S.byI.get(26).p = 'att26';
    renderSummary();
  });
  await p.waitForTimeout(150);
  const up = await p.$eval(LEND + ' .ctx', c =>
    [...c.querySelectorAll(':scope > .msgs')].map(m => +(m.textContent.match(/#(\d+)/) || [0, 0])[1]),
  );
  ok(up.join() === '26,30', 'TH4: the context shows #26 (what #30 answers) before #30 ' + JSON.stringify(up));
  /* TH5: closing a thread taller than the screen from its end brings the card back, not wherever the next cards slid to */
  await p.setViewportSize({ width: 900, height: 420 });
  const PK = '#v-summary article.cv[data-conv="packs"]';
  await p.click(PK + ' details.thr > summary');
  await p.waitForTimeout(150);
  await p.$eval(PK + ' button.thr-close', b => b.scrollIntoView({ block: 'end' }));
  await p.waitForTimeout(100);
  await p.click(PK + ' button.thr-close');
  await p.waitForTimeout(200);
  const back = await p.evaluate(sel => {
    const nav = document.querySelector('nav.tabs').getBoundingClientRect().bottom;
    const a = document.querySelector(sel).getBoundingClientRect();
    const s = document.querySelector(sel + ' details.thr > summary').getBoundingClientRect();
    return {
      nav: Math.round(nav),
      top: Math.round(a.top),
      h: Math.round(a.height),
      sTop: Math.round(s.top),
      vh: innerHeight,
    };
  }, PK);
  const fits = back.h + 16 <= back.vh - back.nav;
  ok(
    fits ? back.top >= back.nav && back.top <= back.nav + 20 : back.sTop > back.nav && back.sTop < back.vh - 20,
    'TH5: after Close the thread at its end, the card is back in view (its top under the tabs, or its Show line on screen) ' +
      JSON.stringify(back),
  );
  await p.setViewportSize({ width: 1280, height: 720 });
  ok(p.errors.length === 0, 'messages view: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();

  // B42 on a phone: no hover, so tapping a bubble shows its actions; nothing scrolls sideways
  p = await viewPage({ ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
  await convSet(p, 'packs', true);
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
async function hopen(seed, n, ctxOpts) {
  const p = await open(seed, PAGE, ctxOpts);
  HP.push(p);
  await until(p, n => S.msgs.length === n && S.threading, n, 120000);
  return p;
}
const lastSample = p => p.evaluate(() => __rt.samples[__rt.samples.length - 1]);
/* Ask one question; returns the calls it made ({bytes, code} each), the turns of the last one and the notes. F32:
   Ask always takes the whole history, so `all` (once the "include older" box) changes nothing. */
async function hask(p, q, all = false) {
  const n0 = await p.evaluate(() => __rt.sampleLog.length);
  await p.evaluate(
    ([q, all]) => {
      location.hash = '#ask';
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
        /- MESSAGES: every stored message, #0 to #19, word for word/.test(r.prompt),
      'H4: a history that fits is sent whole: every line in order, no summaries, "What you have" names #0 to #19',
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

  /* H6, H14: Ask and Views on a history over the budget. F32: both always take the whole history (they took only the
     window before), so the summaries reach back to #0 */
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
        /Grouped by who posted/.test(document.getElementById('view-out').textContent),
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
          X.dig.some(([a]) => a < 100) &&
          note.startsWith((what === 'Ask' ? 'Read #' : 'Built from #') + X.raw[0] + '–#799 word for word') &&
          /Older than #\d+: summaries only\./.test(note),
        'H6: ' +
          what +
          ' on an 800-message history: within the cap (' +
          bytes +
          '), the newest ' +
          n +
          ' word for word, summaries back past the window ("' +
          note +
          '")',
      );
    }
    ok(/- OLDER HISTORY: #0 to #/.test(vp), 'H6: the Views prompt carries summaries from #0 on');
    const view = await until(p, () => Object.values(Object.fromEntries(__rt.store)).find(v => v && v.kind === 'view'));
    ok(
      view && view.sent && view.sent.to === 799 && view.sent.sumFrom === 0,
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
        /too long|Grouped by who posted/.test(
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
        !/Digest:|Summary:|Day summaries/.test(r.prompt + r.note),
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
        'The day lines from #' +
          from +
          ' to #' +
          to +
          " that say Summary: carry that day's summary, and those that say Digest: a few short bullets on it",
      ) && r.note.includes(' Day summaries for ' + n + ' day' + (n === 1 ? '' : 's') + ' (' + days(from, to) + ').'),
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
      (await p.textContent('#qa-list')).includes(', day summaries #' + from + '–#' + to),
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

/* ---------- F24: the By day tab ----------
   The per-day digests, a card per day, newest first, each bullet's numbers opening the message as Ask's citations do.
   Days without a digest are left out (one quiet line says why). Bullet text is data. */
/* 5 days of 100 (Oct 1–5, 2026); the window is the last 20 messages; the newest day has no digest yet */
const bdSeed = (o = {}) => {
  const msgs = hmsgs(o.n || 500, { perDay: o.perDay || 100 });
  const days = new Set(msgs.map(m => m.d)).size;
  const docs = Object.assign(o.noDigests ? {} : hdigests(msgs, k => k < days - 1, o.make), o.docs || {});
  return { msgs, seed: hseed(msgs, { threads: true, meta: { caughtUpI: msgs.length - 21 }, docs, opts: o.opts }) };
};
const bdOpen = async (o = {}, ctx) => {
  const { msgs, seed } = bdSeed(o);
  const p = await open(seed, PAGE, ctx);
  HP.push(p);
  await until(p, n => S.msgs.length === n && S.threading, msgs.length, 120000);
  return { p, msgs };
};
const bdCards = p =>
  p.evaluate(() =>
    [...document.querySelectorAll('#days-list article')].map(a => ({
      day: a.dataset.day,
      title: (a.querySelector('h3') || {}).textContent,
      text: a.textContent,
      bullets: [...a.querySelectorAll('li')].map(li => li.textContent),
    })),
  );
const bdShow = async p => {
  await p.evaluate(() => (location.hash = '#days'));
  await until(p, () => document.querySelector('#days-list article, #days-list .empty'), null, 5000);
};

async function byDay() {
  /* BD11: every tab switches even when the host takes a link's #hash away from the page (claude.ai's artifact viewer
     puts it on its own address, so no hashchange reaches the page); clicking the tab marks it current; Back returns */
  await hcase('BD11', async () => {
    const { p } = await bdOpen();
    await p.evaluate(() =>
      addEventListener(
        'click',
        e => {
          const a = e.target.closest && e.target.closest('a[href^="#"]');
          if (a) e.preventDefault();
        },
        true,
      ),
    );
    const seen = [];
    for (const t of ['messages', 'days', 'views', 'stats', 'ask', 'summary']) {
      await p.click('nav a[data-tab="' + t + '"]');
      await p.waitForTimeout(100);
      seen.push(
        await p.evaluate(
          t => ({
            t,
            shown: !document.getElementById('v-' + t).hidden,
            alone: [...document.querySelectorAll('section.view')].filter(v => !v.hidden).length === 1,
            cur: document.querySelector('nav a[data-tab="' + t + '"]').getAttribute('aria-current') === 'page',
          }),
          t,
        ),
      );
    }
    await p.goBack();
    await p.waitForTimeout(150);
    const back = await p.evaluate(() => !document.getElementById('v-ask').hidden);
    ok(
      seen.every(x => x.shown && x.alone && x.cur) && back,
      'BD11: with the host taking #hash links, each tab click opens that tab alone and marks it current; Back returns to the tab before (' +
        JSON.stringify([seen, back]) +
        ')',
    );
    await p.close();
  });
  /* BD12: switching tabs from far down a long tab brings the new tab's start up under the nav, instead of leaving the
     page at its foot; a tab switched from the top doesn't scroll */
  await hcase('BD12', async () => {
    const { p } = await bdOpen();
    await p.evaluate(() => {
      document
        .getElementById('v-summary')
        .append(Object.assign(document.createElement('div'), { style: 'height:4000px' }));
      scrollTo(0, document.body.scrollHeight);
    });
    await p.waitForTimeout(100);
    await p.click('nav a[data-tab="days"]');
    await p.waitForTimeout(150);
    const r = await p.evaluate(() => {
      const nav = document.querySelector('nav').getBoundingClientRect().bottom;
      const top = document.getElementById('v-days').getBoundingClientRect().top;
      return { gap: Math.round(top - nav), y: Math.round(scrollY) };
    });
    await p.evaluate(() => scrollTo(0, 0));
    await p.click('nav a[data-tab="summary"]');
    await p.waitForTimeout(100);
    const y0 = await p.evaluate(() => scrollY);
    ok(
      r.gap >= 0 && r.gap <= 40 && y0 === 0,
      'BD12: a tab opened from far down a long tab starts just under the nav; from the top, nothing scrolls (' +
        JSON.stringify([r, y0]) +
        ')',
    );
    await p.close();
  });
  /* BD1: the tab opens from the keyboard and lists the digested days newest first, with their bullets and counts; the
     day still waiting is absent and the quiet line names it; a page opened at #days draws them too */
  await hcase('BD1', async () => {
    const { p } = await bdOpen();
    await p.focus('nav a[data-tab="days"]');
    await p.keyboard.press('Enter');
    await until(p, () => document.querySelector('#days-list article'), null, 5000);
    const st = await p.evaluate(() => ({
      hash: location.hash,
      shown: !document.getElementById('v-days').hidden,
      cur: document.querySelector('nav a[data-tab="days"]').getAttribute('aria-current'),
      others: [...document.querySelectorAll('section.view')].filter(v => !v.hidden).length,
      note: (document.querySelector('#days-list > p.note') || {}).textContent || '',
    }));
    const cards = await bdCards(p);
    ok(
      st.hash === '#days' && st.shown && st.cur === 'page' && st.others === 1,
      'F24 BD1: Enter on the By day tab opens it alone and marks it current ' + JSON.stringify(st),
    );
    ok(
      cards.map(c => c.day).join() === '2026-10-04,2026-10-03,2026-10-02,2026-10-01' &&
        cards[0].title === 'Sun, Oct 4' &&
        cards[3].title === 'Thu, Oct 1' &&
        cards[0].text.includes('100 messages') &&
        cards[0].bullets.join(' / ') ===
          'Ana sold a stove on day 3 #301 #302 / Ben asked about permits on day 3 #305' &&
        cards[3].bullets[0] === 'Ana sold a stove on day 0 #1 #2',
      'F24 BD1: the digested days, newest first, with weekday, date, count and bullets: ' +
        JSON.stringify(cards.map(c => [c.day, c.title, c.bullets[0]])),
    );
    ok(
      !cards.some(c => c.day === '2026-10-05') &&
        st.note ===
          "A refresh keeps each day's summary current and rewrites it once after the day ends. Mon, Oct 5 gets its summary at the next refresh. Older days show their short digest: ask Claude to write day summaries for past days.",
      'F24 BD1: the day with neither a summary nor a digest (Oct 5) is left out, and the quiet line says why: "' +
        st.note +
        '"',
    );
    await p.reload();
    await until(p, () => document.querySelectorAll('#days-list article').length === 4, null, 10000);
    ok(
      (await bdCards(p)).length === 4 && p.errors.length === 0,
      'F24 BD1: a page opened at #days draws the days once its data loads; no page errors ' + JSON.stringify(p.errors),
    );
  });

  /* BD2: a bullet's number opens that message in Messages, loading its day when it's before the window */
  await hcase('BD2', async () => {
    const { p } = await bdOpen();
    await bdShow(p);
    await flashReset(p);
    await p.click('#days-list article[data-day="2026-10-02"] li a.cite');
    await until(p, () => document.querySelector('#m101[data-flashed]'), null, 5000);
    const r = await p.evaluate(() => {
      const n = document.getElementById('m101');
      const b = n && n.getBoundingClientRect();
      return {
        hash: location.hash,
        older: document.getElementById('msg-all').checked,
        seen: !!b && b.height > 0 && b.top >= 0 && b.bottom <= innerHeight,
        flash: !!n && n.hasAttribute('data-flashed'),
      };
    });
    ok(
      r.hash === '#messages' && r.older && r.seen && r.flash,
      'F24 BD2: #101 (Oct 2, before the window) opens in Messages, on screen and highlighted ' + JSON.stringify(r),
    );
    ok(p.errors.length === 0, 'F24 BD2: no page errors ' + JSON.stringify(p.errors));
  });

  /* BD3: markup in a bullet shows as literal text */
  await hcase('BD3', async () => {
    const bad = '<img src=x onerror="window.__xss=1"><b>Ben</b> & Cy <script>window.__xss=2</script>';
    const { p } = await bdOpen({ make: (k, ids) => [{ t: bad, refs: [ids[3]] }] });
    await bdShow(p);
    await p.waitForTimeout(200);
    const r = await p.evaluate(() => ({
      li: (document.querySelector('#days-list li') || {}).textContent || '',
      tags: document.querySelectorAll('#days-list img, #days-list b, #days-list script').length,
      xss: window.__xss || null,
    }));
    ok(
      r.li.startsWith(bad) && r.tags === 0 && r.xss === null,
      'F24 BD3: markup in a bullet is shown as text, nothing runs ' + JSON.stringify(r),
    );
  });

  /* BD4: no digests at all: a short empty state, no errors */
  await hcase('BD4', async () => {
    const { p } = await bdOpen({ noDigests: true });
    await bdShow(p);
    const r = await p.evaluate(() => ({
      empty: (document.querySelector('#days-list .empty') || {}).textContent || '',
      cards: document.querySelectorAll('#days-list article').length,
    }));
    ok(
      /^No day summaries yet\./.test(r.empty) && r.cards === 0 && p.errors.length === 0,
      'F24 BD4: with no summaries or digests the tab shows an empty state ' +
        JSON.stringify(r) +
        ' ' +
        JSON.stringify(p.errors),
    );
  });

  /* BD5: no database (signed out): the tab says the digests can't load here, not "once the chat data loads" forever;
     no errors, also when the page opens at #days */
  await hcase('BD5', async () => {
    const p = await open(Object.assign(SEED(), { __opts: { noDb: true } }));
    HP.push(p);
    await bdShow(p);
    await p.waitForTimeout(300);
    const e1 = await p.evaluate(() => (document.querySelector('#days-list .empty') || {}).textContent || '');
    await p.reload();
    await p.waitForTimeout(400);
    const e2 = await p.evaluate(() => (document.querySelector('#days-list .empty') || {}).textContent || '');
    ok(
      e1 === "The day summaries can't load in this view. Open the page on claude.ai while signed in." &&
        e2 === e1 &&
        p.errors.length === 0,
      'F24 BD5: with no database, the tab says "' + e1 + '" and no page errors ' + JSON.stringify(p.errors),
    );
  });

  /* BD10: both listeners fail: the tab says so instead of waiting for the data forever, also opened at #days; the day
     summaries' alone: the older digests show, under a line saying the summaries couldn't load */
  await hcase('BD10', async () => {
    const p = await open(Object.assign(SEED(), { __opts: { snapFail: ['c:daySummaries', 'c:digests'] } }));
    HP.push(p);
    await bdShow(p);
    await p.waitForTimeout(300);
    const e1 = await p.evaluate(() => (document.querySelector('#days-list .empty') || {}).textContent || '');
    await p.reload();
    await p.waitForTimeout(400);
    const e2 = await p.evaluate(() => (document.querySelector('#days-list .empty') || {}).textContent || '');
    ok(
      e1 === "Couldn't load the day summaries. Reload the page to try again." && e2 === e1 && p.errors.length === 0,
      'F24 BD10: when both listeners fail, the tab says "' + e1 + '"; no page errors ' + JSON.stringify(p.errors),
    );
    const { p: q } = await bdOpen({ opts: { snapFail: ['c:daySummaries'] } });
    await bdShow(q);
    await until(q, () => document.querySelectorAll('#days-list article').length === 4, null, 5000);
    const r = await q.evaluate(() => ({
      note: (document.querySelector('#days-list > p.note') || {}).textContent || '',
      cards: document.querySelectorAll('#days-list article').length,
    }));
    ok(
      r.note === "Couldn't load the day summaries. Reload the page to try again. Older digests show meanwhile." &&
        r.cards === 4 &&
        q.errors.length === 0,
      'F29 BD10: the day summaries listener alone fails: the digests show, with a line saying so ' + JSON.stringify(r),
    );
  });

  /* BD6: at 390 px a long bullet with ten numbers wraps: nothing scrolls sideways */
  await hcase('BD6', async () => {
    const long = 'Ana listed ' + 'tentpolesandstakes'.repeat(8) + ' with a long note about the ridge trail and spares';
    const { p } = await bdOpen(
      { make: (k, ids) => [{ t: long, refs: ids.slice(80, 90) }] },
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    );
    await bdShow(p);
    await p.waitForTimeout(200);
    const r = await p.evaluate(() => {
      const a = document.querySelector('#days-list article');
      return {
        cards: document.querySelectorAll('#days-list article').length,
        sw: document.documentElement.scrollWidth,
        w: innerWidth,
        right: a ? Math.round(a.getBoundingClientRect().right) : null,
      };
    });
    ok(
      r.cards === 4 && r.sw <= r.w && r.right <= r.w,
      'F24 BD6: at 390 px the cards fit the width, no sideways scroll ' + JSON.stringify(r),
    );
  });

  /* BD7: dark mode: the cards, their text and the numbers use the dark theme's colors */
  await hcase('BD7', async () => {
    const { p } = await bdOpen({}, { colorScheme: 'dark' });
    await bdShow(p);
    const c = await p.evaluate(() => {
      const a = document.querySelector('#days-list article');
      const cs = x => x && getComputedStyle(x);
      return a
        ? {
            card: cs(a).backgroundColor,
            border: cs(a).borderTopColor,
            text: cs(a.querySelector('li')).color,
            cite: cs(a.querySelector('a.cite')).color,
            note: cs(document.querySelector('#days-list > p.note')).color,
          }
        : null;
    });
    ok(
      !!c &&
        c.card === 'rgb(33, 35, 31)' &&
        c.border === 'rgb(54, 57, 49)' &&
        c.text === 'rgb(233, 232, 224)' &&
        c.cite === 'rgb(122, 165, 255)' &&
        c.note === 'rgb(163, 166, 152)',
      'F24 BD7: in dark mode the cards use the theme tokens ' + JSON.stringify(c),
    );
  });

  /* BD8: a long history draws 30 days at first; "Show 9 more days" adds the rest and moves focus to the first added */
  await hcase('BD8', async () => {
    const { p } = await bdOpen({ n: 400, perDay: 10 });
    await bdShow(p);
    const n0 = (await bdCards(p)).length;
    const btn = await p.evaluate(() => (document.querySelector('#days-list > button') || {}).textContent || '');
    await p.focus('#days-list > button');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(200);
    const r = await p.evaluate(() => ({
      n: document.querySelectorAll('#days-list article').length,
      btn: !!document.querySelector('#days-list > button'),
      focus: document.activeElement && document.activeElement.dataset && document.activeElement.dataset.day,
      last: [...document.querySelectorAll('#days-list article')].pop().dataset.day,
    }));
    ok(
      n0 === 30 &&
        btn === 'Show 9 more days' &&
        r.n === 39 &&
        !r.btn &&
        r.focus === '2026-10-09' &&
        r.last === '2026-10-01',
      'F24 BD8: 30 days first (' + n0 + '), then "' + btn + '" adds the rest ' + JSON.stringify(r),
    );
    ok(p.errors.length === 0, 'F24 BD8: no page errors ' + JSON.stringify(p.errors));
  });

  /* BD9: at 390 px all six tabs fit the bar (none hidden off its right edge, no sideways scroll in the bar or the
     page) and stay easy to tap; also with a wide stand-in for the display font, as a machine without the web font or
     Arial Narrow draws them */
  await hcase('BD9', async () => {
    const p = await open(SEED(), PAGE, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    HP.push(p);
    const measure = () =>
      p.evaluate(() => {
        const nav = document.querySelector('nav.tabs');
        const nr = nav.getBoundingClientRect();
        /* the tabs this chat shows (a group's Posts tab is hidden on a chat, F25) */
        const tabs = [...nav.querySelectorAll('a:not([hidden])')].map(a => {
          const r = a.getBoundingClientRect();
          return { t: a.dataset.tab, l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) };
        });
        return {
          tabs,
          navL: Math.round(nr.left),
          navR: Math.round(nr.left + nav.clientWidth),
          scroll: nav.scrollWidth - nav.clientWidth,
          sw: document.documentElement.scrollWidth,
          iw: innerWidth,
        };
      });
    const fits = m =>
      m.tabs.length === 6 &&
      m.tabs.every(t => t.l >= m.navL && t.r <= m.navR && t.h >= 32) &&
      m.scroll <= 0 &&
      m.sw <= m.iw;
    const m1 = await measure();
    await p.evaluate(() =>
      document.documentElement.style.setProperty('--display', 'Verdana, "DejaVu Sans", sans-serif'),
    );
    const m2 = await measure();
    ok(
      fits(m1) && fits(m2),
      'F24 BD9: at 390 px all six tabs fit the bar, at least 32 px tall, no sideways scroll, also in a wide font ' +
        JSON.stringify({ m1, m2 }),
    );
  });
}

/* ---------- F27: each refresh's report on the By day tab ---------- */
async function byDayReports() {
  /* F27: each refresh's report (reports/d<YYYY-MM-DD>, written by catchup.py with each build), on By day. Oct 5 is the
     day in progress (no digest yet): two runs, stored out of order; Oct 4 has its digest, two runs (the second written
     after midnight) and two older runs that left the document. The chat's zone is Los Angeles. */
  const RP = () => ({
    'reports/d2026-10-05': {
      day: '2026-10-05',
      runs: [
        { at: '2026-10-05T17:04:00Z', fromI: 450, toI: 499, n: 50, bullets: [] },
        {
          at: '2026-10-05T16:04:00Z',
          fromI: 400,
          toI: 449,
          n: 50,
          bullets: [
            { t: 'Ana offered a stove; <b>Ben</b> claimed it', refs: [401, 405] },
            { t: 'Cy asked about permits', refs: [440] },
          ],
        },
      ],
    },
    'reports/d2026-10-04': {
      day: '2026-10-04',
      dropped: 2,
      runs: [
        { at: '2026-10-04T23:04:00Z', fromI: 300, toI: 389, n: 90, bullets: [{ t: 'Dee sold the tarp', refs: [310] }] },
        {
          at: '2026-10-05T07:30:00Z',
          fromI: 390,
          toI: 399,
          n: 10,
          bullets: [{ t: 'Ben said goodnight', refs: [399] }],
        },
      ],
    },
  });
  const rpRuns = (p, day) =>
    p.evaluate(
      day =>
        [...document.querySelectorAll('#days-list article[data-day="' + day + '"] .rp-run')].map(li => ({
          head: li.querySelector('.rp-head').textContent,
          bullets: [...li.querySelectorAll('li')].map(x => x.textContent),
          quiet: (li.querySelector(':scope > p.note') || {}).textContent || '',
          /* a closed <details> keeps its content's boxes (content-visibility: hidden), so ask whether it's drawn */
          seen: li.checkVisibility() && li.getBoundingClientRect().height > 0,
        })),
      day,
    );
  const rpOpens = async (p, sel, i) => {
    await flashReset(p);
    await p.click(sel);
    await until(p, i => document.querySelector('#m' + i + '[data-flashed]'), i, 5000);
    return p.evaluate(i => {
      const n = document.getElementById('m' + i);
      const b = n && n.getBoundingClientRect();
      return location.hash === '#messages' && !!b && b.height > 0 && b.top >= 0 && b.bottom <= innerHeight;
    }, i);
  };

  /* BD13: the day in progress shows each refresh's run in order (time, count, bullets with their numbers; a run with
     no bullets says so), with the day's count so far; markup stays text; a number opens its message */
  await hcase('BD13', async () => {
    const { p } = await bdOpen({ docs: RP() });
    await bdShow(p);
    await until(p, () => document.querySelector('#days-list article.rp-day'), null, 5000);
    const card = await p.evaluate(() => {
      const a = document.querySelector('#days-list article[data-day="2026-10-05"]');
      return {
        first: document.querySelector('#days-list article').dataset.day,
        title: a.querySelector('h3').textContent,
        count: a.querySelector('.row .note').textContent,
        lead: (a.querySelector('.rp-lead') || {}).textContent,
        details: a.querySelectorAll('details').length,
        tags: a.querySelectorAll('li b, li img').length,
      };
    });
    const runs = await rpRuns(p, '2026-10-05');
    ok(
      card.first === '2026-10-05' &&
        card.title === 'Mon, Oct 5' &&
        card.count === '100 messages so far' &&
        card.lead === 'No summary yet. What each refresh found:' &&
        card.details === 0 &&
        card.tags === 0,
      'F27 BD13: the day in progress comes first, titled, with its count so far, its runs in full ' +
        JSON.stringify(card),
    );
    ok(
      runs.length === 2 &&
        runs[0].head === '9:04 AM 50 messages' &&
        runs[0].bullets.join(' / ') ===
          'Ana offered a stove; <b>Ben</b> claimed it #401 #405 / Cy asked about permits #440' &&
        runs[1].head === '10:04 AM 50 messages' &&
        runs[1].bullets.length === 0 &&
        runs[1].quiet === 'Nothing stood out.' &&
        runs.every(x => x.seen),
      'F27 BD13: the runs in order, each with its time, count and bullets (markup as text); an empty run says so ' +
        JSON.stringify(runs),
    );
    const opened = await rpOpens(p, '#days-list article[data-day="2026-10-05"] .rp-run a.cite:has-text("#440")', 440);
    ok(opened, "F27 BD13: a run's number (#440, before the window) opens that message in Messages, on screen");
    ok(p.errors.length === 0, 'F27 BD13: no page errors ' + JSON.stringify(p.errors));
  });

  /* BD14: a finished day keeps its digest and adds a collapsed "What each refresh found (2)"; opened, its runs show
     (one after midnight, with the weekday) and the note on the runs not kept; their numbers open messages; days with
     no runs have no list */
  await hcase('BD14', async () => {
    const { p } = await bdOpen({ docs: RP() });
    await bdShow(p);
    await until(p, () => document.querySelector('#days-list details.rp-more'), null, 5000);
    const sel = '#days-list article[data-day="2026-10-04"]';
    const before = await p.evaluate(sel => {
      const a = document.querySelector(sel);
      const d = a.querySelector('details.rp-more');
      return {
        digest: [...a.querySelectorAll(':scope > ul > li')].map(x => x.textContent),
        count: a.querySelector('.row .note').textContent,
        summary: d.querySelector('summary').textContent,
        open: d.open,
        others: document.querySelectorAll('#days-list details.rp-more').length,
        lastChild: a.lastElementChild === d,
      };
    }, sel);
    const hidden = await rpRuns(p, '2026-10-04');
    await p.focus(sel + ' details.rp-more > summary');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(100);
    const runs = await rpRuns(p, '2026-10-04');
    const note = await p.evaluate(
      sel => (document.querySelector(sel + ' .rp-box > p.note') || {}).textContent || '',
      sel,
    );
    ok(
      before.digest.join(' / ') === 'Ana sold a stove on day 3 #301 #302 / Ben asked about permits on day 3 #305' &&
        before.count === '100 messages' &&
        before.summary === 'What each refresh found (2)' &&
        !before.open &&
        before.lastChild &&
        before.others === 1 &&
        hidden.length === 2 &&
        hidden.every(x => !x.seen),
      'F27 BD14: the finished day keeps its digest, with the runs collapsed under it; other days have none ' +
        JSON.stringify([before, hidden]),
    );
    ok(
      runs.length === 2 &&
        runs[0].head === '4:04 PM 90 messages' &&
        runs[0].bullets[0] === 'Dee sold the tarp #310' &&
        runs[1].head === 'Mon 12:30 AM 10 messages' &&
        runs[1].bullets[0] === 'Ben said goodnight #399' &&
        runs.every(x => x.seen) &&
        note === "2 earlier refreshes this day aren't kept.",
      'F27 BD14: opened from the keyboard, the runs show in order, the one after midnight with its weekday, and the note ' +
        JSON.stringify([runs, note]),
    );
    /* a refresh writes the day again while the list is open: it redraws, still open, with the new run */
    await p.evaluate(() => {
      const d = __rt.get('reports/d2026-10-04');
      d.runs.push({ at: '2026-10-05T07:40:00Z', fromI: 400, toI: 400, n: 1, bullets: [] });
      __rt.write('reports/d2026-10-04', d);
    });
    await until(
      p,
      sel => /\(3\)$/.test(document.querySelector(sel + ' details.rp-more > summary').textContent),
      sel,
      5000,
    );
    const redrawn = await p.evaluate(sel => document.querySelector(sel + ' details.rp-more').open, sel);
    ok(redrawn, 'F27 BD14: the opened list stays open when the tab redraws with a new run');
    ok(await rpOpens(p, sel + ' .rp-run a.cite:has-text("#310")', 310), 'F27 BD14: #310 opens in Messages');
    ok(p.errors.length === 0, 'F27 BD14: no page errors ' + JSON.stringify(p.errors));
  });

  /* BD15: nothing saved, nothing shown: no reports, or a day's document with no run worth showing, adds nothing; a
     refresh's write reaches the open tab without a reload */
  await hcase('BD15', async () => {
    const junk = {
      'reports/d2026-10-05': { day: '2026-10-05', runs: [] },
      'reports/d2026-10-03': { day: '2026-10-03', runs: [null, 5, 'x', []] },
      'reports/today': { day: '2026-10-05', runs: [{ at: '2026-10-05T16:04:00Z', n: 3, bullets: [] }] },
      'reports/d2026-10-02': { day: '2026-10-02', runs: 'no' },
    };
    for (const docs of [{}, junk]) {
      const { p } = await bdOpen({ docs });
      await bdShow(p);
      await p.waitForTimeout(200);
      const r = await p.evaluate(() => ({
        days: [...document.querySelectorAll('#days-list article')].map(a => a.dataset.day).join(),
        rp: document.querySelectorAll('#days-list .rp-more, #days-list .rp-day, #days-list .rp-run').length,
      }));
      ok(
        r.days === '2026-10-04,2026-10-03,2026-10-02,2026-10-01' && r.rp === 0 && p.errors.length === 0,
        'F27 BD15: ' +
          (docs === junk ? 'documents with no run to show' : 'no reports') +
          ' add nothing; the day in progress is left out as before ' +
          JSON.stringify([r, p.errors]),
      );
      if (docs !== junk) continue;
      await p.evaluate(d => __rt.write('reports/d2026-10-05', d), RP()['reports/d2026-10-05']);
      await until(p, () => document.querySelectorAll('#days-list article.rp-day .rp-run').length === 2, null, 5000);
      ok(
        (await rpRuns(p, '2026-10-05')).length === 2 && p.errors.length === 0,
        'F27 BD15: a refresh writing the day in progress shows its runs in the open tab ' + JSON.stringify(p.errors),
      );
    }
  });

  /* BD16: no digests yet, only runs: the quiet line says no digests, each day with runs gets its card (a finished one
     without "so far") */
  await hcase('BD16', async () => {
    const { p } = await bdOpen({ noDigests: true, docs: RP() });
    await bdShow(p);
    await until(p, () => document.querySelectorAll('#days-list article.rp-day').length === 2, null, 5000);
    const r = await p.evaluate(() => ({
      note: (document.querySelector('#days-list > p.note') || {}).textContent || '',
      days: [...document.querySelectorAll('#days-list article')].map(a => [
        a.dataset.day,
        a.querySelector('.row .note').textContent,
        a.querySelectorAll('.rp-run').length,
      ]),
      empty: document.querySelectorAll('#days-list .empty').length,
    }));
    ok(
      /^No day summaries yet\./.test(r.note) &&
        JSON.stringify(r.days) ===
          JSON.stringify([
            ['2026-10-05', '100 messages so far', 2],
            ['2026-10-04', '100 messages', 2],
          ]) &&
        r.empty === 0 &&
        p.errors.length === 0,
      'F27 BD16: with runs and no digests, the days with runs show them in full ' + JSON.stringify([r, p.errors]),
    );
  });

  /* BD17: at 390 px a run's long bullet with ten numbers wraps, in the day in progress and in an opened list: nothing
     scrolls sideways */
  await hcase('BD17', async () => {
    const long = 'Ana listed ' + 'tentpolesandstakes'.repeat(8) + ' with a long note about the ridge trail and spares';
    const docs = RP();
    docs['reports/d2026-10-05'].runs[1].bullets.push({
      t: long,
      refs: [430, 431, 432, 433, 434, 435, 436, 437, 438, 439],
    });
    docs['reports/d2026-10-04'].runs[0].bullets.push({
      t: long,
      refs: [320, 321, 322, 323, 324, 325, 326, 327, 328, 329],
    });
    const { p } = await bdOpen({ docs }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await bdShow(p);
    await until(p, () => document.querySelector('#days-list details.rp-more'), null, 5000);
    await p.evaluate(() => document.querySelectorAll('#days-list details.rp-more').forEach(d => (d.open = true)));
    await p.waitForTimeout(150);
    const r = await p.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      w: innerWidth,
      right: Math.max(
        ...[...document.querySelectorAll('#days-list article, #days-list .rp-run, #days-list .rp-run li')].map(x =>
          Math.round(x.getBoundingClientRect().right),
        ),
      ),
      runs: document.querySelectorAll('#days-list .rp-run').length,
    }));
    ok(
      r.runs === 4 && r.sw <= r.w && r.right <= r.w && p.errors.length === 0,
      'F27 BD17: at 390 px the runs fit the width, no sideways scroll ' + JSON.stringify(r),
    );
  });
}

/* ---------- F29: day summaries on the By day tab, Copy for chat, and in Ask ----------
   daySummaries/d<YYYY-MM-DD> {day, fromI, toI, n, at, full, final, sections:[{h, bullets:[{t, refs}]}], open:[{t,
   refs}]}, written by catchup.py; the page only reads them. Oct 1-5, 2026, 100 messages a day, the clock on Oct 5 at
   1 PM in Los Angeles, so Oct 5 is the day in progress: it has a summary in progress (and a refresh's run), Oct 4 a
   final one (and two runs), Oct 3 one written while in progress (its final rewrite still to come), Oct 2 one with no
   bullet worth showing (its digest shows instead), Oct 1 only its digest; a document with a bad id is ignored. */
const DS_NOW = Date.UTC(2026, 9, 5, 20, 0);
const DS = () => ({
  'daySummaries/d2026-10-05': {
    day: '2026-10-05',
    fromI: 400,
    toI: 489,
    n: 90,
    at: '2026-10-05T16:04:00Z',
    full: false,
    final: false,
    sections: [
      {
        h: 'Stove sale',
        bullets: [
          { t: 'Ana offered a stove; Ben claimed it', refs: [401, 405] },
          { t: 'Pickup set for Saturday', refs: [410] },
        ],
      },
      { h: 'Trip plans', bullets: [{ t: 'Cy proposed the ridge loop', refs: range(440, 451, i => i) }] },
    ],
    open: [{ t: 'Dee asked about permits', refs: [470] }],
  },
  'daySummaries/d2026-10-04': {
    day: '2026-10-04',
    fromI: 300,
    toI: 399,
    n: 100,
    at: '2026-10-05T08:10:00Z',
    full: true,
    final: true,
    sections: [
      {
        h: 'Tarp <i>deal</i>',
        bullets: [
          { t: 'Dee sold the tarp to <b>Ben</b>', refs: [310] },
          { t: 'Ben paid for it [#312]', refs: [312] },
        ],
      },
    ],
    open: [],
  },
  'daySummaries/d2026-10-03': {
    day: '2026-10-03',
    fromI: 200,
    toI: 290,
    n: 91,
    at: '2026-10-03T23:00:00Z',
    full: false,
    final: false,
    sections: [{ h: 'Gear', bullets: [{ t: 'Cy listed a pack', refs: [205] }] }],
    open: [],
  },
  'daySummaries/d2026-10-02': {
    day: '2026-10-02',
    fromI: 100,
    toI: 199,
    sections: [{ h: 'Empty', bullets: [{ t: '   ', refs: [101] }, { refs: [102] }] }],
    open: [],
  },
  'daySummaries/today': { day: '2026-10-05', sections: [{ h: 'X', bullets: [{ t: 'never shown', refs: [400] }] }] },
  'reports/d2026-10-05': {
    day: '2026-10-05',
    runs: [
      { at: '2026-10-05T16:04:00Z', fromI: 400, toI: 489, n: 90, bullets: [{ t: 'Ana offered a stove', refs: [401] }] },
    ],
  },
  'reports/d2026-10-04': {
    day: '2026-10-04',
    runs: [
      { at: '2026-10-04T23:04:00Z', fromI: 300, toI: 389, n: 90, bullets: [{ t: 'Dee sold the tarp', refs: [310] }] },
      { at: '2026-10-05T07:30:00Z', fromI: 390, toI: 399, n: 10, bullets: [] },
    ],
  },
});
const dsOpen = (docs = DS(), ctx = {}) => bdOpen({ docs }, Object.assign({ clockAt: DS_NOW }, ctx));
const dsCard = (p, day) =>
  p.evaluate(day => {
    const a = document.querySelector('#days-list article[data-day="' + day + '"]');
    if (!a) return null;
    return {
      ds: a.classList.contains('ds-day'),
      state: a.dataset.state || null,
      line: (a.querySelector('.ds-state') || {}).textContent || '',
      badge: (a.querySelector('.ds-state .chip') || {}).textContent || '',
      count: (a.querySelector('.row .note') || {}).textContent || '',
      heads: [...a.querySelectorAll('h4')].map(h => h.textContent),
      lists: [...a.querySelectorAll(':scope > ul')].map(ul => [...ul.children].map(li => li.textContent)),
      copy: !!a.querySelector(':scope > .ds-share > button.ds-copy'),
      last: a.lastElementChild.tagName,
      more: (a.querySelector('details.rp-more > summary') || {}).textContent || '',
      open: !!a.querySelector('details.rp-more[open]'),
      tags: a.querySelectorAll('li b, li i, h4 b, h4 i').length,
    };
  }, day);
const DS5_TEXT =
  'Mon, Oct 5 (so far)\n\nStove sale\n• Ana offered a stove; Ben claimed it\n• Pickup set for Saturday\n\nTrip plans\n• Cy proposed the ridge loop\n\nStill open\n• Dee asked about permits';
const DS4_TEXT = 'Sun, Oct 4\n\nTarp <i>deal</i>\n• Dee sold the tarp to <b>Ben</b>\n• Ben paid for it';
const DS2_TEXT = 'Fri, Oct 2\n\n• Ana sold a stove on day 1\n• Ben asked about permits on day 1';
/* the page's clock stops (it runs on Playwright's clock, clockAt), so "Copied." can't clear before it's read; a case
   moves the clock on itself (p.clock.runFor) */
const dsHold = async p => p.clock.pauseAt((await p.evaluate(() => Date.now())) + 1000);
const dsCopy = async (p, day) => {
  const sel = '#days-list article[data-day="' + day + '"]';
  ok(await tryClick(p, sel + ' button.ds-copy'), 'F29: Copy for chat on ' + day + ' can be clicked');
  await until(p, sel => (document.querySelector(sel + ' .ds-copied') || {}).textContent, sel, 5000);
  return p.evaluate(sel => {
    const ta = document.querySelector(sel + ' .ds-share textarea');
    const st = document.querySelector(sel + ' .ds-copied');
    return {
      status: st.textContent,
      role: st.getAttribute('role'),
      boxes: document.querySelectorAll(sel + ' .ds-share textarea').length,
      text: ta ? ta.value : null,
      focused: !!ta && document.activeElement === ta,
      selected: !!ta && ta.selectionStart === 0 && ta.selectionEnd === ta.value.length,
    };
  }, sel);
};

async function daySums() {
  /* DS1: each day's summary, newest first: its title and count, where it stands (in progress with when it was last
     updated, final, or ended with its final rewrite to come), its topic headings over bullets with every number cited,
     then Still open; markup stays text; Copy for chat on each card; the refresh runs collapsed under it; a day whose
     summary has nothing to show, and one with none, fall back to the older digest; a bad document id is ignored */
  await hcase('DS1', async () => {
    const { p } = await dsOpen();
    await bdShow(p);
    await until(p, () => document.querySelectorAll('#days-list article').length === 5, null, 5000);
    const order = await p.evaluate(() => [...document.querySelectorAll('#days-list article')].map(a => a.dataset.day));
    const [d5, d4, d3, d2, d1] = await Promise.all(
      ['2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02', '2026-10-01'].map(d => dsCard(p, d)),
    );
    ok(
      order.join() === '2026-10-05,2026-10-04,2026-10-03,2026-10-02,2026-10-01',
      'F29 DS1: the days newest first ' + order,
    );
    ok(
      d5.ds &&
        d5.state === 'progress' &&
        d5.line === 'In progress · updated 9:04 AM' &&
        d5.badge === 'In progress' &&
        d5.count === '100 messages so far' &&
        JSON.stringify(d5.heads) === JSON.stringify(['Stove sale', 'Trip plans', 'Still open']) &&
        JSON.stringify(d5.lists) ===
          JSON.stringify([
            ['Ana offered a stove; Ben claimed it #401 #405', 'Pickup set for Saturday #410'],
            ['Cy proposed the ridge loop ' + range(440, 451, i => '#' + i).join(' ')],
            ['Dee asked about permits #470'],
          ]) &&
        d5.copy &&
        d5.more === 'What each refresh found (1)' &&
        !d5.open &&
        d5.last === 'DETAILS',
      'F29 DS1: the day in progress: labelled with when it was updated, its headings, bullets (all 12 numbers) and Still open, Copy for chat, its run collapsed ' +
        JSON.stringify(d5),
    );
    ok(
      d4.ds &&
        d4.state === 'final' &&
        d4.line === 'Final · written Mon 1:10 AM' &&
        d4.count === '100 messages' &&
        JSON.stringify(d4.heads) === JSON.stringify(['Tarp <i>deal</i>']) &&
        JSON.stringify(d4.lists) ===
          JSON.stringify([['Dee sold the tarp to <b>Ben</b> #310', 'Ben paid for it [#312] #312']]) &&
        d4.tags === 0 &&
        d4.copy &&
        d4.more === 'What each refresh found (2)' &&
        d4.last === 'DETAILS',
      'F29 DS1: a final day: labelled final with when it was written (the next day), markup shown as text, no Still open when nothing is ' +
        JSON.stringify(d4),
    );
    ok(
      d3.ds &&
        d3.state === 'ended' &&
        d3.line === 'Day ended · updated 4:00 PM; rewritten as one piece at a refresh that brings new messages',
      'F29 DS1: a day that ended before its final rewrite says so ' + JSON.stringify(d3),
    );
    ok(
      !d2.ds &&
        !d1.ds &&
        d2.lists[0].join(' / ') === 'Ana sold a stove on day 1 #101 #102 / Ben asked about permits on day 1 #105' &&
        d1.lists[0][0] === 'Ana sold a stove on day 0 #1 #2' &&
        d2.copy &&
        d1.copy &&
        !d2.state,
      'F29 DS1: a summary with nothing to show (Oct 2) and a day without one (Oct 1) show their older digest ' +
        JSON.stringify([d2, d1]),
    );
    const r = await p.evaluate(() => ({
      note: (document.querySelector('#days-list > p.note') || {}).textContent || '',
      junk: document.getElementById('days-list').textContent.includes('never shown'),
    }));
    ok(
      r.note ===
        "A refresh keeps each day's summary current and rewrites it once after the day ends. Older days show their short digest: ask Claude to write day summaries for past days." &&
        !r.junk &&
        p.errors.length === 0,
      'F29 DS1: the quiet line, a bad document id ignored, no page errors ' + JSON.stringify([r, p.errors]),
    );
  });

  /* DS2: a number in a summary opens that message in Messages (loading its day when it's before the window), from a
     topic's bullet and from Still open */
  await hcase('DS2', async () => {
    const { p } = await dsOpen();
    await bdShow(p);
    await until(p, () => document.querySelector('#days-list article.ds-day'), null, 5000);
    const opens = async (sel, i) => {
      await bdShow(p);
      await until(p, () => document.querySelector('#days-list article.ds-day'), null, 5000);
      await flashReset(p);
      ok(await tryClick(p, sel), 'F29 DS2: ' + sel + ' can be clicked');
      await until(p, i => document.querySelector('#m' + i + '[data-flashed]'), i, 5000);
      return p.evaluate(i => {
        const n = document.getElementById('m' + i);
        const b = n && n.getBoundingClientRect();
        return (
          location.hash === '#messages' &&
          !!b &&
          b.height > 0 &&
          b.top >= 0 &&
          b.bottom <= innerHeight &&
          n.hasAttribute('data-flashed')
        );
      }, i);
    };
    const a = await opens('#days-list article[data-day="2026-10-05"] li a.cite:has-text("#405")', 405);
    const b = await opens('#days-list article[data-day="2026-10-05"] h4.ds-open + ul a.cite', 470);
    const c = await opens('#days-list article[data-day="2026-10-04"] li a.cite:has-text("#310")', 310);
    ok(
      a && b && c,
      'F29 DS2: #405, #470 (Still open) and #310 (a final day) each open in Messages, on screen ' + [a, b, c],
    );
    ok(p.errors.length === 0, 'F29 DS2: no page errors ' + JSON.stringify(p.errors));
  });

  /* DS3: Copy for chat puts the day on the clipboard as chat-ready plain text: the day as a title ("(so far)" on the
     day in progress), each heading and its bullets, Still open, and no message numbers; a digest copies its bullets.
     "Copied." shows in a status line */
  await hcase('DS3', async () => {
    const { p } = await dsOpen();
    await p.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:9917' });
    await bdShow(p);
    await until(p, () => document.querySelector('#days-list article.ds-day'), null, 5000);
    await dsHold(p);
    const got = {};
    for (const d of ['2026-10-05', '2026-10-04', '2026-10-02']) {
      const st = await dsCopy(p, d);
      got[d] = Object.assign(st, { clip: await p.evaluate(() => navigator.clipboard.readText()) });
    }
    ok(
      got['2026-10-05'].clip === DS5_TEXT &&
        got['2026-10-04'].clip === DS4_TEXT &&
        got['2026-10-02'].clip === DS2_TEXT &&
        Object.values(got).every(x => !/#\d/.test(x.clip)),
      'F29 DS3: the day in progress, a final day and a digest copy as plain text without message numbers ' +
        JSON.stringify(Object.values(got).map(x => x.clip)),
    );
    ok(
      Object.values(got).every(x => x.status === 'Copied.' && x.role === 'status' && x.boxes === 0),
      'F29 DS3: each says "Copied." in a status line, with no text box ' + JSON.stringify(got),
    );
    await p.clock.runFor(5100);
    const after = await p.evaluate(
      () => document.querySelector('#days-list article[data-day="2026-10-02"] .ds-copied').textContent,
    );
    ok(after === '', 'F29 DS3: "Copied." clears 5 s later ("' + after + '")');
    ok(p.errors.length === 0, 'F29 DS3: no page errors ' + JSON.stringify(p.errors));
  });

  /* DS4: where the clipboard is out of reach (the artifact viewer can block it), Copy for chat says so and shows the
     text selected in a box below, to copy by hand; pressing it again doesn't add a second box */
  await hcase('DS4', async () => {
    const { p } = await dsOpen();
    await p.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('blocked by the host')) },
      });
      document.execCommand = () => false;
    });
    await bdShow(p);
    await until(p, () => document.querySelector('#days-list article.ds-day'), null, 5000);
    await dsHold(p);
    const a = await dsCopy(p, '2026-10-04');
    const b = await dsCopy(p, '2026-10-04');
    ok(
      a.status === "Couldn't copy here: select the text below and copy it." &&
        a.text === DS4_TEXT &&
        a.focused &&
        a.selected &&
        a.boxes === 1 &&
        b.boxes === 1 &&
        b.text === DS4_TEXT,
      'F29 DS4: a blocked clipboard: the message and the text selected in one box ' + JSON.stringify([a, b]),
    );
    ok(p.errors.length === 0, 'F29 DS4: no page errors ' + JSON.stringify(p.errors));
  });

  /* DS5: at 390 px a summary with a long unbroken heading and bullet, many numbers, the Copy row and the box a blocked
     clipboard shows: nothing scrolls sideways */
  await hcase('DS5', async () => {
    const docs = DS();
    const long = 'tentpolesandstakes'.repeat(8);
    docs['daySummaries/d2026-10-05'].sections.push({
      h: 'Heading ' + long,
      bullets: [{ t: 'Ana listed ' + long + ' with a long note about the ridge trail', refs: range(450, 480, i => i) }],
    });
    const { p } = await dsOpen(docs, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await p.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('no')) },
      });
      document.execCommand = () => false;
    });
    await bdShow(p);
    await until(p, () => document.querySelector('#days-list article.ds-day'), null, 5000);
    await dsCopy(p, '2026-10-05');
    await p.evaluate(() => document.querySelectorAll('#days-list details.rp-more').forEach(d => (d.open = true)));
    await p.waitForTimeout(150);
    const r = await p.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      w: innerWidth,
      right: Math.max(
        ...[
          ...document.querySelectorAll(
            '#days-list article, #days-list li, #days-list h4, #days-list .ds-share, #days-list textarea',
          ),
        ].map(x => Math.round(x.getBoundingClientRect().right)),
      ),
      box: !!document.querySelector('#days-list .ds-share textarea'),
    }));
    ok(
      r.box && r.sw <= r.w && r.right <= r.w && p.errors.length === 0,
      'F29 DS5: at 390 px the summaries, the Copy row and its box fit the width, no sideways scroll ' +
        JSON.stringify(r),
    );
  });

  /* DS6: dark mode: the state chips use the dark theme's tokens */
  await hcase('DS6', async () => {
    const { p } = await dsOpen(DS(), { colorScheme: 'dark' });
    await bdShow(p);
    await until(p, () => document.querySelector('#days-list article.ds-day'), null, 5000);
    const c = await p.evaluate(() => {
      const chip = d =>
        getComputedStyle(document.querySelector('#days-list article[data-day="' + d + '"] .ds-state .chip'));
      return {
        progress: [chip('2026-10-05').backgroundColor, chip('2026-10-05').color],
        final: [chip('2026-10-04').backgroundColor, chip('2026-10-04').color],
        ended: [chip('2026-10-03').backgroundColor, chip('2026-10-03').color],
      };
    });
    ok(
      c.progress.join() === 'rgb(31, 43, 69),rgb(122, 165, 255)' &&
        c.final.join() === 'rgb(43, 49, 34),rgb(180, 195, 138)' &&
        c.ended.join() === 'rgb(58, 42, 28),rgb(233, 164, 106)',
      'F29 DS6: in dark mode the state chips use the theme tokens ' + JSON.stringify(c),
    );
  });

  /* DS7: a refresh's writes reach the open tab without a reload: today's summary updated (a new topic, a later time),
     a summary for a day that only had a digest replaces it, and today's turning final */
  await hcase('DS7', async () => {
    const { p } = await dsOpen();
    await bdShow(p);
    await until(p, () => document.querySelector('#days-list article.ds-day'), null, 5000);
    await p.evaluate(() => {
      const d = __rt.get('daySummaries/d2026-10-05');
      d.sections.push({ h: 'Lunch', bullets: [{ t: 'Dee brought soup', refs: [495] }] });
      Object.assign(d, { toI: 499, n: 100, at: '2026-10-05T19:04:00Z' });
      __rt.write('daySummaries/d2026-10-05', d);
      __rt.write('daySummaries/d2026-10-02', {
        day: '2026-10-02',
        fromI: 100,
        toI: 199,
        n: 100,
        at: '2026-10-05T19:04:00Z',
        full: true,
        final: true,
        sections: [{ h: 'Backfilled', bullets: [{ t: 'Ben fixed his stove', refs: [150] }] }],
        open: [],
      });
    });
    await until(p, () => /Lunch/.test(document.getElementById('days-list').textContent), null, 5000);
    const [d5, d2] = await Promise.all([dsCard(p, '2026-10-05'), dsCard(p, '2026-10-02')]);
    ok(
      d5.line === 'In progress · updated 12:04 PM' &&
        d5.heads.join() === 'Stove sale,Trip plans,Lunch,Still open' &&
        d2.ds &&
        d2.state === 'final' &&
        d2.lists[0][0] === 'Ben fixed his stove #150',
      'F29 DS7: the update and the backfilled day show in the open tab ' + JSON.stringify([d5, d2]),
    );
    await p.evaluate(() => {
      const d = __rt.get('daySummaries/d2026-10-05');
      __rt.write('daySummaries/d2026-10-05', Object.assign(d, { full: true, final: true, at: '2026-10-06T08:04:00Z' }));
    });
    await until(
      p,
      () => (document.querySelector('#days-list article[data-day="2026-10-05"]') || {}).dataset.state === 'final',
      null,
      5000,
    );
    const f = await dsCard(p, '2026-10-05');
    ok(
      f.line === 'Final · written Tue 1:04 AM' && f.count === '100 messages' && p.errors.length === 0,
      'F29 DS7: today turning final shows as final, without "so far" ' + JSON.stringify([f, p.errors]),
    );
  });

  /* DS8: summaries but no digests, the day in progress without its summary yet: the quiet line names it, and the
     older days without a summary; the day in progress shows its refresh runs in full */
  await hcase('DS8', async () => {
    const docs = DS();
    delete docs['daySummaries/d2026-10-05'];
    delete docs['daySummaries/d2026-10-02'];
    const { msgs, seed } = bdSeed({ noDigests: true, docs });
    const p = await open(seed, PAGE, { clockAt: DS_NOW });
    HP.push(p);
    await until(p, n => S.msgs.length === n && S.threading, msgs.length, 120000);
    await bdShow(p);
    await until(p, () => document.querySelectorAll('#days-list article').length === 3, null, 5000);
    const r = await p.evaluate(() => ({
      note: (document.querySelector('#days-list > p.note') || {}).textContent || '',
      days: [...document.querySelectorAll('#days-list article')].map(a => [a.dataset.day, a.className]),
    }));
    ok(
      r.note ===
        "A refresh keeps each day's summary current and rewrites it once after the day ends. Mon, Oct 5 gets its summary at the next refresh. 2 older days have no summary: ask Claude to write day summaries for past days." &&
        JSON.stringify(r.days) ===
          JSON.stringify([
            ['2026-10-05', 'item dg-day rp-day'],
            ['2026-10-04', 'item dg-day ds-day'],
            ['2026-10-03', 'item dg-day ds-day'],
          ]) &&
        p.errors.length === 0,
      'F29 DS8: ' + JSON.stringify([r, p.errors]),
    );
  });

  /* DS10 (F29 review, finding 6): a summary's state follows the day boundary while the tab stays open: at midnight in
     the chat's time zone the day in progress becomes "Day ended", in words that hold however the next refreshes go */
  await hcase('DS10', async () => {
    const { p } = await dsOpen(DS(), { clockAt: Date.UTC(2026, 9, 6, 6, 58, 30) }); /* 11:58:30 PM on Oct 5 in LA */
    await bdShow(p);
    await until(p, () => document.querySelector('#days-list article.ds-day'), null, 5000);
    const before = await dsCard(p, '2026-10-05');
    await p.clock.runFor(120000); /* past midnight; the page's minute tick runs */
    await until(
      p,
      () => document.querySelector('#days-list article[data-day="2026-10-05"]').dataset.state === 'ended',
      null,
      5000,
    );
    const after = await dsCard(p, '2026-10-05');
    const text = await p.evaluate(() => document.getElementById('days-list').textContent);
    ok(
      before.state === 'progress' &&
        before.count === '100 messages so far' &&
        after.state === 'ended' &&
        after.line === 'Day ended · updated 9:04 AM; rewritten as one piece at a refresh that brings new messages' &&
        after.count === '100 messages' &&
        !/next refresh/.test(text),
      'F29 DS10: the day in progress at 11:58 PM is "Day ended" after midnight without a reload ' +
        JSON.stringify([before.line, after.line]),
    );
    ok(p.errors.length === 0, 'F29 DS10: no page errors ' + JSON.stringify(p.errors));
  });

  /* DS12 (F29 second review, finding 5): a day rewritten after it ended, with a later day stored, is Final only when no
     message of that day was stored after its summary; otherwise its final rewrite is still to come */
  await hcase('DS12', async () => {
    const docs = DS();
    Object.assign(docs['daySummaries/d2026-10-04'], { full: true, final: false, toI: 389, fullToI: 389, n: 90 });
    const { p } = await dsOpen(docs);
    await bdShow(p);
    await until(p, () => document.querySelector('#days-list article.ds-day'), null, 5000);
    const a = await dsCard(p, '2026-10-04');
    await p.evaluate(() => {
      const d = __rt.get('daySummaries/d2026-10-04');
      __rt.write('daySummaries/d2026-10-04', Object.assign(d, { toI: 399, fullToI: 399, n: 100 }));
    });
    await until(
      p,
      () => (document.querySelector('#days-list article[data-day="2026-10-04"]') || {}).dataset.state === 'final',
      null,
      5000,
    );
    const b = await dsCard(p, '2026-10-04');
    ok(
      a.state === 'ended' &&
        a.line === 'Day ended · updated Mon 1:10 AM; rewritten as one piece at a refresh that brings new messages' &&
        b.state === 'final' &&
        b.line === 'Final · written Mon 1:10 AM',
      'F29 DS12: #390–#399 stored after the summary (through #389): not Final; through #399: Final ' +
        JSON.stringify([a.line, b.line]),
    );
  });
}

/* ---------- F29: Ask and Views read the day summaries (older digests where a day has none) ---------- */
/* summary documents for the days of msgs that keep(k, day, ids) picks; make(k, ids) gives {sections, open} */
function hsums(msgs, keep = () => true, make) {
  const by = new Map();
  msgs.forEach(m => (by.has(m.d) ? by.get(m.d).push(m.i) : by.set(m.d, [m.i])));
  const docs = {};
  [...by].forEach(([d, ids], k) => {
    if (!keep(k, d, ids)) return;
    const body = make
      ? make(k, ids)
      : {
          sections: [
            {
              h: 'Stove sale',
              bullets: [
                { t: 'Ana offered a stove on day ' + k, refs: [ids[1], ids[2]] },
                { t: 'Ben claimed it', refs: [ids[5]] },
              ],
            },
            { h: 'Trip', bullets: [{ t: 'Cy proposed the loop', refs: [ids[40]] }] },
          ],
          open: [{ t: 'Dee asked about permits', refs: [ids[70]] }],
        };
    docs['daySummaries/d' + d] = Object.assign(
      {
        day: d,
        fromI: ids[0],
        toI: ids[ids.length - 1],
        n: ids.length,
        at: '2026-10-20T08:00:00Z',
        full: true,
        final: true,
      },
      body,
    );
  });
  return docs;
}
const sumLoaded = (p, n) => until(p, n => S.daySums && S.daySums.size === n, n);
const sumLines = dig => dig.filter(([, , l]) => /\] [\d,]+ messages?\. Summary: /.test(l));

async function askDaySums() {
  /* AD1: Ask's older history: a day line carries the day's summary where it has one for the whole day, else its older
     digest; each point cites only that day's stored messages; "What you have", the note and the saved row count both;
     a view's prompt reads the same lines */
  await hcase('AD1', async () => {
    const msgs = hmsgs(800, { perDay: 134 });
    const docs = Object.assign(
      hdigests(msgs),
      hsums(msgs, k => k !== 1),
    );
    const p = await hopen(
      hseed(msgs, { threads: true, meta: { caughtUpI: 789 }, opts: { promptMax: 16384 }, docs }),
      800,
    );
    await sumLoaded(p, 5);
    await dgLoaded(p, 6);
    const r = await hask(p, 'Who sold a stove?', true);
    const { dig } = parts(r.prompt);
    const sl = sumLines(dig),
      dl = digestLines(dig);
    const span = hdays(msgs);
    ok(
      sl.length > 0 &&
        sl.every(([a, b, l]) => {
          const k = Math.floor(a / 134);
          return (
            k !== 1 &&
            span.get(msgs[a].d)[0] === a &&
            span.get(msgs[a].d)[1] === b &&
            l.endsWith(
              ' messages. Summary: Stove sale: Ana offered a stove on day ' +
                k +
                ' [#' +
                (a + 1) +
                ', #' +
                (a + 2) +
                ']; Ben claimed it [#' +
                (a + 5) +
                '] | Trip: Cy proposed the loop [#' +
                (a + 40) +
                '] | Still open: Dee asked about permits [#' +
                (a + 70) +
                ']',
            ) &&
            citedIn(l.slice(l.indexOf('Summary: '))).every(i => i >= a && i <= b)
          );
        }) &&
        dl.every(([a]) => Math.floor(a / 134) === 1),
      'F29 AD1: ' +
        sl.length +
        ' day lines carry their summary, ' +
        dl.length +
        ' a digest (day 1, which has no summary, only): ' +
        sl.map(x => x[2].slice(0, 70)).join(' / '),
    );
    const n = sl.length + dl.length;
    ok(
      r.prompt.includes(
        " that say Summary: carry that day's summary, and those that say Digest: a few short bullets on it",
      ) &&
        r.note.includes(' Day summaries for ' + n + ' day' + (n === 1 ? '' : 's')) &&
        r.calls.length === 1 &&
        r.calls[0].bytes <= 16384 - HMARGIN,
      'F29 AD1: "What you have" names both kinds; the note counts ' +
        n +
        ' days; one call within the cap ("' +
        r.note +
        '")',
    );
    const v = await p.evaluate(() => viewPrompt('Group everything by topic', 16384, false).text);
    ok(
      /\] [\d,]+ messages\. Summary: Stove sale: /.test(v),
      'F29 AD1: a view built over the whole history reads the same summary lines',
    );
    ok(p.errors.length === 0, 'F29 AD1: no page errors ' + JSON.stringify(p.errors));
  });

  /* AD2: dayLines: a summary's line is the whole day's, headings before their points and Still open last; a point
     keeps only the numbers of its own day that are stored, and one with none left is dropped; a summary that doesn't
     cover the whole day, or a stretch starting mid-day, falls back; a long summary goes in whole points within the
     line's bytes and says how many didn't fit, all of them with room enough, and at least one point at any size */
  await hcase('AD2', async () => {
    const msgs = hmsgs(400, { perDay: 100 });
    const longDay = (k, ids) => ({
      sections: Array.from({ length: 6 }, (_, j) => ({
        h: 'Topic ' + j,
        bullets: Array.from({ length: 10 }, (_, b) => ({
          t: 'Point ' + j + '.' + b + ' about the ridge trail permits and the spare tent poles, '.repeat(3),
          refs: [ids[j * 10 + b]],
        })),
      })),
      open: [],
    });
    const docs = Object.assign(
      hsums(
        msgs,
        k => k !== 1,
        (k, ids) =>
          k === 0
            ? {
                sections: [
                  {
                    h: 'Stove\nsale  ',
                    bullets: [
                      { t: 'Ana offered a stove', refs: [ids[1], 5000, ids[2], ids[2] + 100] },
                      { t: 'Elsewhere only', refs: [250] },
                      { t: 7, refs: [ids[3]] },
                    ],
                  },
                  { h: '', bullets: [{ t: 'No heading', refs: [ids[9]] }] },
                ],
                open: [{ t: 'Dee asked', refs: [ids[70]] }],
              }
            : k === 3
              ? longDay(k, ids)
              : { sections: [{ h: 'Gear', bullets: [{ t: 'Cy listed a pack', refs: [ids[3]] }] }], open: [] },
      ),
      hdigests(msgs, k => k === 1),
    );
    docs['daySummaries/d' + msgs[200].d].fromI = 199; /* claims a day that started a message earlier */
    const p = await hopen(hseed(msgs, { threads: true, docs }), 400);
    await sumLoaded(p, 3);
    await dgLoaded(p, 1);
    const ls = await p.evaluate(() => [
      dayLines(0, 399),
      dayLines(150, 199),
      dayLines(300, 399, 100000),
      dayLines(300, 399, 120),
    ]);
    const [all, mid, big, tiny] = ls;
    ok(
      all.length === 4 &&
        all[0].text ===
          '[#0–#99, Oct 1] 100 messages. Summary: Stove sale: Ana offered a stove [#1, #2] | More: No heading [#9] | Still open: Dee asked [#70]' &&
        all[0].ds &&
        all[0].dg &&
        all[1].text.startsWith('[#100–#199, Oct 2] 100 messages. Digest: ') &&
        !all[1].ds &&
        /Busiest: |Not grouped/.test(all[2].text) &&
        !all[2].dg,
      'F29 AD2: summary lines; a day with only a digest; a summary claiming an earlier start falls back to title-only: ' +
        all.map(l => l.text.slice(0, 80)).join(' / '),
    );
    const n3 = (all[3].text.match(/\[#\d+\]/g) || []).length;
    ok(
      all[3].bytes <= 4096 + 1 &&
        n3 > 5 &&
        all[3].text.endsWith(' (+' + (60 - n3) + ' more points)') &&
        all[3].text.includes('| Topic 1: Point 1.0'),
      'F29 AD2: a long summary in a prompt line: ' +
        n3 +
        ' whole points within 4,096 bytes, then how many more (' +
        all[3].bytes +
        ' bytes)',
    );
    ok(
      (big[0].text.match(/\[#\d+\]/g) || []).length === 60 &&
        !/more point/.test(big[0].text) &&
        mid.length === 1 &&
        !mid[0].dg,
      'F29 AD2: with room, every point; a stretch starting mid-day gets that day title-only',
    );
    ok(
      tiny[0].ds && tiny[0].bytes <= 121 && tiny[0].text.endsWith('(+59 more points)'),
      'F29 AD2: at any size, at least one point, cut to fit: ' + tiny[0].text,
    );
    ok(p.errors.length === 0, 'F29 AD2: no page errors ' + JSON.stringify(p.errors));
  });

  /* AD3: the day_summaries tool gives each day's summary (a long one cut to fit one result, then how many points more),
     and where to continue when the days don't all fit; days without one get their digest or the title-only line */
  await hcase('AD3', async () => {
    const msgs = hmsgs(1200, { perDay: 100 });
    const docs = Object.assign(
      hsums(
        msgs,
        k => k < 2,
        (k, ids) =>
          k === 0
            ? {
                sections: [
                  {
                    h: 'Everything',
                    bullets: ids.map(i => ({
                      t: 'Point ' + i + ' about the ridge trail permits and the spare poles. '.repeat(3),
                      refs: [i],
                    })),
                  },
                ],
                open: [],
              }
            : { sections: [{ h: 'Gear', bullets: [{ t: 'Cy listed a pack', refs: [ids[3]] }] }], open: [] },
      ),
      hdigests(msgs, k => k === 2),
    );
    const plan = [
      {
        calls: [
          { name: 'day_summaries', input: { from: '2026-10-01', to: '2026-10-12' } },
          { name: 'day_summaries', input: { from: '2026-10-02', to: '2026-10-12' } },
          { name: 'day_summaries', input: { from: '2026-10-01', to: '2026-10-01' } },
        ],
      },
      { say: 'Cy listed a pack [#103].' },
    ];
    const p = await asOpen(hseed(msgs, { threads: true, docs, opts: { tools: true } }), plan);
    await sumLoaded(p, 2);
    const r = await hask(p, 'What happened on Oct 1 and 2?');
    const log = (await asTools(p)).filter(x => x.name === 'day_summaries');
    const [one, two, alone] = log.map(x => x.out);
    const b8 = t => new TextEncoder().encode(t).length;
    ok(
      one.days.length === 12 &&
        one.days[0].startsWith('[#0–#99, Oct 1] 100 messages. Summary: Everything: Point 0 ') &&
        /\(\+\d+ more points\)$/.test(one.days[0]) &&
        b8(one.days[0]) + 1 <= 4096 &&
        !one.next,
      'F29 AD3 (third review, finding 2): over several days a long day takes at most 4 KB, so the other days fit too ' +
        JSON.stringify([one.days.length, b8(one.days[0]), one.days[0].slice(-40), one.next]),
    );
    ok(
      alone.days.length === 1 &&
        b8(alone.days[0]) > 4096 &&
        b8(alone.days[0]) + 1 <= 16384 - 512 &&
        /\(\+\d+ more points\)$/.test(alone.days[0]),
      'F29 AD3: asked for alone, the day gets its summary up to a whole result ' + b8(alone.days[0]) + ' bytes',
    );
    ok(
      two.days.length === 11 &&
        two.days[0] === '[#100–#199, Oct 2] 100 messages. Summary: Gear: Cy listed a pack [#103]' &&
        two.days[1].startsWith('[#200–#299, Oct 3] 100 messages. Digest: ') &&
        /Busiest: |Not grouped/.test(two.days[2]) &&
        !two.next,
      'F29 AD3: then a day per line: a summary, a digest, title-only ' + JSON.stringify(two.days.slice(0, 3)),
    );
    ok(
      r.prompt.includes('day_summaries (a line per day, with its summary where it has one)') && p.errors.length === 0,
      'F29 AD3: the SEARCH line names what day_summaries gives; no page errors ' + JSON.stringify(p.errors),
    );
  });

  /* AD4 (F29 review, finding 2): a day whose full summary doesn't fit still carries as much as its digest would: its
     summary cut to the digest's size. Ask's older history never covers fewer days than with the digests alone. */
  await hcase('AD4', async () => {
    const msgs = hmsgs(800, { perDay: 134 });
    const long = (k, ids) => ({
      sections: [
        {
          h: 'Everything',
          bullets: ids
            .slice(0, 60)
            .map(i => ({ t: 'Point ' + i + ' about the ridge trail permits and the tent poles', refs: [i] })),
        },
      ],
      open: [],
    });
    const got = {};
    for (const [label, docs] of [
      ['digests', hdigests(msgs)],
      [
        'both',
        Object.assign(
          hdigests(msgs),
          hsums(msgs, () => true, long),
        ),
      ],
    ]) {
      const p = await hopen(
        hseed(msgs, { threads: true, meta: { caughtUpI: 789 }, opts: { promptMax: 16384 }, docs }),
        800,
      );
      await dgLoaded(p, 6);
      if (label === 'both') await sumLoaded(p, 6);
      const r = await hask(p, 'Anything about permits?', true);
      const { dig } = parts(r.prompt);
      got[label] = {
        carried: dig.filter(([, , l]) => /\] [\d,]+ messages\. (Digest|Summary): /.test(l)).length,
        sums: sumLines(dig).map(([, , l]) => l),
        bytes: r.calls[0].bytes,
      };
      await p.close();
    }
    ok(
      got.digests.carried > 0 &&
        got.both.carried >= got.digests.carried &&
        got.both.sums.length > 0 &&
        got.both.sums.every(l => /\(\+\d+ more points\)$/.test(l)) &&
        got.both.bytes <= 16384 - HMARGIN,
      'F29 AD4: with long summaries, ' +
        got.both.carried +
        ' day lines carry one (the digests alone: ' +
        got.digests.carried +
        '), each cut to fit: ' +
        JSON.stringify(got.both.sums.slice(0, 2)),
    );
  });

  /* AD5 (F29 review, finding 5): the older history builds a day's summary line only when the swap reaches that day,
     once per prompt, not every day's on every round */
  await hcase('AD5', async () => {
    const msgs = hmsgs(800, { perDay: 20 }); /* 40 days, every one summarized, each too long for more than a few */
    const docs = hsums(
      msgs,
      () => true,
      (k, ids) => ({
        sections: [
          {
            h: 'Day ' + k,
            bullets: ids.map(i => ({
              t: 'Point ' + i + ' about the ridge trail permits and the spare tent poles',
              refs: [i],
            })),
          },
        ],
        open: [],
      }),
    );
    const p = await hopen(
      hseed(msgs, { threads: true, meta: { caughtUpI: 789 }, opts: { promptMax: 32768 }, docs }),
      800,
    );
    await sumLoaded(p, 40);
    await p.evaluate(() => {
      window.__dsCalls = 0;
      const f = window.daySumLine;
      window.daySumLine = function () {
        window.__dsCalls++;
        return f.apply(this, arguments);
      };
    });
    const r = await hask(p, 'Anything about permits?', true);
    const { dig } = parts(r.prompt);
    const calls = await p.evaluate(() => window.__dsCalls);
    const dayLs = dig.filter(([, , l]) => /\] [\d,]+ messages?\./.test(l)).length;
    ok(
      sumLines(dig).length > 0 && calls <= 60,
      'F29 AD5: ' + calls + ' summary lines built for ' + dayLs + ' day lines (' + sumLines(dig).length + ' carry one)',
    );
    ok(p.errors.length === 0, 'F29 AD5: no page errors ' + JSON.stringify(p.errors));
  });

  /* AD6 (F29 review, findings 7 and 8): a summary's line never passes its byte cap (its line break counted), and a
     point it shows is a real one, with its numbers; when not even part of one fits there's no line (the digest or the
     title-only line takes its place). dayLines stops at a byte budget and says where to continue. */
  await hcase('AD6', async () => {
    const msgs = hmsgs(300, { perDay: 100 });
    const docs = hsums(
      msgs,
      () => true,
      (k, ids) => ({
        sections: [
          {
            h: 'Topic',
            bullets: ids
              .slice(0, 20)
              .map(i => ({ t: 'Point ' + i + ' about the ridge trail permits and the tent poles', refs: [i] })),
          },
        ],
        open: [],
      }),
    );
    const p = await hopen(hseed(msgs, { threads: true, docs }), 300);
    await sumLoaded(p, 3);
    const res = await p.evaluate(() => {
      const x = dayScan(idxOf(100), idxOf(200) - 1).days[0];
      const out = [];
      for (let cap = 20; cap <= 1200; cap += 3) {
        const l = daySumLine(x, cap);
        out.push({
          cap,
          bytes: l ? l.bytes : null,
          text: l ? l.text : null,
          real: l ? new TextEncoder().encode(l.text).length + 1 : null,
        });
      }
      return out;
    });
    const lines = res.filter(r => r.text);
    const over = res.filter(r => r.bytes != null && (r.bytes > r.cap || r.real !== r.bytes));
    const bad = lines.filter(r => {
      const shown = (r.text.match(/\[#\d+\]/g) || []).length;
      const m = /\(\+(\d+) more points?\)$/.exec(r.text);
      return !shown || shown + (m ? +m[1] : 0) !== 20 || !/Summary: Topic: Point 1/.test(r.text);
    });
    ok(
      lines.length > 300 && res.some(r => !r.text) && !over.length && !bad.length,
      'F29 AD6: at every cap from 20 to 1,200 bytes the line fits it, and every point it shows is real (' +
        lines.length +
        ' lines; over the cap: ' +
        JSON.stringify(over.slice(0, 2)) +
        '; wrong points: ' +
        JSON.stringify(bad.slice(0, 2)) +
        ')',
    );
    const cut = await p.evaluate(() => {
      const ls = dayLines(0, 299, 4096, 3000);
      return { n: ls.length, bytes: ls.reduce((n, l) => n + l.bytes, 0), next: ls.next || null };
    });
    ok(
      cut.n >= 1 && cut.n < 3 && cut.bytes <= 3000 && cut.next === '2026-10-0' + (1 + cut.n),
      'F29 AD6: dayLines within a budget stops there and names the day to continue from ' + JSON.stringify(cut),
    );
    ok(p.errors.length === 0, 'F29 AD6: no page errors ' + JSON.stringify(p.errors));
  });

  /* AD8 (F29 second review, finding 3): a newer day whose line doesn't fit is skipped, and the older days after it
     still take theirs: one large day never leaves the older ones title-only */
  await hcase('AD8', async () => {
    const msgs = hmsgs(800, { perDay: 134 });
    const small = (k, ids) => ({
      sections: [{ h: 'Day ' + k, bullets: [{ t: 'A short note', refs: [ids[3]] }] }],
      open: [],
    });
    const big = (k, ids) => ({
      sections: [
        {
          h: 'Day ' + k,
          bullets: ids
            .slice(0, 80)
            .map(i => ({ t: 'Point ' + i + ' about the ridge trail permits and the tent poles', refs: [i] })),
        },
      ],
      open: [],
    });
    const run = async make => {
      const p = await hopen(
        hseed(msgs, {
          threads: true,
          meta: { caughtUpI: 789 },
          opts: { promptMax: 12288 },
          docs: hsums(msgs, () => true, make),
        }),
        800,
      );
      await sumLoaded(p, 6);
      const r = await hask(p, 'Anything about permits?', true);
      const sl = sumLines(parts(r.prompt).dig).map(([a]) => a);
      await p.close();
      return sl;
    };
    const A = await run(small); /* every day small: the day lines that carry one */
    const D = Math.max(...A);
    const B = await run((k, ids) => (ids[0] === D ? big(k, ids) : small(k, ids)));
    ok(
      A.length >= 2 && !B.includes(D) && JSON.stringify(B) === JSON.stringify(A.filter(a => a !== D)),
      'F29 AD8: the newest day line with a summary made too long to fit (#' +
        D +
        ') is skipped; the older ones keep theirs ' +
        JSON.stringify({ allSmall: A, oneLarge: B }),
    );
  });
}

/* ---------- askErrors: what Ask and Views say when a request to Claude fails (sample.d.ts error codes) ---------- */
const NOT_GRANTED_TEXT =
  "Claude access wasn't allowed on this page, so nothing was sent. To allow it, open this page's Permissions (in the artifact's menu), allow Claude, then reload the page and try again.";
async function askErrors() {
  /* E1: a declined consent (not_granted) says plainly that Claude access wasn't allowed and how to allow it, in Ask and
     in Views; a refusal without a code that talks of consent says the same; other codes get their own words, and an
     unknown one names its code */
  await hcase('E1', async () => {
    const msgs = hmsgs(40, { perDay: 20 });
    const p = await hopen(hseed(msgs, { threads: true, opts: { sampleError: 'not_granted' } }), 40);
    const askNote = async q => {
      await p.evaluate(q => {
        location.hash = '#ask';
        document.getElementById('ask-in').value = q;
        document.getElementById('ask-go').click();
      }, q);
      await until(
        p,
        () => document.getElementById('ask-note').textContent && !document.getElementById('ask-go').disabled,
      );
      return p.evaluate(() => document.getElementById('ask-note').textContent);
    };
    const viewNote = async () => {
      await p.evaluate(() => {
        location.hash = '#views';
        document.getElementById('view-in').value = 'group by person';
        document.getElementById('view-go').click();
      });
      await until(
        p,
        () => document.getElementById('view-note').textContent && !document.getElementById('view-go').disabled,
      );
      return p.evaluate(() => document.getElementById('view-note').textContent);
    };
    const got = { ask: await askNote('Who sold a stove?'), view: await viewNote() };
    got.noCode = {};
    for (const m of [
      'The viewer declined consent',
      'Claude declined to answer',
      'Request denied by upstream',
      'Missing permission for tool',
    ]) {
      await p.evaluate(m => (window.__sampleError = { message: m }), m);
      got.noCode[m] = await askNote('And now? ' + m);
    }
    await p.evaluate(() => (window.__sampleError = 'upstream_error'));
    got.upstream = await askNote('Once more?');
    await p.evaluate(() => (window.__sampleError = 'weird_code'));
    got.unknown = await askNote('Again?');
    ok(
      got.ask === NOT_GRANTED_TEXT &&
        got.view === NOT_GRANTED_TEXT &&
        Object.entries(got.noCode).every(([m, t]) => t === 'Something went wrong (' + m + '). Try again.'),
      'E1: a declined consent (not_granted, as sample.d.ts says), in Ask and in Views; a failure without a code shows its message, whatever it says (third review, finding 5): ' +
        JSON.stringify(got),
    );
    ok(
      got.upstream ===
        "Claude couldn't be reached: a service or connection problem, or Claude isn't allowed on this page yet. If you closed a permission prompt, open this page's Permissions (in the artifact's menu), allow Claude and reload; otherwise try again." &&
        got.unknown === 'Something went wrong (weird_code: refused: weird_code). Try again.',
      'E1: a service error has its own words; an unknown code is named ' + JSON.stringify([got.upstream, got.unknown]),
    );
    ok(p.errors.length === 0, 'E1: no page errors ' + JSON.stringify(p.errors));
  });

  /* E2 (F32 left it behind): the page never mentions an "include older" checkbox for Ask; it always reads the whole
     history */
  await hcase('E2', async () => {
    const p = await hopen(hseed(hmsgs(40, { perDay: 20 }), { threads: true }), 40);
    const text = await p.evaluate(() => document.body.textContent.replace(/\s+/g, ' '));
    ok(
      !/include (them|older)|with its checkbox|messages before the catch-up window/i.test(text) &&
        /Ask Claude and Views always cover the whole history/.test(text),
      'E2: no "include older" checkbox anywhere on the page; the help says Ask and Views cover the whole history',
    );
  });

  /* E3 (F29 third review, finding 4): an automatic view update and a range summary that fail say the same as Ask:
     a declined consent how to allow Claude, a failure without a code its message (saved with the view's autoErr) */
  await hcase('E3', async () => {
    const got = {};
    for (const [label, m] of [
      ['consent', { fail: 'not_granted' }],
      ['no code', { failRaw: { message: 'Missing permission for tool' } }],
    ]) {
      const p = await vopen({ v1: { auto: true } });
      await vjson(p, m);
      await vmore(p, 25);
      await until(p, () => (__rt.get('views/v1') || {}).autoErr, null, 5000);
      const doc = await get(p, 'views/v1');
      await vtoggle(p, 'v1');
      got[label] = { st: (await vstate(p)).st, autoErr: doc.autoErr };
      await p.close();
    }
    ok(
      got.consent.st === NOT_GRANTED_TEXT &&
        got['no code'].st === 'Something went wrong (Missing permission for tool). Try again.' &&
        got['no code'].autoErr.msg === 'Missing permission for tool',
      'E3: an automatic view update that fails: ' + JSON.stringify(got),
    );
    const rs = {};
    for (const [label, reply] of [
      ['consent', { __throw: 'not_granted' }],
      ['no code', { __throwRaw: { message: 'Missing permission for tool' } }],
    ]) {
      const { p } = await lrOpen({ promptMax: 24576 });
      rs[label] = await lrRun(p, [reply, reply], () => {
        const t = (document.querySelector('#v-summary .rangebox .range-st') || {}).textContent || '';
        return /failed|Something went wrong|wasn't allowed/.test(t) && t;
      });
      await p.close();
    }
    ok(
      (rs.consent || '').includes(NOT_GRANTED_TEXT) &&
        (rs['no code'] || '').includes('Something went wrong (Missing permission for tool). Try again.'),
      'E3: a range summary that fails: ' + JSON.stringify(rs),
    );
  });
}

/* ---------- R2: photos stored as they upload ----------
   Each photo is indexed (photos/b<start>) the moment it lands, refresh/lastImport says "uploading" with a heartbeat
   while they store, owed slots are on record (null, and meta/chat.photosOwed), every upload error code has its own
   handling, and asset usage is recorded with each import. Timings are shortened with __mcImportTune. The upload
   timeout stays long (20 s): at 1.5 s, a slow upload in a test that isn't about timeouts timed out on a busy runner
   (P6 and P23, with the suite run three at a time, Nov 22). P13, the test of a hung upload, sets its own. */
const TUNE = { beatMs: 200, leaseMs: 1500, uploadTimeoutMs: 20000, retryMs: 100, rateWaitMs: 300 };
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
  /* the closed tab's lease is held, then lapsed, by setting its end: copying the old tab's real end raced the clock
     on a busy runner (T7) */
  const leaseEnd = ms =>
    p2.evaluate(ms => {
      __rt.leases.get('refresh/importLock').exp = Date.now() + ms;
    }, ms);
  await leaseEnd(60000);
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
  await leaseEnd(-1);
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
  const up6 = await uploads(p);
  const im6 = (await imports(p)).map(v => v.state + (v.stop ? ':' + v.stop : ''));
  ok(
    /Still storing photos from the last paste \(\d\/6\)… keep this tab open/.test(t6) &&
      up6.length === 6 &&
      im6.filter(v => v !== 'uploading').length === 1,
    'P6: a second paste while uploading: toast "Still storing photos from the last paste (n/6)", no second import, ' +
      '6 uploads (' +
      t6 +
      ') ' +
      JSON.stringify({ uploads: up6.length, imports: im6 }),
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
  // P13: an upload that hangs: the page's timeout stops it; the late answer is never indexed. The timeout (3 s) is far
  // longer than an upload takes on a busy runner, and the hang (6 s) far longer than the timeout.
  p = await openR2({}, { tune: Object.assign({}, TUNE, { uploadTimeoutMs: 3000 }) });
  await setUp(p, { script: { 1: { hang: 6000 } } });
  r = await paste(p, capSix());
  const w13 = (await writesTo(p, '^photos/')).length;
  /* the late answer lands (the stand-in logs an upload when it answers); a write it caused would follow at once */
  await until(p, () => __rt.uploads.length === 2, null, 10000);
  await sleep(300);
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
    // B63: the helper's photo base64 arrives in lines of 76; the stored photo is the joined bytes
    const ph18 = B.backfill.photos.find(ph => ph.i === 30);
    const want18 = Buffer.from(ph18.b64.replace(/\s+/g, ''), 'base64').length;
    const up18 = (await uploads(p)).slice(-1)[0];
    ok(
      ph18.b64.includes('\n') && up18 && up18.size === want18,
      'B63: a photo sent in lines stores its joined bytes (' + (up18 && up18.size) + ' of ' + want18 + ')',
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
  /* the retry waits a minute on Playwright's clock, which the case moves on once tab B holds the lease: at a real
     900 ms, a busy runner could retry before the steal */
  p = await open(Object.assign(SEED(), { __opts: { tune: Object.assign({}, TUNE, { retryMs: 60000 }) } }), PAGE, {
    clockAt: Date.now(),
  });
  await setUp(p, { delayMs: 300 });
  await pasteFirst(p, JSON.stringify(cap(range(0, 9), { photos: [PH(2), PH(3)] })));
  await p.evaluate(() => __rt.fails.push({ p: 'photos/b0', op: 'update' }, { p: 'photos/b0', op: 'set' }));
  await until(p, () => __rt.fails.length === 1); /* tab A's first photo write was refused; it waits to retry */
  const otherId = '/_blob/' + 'e'.repeat(32);
  await p.evaluate(id => {
    __rt.fails.length = 0;
    __rt.steal('refresh/importLock', 'tabB', 600000); /* A froze past its lease; tab B took over and indexed #8 */
    const b = __rt.get('photos/b0');
    b.byK['8'] = { 0: id };
    __rt.write('photos/b0', b);
  }, otherId);
  await p.clock.runFor(60050);
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
/* the helper the page shipped with (v1.35.1: a Chrome behind it is flagged even when versions.helper is stale) */
const HV = (SRC.match(/const HELPER_VERSION\s*=\s*"([^"]+)"/) || [])[1] || '0.0';
const vers = o => Object.assign({ page: PV, helper: HV, refresh: LAST, browsers: {} }, o);
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
      links[0].t === 'Update helper' &&
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
          n[0].includes('Chrome “Work Mac” ran helper ' + h + '; the current one is ' + HV) &&
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
  for (const h of [HV, HV + '.0', '9.9'])
    await none(
      withMeta(metaWith({ versions: vers({ browsers: { 'Work Mac': { helper: h, at: iso(DAY) } } }) })),
      'U9: helper ' + h + ' is not behind ' + HV,
    );
  /* v1.35.1: versions.helper is stale (v1.35.0 refreshes wrote 2.1 while shipping 2.3) and every Chrome ran it: the
     page's own helper version still shows the last refresh's Chrome as behind, named, with a direct Update helper link */
  p = await open(
    withMeta(
      metaWith({
        versions: vers({
          helper: '2.1',
          browsers: { 'Work Mac': { helper: '2.1', at: iso(3600000) }, Home: { helper: '2.1', at: iso(2 * DAY) } },
        }),
      }),
    ),
  );
  n = await noticeTexts(p);
  links = await noticeLinks(p);
  ok(
    n &&
      n.length === 1 &&
      n[0].startsWith('At the last refresh, Chrome “Work Mac” ran helper 2.1; the current one is ' + HV + '.') &&
      /Check for updates/.test(n[0]) &&
      links.length === 1 &&
      links[0].t === 'Update helper' &&
      links[0].href === 'https://github.com/roopesh/messenger-catchup/releases/latest/download/helper.user.js',
    'notices: a stale versions.helper (2.1) with every Chrome on 2.1: the newest-used Chrome is told to update to ' +
      HV +
      ', with the Update helper link (' +
      JSON.stringify([n, links]) +
      ')',
  );
  await p.close();
  /* U10: no helper (Claude injected), or a version that can't be read */
  for (const h of ['none', '', 'dev', null])
    await none(
      withMeta(metaWith({ versions: vers({ browsers: { Home: { helper: h, at: iso(DAY) } } }) })),
      'U10: helper ' + JSON.stringify(h) + ' shows nothing',
    );
  const noH = vers({ browsers: { Home: { helper: '1.1', at: iso(DAY) } } });
  delete noH.helper;
  p = await open(withMeta(metaWith({ versions: noH })));
  n = await noticeTexts(p);
  ok(
    n && n.length === 1 && n[0].includes("ran helper 1.1, which can't update itself. The current one is " + HV),
    "U10: versions without helper: the page's own helper version is the current one (" + JSON.stringify(n) + ')',
  );
  await p.close();
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
    m.versions.helper = '9.9';
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
  p = await open(two({ 'Work Mac': { helper: HV, at: iso(3600000) }, Home: { helper: '1.1', at: iso(3 * DAY) } }));
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
    two({ 'Work Mac': { helper: HV, at: iso(3600000) }, Chrome: { helper: '1.1', at: iso(2 * DAY) } }),
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
  p = await open(two({ Chrome: { helper: HV, at: iso(3600000) }, Home: { helper: '1.1', at: iso(2 * DAY) } }));
  n = await noticeTexts(p);
  ok(
    n && n.length === 1 && n[0].startsWith('When Chrome “Home” was last used'),
    'notices U23: the newest entry is "Chrome" on ' +
      HV +
      ': an older Chrome on 1.1 still gets D (' +
      JSON.stringify(n) +
      ')',
  );
  await p.close();
  /* U24: a notice's text is laid out as text, not as a message row's grid (#43: it shared the class .msg) */
  p = await open(withMeta(c2));
  const lay = await p.evaluate(() => {
    const x = document.querySelector('#upd p');
    const t = x && x.querySelector('span');
    return t && { display: getComputedStyle(t).display, w: t.getBoundingClientRect().width, pw: x.clientWidth };
  });
  ok(
    lay && lay.display !== 'grid' && lay.w > lay.pw / 2,
    "notices U24: a notice's text isn't a grid and spans the line (" + JSON.stringify(lay) + ')',
  );
  await p.close();
  /* U25: versions.refresh without the weekday that lastRefresh has (or the other way round) is the same refresh (#43) */
  await none(
    withMeta(metaWith({ lastRefresh: 'Fri ' + LAST, versions: vers({}) })),
    'U25: lastRefresh "Fri ' + LAST + '", versions.refresh "' + LAST + '": nothing',
  );
  await none(
    withMeta(metaWith({ versions: vers({ refresh: 'Fri ' + LAST }) })),
    'U25: versions.refresh with the weekday, lastRefresh without: nothing',
  );
  p = await open(
    withMeta(metaWith({ lastRefresh: 'Fri ' + LAST, versions: vers({ refresh: 'Thu Nov 19, 8:00 PM' }) })),
  );
  n = await noticeTexts(p);
  ok(
    n && n.length === 1 && /older copy of the Messenger Catch-up skill/.test(n[0]),
    'notices U25: a different refresh, both with weekdays, is still C (' + JSON.stringify(n) + ')',
  );
  await p.close();
  /* U26: one run that wrote its start time in versions.refresh and its finish time in lastRefresh (run 599) */
  await none(
    withMeta(metaWith({ lastRefresh: 'Sun Nov 22, 9:16 AM', versions: vers({ refresh: 'Sun Nov 22, 9:09 AM' }) })),
    'U26: versions.refresh 7 minutes before lastRefresh is the same run: nothing',
  );
  await none(
    withMeta(metaWith({ lastRefresh: 'Nov 22, 12:20 AM', versions: vers({ refresh: 'Nov 21, 11:55 PM' }) })),
    'U26: 25 minutes apart across midnight is the same run: nothing',
  );
  p = await open(withMeta(metaWith({ versions: vers({ refresh: 'Nov 20, 8:04 AM' }) })));
  n = await noticeTexts(p);
  ok(
    n && n.length === 1 && /older copy of the Messenger Catch-up skill/.test(n[0]),
    'notices U26: an hour apart is a different refresh: still C (' + JSON.stringify(n) + ')',
  );
  await p.close();
  /* U27 (B54): a scheduled run wrote lastRefresh as an ISO time and versions.refresh as the display string. The page
     reads either form, compares them as times in meta/chat.tz (the same 45 minutes) and shows the ISO one formatted. */
  const B54 = '2026-11-23T17:04:30Z';
  const lastShown = p => p.evaluate(() => document.getElementById('refresh-st').textContent);
  p = await open(withMeta(metaWith({ lastRefresh: B54, versions: vers({ refresh: 'Mon Nov 23, 9:00 AM' }) })));
  n = await noticeTexts(p);
  let st = await lastShown(p);
  ok(
    n && n.length === 0 && !p.errors.length,
    'notices U27: ISO lastRefresh 4 minutes after a display versions.refresh is the same run: nothing (' +
      JSON.stringify(n) +
      ')',
  );
  ok(
    /Last refreshed Mon Nov 23, 9:04 AM\./.test(st) && !/2026-11-23T/.test(st),
    'U27: an ISO lastRefresh shows as "Mon Nov 23, 9:04 AM" in the chat\'s zone (' + JSON.stringify(st) + ')',
  );
  await p.close();
  p = await open(
    withMeta(
      metaWith({ tz: 'America/New_York', lastRefresh: B54, versions: vers({ refresh: 'Mon Nov 23, 12:04 PM' }) }),
    ),
  );
  n = await noticeTexts(p);
  st = await lastShown(p);
  ok(
    n && n.length === 0 && /Last refreshed Mon Nov 23, 12:04 PM\./.test(st),
    'U27: in meta/chat.tz America/New_York the same time is 12:04 PM, and matches (' + JSON.stringify([n, st]) + ')',
  );
  await p.close();
  await none(
    withMeta(metaWith({ lastRefresh: 'Mon Nov 23, 9:10 AM', versions: vers({ refresh: B54 }) })),
    'U27: an ISO versions.refresh 6 minutes before a display lastRefresh: nothing',
  );
  await none(
    withMeta(metaWith({ lastRefresh: B54, versions: vers({ refresh: '2026-11-23T16:40:00Z' }) })),
    'U27: both ISO, 25 minutes apart: nothing',
  );
  p = await open(withMeta(metaWith({ lastRefresh: B54, versions: vers({ refresh: 'Mon Nov 23, 8:00 AM' }) })));
  n = await noticeTexts(p);
  ok(
    n && n.length === 1 && /older copy of the Messenger Catch-up skill/.test(n[0]),
    'notices U27: an ISO lastRefresh over an hour after versions.refresh is a different refresh: still C (' +
      JSON.stringify(n) +
      ')',
  );
  await p.close();
  /* U28 (B55): Claude in Chrome's names ("Browser 1", "Browser 2") can swap on reconnect, so a refresh keys each Chrome by
     the extension's deviceId and stores the name alongside. A notice names the Chrome by that stored name, never by the
     id; an entry from before (keyed by the name, no `name` field) still works, named by its key. */
  const ID1 = '6c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5';
  const ID2 = 'a0b1c2d3-e4f5-4a6b-9c8d-7e6f5a4b3c2d';
  p = await open(
    two({
      [ID1]: { name: 'Browser 1', helper: HV, at: iso(3600000) },
      [ID2]: { name: 'Browser 2', helper: '1.1', at: iso(3 * DAY) },
    }),
  );
  n = await noticeTexts(p);
  ok(
    n &&
      n.length === 1 &&
      n[0].startsWith('When Chrome “Browser 2” was last used for a refresh (') &&
      n[0].includes("it ran helper 1.1, which can't update itself") &&
      !n[0].includes(ID2) &&
      !p.errors.length,
    'notices U28: deviceId keys: the older Chrome on 1.1 is named by its stored name "Browser 2", not its id (' +
      JSON.stringify(n) +
      ')',
  );
  await p.close();
  /* after a swap the same device carries its new name: the last refresh's Chrome (ID2) is now "Browser 1" */
  p = await open(
    two({
      [ID1]: { name: 'Browser 2', helper: HV, at: iso(2 * DAY) },
      [ID2]: { name: 'Browser 1', helper: '1.9', at: iso(3600000) },
    }),
  );
  n = await noticeTexts(p);
  ok(
    n && n.length === 1 && n[0].startsWith('At the last refresh, Chrome “Browser 1” ran helper 1.9;'),
    'notices U28: after a swap, the notice follows the device: its stored name "Browser 1" (' + JSON.stringify(n) + ')',
  );
  await p.close();
  /* an old name-keyed entry next to a new one: both work, each Chrome named, in name order */
  p = await open(
    two({
      Home: { helper: '1.1', at: iso(2 * DAY) },
      [ID1]: { name: 'Browser 1', helper: '1.9', at: iso(3600000) },
    }),
  );
  n = await noticeTexts(p);
  ok(
    n &&
      n.length === 2 &&
      n[0].startsWith('At the last refresh, Chrome “Browser 1” ran helper 1.9;') &&
      n[1].startsWith('When Chrome “Home” was last used for a refresh (') &&
      !n.join(' ').includes(ID1),
    'notices U28: an old name-keyed entry ("Home") and a deviceId entry ("Browser 1") both show, by name (' +
      JSON.stringify(n) +
      ')',
  );
  await p.close();
  await none(
    two({ [ID1]: { name: 'Browser 1', helper: HV, at: iso(3600000) }, Chrome: { helper: '1.1', at: iso(2 * DAY) } }),
    'U28: deviceId entries keep the rule that an older "Chrome" entry (no deviceId) shows nothing',
  );
  /* a missing or blank name falls back to the key, as for an old entry */
  p = await open(two({ Home: { name: '  ', helper: '1.1', at: iso(3600000) } }));
  n = await noticeTexts(p);
  ok(
    n && n.length === 1 && n[0].startsWith('At the last refresh, Chrome “Home” ran helper 1.1'),
    'notices U28: a blank name falls back to the key (' + JSON.stringify(n) + ')',
  );
  await p.close();
  /* Dismiss is kept under the deviceId: the same Chrome renamed stays dismissed; another Chrome under the old name
     (a swap) is a different Chrome and shows */
  p = await open(two({ [ID1]: { name: 'Browser 1', helper: '1.1', at: iso(3600000) } }));
  const dis28 = await dismissNotice(p, '“Browser 1”');
  await p.evaluate(id => {
    const m = __rt.get('meta/chat');
    m.versions.browsers[id].name = 'Browser 2';
    __rt.write('meta/chat', m);
  }, ID1);
  await p.waitForTimeout(300);
  const after28 = await nCount(p);
  await p.evaluate(
    ([id1, id2, at]) => {
      const m = __rt.get('meta/chat');
      m.versions.browsers[id1].at = at;
      m.versions.browsers[id2] = { name: 'Browser 1', helper: '1.1', at: new Date().toISOString() };
      __rt.write('meta/chat', m);
    },
    [ID1, ID2, iso(DAY)],
  );
  await until(p, () => document.querySelectorAll('#upd p').length === 1, null, 3000);
  n = await noticeTexts(p);
  ok(
    dis28 &&
      after28 === 0 &&
      n &&
      n.length === 1 &&
      n[0].startsWith('At the last refresh, Chrome “Browser 1” ran helper 1.1') &&
      !p.errors.length,
    'notices U28: a dismissal follows the deviceId through a rename, and another device now called "Browser 1" still shows (' +
      JSON.stringify([dis28, after28, n]) +
      ')',
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
    got.packs === 'Claimed: Ben Brooks, Cy (2), Dee Diaz (DD), Dee' &&
      JSON.stringify(got.links.map(a => a.t)) === JSON.stringify(['Ben Brooks', 'Cy', 'Dee Diaz (DD)', 'Dee']) &&
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
    ['packs', null, 'Claimed: Ben Brooks, Cy (2), Dee Diaz (DD), Dee'],
  ];
  ok(
    JSON.stringify(sts) === JSON.stringify(wantSts),
    'claims C4: status shows "Pending"/"Sold" linking to statusAt (a plain label without one), claims after statusAt marked, unknown or null status ignored (' +
      JSON.stringify(sts) +
      ')',
  );
  await flashReset(p);
  const stClicked = await tryClick(p, '[data-conv="t2"] .callout.deal .lab a.dstat');
  const stOpen =
    stClicked &&
    (await until(p, () => {
      const d = document.querySelector('[data-conv="t2"] details.thr');
      return d && d.open && location.hash === '#summary' && d.querySelector('.msg[data-i="13"][data-flashed]');
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
  await flashReset(p);
  const c2 = await tryClick(p, '[data-conv="packs"] .callout.deal .claims a:nth-of-type(2)');
  const inCard =
    c2 &&
    (await until(p, () => {
      const d = document.querySelector('[data-conv="packs"] details.thr');
      return d && d.open && location.hash === '#summary' && d.querySelector('.msg[data-i="35"][data-flashed]');
    }));
  await flashReset(p);
  const c4 = await tryClick(p, '[data-conv="packs"] .callout.deal .claims a:nth-of-type(4)');
  const away =
    c4 &&
    !!(await until(
      p,
      () =>
        location.hash === '#messages' &&
        !document.getElementById('v-messages').hidden &&
        document.querySelector('#m54[data-flashed]'),
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
      if (r && r.__throwRaw) throw r.__throwRaw; /* a failure that isn't a SampleError: no code */
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
async function deepOpen(opts = {}, digests = false, ctxOpts) {
  const msgs = hmsgs(800, { perDay: 130 });
  const p = await hopen(
    hseed(msgs, {
      docs: digests ? hdigests(msgs) : {},
      threads: { interleave: true, long: [50, 700] },
      meta: { caughtUpI: 769 },
      opts: Object.assign({ promptMax: 32768, answer: 'From a summary: Ana sold the stove early on [#5].' }, opts),
    }),
    800,
    ctxOpts,
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
    await msgFilter(p, '#5');
    const f = await p.evaluate(() => [
      !!document.getElementById('m5'),
      document.querySelectorAll('#msgs .msg[id]').length,
    ]);
    await msgFilter(p, '');
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
    if (threaded) await convSet(p, '_rest', true);
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

/* ---------- crossReply: Messenger replies across conversations, mid-conversation (F23) ----------
   viewSeed with more links in "Maps" (t5, #39-#49 without #44): #45 is Cy's Messenger reply to Ana's #34 (in "packs"),
   #46 replies to #45 (same conversation), #47 and #48 carry guessed links (i, c) to "gap" and "Stove", #49 replies to
   #53 (in "Snacks"), whose text is markup, #43 replies to Ana's photo #31, and #42 to her long #30. "lend" still starts
   with Dee's reply to #30 (B40). */
const XR_MARKUP = '<img src=x onerror="window.__xss=1"><b>bold</b> & <i>more</i>';
function xrTweak(V) {
  const set = (i, o) => Object.assign(V.msgs[i], o);
  set(45, { f: 'Cy', b: 'Does it fit a bear can?', r: 'Ana', q: 'Can meet Saturday at the trailhead' });
  set(46, { f: 'Ben', b: 'Mine does', r: 'Cy', q: 'Does it fit a bear can?' });
  set(49, { f: 'Dee', b: 'Ha, same', r: 'Cy', q: '<b>bold</b>' });
  set(53, { f: 'Cy', b: XR_MARKUP });
  set(43, { f: 'Ben', b: 'Which color is that?', r: 'Ana', q: '' });
  set(42, { f: 'Cy', b: 'Is the hip belt padded?', r: 'Ana', q: 'Selling my old pack' });
  Object.assign(V.th.links, {
    42: [30, 'r'],
    43: [31, 'rg'],
    45: [34, 'r'],
    46: [45, 'r'],
    47: [36, 'i'],
    48: [37, 'c'],
    49: [53, 'rq'],
  });
}
const xrOf = (p, i) =>
  p.evaluate(i => {
    const r = document.getElementById('m' + i);
    const x = r && r.querySelector(':scope > .xr');
    return x ? { text: x.textContent, title: x.title, html: x.innerHTML, lk: !!r.querySelector('a.lk') } : null;
  }, i);
async function crossReply() {
  let p = await viewPage({ tweak: xrTweak });
  await p.click('#lay-thread');
  for (const c of await convIds(p)) await convSet(p, c, ['t5', 'lend'].includes(c));
  const x45 = await xrOf(p, 45);
  ok(
    x45 &&
      x45.text === '↩ replying to Ana: Can meet Saturday at the trailhead' &&
      /Show #34 in “Pack for sale”/.test(x45.title) &&
      !x45.lk,
    'F23: a Messenger reply mid-conversation to a message in another conversation shows "↩ replying to Ana: <her text>" ' +
      'in place of the reply link (' +
      JSON.stringify(x45) +
      ')',
  );
  const x43 = await xrOf(p, 43);
  const x42 = await xrOf(p, 42);
  ok(
    x43 &&
      x43.text === '↩ replying to Ana: [photo]' &&
      x42 &&
      x42.text.startsWith('↩ replying to Ana: Selling my old pack, $40.') &&
      x42.text.length < 160,
    'F23: a reply to a photo says [photo], and a long parent is cut to its start (' +
      JSON.stringify([x43 && x43.text, x42 && x42.text.length]) +
      ')',
  );
  ok(
    x45 && !(await xrOf(p, 46)) && (await p.$('#m46 a.lk')) && (await p.$eval('#m46', r => !!r.closest('.kids'))),
    'F23: a reply to a message in the same conversation nests as before, with no "replying to" line (while #45 has one)',
  );
  ok(
    x45 && !(await xrOf(p, 47)) && !(await xrOf(p, 48)) && (await p.$('#m47 a.lk.i')) && (await p.$('#m48 a.lk.c')),
    'F23: guessed links across conversations (answers, continues) keep their link and get no "replying to" line',
  );
  const x49 = await xrOf(p, 49);
  ok(
    x49 &&
      x49.text === '↩ replying to Cy: ' + XR_MARKUP &&
      !/<img|<b>bold/.test(x49.html) &&
      (await p.evaluate(() => !window.__xss && !document.querySelector('#m49 img, #m49 .xr i'))),
    "F23: markup in the parent's text shows as literal text (" + JSON.stringify(x49 && x49.text) + ')',
  );
  const lend = await p.evaluate(() => {
    const d = document.querySelector('#msgs details.conv[data-conv="lend"]');
    return {
      ctx: d.querySelectorAll(':scope > .ctx').length,
      xr: d.querySelectorAll('.xr').length,
      lk: !!d.querySelector('#m50 a.lk'),
      ctxText: (d.querySelector(':scope > .ctx .lab') || {}).textContent,
    };
  });
  ok(
    x45 && lend.ctx === 1 && lend.xr === 0 && lend.lk && /Pack for sale/.test(lend.ctxText),
    'F23: B40 unchanged: a conversation that starts with such a reply shows its context block once and no ' +
      '"replying to" line (' +
      JSON.stringify(lend) +
      ')',
  );
  await p.hover('#m45 > .c');
  const xa = await p.evaluate(() => {
    const x = document.querySelector('#m45 > .xr').getBoundingClientRect();
    const a = document.querySelector('#m45 > .c > .acts').getBoundingClientRect();
    return { xb: x.bottom, at: a.top, ah: a.height };
  });
  ok(
    xa.ah > 0 && xa.at >= xa.xb,
    'F23: the hover toolbar sits below the "replying to" line, never over it, whatever its width (' +
      JSON.stringify(xa) +
      ')',
  );
  await p.mouse.move(5, 5);
  await flashReset(p);
  ok(await tryClick(p, '#m45 > .xr'), 'F23: the line on #45 can be clicked');
  ok(
    await until(p, () => {
      const n = document.querySelector('#m34[data-flashed]');
      const r = n && n.getBoundingClientRect();
      return r && r.height && r.top >= 0 && r.bottom <= innerHeight && n.closest('details').dataset.conv === 'packs';
    }),
    'F23: clicking the line shows #34 in its own conversation ("packs", opened)',
  );
  await p.evaluate(() => {
    location.hash = '#summary';
  });
  await p.waitForTimeout(200);
  await p.click('#v-summary article.cv[data-conv="t5"] details.thr > summary');
  await p.waitForTimeout(200);
  ok(
    (await p
      .$eval('#v-summary article.cv[data-conv="t5"] .msg[data-i="45"] > .xr', x => x.textContent)
      .catch(() => '')) === '↩ replying to Ana: Can meet Saturday at the trailhead' &&
      !(await p.$('#v-summary article.cv[data-conv="t5"] .msg[data-i="46"] > .xr')),
    "F23: the summary card's thread shows the same line",
  );
  ok(p.errors.length === 0, 'F23: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();

  /* a phone, dark: one line, cut with an ellipsis, nothing scrolls sideways */
  p = await viewPage({
    tweak: xrTweak,
    ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' },
  });
  await p.click('#lay-thread');
  for (const c of await convIds(p)) await convSet(p, c, c === 't5');
  const ph = await p.evaluate(() => {
    const x = document.querySelector('#m42 > .xr');
    const r = x && x.getBoundingClientRect();
    const row = document.getElementById('m42').getBoundingClientRect();
    const who = document.querySelector('#m42 .who').getBoundingClientRect();
    const cs = x && getComputedStyle(x);
    return {
      line: !!x,
      oneLine: !!r && r.height < 30,
      inRow: !!r && r.left >= row.left && r.right <= row.right + 0.5,
      above: !!r && r.bottom <= who.top + 0.5,
      cut: !!x && x.scrollWidth > x.clientWidth && cs.textOverflow === 'ellipsis',
      color: cs && cs.color,
      scrollW: document.documentElement.scrollWidth,
    };
  });
  ok(
    ph.line && ph.oneLine && ph.inRow && ph.above && ph.cut && ph.scrollW <= 390 && ph.color === 'rgb(163, 166, 152)',
    'F23: at 390 px (dark) the line sits above the bubble on one line, cut with an ellipsis, in the muted color, and ' +
      'nothing scrolls sideways (' +
      JSON.stringify(ph) +
      ')',
  );
  ok(p.errors.length === 0, 'F23 phone: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();

  /* the parent on a day Show older hasn't loaded (F15): the line loads that day and shows it */
  await ocase('F23 older', async () => {
    const n = 6400;
    const { p, msgs } = await oopen(n, lastTwoDays(n));
    await p.click('#lay-thread');
    const t = msgs[n - 10 * 460].i;
    const i = await p.evaluate(t => {
      const T = S.threading;
      const shown = new Set([...document.querySelectorAll('#msgs .msg[id]')].map(x => +x.id.slice(1)));
      const c = T.convs.find(c => c.members.filter(k => shown.has(k)).length >= 3 && !c.members.includes(t));
      const mem = c.members.filter(k => shown.has(k));
      const i = mem[mem.length - 1];
      __rt.write('threading/current', {
        convs: T.convs,
        links: Object.assign({}, T.links, { [i]: [t, 'r'] }),
        to: T.to,
        note: '',
      });
      return i;
    }, t);
    await until(p, i => document.querySelector('#m' + i + ' > .xr'), i, 5000);
    const before = await p.evaluate(t => !!document.getElementById('m' + t), t);
    await flashReset(p);
    await p.evaluate(i => {
      const r = document.getElementById('m' + i);
      r.closest('details').open = true;
      r.querySelector(':scope > .xr').click();
    }, i);
    /* until it's loaded and shown (a fixed 700 ms raced the day's load) */
    const shown = !!(await until(
      p,
      t => {
        const x = document.getElementById('m' + t);
        const r = x && x.getBoundingClientRect();
        return !!x && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && x.hasAttribute('data-flashed');
      },
      t,
      5000,
    ));
    ok(!before && shown, 'F23: the line on #' + i + ' opens #' + t + ' (10 days back, not loaded) by loading its day');
    ok(p.errors.length === 0, 'F23 older: no page errors ' + JSON.stringify(p.errors));
  });
}

/* ---------- saved questions: Remove, Undo and Clear all on the Ask tab (F26) ---------- */
const QA_MARKUP = '<img src=x onerror="window.__x=1"><b>Bold?</b>';
/* The undo delay is long and these pages run on Playwright's clock: a case ends the delay by moving the clock with
   undoPass, never by sleeping past a short real one, which raced the clicks on a busy runner (saved Q3, Nov 22). */
const QA_UNDO = 60000;
const undoPass = (p, ms) => p.clock.runFor(ms);
const QA_DOCS = () => ({
  'qa/q1': { q: 'Who sold a stove?', a: 'Ben did [#1].', at: '2026-11-10T10:00:00.000Z', scope: 'window', toI: 19 },
  'qa/q2': { q: QA_MARKUP, a: 'Ana asked [#2].', at: '2026-11-11T10:00:00.000Z', scope: 'all', toI: 19 },
  'qa/q3': { q: 'What did Cy want?', a: 'A tent [#3].', at: '2026-11-12T10:00:00.000Z', scope: 'window', toI: 19 },
});
/* every case counts the dialogs its page opens; the page must never open one */
let qaDialogs = 0;
async function qopen(ctx, docs = QA_DOCS()) {
  const seed = hseed(hmsgs(20), { meta: { markerMode: null }, docs, opts: { undoMs: QA_UNDO } });
  const p = await open(seed, PAGE, Object.assign({ clockAt: Date.now() }, ctx));
  HP.push(p);
  p.on('dialog', d => {
    qaDialogs++;
    d.dismiss().catch(() => {});
  });
  await until(p, () => S.msgs.length === 20 && document.querySelectorAll('#qa-list .item, #qa-list details').length);
  await p.evaluate(() => (location.hash = '#ask'));
  return p;
}
/* what the list, the undo line and the store show */
const qstate = p =>
  p.evaluate(() => ({
    list: [...document.querySelectorAll('#qa-list .item.qa')].map(c => c.dataset.id),
    stored: Object.keys(__rt.all())
      .filter(k => /^qa\//.test(k))
      .map(k => k.slice(3))
      .sort(),
    undo: document.getElementById('qa-undo') ? document.getElementById('qa-undo').textContent : null,
    clear: !!document.getElementById('qa-clear') && !document.getElementById('qa-clear').hidden,
    dels: __rt.writes.filter(w => w.op === 'delete').map(w => w.p),
    empty: /No questions yet/.test(document.getElementById('qa-list').textContent),
  }));
/* clicks a case depends on wait as long as tryClick and until do (10 s): with 2 s, views V7's click on New view timed
   out with the page suite run three at a time (Nov 22) */
const qclick = (p, id) => p.click('#qa-list .item.qa[data-id="' + id + '"] .qa-rm', { timeout: 10000 });
const qundo = (p, k = 0) => p.click('#qa-undo p:nth-child(' + (k + 1) + ') button', { timeout: 10000 });
async function savedQuestions() {
  /* Q1: Remove (from the keyboard) hides it at once, shows "Removed … · Undo" in a live region, then deletes qa/<id> */
  await hcase('Q1', async () => {
    const p = await qopen();
    const a11y = await p.evaluate(() => {
      const u = document.getElementById('qa-undo');
      const b = document.querySelector('#qa-list .item.qa[data-id="q1"] .qa-rm');
      return {
        live: u.getAttribute('aria-live') === 'polite' && u.getAttribute('role') === 'status',
        label: b.tagName === 'BUTTON' && b.getAttribute('aria-label') === 'Remove the question “Who sold a stove?”',
        text: b.textContent,
      };
    });
    await p.focus('#qa-list .item.qa[data-id="q1"] .qa-rm');
    await p.keyboard.press('Enter');
    await sleep(50);
    const now = await qstate(p);
    const focus = await p.evaluate(() => document.activeElement.textContent);
    ok(
      a11y.live &&
        a11y.label &&
        a11y.text === 'Remove' &&
        now.list.join() === 'q3,q2' &&
        now.stored.join() === 'q1,q2,q3' &&
        now.undo === 'Removed “Who sold a stove?” · Undo' &&
        focus === 'Undo' &&
        !now.dels.length,
      'saved Q1: Remove (a labelled button, pressed with Enter) hides the question at once, keeps qa/q1 for now, says "' +
        now.undo +
        '" in a polite live region and moves focus to Undo (' +
        JSON.stringify({ a11y, now, focus }) +
        ')',
    );
    await undoPass(p, QA_UNDO + 300);
    const later = await qstate(p);
    ok(
      later.list.join() === 'q3,q2' && later.stored.join() === 'q2,q3' && later.dels.join() === 'qa/q1' && !later.undo,
      'saved Q1: after the delay qa/q1 is deleted, the list stays without it and the undo line is gone (' +
        JSON.stringify(later) +
        ')',
    );
  });

  /* Q2: Undo within the delay keeps the question in the list and in qa */
  await hcase('Q2', async () => {
    const p = await qopen();
    await qclick(p, 'q3');
    await sleep(50);
    await p.keyboard.press('Enter'); /* focus is on Undo */
    await sleep(50);
    const back = await qstate(p);
    const focus = await p.evaluate(() => document.activeElement.closest('.item.qa')?.dataset.id ?? null);
    await undoPass(p, QA_UNDO + 300);
    const later = await qstate(p);
    ok(
      back.list.join() === 'q3,q2,q1' &&
        !back.undo &&
        focus === 'q3' &&
        later.list.join() === 'q3,q2,q1' &&
        later.stored.join() === 'q1,q2,q3' &&
        !later.dels.length,
      'saved Q2: Undo (Enter) brings the question back at once, focus on it, and after the delay nothing was deleted (' +
        JSON.stringify({ back, focus, later }) +
        ')',
    );
  });

  /* Q3: several removals in a row each have their own Undo and timer */
  await hcase('Q3', async () => {
    const p = await qopen();
    await qclick(p, 'q1');
    await qclick(p, 'q3');
    await sleep(50);
    const two = await qstate(p);
    await qundo(p, 0); /* q1's line */
    await undoPass(p, QA_UNDO + 300);
    const later = await qstate(p);
    ok(
      two.list.join() === 'q2' &&
        /Removed “Who sold a stove\?” · Undo/.test(two.undo) &&
        /Removed “What did Cy want\?” · Undo/.test(two.undo) &&
        !two.clear &&
        later.list.join() === 'q2,q1' &&
        later.stored.join() === 'q1,q2' &&
        later.dels.join() === 'qa/q3',
      'saved Q3: two removals in a row show two Undo lines; undoing the first keeps q1 and only qa/q3 is deleted; Clear all hides with one question left (' +
        JSON.stringify({ two, later }) +
        ')',
    );
  });

  /* Q4: Clear all (2 or more saved) hides every question with one Undo; Undo restores them all; again deletes them */
  await hcase('Q4', async () => {
    const p = await qopen();
    const label = await p.evaluate(() => document.getElementById('qa-clear').getAttribute('aria-label'));
    const before = await qstate(p);
    await p.click('#qa-clear', { timeout: 10000 });
    await sleep(50);
    const cleared = await qstate(p);
    await qundo(p);
    await undoPass(p, QA_UNDO + 300);
    const undone = await qstate(p);
    await p.click('#qa-clear', { timeout: 10000 });
    await undoPass(p, QA_UNDO + 400);
    const gone = await qstate(p);
    ok(
      before.clear &&
        label === 'Clear all 3 saved questions' &&
        cleared.list.length === 0 &&
        cleared.empty &&
        cleared.undo === 'Removed 3 questions · Undo' &&
        !cleared.clear &&
        cleared.stored.length === 3,
      'saved Q4: Clear all (labelled "' +
        label +
        '") hides all three at once and says "' +
        cleared.undo +
        '" (' +
        JSON.stringify({ before, cleared }) +
        ')',
    );
    ok(
      undone.list.join() === 'q3,q2,q1' &&
        undone.stored.length === 3 &&
        !undone.dels.length &&
        undone.clear &&
        gone.list.length === 0 &&
        gone.stored.length === 0 &&
        gone.dels.slice().sort().join() === 'qa/q1,qa/q2,qa/q3' &&
        !gone.undo,
      'saved Q4: Undo restores all three; Clear all again deletes every qa document after the delay (' +
        JSON.stringify({ undone, gone }) +
        ')',
    );
  });

  /* Q5: a failed delete brings the question back with a short line */
  await hcase('Q5', async () => {
    const p = await qopen();
    await p.evaluate(() => __rt.fails.push({ p: 'qa/q1', op: 'delete' }));
    await qclick(p, 'q1');
    await undoPass(p, QA_UNDO + 300);
    const s = await qstate(p);
    ok(
      s.list.join() === 'q3,q2,q1' &&
        s.stored.join() === 'q1,q2,q3' &&
        s.undo === "Couldn't remove “Who sold a stove?”. It's back in the list.",
      'saved Q5: when the delete fails the question is back in the list with "' +
        s.undo +
        '" (' +
        JSON.stringify(s) +
        ')',
    );
    /* and a Clear all where one delete fails puts back just that one */
    await p.evaluate(() => {
      __rt.fails.push({ p: 'qa/q2', op: 'delete' });
      document.querySelectorAll('#qa-undo p').forEach(x => x.remove());
    });
    await p.click('#qa-clear', { timeout: 10000 });
    await undoPass(p, QA_UNDO + 400);
    const c = await qstate(p);
    ok(
      c.list.join() === 'q2' &&
        c.stored.join() === 'q2' &&
        c.undo === "Couldn't remove 1 of 3 questions. They're back in the list.",
      'saved Q5: a Clear all with one failed delete puts back just that question, saying "' +
        c.undo +
        '" (' +
        JSON.stringify(c) +
        ')',
    );
  });

  /* Q6: markup in a saved question shows as literal text, in the list, the Remove label and the undo line */
  await hcase('Q6', async () => {
    const p = await qopen();
    const shown = await p.evaluate(() => ({
      h3: document.querySelector('#qa-list .item.qa[data-id="q2"] h3').textContent,
      label: document.querySelector('#qa-list .item.qa[data-id="q2"] .qa-rm').getAttribute('aria-label'),
    }));
    await qclick(p, 'q2');
    await sleep(50);
    const s = await qstate(p);
    const ran = await p.evaluate(() => ({
      x: window.__x,
      img: document.querySelectorAll('#qa-list img, #qa-undo img').length,
      b: document.querySelectorAll('#qa-list b, #qa-undo b').length,
    }));
    ok(
      shown.h3.startsWith(QA_MARKUP) &&
        shown.label.startsWith('Remove the question “<img src=x') &&
        s.undo.startsWith('Removed “<img src=x onerror=') &&
        ran.x === undefined &&
        !ran.img &&
        !ran.b,
      'saved Q6: markup in a question shows as literal text in the list, the Remove label and the undo line, and runs nothing (' +
        JSON.stringify({ shown, undo: s.undo, ran }) +
        ')',
    );
  });

  /* Q7: Look deeper on an answer still works after a saved question is removed */
  await hcase('Q7', async () => {
    const { p } = await deepOpen({ undoMs: QA_UNDO }, false, { clockAt: Date.now() });
    await until(p, () => document.querySelectorAll('#qa-list .item.qa').length === 1);
    await p.evaluate(() =>
      __rt.write('qa/z1', {
        q: 'An older question',
        a: 'Old answer [#3].',
        at: '2026-10-01T10:00:00.000Z',
        scope: 'window',
      }),
    );
    await until(p, () => document.querySelectorAll('#qa-list .item.qa').length === 2);
    const kept = await p.evaluate(() => document.querySelector('#qa-list .item.qa').dataset.id);
    await qclick(p, 'z1');
    await undoPass(p, QA_UNDO + 300);
    await scriptJson(p, [{ stretches: [{ from: 100, to: 160, focus: 130, why: 'the stove sale' }] }]);
    const d = await deepPress(p);
    await sleep(200);
    const s = await p.evaluate(() =>
      Object.entries(__rt.all())
        .filter(([k]) => /^qa\//.test(k))
        .map(([k, v]) => k.slice(3) + ':' + v.scope),
    );
    const list = await qstate(p);
    ok(
      d.json === 1 &&
        d.plain === 1 &&
        d.hidden &&
        /^Looked deeper/.test(d.status) &&
        !s.some(x => x.startsWith('z1:')) &&
        s.includes(kept + ':all') &&
        s.some(x => /:deeper$/.test(x)) &&
        list.list.length === 2 &&
        list.list.includes(kept),
      'saved Q7: with a saved question removed, Look deeper on the remaining answer still reads and saves its answer (' +
        JSON.stringify({ status: d.status, s, list: list.list }) +
        ')',
    );
  });

  /* Q8: at 390 px the list, Remove links, Clear all and the undo line fit the width */
  await hcase('Q8', async () => {
    const docs = QA_DOCS();
    docs['qa/q4'] = {
      q: 'A long question about a stove, a tent, a pack and a water filter that goes on and on ' + 'x'.repeat(80),
      a: 'Long answer '.repeat(40),
      at: '2026-11-13T10:00:00.000Z',
      scope: 'window',
    };
    const p = await qopen({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, docs);
    await p.evaluate(() => document.querySelector('#qa-list .item.qa[data-id="q4"] details').setAttribute('open', ''));
    await qclick(p, 'q1');
    await sleep(50);
    const fit = await p.evaluate(() => {
      const r = s => Math.max(0, ...[...document.querySelectorAll(s)].map(x => x.getBoundingClientRect().right));
      return {
        sw: document.documentElement.scrollWidth,
        iw: innerWidth,
        rm: r('#qa-list .qa-rm'),
        clear: r('#qa-clear'),
        undo: r('#qa-undo p'),
        items: r('#qa-list .item.qa'),
        n: document.querySelectorAll('#qa-list .qa-rm').length,
      };
    });
    ok(
      fit.n === 3 && fit.sw <= fit.iw && Math.max(fit.rm, fit.clear, fit.undo, fit.items) <= fit.iw && fit.undo > 0,
      'saved Q8: at 390 px the saved questions, their Remove links, Clear all and the undo line fit, no sideways scroll (' +
        JSON.stringify(fit) +
        ')',
    );
  });

  /* Q10: closing the page (pagehide) during the delay starts every pending delete before its first await, so a Clear
     all of 3 sends 3 deletes before unload; going hidden (a phone may discard a background tab without pagehide)
     flushes too, and a removal never commits twice */
  await hcase('Q10', async () => {
    const p = await qopen();
    await p.click('#qa-clear', { timeout: 10000 });
    await sleep(50);
    const sync = await p.evaluate(() => {
      const n = () => __rt.writes.filter(w => w.op === 'delete').length;
      const before = n();
      dispatchEvent(new Event('pagehide'));
      const now = n();
      return Promise.resolve().then(() => ({ before, now, tick: n() }));
    });
    await undoPass(p, QA_UNDO + 300);
    const s = await qstate(p);
    ok(
      sync.before === 0 &&
        sync.now === 3 &&
        sync.tick === 3 &&
        s.dels.slice().sort().join() === 'qa/q1,qa/q2,qa/q3' &&
        s.stored.length === 0 &&
        !s.undo,
      'saved Q10: pagehide after Clear all of 3 starts all 3 deletes at once, and none again after the delay (' +
        JSON.stringify({ sync, s }) +
        ')',
    );
    const p2 = await qopen();
    await qclick(p2, 'q1');
    await qclick(p2, 'q3');
    await sleep(50);
    const vis = await p2.evaluate(() => {
      const n = () => __rt.writes.filter(w => w.op === 'delete').map(w => w.p);
      const before = n().length;
      document.dispatchEvent(new Event('visibilitychange')); /* still visible: nothing */
      const visible = n().length;
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      const hidden = n().slice().sort();
      dispatchEvent(new Event('pagehide'));
      document.dispatchEvent(new Event('visibilitychange'));
      return { before, visible, hidden, again: n().length };
    });
    await undoPass(p2, QA_UNDO + 300);
    const s2 = await qstate(p2);
    ok(
      vis.before === 0 &&
        vis.visible === 0 &&
        vis.hidden.join() === 'qa/q1,qa/q3' &&
        vis.again === 2 &&
        s2.dels.length === 2 &&
        s2.stored.join() === 'q2' &&
        !s2.undo,
      'saved Q10: going hidden commits both pending removals at once; a later pagehide, hide or the timers delete nothing twice (' +
        JSON.stringify({ vis, s2 }) +
        ')',
    );
  });

  /* Q9: removing, undoing and clearing never opens a dialog, here or in the cases above */
  await hcase('Q9', async () => {
    const p = await qopen();
    await p.evaluate(() => {
      window.__dlg = [];
      ['alert', 'confirm', 'prompt'].forEach(f => (window[f] = () => __dlg.push(f)));
    });
    await qclick(p, 'q1');
    await qundo(p);
    await p.click('#qa-clear', { timeout: 10000 });
    await undoPass(p, QA_UNDO + 400);
    const s = await qstate(p);
    const dlg = await p.evaluate(() => __dlg);
    ok(
      s.stored.length === 0 && s.dels.length === 3 && !dlg.length && qaDialogs === 0,
      'saved Q9: Remove, Undo and Clear all never call alert, confirm or prompt, here or in the cases above (' +
        JSON.stringify({ dlg, qaDialogs, dels: s.dels }) +
        ')',
    );
  });
}

/* ---------- Views: a picker with Rename, Rebuild and Remove, and views that keep themselves up to date (F28) ----------
   Two saved views over 20 stored messages (#0–#19, all on Oct 1): v1 "By person" built Nov 10 and v2 "Products" built
   Nov 12, plus a method idea and a note from Claude. vjson scripts Claude's view replies (a delay, a failure); vmore
   stores newer messages as an import does (the chunk, then meta/chat). The automatic update's waits are shortened with
   __mcViewAutoMs. */
const VW_UNDO = 60000; /* as QA_UNDO: ended with undoPass */
const VW_DOCS = (o = {}) => ({
  'views/v1': Object.assign(
    {
      kind: 'view',
      title: 'By person',
      intro: 'Grouped by who posted.',
      sections: [{ heading: 'Ben', tag: 'open', summary: 'Sells a stove [#1].', refs: [1] }],
      prompt: 'group by person',
      at: '2026-11-10T18:00:00.000Z',
      toI: 19,
      sent: { from: 0, to: 19, sumFrom: null, afterFrom: null },
    },
    o.v1,
  ),
  'views/v2': Object.assign(
    {
      kind: 'view',
      title: 'Products',
      intro: 'Every product mentioned.',
      sections: [{ heading: 'Stove', summary: 'Ben has one [#1].', refs: [1] }],
      prompt: 'only products, with who owns what',
      at: '2026-11-12T18:00:00.000Z',
      toI: 19,
      sent: { from: 5, to: 19, sumFrom: 0, afterFrom: null },
    },
    o.v2,
  ),
  'views/i1': { kind: 'idea', prompt: 'Flag every raffle with its spots left', at: '2026-11-11T10:00:00.000Z' },
  'notes/n1': { title: 'How a refresh works', when: 'Nov 12', at: '2026-11-12T10:00:00.000Z', intro: 'A short note.' },
});
/* every case counts the dialogs its page opens; the page must never open one */
let vwDialogs = 0;
async function vopen(o = {}) {
  const seed = hseed(hmsgs(20), {
    meta: { markerMode: null },
    docs: o.docs || VW_DOCS(o),
    opts: Object.assign({ undoMs: VW_UNDO }, o.opts),
  });
  const p = await open(seed, PAGE, Object.assign({ clockAt: Date.now() }, o.ctx));
  HP.push(p);
  p.on('dialog', d => {
    vwDialogs++;
    d.dismiss().catch(() => {});
  });
  await vready(p);
  return p;
}
async function vready(p) {
  await until(p, () => typeof S !== 'undefined' && S.msgs.length === 20 && S.viewsIn);
  await p.evaluate(() => {
    window.__mcViewAutoMs = 60;
    location.hash = '#views';
  });
  await sleep(80);
}
/* what the list, the open view, the undo line and the store show */
const vstate = p =>
  p.evaluate(() => {
    const q = s => [...document.querySelectorAll(s)];
    const out = document.getElementById('view-out');
    const a = document.activeElement;
    const keys = Object.keys(__rt.all()).filter(k => /^views\//.test(k));
    return {
      list: q('#views-list .vw').map(d => d.dataset.id),
      open: q('#views-list .vw[open]').map(d => d.dataset.id),
      titles: q('#views-list .vw > summary h3').map(h => h.textContent),
      metas: q('#views-list .vw > summary .vw-meta').map(h => h.textContent),
      errs: q('#views-list .vw > summary .vw-err').map(h => h.textContent),
      out: out.textContent,
      outIn: out.closest('.vw') ? out.closest('.vw').dataset.id : null,
      st: q('#views-list .vw-st')
        .map(x => x.textContent)
        .join(' '),
      undo: document.getElementById('vw-undo').textContent,
      stored: keys.map(k => k.slice(6)).sort(),
      toI: Object.fromEntries(keys.map(k => [k.slice(6), __rt.get(k).toI])),
      dels: __rt.writes.filter(w => w.op === 'delete' && /^views\//.test(w.p)).map(w => w.p),
      box: !document.getElementById('view-box').hidden,
      newBtn: !document.getElementById('view-new').hidden,
      calls: __rt.sampleLog.length,
      focus: a && a !== document.body ? a.dataset.f || a.id || a.textContent : null,
    };
  });
const vclick = (p, id, sel) => p.click('#views-list .vw[data-id="' + id + '"] ' + sel, { timeout: 10000 });
const vtoggle = async (p, id) => {
  await vclick(p, id, '> summary');
  await sleep(100);
};
/* Claude's view replies from here on: each waits delay ms, then fails with code fail or answers reply */
const vjson = (p, m) =>
  p.evaluate(async m => {
    const s = await claude.use('sample');
    s.json = async prompt => {
      __rt.samples.push(prompt);
      __rt.sampleLog.push({ bytes: prompt.length, code: m.fail || null });
      await new Promise(r => setTimeout(r, m.delay || 0));
      if (m.fail) throw Object.assign(new Error('scripted ' + m.fail), { code: m.fail });
      if (m.failRaw) throw m.failRaw; /* no code */
      return (
        m.reply || {
          title: 'Rebuilt',
          intro: 'Rebuilt intro.',
          sections: [{ heading: 'Cy', summary: 'Wants a tent [#3].', refs: [3] }],
        }
      );
    };
  }, m);
/* newer messages stored, as an import writes them: the chunk with #20… added, then meta/chat */
const vmore = (p, n) =>
  p.evaluate(
    msgs => {
      __rt.write('chunks/c0000', { start: 0, msgs });
      __rt.write('meta/chat', Object.assign(__rt.get('meta/chat'), { lastI: msgs[msgs.length - 1].i }));
    },
    hmsgs(20).concat(hmsgs(n).slice(20)),
  );
const vtoI = (p, id, n) => until(p, ([id, n]) => (__rt.get('views/' + id) || {}).toI === n, [id, n], 5000);
async function viewsTab() {
  /* V1: a compact list, newest first: title, when built and the span; nothing open; ideas and notes collapsed below */
  await hcase('V1', async () => {
    const p = await vopen();
    const s = await vstate(p);
    const more = await p.evaluate(() => ({
      ideas: document.getElementById('vw-ideas').tagName === 'DETAILS' && !document.getElementById('vw-ideas').open,
      notes: document.getElementById('vw-notes').tagName === 'DETAILS' && !document.getElementById('vw-notes').open,
      last: [...document.getElementById('v-views').children]
        .slice(-2)
        .map(x => x.id)
        .join(),
      ideasTxt: document.getElementById('ideas-list').textContent,
      notesTxt: document.getElementById('notes-list').textContent,
      counts: document.getElementById('ideas-n').textContent + '|' + document.getElementById('notes-n').textContent,
      inList: /raffle|How a refresh/.test(document.getElementById('views-list').textContent),
      h: Math.max(...[...document.querySelectorAll('#views-list .vw')].map(x => x.getBoundingClientRect().height)),
    }));
    ok(
      s.list.join() === 'v2,v1' &&
        !s.open.length &&
        s.titles.join() === 'Products,By person' &&
        /^Built Nov 12(, 2026)?, 10:00 AM · #5–#19 \(Oct 1\)$/.test(s.metas[0]) &&
        /^Built Nov 10(, 2026)?, 10:00 AM · #0–#19 \(Oct 1\)$/.test(s.metas[1]) &&
        !s.out &&
        !s.box &&
        s.newBtn &&
        more.h < 90,
      'views V1: saved views are a compact list, newest first, each a title and "' +
        s.metas[0] +
        '", none open, the build box closed behind New view (' +
        JSON.stringify({ s, h: more.h }) +
        ')',
    );
    ok(
      more.ideas &&
        more.notes &&
        more.last === 'vw-ideas,vw-notes' &&
        /Flag every raffle/.test(more.ideasTxt) &&
        /How a refresh works/.test(more.notesTxt) &&
        more.counts === ' (1)| (1)' &&
        !more.inList,
      'views V1: method ideas and notes from Claude are in their own collapsed sections at the foot of the tab, with counts (' +
        JSON.stringify(more) +
        ')',
    );
    ok(p.errors.length === 0, 'views V1: no page errors ' + JSON.stringify(p.errors));
  });

  /* V2: opening one closes the other; the open one is remembered in this browser after a reload */
  await hcase('V2', async () => {
    const p = await vopen();
    await vtoggle(p, 'v1');
    const a = await vstate(p);
    await vtoggle(p, 'v2');
    const b = await vstate(p);
    await p.reload();
    await vready(p);
    const c = await vstate(p);
    await vtoggle(p, 'v2');
    const d = await vstate(p);
    await p.reload();
    await vready(p);
    const e = await vstate(p);
    ok(
      a.open.join() === 'v1' &&
        a.outIn === 'v1' &&
        /Asked for: group by person/.test(a.out) &&
        /Built from #0–#19 word for word\./.test(a.out) &&
        /Grouped by who posted\./.test(a.out) &&
        /Sells a stove/.test(a.out) &&
        a.focus === 'open:v1',
      'views V2: opening a view shows its content inside its card, focus kept on its title (' + JSON.stringify(a) + ')',
    );
    ok(
      b.open.join() === 'v2' && b.outIn === 'v2' && /Every product mentioned/.test(b.out) && !/Grouped by/.test(b.out),
      'views V2: opening another view closes the first (' + JSON.stringify(b) + ')',
    );
    ok(
      c.open.join() === 'v2' && c.outIn === 'v2' && /Every product mentioned/.test(c.out),
      'views V2: after a reload the same view is open (' + JSON.stringify(c) + ')',
    );
    ok(
      !d.open.length && !d.out && !e.open.length && !e.out,
      'views V2: closing it leaves none open, also after a reload (' + JSON.stringify({ d, e }) + ')',
    );
    ok(p.errors.length === 0, 'views V2: no page errors ' + JSON.stringify(p.errors));
  });

  /* V3: Rename inline: Enter saves views/<id>.title, Escape cancels, a failed write puts the old name back */
  await hcase('V3', async () => {
    const p = await vopen();
    await vtoggle(p, 'v1');
    await vclick(p, 'v1', '[data-f="ren:v1"]');
    await sleep(50);
    const f = await p.evaluate(() => {
      const i = document.activeElement;
      return {
        tag: i.tagName,
        val: i.value,
        sel: i.selectionEnd - i.selectionStart,
        label: i.getAttribute('aria-label'),
      };
    });
    await p.keyboard.type('People and wants');
    await p.keyboard.press('Enter');
    await until(p, () => (__rt.get('views/v1') || {}).title === 'People and wants');
    await sleep(100);
    const a = await vstate(p);
    await vclick(p, 'v1', '[data-f="ren:v1"]');
    await p.keyboard.type('Nope');
    await p.keyboard.press('Escape');
    await sleep(100);
    const b = await vstate(p);
    const bTitle = (await get(p, 'views/v1')).title;
    await p.evaluate(() => __rt.fails.push({ p: 'views/v1', op: 'update' }));
    await vclick(p, 'v1', '[data-f="ren:v1"]');
    await p.keyboard.type('Folks');
    await p.click('#views-list .vw-ren button.secondary', { timeout: 10000 });
    await sleep(200);
    const c = await vstate(p);
    ok(
      f.tag === 'INPUT' &&
        f.val === 'By person' &&
        f.sel === 9 &&
        f.label === 'New name for the view “By person”' &&
        a.titles.join() === 'Products,People and wants' &&
        a.open.join() === 'v1' &&
        a.focus === 'ren:v1',
      'views V3: Rename opens a field holding the name, selected; Enter saves the new name to views/v1 and focus returns to Rename (' +
        JSON.stringify({ f, a }) +
        ')',
    );
    ok(
      b.titles[1] === 'People and wants' && bTitle === 'People and wants' && b.focus === 'ren:v1',
      'views V3: Escape cancels a rename (' + JSON.stringify(b) + ')',
    );
    ok(
      c.titles[1] === 'People and wants' && /Couldn't rename it/.test(c.st),
      'views V3: a rename that fails to save puts the old name back with a short line (' + JSON.stringify(c) + ')',
    );
    ok(p.errors.length === 0, 'views V3: no page errors ' + JSON.stringify(p.errors));
  });

  /* V4: Rebuild runs the same request again and replaces the content (name kept), with progress; a failure keeps it */
  await hcase('V4', async () => {
    const p = await vopen();
    await vjson(p, { delay: 500 });
    await vtoggle(p, 'v1');
    const before = await get(p, 'views/v1');
    await vclick(p, 'v1', '[data-f="reb:v1"]');
    await sleep(120);
    const mid = await vstate(p);
    const dis = await p.evaluate(() => ({
      go: document.getElementById('view-go').disabled,
      reb: document.querySelector('[data-f="reb:v1"]').disabled,
      spin: !!document.querySelector('#views-list .vw-st .spin'),
    }));
    await until(p, () => /Rebuilt intro/.test(document.getElementById('view-out').textContent));
    await sleep(100);
    const after = await vstate(p);
    const doc = await get(p, 'views/v1');
    const prompt = await p.evaluate(() => __rt.samples[__rt.samples.length - 1]);
    ok(
      /Rebuilding… this can take a minute\./.test(mid.st) &&
        dis.spin &&
        dis.go &&
        dis.reb &&
        /rebuilding…/.test(mid.metas[1]) &&
        /Grouped by who posted/.test(mid.out),
      'views V4: while it rebuilds, the view says so with a spinner and every build button waits (' +
        JSON.stringify({ mid, dis }) +
        ')',
    );
    ok(
      doc.intro === 'Rebuilt intro.' &&
        doc.sections[0].heading === 'Cy' &&
        doc.title === 'By person' &&
        doc.prompt === 'group by person' &&
        doc.made === before.at &&
        doc.at > before.at &&
        doc.toI === 19 &&
        doc.kind === 'view' &&
        doc.sent &&
        doc.sent.to === 19 &&
        /group by person/.test(prompt) &&
        after.calls === 1 &&
        /Rebuilt intro/.test(after.out) &&
        !/Grouped by/.test(after.out) &&
        /Built from #\d+–#19 word for word/.test(after.out) &&
        after.open.join() === 'v1' &&
        /^Built at \d/.test(after.metas[1]) &&
        !after.st,
      'views V4: Rebuild sends the saved request again and replaces the content in views/v1, keeping its name (' +
        JSON.stringify({ doc, after }) +
        ')',
    );
    await vjson(p, { fail: 'rate_limited' });
    await vclick(p, 'v1', '[data-f="reb:v1"]');
    await until(p, () => /Too many requests/.test(document.querySelector('#views-list .vw-st').textContent));
    const f = await vstate(p);
    ok(
      /Rebuilt intro/.test(f.out) &&
        (await get(p, 'views/v1')).intro === 'Rebuilt intro.' &&
        /Too many requests right now/.test(f.st),
      'views V4: a failed rebuild keeps the content and says why (' + JSON.stringify(f) + ')',
    );
    ok(p.errors.length === 0, 'views V4: no page errors ' + JSON.stringify(p.errors));
  });

  /* V5: Remove hides it at once with "Removed … · Undo" in a live region; Undo brings it back open; the delete waits */
  await hcase('V5', async () => {
    const p = await vopen();
    await vtoggle(p, 'v1');
    const label = await p.$eval('[data-f="rm:v1"]', b => b.getAttribute('aria-label'));
    await p.focus('[data-f="rm:v1"]');
    await p.keyboard.press('Enter');
    await sleep(60);
    const now = await vstate(p);
    const live = await p.evaluate(() => {
      const u = document.getElementById('vw-undo');
      return u.getAttribute('role') === 'status' && u.getAttribute('aria-live') === 'polite';
    });
    await p.keyboard.press('Enter'); /* focus is on Undo */
    await sleep(60);
    const back = await vstate(p);
    await undoPass(p, VW_UNDO + 200);
    const still = await vstate(p);
    await vclick(p, 'v1', '[data-f="rm:v1"]');
    await undoPass(p, VW_UNDO + 300);
    const later = await vstate(p);
    ok(
      label === 'Remove the view “By person”' &&
        live &&
        now.list.join() === 'v2' &&
        now.stored.join() === 'i1,v1,v2' &&
        now.undo === 'Removed “By person” · Undo' &&
        now.focus === 'Undo' &&
        !now.dels.length &&
        !now.out,
      'views V5: Remove (a labelled button, pressed with Enter) hides the view at once, keeps views/v1 for now and says "' +
        now.undo +
        '" in a polite live region, focus on Undo (' +
        JSON.stringify(now) +
        ')',
    );
    ok(
      back.list.join() === 'v2,v1' &&
        back.open.join() === 'v1' &&
        back.focus === 'open:v1' &&
        !back.undo &&
        still.stored.join() === 'i1,v1,v2' &&
        !still.dels.length,
      'views V5: Undo brings it back open with focus on it, and nothing is deleted after the pause (' +
        JSON.stringify({ back, still }) +
        ')',
    );
    ok(
      later.list.join() === 'v2' && later.stored.join() === 'i1,v2' && later.dels.join() === 'views/v1' && !later.undo,
      'views V5: removed again, views/v1 is deleted after the pause and the undo line goes (' +
        JSON.stringify(later) +
        ')',
    );
    ok(p.errors.length === 0, 'views V5: no page errors ' + JSON.stringify(p.errors));
  });

  /* V6: a failed delete brings the view back with a short line */
  await hcase('V6', async () => {
    const p = await vopen();
    await p.evaluate(() => __rt.fails.push({ p: 'views/v2', op: 'delete' }));
    await vtoggle(p, 'v2');
    await vclick(p, 'v2', '[data-f="rm:v2"]');
    await undoPass(p, VW_UNDO + 300);
    const s = await vstate(p);
    ok(
      s.list.join() === 'v2,v1' &&
        s.stored.includes('v2') &&
        /^Couldn't remove “Products”\. It's back in the list\.$/.test(s.undo),
      'views V6: when the delete fails the view is back in the list with "' + s.undo + '" (' + JSON.stringify(s) + ')',
    );
  });

  /* V7: New view opens the build box; a built view is saved, opened, and the box closes; Cancel; no views: box open */
  await hcase('V7', async () => {
    let p = await vopen();
    await p.click('#view-new', { timeout: 10000 });
    await sleep(60);
    const opened = await vstate(p);
    await p.keyboard.type('group by person');
    await p.click('#view-go', { timeout: 10000 });
    await until(
      p,
      () => !document.getElementById('view-go').disabled && document.querySelectorAll('#views-list .vw').length === 3,
    );
    await sleep(100);
    const s = await vstate(p);
    const id = s.list[0];
    const doc = await get(p, 'views/' + id);
    ok(
      opened.box && !opened.newBtn && opened.focus === 'view-in',
      'views V7: New view opens the build box, focus in it (' + JSON.stringify(opened) + ')',
    );
    ok(
      doc &&
        doc.kind === 'view' &&
        doc.auto === false &&
        doc.title === 'By person' &&
        doc.made === doc.at &&
        doc.toI === 19 &&
        s.open.join() === id &&
        s.outIn === id &&
        /Grouped by who posted/.test(s.out) &&
        /Built from #\d+–#19 word for word/.test(s.out) &&
        !s.box &&
        s.newBtn,
      'views V7: Build view saves the view (auto off), puts it first and open, and the build box closes (' +
        JSON.stringify({ doc, s }) +
        ')',
    );
    await p.click('#view-new', { timeout: 10000 });
    await p.click('#view-cancel', { timeout: 10000 });
    await sleep(60);
    const c = await vstate(p);
    ok(
      !c.box && c.newBtn && c.focus === 'view-new',
      'views V7: Cancel closes the build box (' + JSON.stringify(c) + ')',
    );
    ok(p.errors.length === 0, 'views V7: no page errors ' + JSON.stringify(p.errors));
    p = await vopen({ docs: {} });
    const e = await vstate(p);
    ok(
      e.box && !e.newBtn && !e.list.length && /No views yet/.test(await txt(p, '#views-list')),
      'views V7: with no saved views the build box is open (' + JSON.stringify(e) + ')',
    );
  });

  /* V8: the "Keep up to date" switch saves auto on the view's doc and says what it costs */
  await hcase('V8', async () => {
    const p = await vopen();
    await vtoggle(p, 'v2');
    const sw = await p.evaluate(() => {
      const c = document.querySelector('[data-f="auto:v2"]');
      return {
        role: c.getAttribute('role'),
        checked: c.checked,
        label: c.closest('label').textContent,
        help: document.getElementById(c.getAttribute('aria-describedby')).textContent,
      };
    });
    await vclick(p, 'v2', '[data-f="auto:v2"]');
    await until(p, () => (__rt.get('views/v2') || {}).auto === true);
    await sleep(300);
    const on = await vstate(p);
    await vclick(p, 'v2', '[data-f="auto:v2"]');
    const off = await until(p, () => (__rt.get('views/v2') || {}).auto === false);
    ok(
      sw.role === 'switch' &&
        !sw.checked &&
        sw.label === 'Keep up to date' &&
        /refresh/.test(sw.help) &&
        /claude\.ai usage/.test(sw.help),
      'views V8: each view has a "Keep up to date" switch whose help says when it rebuilds and that it uses claude.ai usage ("' +
        sw.help +
        '")',
    );
    ok(
      /kept up to date/.test(on.metas[0]) && on.calls === 0 && on.focus === 'auto:v2' && off,
      'views V8: switched on it is saved as auto:true (no rebuild: nothing newer), off as auto:false (' +
        JSON.stringify(on) +
        ')',
    );
  });

  /* V9: a view kept up to date waits while a refresh runs, then rebuilds once, saying after which refresh; nothing
     more without a new import; the next import rebuilds it once more */
  await hcase('V9', async () => {
    const p = await vopen({ v1: { auto: true } });
    await vjson(p, {});
    await p.evaluate(() =>
      __rt.write('refresh/status', { state: 'running', startedAt: new Date().toISOString(), step: 'build' }),
    );
    await vmore(p, 25);
    await sleep(600);
    const during = await vstate(p);
    const fin = new Date(Date.now() - 1000).toISOString();
    await p.evaluate(f => __rt.write('refresh/status', { state: 'done', startedAt: f, finishedAt: f, added: 5 }), fin);
    await vtoI(p, 'v1', 24);
    await sleep(150);
    const after = await vstate(p);
    const doc = await get(p, 'views/v1');
    const want = await p.evaluate(
      f => new Date(f).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      fin,
    );
    await sleep(600);
    const again = await vstate(p);
    await p.evaluate(() => __rt.write('meta/chat', Object.assign(__rt.get('meta/chat'), { lastRefresh: 'Later' })));
    await sleep(600);
    const meta = await vstate(p);
    await vmore(p, 30);
    await vtoI(p, 'v1', 29);
    await sleep(150);
    const next = await vstate(p);
    ok(
      during.calls === 0 && during.toI.v1 === 19,
      'views V9: nothing is rebuilt while the refresh that stored the messages runs (' + JSON.stringify(during) + ')',
    );
    ok(
      after.calls === 1 &&
        doc.intro === 'Rebuilt intro.' &&
        doc.title === 'By person' &&
        doc.auto === true &&
        doc.autoAt === doc.at &&
        doc.autoAfter === fin &&
        doc.autoBusy === undefined &&
        doc.sent.to === 24 &&
        after.toI.v2 === 19 &&
        after.metas[1].startsWith('Updated after the ' + want + ' refresh · #') &&
        /kept up to date$/.test(after.metas[1]),
      'views V9: once it has finished, the view rebuilds itself once with the new messages and says "' +
        after.metas[1] +
        '"; the other view is left alone (' +
        JSON.stringify({ doc, after }) +
        ')',
    );
    ok(
      again.calls === 1 && meta.calls === 1,
      'views V9: no second rebuild without a new import, also after meta/chat changes (' +
        JSON.stringify({ again: again.calls, meta: meta.calls }) +
        ')',
    );
    ok(
      next.calls === 2 &&
        next.toI.v1 === 29 &&
        /^Updated at \d{1,2}:\d\d [AP]M with newer messages/.test(next.metas[1]),
      'views V9: the next import rebuilds it once more ("' + next.metas[1] + '")',
    );
    ok(p.errors.length === 0, 'views V9: no page errors ' + JSON.stringify(p.errors));
  });

  /* V10: never while another build runs, nor while the user is typing on the tab (renaming) */
  await hcase('V10', async () => {
    const p = await vopen({ v1: { auto: true } });
    await vjson(p, { delay: 800 });
    await vtoggle(p, 'v2');
    await vclick(p, 'v2', '[data-f="reb:v2"]');
    await sleep(100);
    await vmore(p, 25);
    await sleep(450);
    const mid = await vstate(p);
    await vtoI(p, 'v1', 24);
    await until(p, () => !document.querySelector('#views-list .vw-st .spin'), null, 5000);
    const end = await vstate(p);
    ok(
      mid.calls === 1 && mid.toI.v1 === 19 && end.calls === 2 && end.toI.v1 === 24 && end.toI.v2 === 19,
      'views V10: an import during a Rebuild waits for it, then the view kept up to date rebuilds (' +
        JSON.stringify({ mid, end }) +
        ')',
    );
    await vjson(p, {});
    await vtoggle(p, 'v1');
    await vclick(p, 'v1', '[data-f="ren:v1"]');
    await sleep(50);
    await vmore(p, 30);
    await sleep(600);
    const typing = await vstate(p);
    await p.keyboard.press('Escape');
    await vtoI(p, 'v1', 29);
    const done = await vstate(p);
    ok(
      typing.calls === 2 && typing.toI.v1 === 24 && done.calls === 3,
      'views V10: no automatic rebuild while a rename is open; it runs once the rename ends (' +
        JSON.stringify({ typing: typing.calls, done: done.calls }) +
        ')',
    );
    ok(p.errors.length === 0, 'views V10: no page errors ' + JSON.stringify(p.errors));
  });

  /* V11: a failed automatic rebuild keeps the old content, notes it briefly, and isn't tried again for that import */
  await hcase('V11', async () => {
    const p = await vopen({ v1: { auto: true } });
    await vjson(p, { fail: 'rate_limited' });
    await vmore(p, 25);
    await until(p, () => (__rt.get('views/v1') || {}).autoErr, null, 5000);
    await sleep(600);
    const s = await vstate(p);
    const doc = await get(p, 'views/v1');
    await vtoggle(p, 'v1');
    const o = await vstate(p);
    ok(
      s.calls === 1 &&
        doc.intro === 'Grouped by who posted.' &&
        doc.toI === 19 &&
        doc.autoErr.code === 'rate_limited' &&
        doc.autoErr.toI === 24 &&
        !doc.autoBusy &&
        /^Couldn't update at \d{1,2}:\d\d [AP]M: this is the earlier version\.$/.test(s.errs[0]) &&
        /Grouped by who posted/.test(o.out) &&
        /Too many requests/.test(o.st),
      'views V11: a failed automatic rebuild keeps the content, says "' +
        s.errs[0] +
        '" and isn\'t retried for the same import (' +
        JSON.stringify({ doc, s, st: o.st }) +
        ')',
    );
    ok(p.errors.length === 0, 'views V11: no page errors ' + JSON.stringify(p.errors));
  });

  /* V12: another open copy of the page already updating the view (a fresh autoBusy) is left to it */
  await hcase('V12', async () => {
    const p = await vopen({ v1: { auto: true, autoBusy: { tab: 'other', at: new Date().toISOString() } } });
    await vjson(p, {});
    await vmore(p, 25);
    await sleep(800);
    const s = await vstate(p);
    ok(
      s.calls === 0 && s.toI.v1 === 19,
      'views V12: a view another copy of the page is updating is left to it (' + JSON.stringify(s) + ')',
    );
  });

  /* V13: at 390 px the list, an open view's actions and content, rename, the undo line, the build box and the
     collapsed sections fit the width */
  await hcase('V13', async () => {
    const long = 'A long view name about stoves, tents, packs and water filters that goes on ' + 'x'.repeat(60);
    const p = await vopen({
      ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      v1: {
        title: long,
        auto: true,
        autoAt: '2026-11-10T18:00:00.000Z',
        autoErr: { at: '2026-11-11T18:00:00.000Z', code: 'rate_limited', toI: 19 },
      },
    });
    await vtoggle(p, 'v2');
    await vclick(p, 'v2', '[data-f="rm:v2"]');
    await sleep(60);
    await vtoggle(p, 'v1');
    await p.click('#view-new', { timeout: 10000 });
    const fit = s =>
      p.evaluate(s => {
        document.getElementById('vw-ideas').open = true;
        document.getElementById('vw-notes').open = true;
        const r = s => Math.max(0, ...[...document.querySelectorAll(s)].map(x => x.getBoundingClientRect().right));
        return {
          sw: document.documentElement.scrollWidth,
          iw: innerWidth,
          max: r(s),
          n: document.querySelectorAll(s).length,
        };
      }, s);
    const all =
      '#views-list .vw, #views-list .vw *, #vw-undo p, #vw-undo button, #view-box *, #view-new, .vw-more, .vw-more *';
    const a = await fit(all);
    await vclick(p, 'v1', '[data-f="ren:v1"]');
    await sleep(60);
    const b = await fit('.vw-ren, .vw-ren *');
    ok(
      a.n > 20 && a.sw <= a.iw && a.max <= a.iw && b.n === 4 && b.sw <= b.iw && b.max <= b.iw,
      'views V13: at 390 px the list, the open view with its actions and note, rename, Undo, the build box and the collapsed sections fit, no sideways scroll (' +
        JSON.stringify({ a, b }) +
        ')',
    );
    ok(p.errors.length === 0, 'views V13: no page errors ' + JSON.stringify(p.errors));
  });

  /* V14: none of it opens a dialog */
  ok(vwDialogs === 0, 'views V14: Remove, Undo, Rename and Rebuild never open a dialog (' + vwDialogs + ')');
}

/* ---------- Stats (F31) ----------
   The Stats tab counts everything on the page from the stored messages. 27 messages from the mock cast on four days
   (Sun Nov 1, Thu Nov 12, Thu Nov 19 and today, Fri Nov 20), with the clock at noon on Nov 20 in Los Angeles. Dee posts
   as "Dee", under the nickname "Deedee", and once as "Deedee" without a full name (the page ties it to her), so she
   must count as one person; two Bens are told apart by their full names. Per person over all 27: Ana 9, Ben Brooks 6,
   Dee 5, Cy 3, You 3, Ben Ortiz 1. #5 is a photo, #26 a GIF; #6 has one link and #23 two. Threading has four
   conversations (Nov 1, 12, 19, 20; Ben's #22 today closes the Nov 12 one) and the loose messages; the summary has a
   deal posted Nov 12 and sold Nov 19 (#20), and one posted today and pending (#24).
   Part 2 adds: the summary's tags (Trip, For sale, Gear talk, For sale); claims (Dee #7, You #8 for 2, Dee #25);
   threading links (#6 answers #5, #14 quotes #12, #19 replies to #18, #17 continues #16); questions #5 (first
   answered by #6, 10 min), #9 (by #13, 20 min) and #24 (by #25, 5 min) answered, #1 and #26 open; and "tent" whole
   in #0, #6 (as TENT), #13, #16 (tent-pole), #22 and #24, but not "Tents" (#2) or "contents" (#17). */
const ST_NOW = Date.parse('2026-11-20T20:00:00Z');
function stMsgs() {
  const L = [];
  const add = (d, hm, f, o = {}) => {
    const [h, mi] = hm.split(':').map(Number);
    const wd = DOW[new Date(d + 'T12:00:00Z').getUTCDay()];
    const t = wd + ' ' + (h % 12 || 12) + ':' + String(mi).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM');
    L.push(Object.assign({ i: L.length, t, d, f, b: 'message ' + L.length, m: 'mid.' + L.length }, o));
  };
  const ANA = { fn: 'Ana Alvarez' },
    BEN = { fn: 'Ben Brooks' },
    DEE = { fn: 'Dee Dalton' };
  add('2026-11-01', '9:05', 'Ana', Object.assign({ b: 'Who is up for a tent trip?' }, ANA)); /* 0 */
  add('2026-11-01', '9:10', 'Ana', ANA);
  add('2026-11-01', '9:20', 'Ben', Object.assign({ b: 'Tents are cheap now' }, BEN));
  add('2026-11-01', '14:00', 'Cy');
  add('2026-11-01', '14:05', 'Deedee'); /* 4: no full name */
  add('2026-11-12', '19:30', 'Ana', Object.assign({ b: '', p: 'att5' }, ANA)); /* 5: a photo */
  add(
    '2026-11-12',
    '19:40',
    'Ben',
    Object.assign({ b: 'How much for the TENT?', l: ['https://example.com/tent'] }, BEN),
  );
  add('2026-11-12', '19:45', 'Deedee', DEE);
  add('2026-11-12', '20:15', 'You');
  ['10:00', '10:05', '10:10', '10:15'].forEach(t => add('2026-11-19', t, 'Ana', ANA)); /* 9-12 */
  add('2026-11-19', '10:20', 'Ben', Object.assign({ b: 'Is the tent still around?' }, BEN));
  add('2026-11-19', '10:25', 'Ben', BEN);
  add('2026-11-19', '10:30', 'Dee', DEE); /* 15 */
  add('2026-11-19', '11:00', 'Cy', { b: 'tent-pole question' });
  add('2026-11-19', '11:05', 'Cy', { b: 'The contents arrived' });
  add('2026-11-19', '11:10', 'You');
  add('2026-11-19', '11:20', 'Ben', { fn: 'Ben Ortiz' });
  add('2026-11-19', '15:00', 'Ben', Object.assign({ r: 'Ana' }, BEN)); /* 20: a reply known by name only */
  add('2026-11-19', '15:10', 'Deedee', Object.assign({ r: 'Ana', pi: 12 }, DEE));
  add('2026-11-20', '8:00', 'Ben', Object.assign({ b: 'Tent sold?' }, BEN)); /* 22 */
  add('2026-11-20', '8:30', 'Ana', Object.assign({ l: ['https://example.com/a', 'https://example.com/b'] }, ANA));
  add('2026-11-20', '10:15', 'You', { b: 'My tent is pending' });
  add('2026-11-20', '10:20', 'Dee', Object.assign({ r: 'You', pi: 24 }, DEE));
  add('2026-11-20', '11:00', 'Ana', Object.assign({ b: '' }, ANA)); /* 26: a GIF */
  return L;
}
function stDocs() {
  const ids = (a, b) => range(a, b, i => i);
  const conv = (id, members) => ({ id, title: 'Topic ' + id, members });
  return {
    'threading/current': {
      convs: [
        conv('c1', [0, 1, 2]),
        conv('c2', [5, 6, 7, 8, 22]),
        conv('c3', [21, 20].concat(ids(9, 19))),
        conv('c4', ids(23, 26)),
        conv('loose', [3, 4]),
      ],
      links: { 6: [5, 'i'], 14: [12, 'rq'], 17: [16, 'c'], 19: [18, 'r'] },
      to: 26,
      note: '',
    },
    'summary/current': {
      version: 2,
      convs: [
        { id: 'c4', tag: 'For sale' },
        { id: 'c3', tag: 'Gear talk' },
        { id: 'c2', tag: 'For sale' },
        { id: 'c1', tag: 'Trip' },
      ],
      open: [
        { conv: 'c4', ask: 26, to: 'anyone', note: '' },
        { conv: 'c1', ask: 1, to: 'anyone', note: '' },
      ],
      answered: [
        { conv: 'c4', ask: 24, answer: 'yes', refs: [25] },
        { conv: 'c3', ask: 9, answer: 'yes', refs: [13] },
        { conv: 'c2', ask: 5, answer: 'yes', refs: [7] },
      ],
      deals: [
        {
          conv: 'c2',
          refs: [5, 6],
          tag: 'For sale',
          text: 'Tent, $80',
          status: 'sold',
          statusAt: 20,
          claims: [
            { i: 7, who: 'Deedee' },
            { i: 8, who: 'You', n: 2 },
          ],
        },
        {
          conv: 'c4',
          refs: [23],
          tag: 'For sale',
          text: 'Stove, $40',
          status: 'pending',
          statusAt: 24,
          claims: [{ i: 25, who: 'Dee' }],
        },
      ],
      mentions: [],
      toI: 26,
      generatedAt: 'now',
    },
    'photos/index': { byI: {}, gifs: [26] },
  };
}
async function stOpen(o = {}) {
  const msgs = stMsgs();
  const seed = hseed(msgs, { docs: stDocs(), opts: o.opts });
  const p = await open(seed, PAGE, Object.assign({ clockAt: ST_NOW }, o.ctx));
  HP.push(p);
  await until(p, n => S.msgs.length === n && S.threading && S.summary && S.gifs && S.gifs.size, msgs.length);
  if (o.go !== false) await stGo(p);
  return p;
}
/* open the tab from the nav, as a reader does (the stand-in swallows #hash links, as claude.ai's viewer does) */
async function stGo(p) {
  await p.click('nav a[data-tab="stats"]');
  await until(p, () => document.querySelector('#st-body .st-sec, #st-body .empty'), null, 5000);
}
const stState = p =>
  p.evaluate(() => {
    const q = s => document.querySelector(s);
    const tiles = {};
    document
      .querySelectorAll('#st-body > [data-sec="tiles"] .st-tile, #st-body > [data-sec="p-tiles"] .st-tile')
      .forEach(t => (tiles[t.dataset.k] = t.querySelector('.n').textContent));
    const list = sel =>
      [...document.querySelectorAll(sel + ' .st-top li')].map(li =>
        ['.who', '.c', '.pc'].map(c => li.querySelector(c).textContent).join(' '),
      );
    const bars = c =>
      [...document.querySelectorAll('#st-body .st-chart[data-chart="' + c + '"] g[data-k]')].map(g => +g.dataset.v);
    return {
      tiles,
      span: q('#st-span').textContent,
      reset: !q('#st-reset').hidden,
      secs: [...document.querySelectorAll('#st-body > .st-sec')].filter(s => !s.hidden).map(s => s.dataset.sec),
      top: list('#st-body > [data-sec="top"]'),
      replies: list('#st-body > [data-sec="p-replies"]'),
      volume: bars('volume'),
      hours: bars('hours'),
      person: bars('person'),
      personHours: bars('person-hours'),
      head: (q('#st-body .st-head h3') || {}).textContent || null,
      tf: (q('#v-stats [data-tf][aria-pressed="true"]') || { dataset: {} }).dataset.tf || null,
      title: [...document.querySelectorAll('#st-body > .st-sec:not([hidden]) h3')].map(h => h.textContent),
    };
  });
/* the middle of bar k of a chart, scrolled into view */
const stBar = (p, chart, k) =>
  p.evaluate(
    ([c, k]) => {
      const box = document.querySelector('#st-body .st-chart[data-chart="' + c + '"]');
      box.scrollIntoView({ block: 'center' });
      const r = box.querySelector('g[data-k="' + k + '"] rect.hit').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 };
    },
    [chart, k],
  );
async function stDrag(p, k0, k1) {
  const a = await stBar(p, 'volume', k0),
    b = await stBar(p, 'volume', k1);
  await p.mouse.move(a.x, a.y);
  await p.mouse.down();
  await p.mouse.move(b.x, b.y, { steps: 8 });
  await p.mouse.up();
  await p.waitForTimeout(150);
}
async function stTf(p, tf) {
  await p.click('#v-stats [data-tf="' + tf + '"]');
  await p.waitForTimeout(100);
  return stState(p);
}
const ST_ALL = {
  messages: '27',
  text: '25',
  people: '6',
  photos: '2',
  links: '3',
  hour: '10–11 AM',
  top5: '96%',
  you: '3',
  convs: '4',
  deals: '2',
  sold: '1',
};
const ST_SECS = ['tiles', 'volume', 'top', 'heat', 'convs', 'deals', 'people', 'engage', 'words'];
const ST_TOP = [
  'Ana Alvarez 9 33.3%',
  'Ben Brooks 6 22.2%',
  'Dee Dalton 5 18.5%',
  'Cy 3 11.1%',
  'You 3 11.1%',
  'Ben Ortiz 1 3.7%',
];
const stSame = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function stats() {
  /* ST1: the Stats tab opens from the nav (the host swallows #hash links), alone and marked current; it opens on 30
     days with every tile right; nothing about reactions anywhere */
  await hcase('ST1', async () => {
    const p = await stOpen({ go: false });
    await p.click('nav a[data-tab="stats"]');
    await p.waitForTimeout(200);
    const nav = await p.evaluate(() => ({
      shown: !document.getElementById('v-stats').hidden,
      alone: [...document.querySelectorAll('section.view')].filter(v => !v.hidden).length === 1,
      cur: document.querySelector('nav a[data-tab="stats"]').getAttribute('aria-current'),
      text: document.getElementById('v-stats').textContent,
    }));
    const s = await stState(p);
    ok(
      nav.shown && nav.alone && nav.cur === 'page',
      'F31 ST1: the Stats tab opens from the nav alone and marked current ' + JSON.stringify(nav).slice(0, 120),
    );
    ok(
      s.tf === 'd30' && stSame(s.tiles, ST_ALL) && stSame(s.secs, ST_SECS),
      'F31 ST1: on 30 days the tiles count all 27 messages: text, people, photos and GIFs, links, busiest hour, top 5, yours, conversations, deals ' +
        JSON.stringify(s.tiles),
    );
    ok(
      s.span === 'Oct 22 – Nov 20: 27 messages. History starts Nov 1.',
      'F31 ST1: the span line says the span, the count and where the stored history starts: "' + s.span + '"',
    );
    ok(!/reaction/i.test(nav.text), 'F31 ST1: no reactions anywhere on the tab');
    ok(p.errors.length === 0, 'F31 ST1: no page errors ' + JSON.stringify(p.errors));
  });

  /* ST2: each timeframe counts its own span, with its own bars; the history line only when the span reaches past the
     first stored message; Custom takes From and To days */
  await hcase('ST2', async () => {
    const p = await stOpen();
    const today = await stTf(p, 'today');
    ok(
      stSame(today.tiles, {
        messages: '5',
        text: '4',
        people: '4',
        photos: '1',
        links: '2',
        hour: '8–9 AM',
        top5: '100%',
        you: '1',
        convs: '1',
        deals: '1',
        sold: '0',
      }) &&
        today.volume.length === 24 &&
        today.volume[8] === 2 &&
        today.volume[10] === 2 &&
        today.span === 'Fri, Nov 20: 5 messages.' &&
        today.title.includes('Messages per hour'),
      'F31 ST2: Today counts Nov 20 by the hour (a tie for the busiest hour goes to the earlier) ' +
        JSON.stringify(today),
    );
    const d7 = await stTf(p, 'd7');
    ok(
      stSame(d7.tiles, {
        messages: '18',
        text: '17',
        people: '6',
        photos: '1',
        links: '2',
        hour: '10–11 AM',
        top5: '94%',
        you: '2',
        convs: '2',
        deals: '1',
        sold: '1',
      }) &&
        d7.volume.length === 7 &&
        d7.volume.join() === '0,0,0,0,0,13,5' &&
        d7.span === 'Nov 14 – Nov 20: 18 messages.',
      'F31 ST2: 7 days counts Nov 14-20 by the day, with no history line ' + JSON.stringify(d7),
    );
    const d90 = await stTf(p, 'd90');
    ok(
      stSame(d90.tiles, ST_ALL) &&
        d90.volume.length === 90 &&
        d90.volume.reduce((a, b) => a + b, 0) === 27 &&
        d90.span === 'Aug 23 – Nov 20: 27 messages. History starts Nov 1.',
      'F31 ST2: 90 days: 90 day bars holding all 27, and the history line ' +
        JSON.stringify([d90.span, d90.volume.length]),
    );
    const all = await stTf(p, 'all');
    ok(
      stSame(all.tiles, ST_ALL) &&
        all.volume.length === 20 &&
        all.volume[0] === 5 &&
        all.volume[11] === 4 &&
        all.span === 'Nov 1 – Nov 20: 27 messages. History starts Nov 1.',
      'F31 ST2: All runs from the first stored day through today ' + JSON.stringify([all.span, all.volume]),
    );
    await p.click('#v-stats [data-tf="custom"]');
    await p.waitForTimeout(100);
    const prefill = await p.evaluate(() => [
      document.getElementById('st-custom').hidden,
      document.getElementById('st-from').value,
      document.getElementById('st-to').value,
    ]);
    await p.fill('#st-from', '2026-11-12');
    await p.fill('#st-to', '2026-11-19');
    await p.press('#st-to', 'Enter');
    await p.waitForTimeout(150);
    const cu = await stState(p);
    ok(
      prefill.join() === 'false,2026-11-01,2026-11-20' &&
        cu.tf === 'custom' &&
        cu.tiles.messages === '17' &&
        cu.volume.length === 8 &&
        cu.span === 'Nov 12 – Nov 19: 17 messages.',
      'F31 ST2: Custom starts from the span shown and counts From-To days (' + JSON.stringify([prefill, cu.span]) + ')',
    );
    /* typing a date segment by segment: the box keeps the focus and what's typed, and the range applies after a pause */
    await p.click('#st-from');
    await p.keyboard.press('ArrowLeft');
    await p.keyboard.press('ArrowLeft');
    const box = await p.evaluateHandle(() => document.activeElement);
    await p.keyboard.type('11152026', { delay: 80 });
    const mid = await p.evaluate(
      b => [b.isConnected && document.activeElement === b, b.value, document.getElementById('st-span').textContent],
      box,
    );
    await p.waitForTimeout(1400);
    const typed = await stState(p);
    ok(
      mid[0] && mid[1] === '2026-11-15' && /^Nov 12 – Nov 19/.test(mid[2]) && /^Nov 15 – Nov 19/.test(typed.span),
      'F31 ST2b: typing a From date keeps the box and its focus, and applies after the pause ' +
        JSON.stringify([mid, typed.span]),
    );
    /* a From after the To moves the To to match: the boxes show the range used */
    await p.fill('#st-from', '2026-11-19');
    await p.fill('#st-to', '2026-11-12');
    await p.press('#st-to', 'Enter');
    await p.waitForTimeout(150);
    const back = await p.evaluate(() => [
      document.getElementById('st-from').value,
      document.getElementById('st-to').value,
    ]);
    const backSpan = (await stState(p)).span;
    ok(
      back.join() === '2026-11-12,2026-11-12' && /^Thu, Nov 12: /.test(backSpan),
      'F31 ST2b: a To before the From moves the From to it, and the span says so ' + JSON.stringify([back, backSpan]),
    );
    /* this week runs from Sunday through today (Fri Nov 20); last week is the whole Sunday-to-Saturday week before */
    const wk = await stTf(p, 'wk');
    const lw = await stTf(p, 'lastwk');
    ok(
      wk.volume.length === 6 &&
        /^Nov 15 – Nov 20: /.test(wk.span) &&
        lw.volume.length === 7 &&
        /^Nov 8 – Nov 14: /.test(lw.span),
      'F31 ST2c: This week is Sun Nov 15 – Fri Nov 20, Last week Nov 8 – Nov 14 ' + JSON.stringify([wk.span, lw.span]),
    );
    const d30 = await stTf(p, 'd30');
    ok(
      stSame(d30.tiles, ST_ALL) && d30.volume.length === 30 && d30.volume[28] === 13,
      'F31 ST2: back on 30 days: 30 day bars, Nov 19 holding 13',
    );
    ok(p.errors.length === 0, 'F31 ST2: no page errors ' + JSON.stringify(p.errors));
  });

  /* ST3: the top 10: every message counts, the owner is ranked with everyone, Dee's nickname and full-name messages are
     one person, the two Bens two; a tie goes to who posted first in the chat */
  await hcase('ST3', async () => {
    const p = await stOpen();
    const s = await stState(p);
    ok(
      stSame(s.top, ST_TOP),
      'F31 ST3: the top 10 with counts and shares, Dee Dalton merged across "Dee Dalton", "Deedee" and a message without a full name: ' +
        JSON.stringify(s.top),
    );
  });

  /* ST4: a click on a day bar opens that day: its tiles, its hours split by the day's top four (each hour's own top
     three in the tooltip) and its top 10; Back returns to the timeframe with the chart focused */
  await hcase('ST4', async () => {
    const p = await stOpen();
    const b = await stBar(p, 'volume', 28);
    await p.mouse.click(b.x, b.y);
    await p.waitForTimeout(150);
    const s = await stState(p);
    const day = await p.evaluate(() => {
      const box = document.querySelector('#st-body .st-chart[data-chart="hours"]');
      const segs = k => box.querySelectorAll('g[data-k="' + k + '"] path, g[data-k="' + k + '"] rect:not(.hit)').length;
      return {
        focus: document.activeElement && document.activeElement.textContent,
        legend: [...document.querySelectorAll('#st-body .st-legend li')].map(li => li.textContent),
        seg10: segs(10),
        seg11: segs(11),
        seg9: segs(9),
      };
    });
    ok(
      s.head === 'Thu, Nov 19' &&
        day.focus === 'Thu, Nov 19' &&
        s.span === 'Thu, Nov 19: 13 messages.' &&
        stSame(s.tiles, {
          messages: '13',
          text: '13',
          people: '6',
          photos: '0',
          links: '0',
          hour: '10–11 AM',
          top5: '92%',
          you: '1',
          convs: '1',
          deals: '0',
          sold: '1',
        }),
      'F31 ST4: a click on Nov 19 opens that day, focused, with its own tiles ' + JSON.stringify([s.head, s.tiles]),
    );
    ok(
      s.hours.length === 24 &&
        s.hours[10] === 7 &&
        s.hours[11] === 4 &&
        s.hours[15] === 2 &&
        day.seg10 === 3 &&
        day.seg11 === 2 &&
        day.seg9 === 0 &&
        stSame(day.legend, ['Ana Alvarez', 'Ben Brooks', 'Cy', 'Dee Dalton', 'Everyone else']),
      "F31 ST4: the day by the hour, each bar split by the day's top four and everyone else " +
        JSON.stringify([s.hours, day]),
    );
    const t = await stBar(p, 'hours', 10);
    await p.mouse.move(t.x, t.y);
    await p.waitForTimeout(80);
    const tip = await p.evaluate(() =>
      [...document.querySelectorAll('#st-body .st-chart[data-chart="hours"] .st-tip > *')].map(x => x.textContent),
    );
    const t11 = await stBar(p, 'hours', 11);
    await p.mouse.move(t11.x, t11.y);
    await p.waitForTimeout(80);
    const tip11 = await p.evaluate(() =>
      [...document.querySelectorAll('#st-body .st-chart[data-chart="hours"] .st-tip > *')].map(x => x.textContent),
    );
    ok(
      stSame(tip, ['10–11 AM', '7 messages', 'Ana Alvarez 4', 'Ben Brooks 2', 'Dee Dalton 1']) &&
        stSame(tip11, ['11 AM–12 PM', '4 messages', 'Cy 2', 'You 1', 'Ben Ortiz 1']),
      "F31 ST4: an hour's tooltip names its own top three " + JSON.stringify([tip, tip11]),
    );
    ok(
      stSame(s.top, [
        'Ana Alvarez 4 30.8%',
        'Ben Brooks 3 23.1%',
        'Cy 2 15.4%',
        'Dee Dalton 2 15.4%',
        'You 1 7.7%',
        'Ben Ortiz 1 7.7%',
      ]),
      "F31 ST4: the day's top 10 " + JSON.stringify(s.top),
    );
    await p.click('#st-body .st-back');
    await p.waitForTimeout(150);
    const back = await stState(p);
    const f = await p.evaluate(() => document.activeElement && document.activeElement.dataset.chart);
    ok(
      back.head === null && stSame(back.tiles, ST_ALL) && back.volume.length === 30 && f === 'volume',
      'F31 ST4: Back returns to 30 days with the volume chart focused (' + f + ')',
    );
    ok(p.errors.length === 0, 'F31 ST4: no page errors ' + JSON.stringify(p.errors));
  });

  /* ST5: from the keyboard: the arrow keys step through the bars (a live line reads each), Enter opens the day */
  await hcase('ST5', async () => {
    const p = await stOpen();
    await p.focus('#st-body .st-chart[data-chart="volume"]');
    await p.keyboard.press('End');
    await p.keyboard.press('ArrowLeft');
    const said = await p.evaluate(
      () => document.querySelector('#st-body .st-chart[data-chart="volume"] .sr').textContent,
    );
    await p.keyboard.press('Enter');
    await p.waitForTimeout(150);
    const s = await stState(p);
    ok(
      said === 'Thu, Nov 19, 13 messages' && s.head === 'Thu, Nov 19',
      'F31 ST5: End, Left reads "' + said + '", and Enter opens that day (' + s.head + ')',
    );
  });

  /* ST6: a click on a person opens their chart: their numbers and share, their days, their busiest hours and whom they
     reply to (by the stored parent, or by name when the parent isn't linked) */
  await hcase('ST6', async () => {
    const p = await stOpen();
    await p.click('#st-body .st-top li:nth-child(3) button');
    await p.waitForTimeout(150);
    const s = await stState(p);
    ok(
      s.head === 'Dee Dalton' &&
        stSame(s.tiles, {
          messages: '5',
          share: '18.5%',
          rank: '#3',
          hour: '10–11 AM',
          text: '5',
          photos: '0',
          links: '0',
          replies: '2',
        }) &&
        s.span === 'Dee Dalton, Oct 22 – Nov 20: 5 messages.',
      "F31 ST6: Dee Dalton's chart: 5 messages, 18.5%, #3, busiest 10-11 AM, 2 replies " +
        JSON.stringify([s.head, s.tiles]),
    );
    ok(
      s.person.length === 30 &&
        s.person[10] === 1 &&
        s.person[21] === 1 &&
        s.person[28] === 2 &&
        s.person[29] === 1 &&
        s.personHours[10] === 2 &&
        s.personHours[14] === 1 &&
        stSame(s.replies, ['Ana Alvarez 1 50.0%', 'You 1 50.0%']),
      'F31 ST6: her messages by day and by hour, and whom she replied to ' + JSON.stringify([s.person, s.replies]),
    );
    await p.click('#st-body .st-back');
    await p.waitForTimeout(150);
    const f = await p.evaluate(() => document.activeElement && document.activeElement.closest('li').dataset.pk);
    await p.click('#st-body .st-top li:nth-child(2) button');
    await p.waitForTimeout(150);
    const ben = await stState(p);
    ok(
      f === 'FDee Dalton' &&
        ben.head === 'Ben Brooks' &&
        stSame(ben.replies, ['Ana Alvarez 3 100.0%']) &&
        ben.tiles.replies === '3',
      'F31 ST6: Back focuses her name again; Ben Brooks replied to Ana Alvarez three times: by name only (#20), and by the links threading found (#6 answers her, #14 quotes her) ' +
        JSON.stringify([f, ben.replies]),
    );
    /* from a day, a person's chart covers that day */
    await p.click('#st-body .st-back');
    await p.waitForTimeout(100);
    const b = await stBar(p, 'volume', 28);
    await p.mouse.click(b.x, b.y);
    await p.waitForTimeout(150);
    await p.click('#st-body .st-top li:nth-child(1) button');
    await p.waitForTimeout(150);
    const ana = await stState(p);
    await p.click('#st-body .st-back');
    await p.waitForTimeout(150);
    const up = await stState(p);
    ok(
      ana.head === 'Ana Alvarez' &&
        ana.tiles.messages === '4' &&
        ana.personHours[10] === 4 &&
        ana.person.length === 24 &&
        up.head === 'Thu, Nov 19',
      "F31 ST6: from Nov 19, Ana Alvarez's chart covers that day by the hour, and Back returns to the day " +
        JSON.stringify([ana.tiles, up.head]),
    );
    ok(p.errors.length === 0, 'F31 ST6: no page errors ' + JSON.stringify(p.errors));
  });

  /* ST7: dragging across the bars zooms in: the tiles, the top 10 and the heatmap follow; a span of two days shows
     hours; a finger drags too; Reset zoom restores the timeframe */
  await hcase('ST7', async () => {
    const p = await stOpen();
    await stDrag(p, 21, 29);
    const z = await stState(p);
    const heat = await p.evaluate(() => {
      const r = document.querySelector('#st-body .st-chart[data-chart="heat"] rect[data-d="5"][data-h="11"]');
      return r && r.getAttribute('fill');
    });
    ok(
      z.reset &&
        z.volume.length === 9 &&
        z.tiles.messages === '22' &&
        z.span === 'Nov 12 – Nov 20 (zoomed in from Oct 22 – Nov 20): 22 messages. History starts Nov 1.' &&
        stSame(z.top, [
          'Ana Alvarez 7 31.8%',
          'Ben Brooks 5 22.7%',
          'Dee Dalton 4 18.2%',
          'You 3 13.6%',
          'Cy 2 9.1%',
          'Ben Ortiz 1 4.5%',
        ]) &&
        heat === 'var(--c1)',
      'F31 ST7: a drag from Nov 12 to Nov 20 zooms to those 9 days and every number follows ' + JSON.stringify(z),
    );
    await stDrag(p, 7, 8);
    const h = await stState(p);
    ok(
      h.volume.length === 48 &&
        h.tiles.messages === '18' &&
        h.title.includes('Messages per hour') &&
        h.span.startsWith('Nov 19 – Nov 20 (zoomed in from Oct 22 – Nov 20): 18 messages.'),
      'F31 ST7: zooming again to Nov 19-20 shows 48 hours ' + JSON.stringify([h.span, h.volume.length]),
    );
    await p.click('#st-reset');
    await p.waitForTimeout(150);
    const r = await stState(p);
    ok(
      !r.reset && r.volume.length === 30 && stSame(r.tiles, ST_ALL) && stSame(r.top, ST_TOP),
      'F31 ST7: Reset zoom brings back 30 days and every number ' + JSON.stringify([r.span, r.tiles.messages]),
    );
    /* a finger: touch pointer events across Nov 19 and Nov 20 */
    const t = await p.evaluate(() => {
      const box = document.querySelector('#st-body .st-chart[data-chart="volume"]');
      box.scrollIntoView({ block: 'center' });
      const svg = box.querySelector('svg');
      const at = k => {
        const r = box.querySelector('g[data-k="' + k + '"] rect.hit').getBoundingClientRect();
        return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      };
      const ev = (type, k) =>
        svg.dispatchEvent(
          new PointerEvent(
            type,
            Object.assign({ bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0 }, at(k)),
          ),
        );
      ev('pointerdown', 28);
      ev('pointermove', 28);
      ev('pointermove', 29);
      ev('pointerup', 29);
      return document.querySelectorAll('#st-body .st-chart[data-chart="volume"] g[data-k]').length;
    });
    const tz = await stState(p);
    ok(
      t === 48 && tz.tiles.messages === '18' && tz.reset,
      'F31 ST7: a finger dragging across two day bars zooms in too (' + t + ' bars)',
    );
    ok(p.errors.length === 0, 'F31 ST7: no page errors ' + JSON.stringify(p.errors));
  });

  /* ST8: the heatmap: Thursday 10-11 AM (Nov 19) is the strongest cell; hovering a cell names it */
  await hcase('ST8', async () => {
    const p = await stOpen();
    const h = await p.evaluate(() => {
      const box = document.querySelector('#st-body .st-chart[data-chart="heat"]');
      box.scrollIntoView({ block: 'center' });
      const cells = [...box.querySelectorAll('rect[data-d]')];
      const op = r => +r.getAttribute('fill-opacity');
      const top = cells.filter(r => r.getAttribute('fill') === 'var(--c1)').sort((a, b) => op(b) - op(a))[0];
      const c = box.querySelector('rect[data-d="4"][data-h="19"]').getBoundingClientRect();
      return {
        n: cells.length,
        lit: cells.filter(r => r.getAttribute('fill') === 'var(--c1)').length,
        top: [top.dataset.d, top.dataset.h, op(top)],
        at: { x: c.left + c.width / 2, y: c.top + c.height / 2 },
        label: box.getAttribute('aria-label'),
      };
    });
    await p.mouse.move(h.at.x, h.at.y);
    await p.waitForTimeout(80);
    const tip = await p.evaluate(() =>
      [...document.querySelectorAll('#st-body .st-chart[data-chart="heat"] .st-tip > *')].map(x => x.textContent),
    );
    ok(
      h.n === 168 &&
        h.lit === 10 &&
        h.top.join() === '4,10,1' &&
        /Busiest: Thu, 10–11 AM, 7 messages\./.test(h.label) &&
        stSame(tip, ['Thu, 7–8 PM', '3 messages']),
      'F31 ST8: a 7 x 24 heatmap, Thursday 10-11 AM the strongest, a hover names the cell ' + JSON.stringify([h, tip]),
    );
  });

  /* ST9: a switched-off section stays off after a reload (this browser only); the rest still draw */
  await hcase('ST9', async () => {
    const p = await stOpen();
    await p.click('#v-stats input[data-sec="heat"]');
    await p.click('#v-stats input[data-sec="tiles"]');
    await p.waitForTimeout(100);
    const s1 = await stState(p);
    await p.reload();
    await p.waitForFunction(() => window.__rt && document.getElementById('window').textContent !== 'Loading the chat…');
    await until(p, () => S.msgs.length === 27 && S.threading, null);
    await stGo(p);
    const s2 = await stState(p);
    const boxes = await p.evaluate(() =>
      ['tiles', 'volume', 'top', 'heat'].map(
        k => document.querySelector('#v-stats input[data-sec="' + k + '"]').checked,
      ),
    );
    const rest = ST_SECS.filter(k => k !== 'tiles' && k !== 'heat');
    ok(
      stSame(s1.secs, rest) && stSame(s2.secs, rest) && boxes.join() === 'false,true,true,false',
      'F31 ST9: Numbers and Heatmap switched off stay off after a reload ' + JSON.stringify([s1.secs, s2.secs, boxes]),
    );
    for (const k of rest) await p.click('#v-stats input[data-sec="' + k + '"]');
    await p.waitForTimeout(100);
    const none = await p.evaluate(() => (document.querySelector('#st-body .empty') || {}).textContent || '');
    ok(/Every section is switched off/.test(none), 'F31 ST9: with every section off, one line says so: "' + none + '"');
    ok(p.errors.length === 0, 'F31 ST9: no page errors ' + JSON.stringify(p.errors));
  });

  /* ST10: with storage blocked (a private window), the tab draws and switches the same, with no errors */
  await hcase('ST10', async () => {
    const p = await stOpen({ go: false });
    await p.context().addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
    });
    await p.reload();
    await until(p, () => S.msgs.length === 27 && S.threading, null);
    await stGo(p);
    const a = await stState(p);
    await p.click('#v-stats input[data-sec="heat"]');
    const b = await stTf(p, 'today');
    ok(
      stSame(a.tiles, ST_ALL) && b.tiles.messages === '5' && !b.secs.includes('heat') && p.errors.length === 0,
      'F31 ST10: with the localStorage getter throwing, the tab draws, switches sections and timeframes, no errors ' +
        JSON.stringify(p.errors),
    );
  });

  /* ST11: at 390 px nothing scrolls sideways: the timeframes, From/To, tiles, charts and lists, a day and a person;
     all six tabs fit the bar */
  await hcase('ST11', async () => {
    const p = await stOpen({ ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
    const wide = () =>
      p.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        w: innerWidth,
        over: [...document.querySelectorAll('#v-stats *')]
          .filter(e => e.getClientRects().length && e.getBoundingClientRect().right > innerWidth + 0.5)
          .map(e => e.tagName + '.' + (e.getAttribute('class') || ''))
          .slice(0, 5),
      }));
    const m = await wide();
    await p.tap('#v-stats [data-tf="custom"]');
    await p.waitForTimeout(100);
    const c = await wide();
    await p.tap('#v-stats [data-tf="d30"]');
    await p.waitForTimeout(100);
    const b = await stBar(p, 'volume', 28);
    await p.touchscreen.tap(b.x, b.y);
    await p.waitForTimeout(150);
    const day = await wide();
    const head = (await stState(p)).head;
    await p.tap('#st-body .st-top li:nth-child(1) button');
    await p.waitForTimeout(150);
    const per = await wide();
    const nav = await p.evaluate(() => {
      const n = document.querySelector('nav.tabs');
      const r = n.getBoundingClientRect();
      return {
        tabs: n.querySelectorAll('a:not([hidden])').length,
        fit: [...n.querySelectorAll('a:not([hidden])')].every(a => {
          const x = a.getBoundingClientRect();
          return x.left >= r.left && x.right <= r.left + n.clientWidth && x.height >= 32;
        }),
        scroll: n.scrollWidth - n.clientWidth,
      };
    });
    const fit = x => x.sw <= x.w && !x.over.length;
    ok(
      fit(m) && fit(c) && fit(day) && fit(per) && head === 'Thu, Nov 19',
      'F31 ST11: at 390 px nothing runs past the right edge (main, Custom, a tapped day, a person) ' +
        JSON.stringify({ m, c, day, per }),
    );
    ok(
      nav.tabs === 6 && nav.fit && nav.scroll <= 0,
      'F31 ST11: all six tabs fit the bar at 390 px ' + JSON.stringify(nav),
    );
    ok(p.errors.length === 0, 'F31 ST11: no page errors ' + JSON.stringify(p.errors));
  });

  /* ST12: dark mode: the bars, the heatmap and the tooltip use the dark theme's colours */
  await hcase('ST12', async () => {
    const p = await stOpen({ ctx: { colorScheme: 'dark' } });
    const c = await p.evaluate(() => {
      const cs = s => getComputedStyle(document.querySelector(s));
      return {
        bar: cs('#st-body .st-chart[data-chart="volume"] g[data-k="28"] path').fill,
        box: cs('#st-body .st-chart[data-chart="volume"]').backgroundColor,
        tile: cs('#st-body .st-tile').backgroundColor,
        tip: cs('#st-body .st-tip').backgroundColor,
      };
    });
    ok(
      c.bar === 'rgb(57, 135, 229)' &&
        c.box === 'rgb(33, 35, 31)' &&
        c.tile === 'rgb(33, 35, 31)' &&
        c.tip === 'rgb(233, 232, 224)',
      'F31 ST12: in dark mode the charts use the dark tokens ' + JSON.stringify(c),
    );
  });

  /* ST13: before any data, and with no database: one line each, no errors */
  await hcase('ST13', async () => {
    const p = await open(Object.assign(SEED(), { __opts: { noDb: true } }));
    HP.push(p);
    await stGo(p);
    const e = await p.evaluate(() => (document.querySelector('#st-body .empty') || {}).textContent || '');
    const q = await open(SEED());
    HP.push(q);
    await stGo(q);
    const e2 = await q.evaluate(() => (document.querySelector('#st-body .empty') || {}).textContent || '');
    ok(
      e === "The stats can't load in this view. Open the page on claude.ai while signed in." &&
        /^No messages stored yet\./.test(e2) &&
        !p.errors.length &&
        !q.errors.length,
      'F31 ST13: no database and no messages each get one line ' + JSON.stringify([e, e2, p.errors, q.errors]),
    );
  });

  /* ST14: new messages arriving while the tab is open are counted at once; the keyboard stays on the chart it was on */
  await hcase('ST14', async () => {
    const p = await stOpen();
    await p.focus('#st-body .st-chart[data-chart="volume"]');
    await p.evaluate(() => {
      const c = __rt.get('chunks/c0000');
      c.msgs.push({ i: 27, t: 'Fri 11:30 AM', d: '2026-11-20', f: 'Cy', b: 'On my way', m: 'mid.27' });
      __rt.write('chunks/c0000', c);
    });
    await until(p, () => S.msgs.length === 28, null);
    await p.waitForTimeout(100);
    const s = await stState(p);
    const f = await p.evaluate(() => document.activeElement && document.activeElement.dataset.chart);
    ok(
      s.tiles.messages === '28' && s.volume[29] === 6 && s.top[3] === 'Cy 4 14.3%' && f === 'volume',
      'F31 ST14: a new message shows at once in the tiles, the bars and the top 10, focus kept (' +
        JSON.stringify([s.tiles.messages, s.top[3], f]) +
        ')',
    );
  });

  /* ST16: a finger that wobbles a little, or slides without leaving its bar, taps: Nov 19 opens, nothing zooms */
  await hcase('ST16', async () => {
    const p = await stOpen({ ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
    const r = await p.evaluate(() => {
      const box = document.querySelector('#st-body .st-chart[data-chart="volume"]');
      box.scrollIntoView({ block: 'center' });
      const svg = box.querySelector('svg');
      const b = box.querySelector('g[data-k="28"] rect.hit').getBoundingClientRect();
      const ev = (type, dx) =>
        svg.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 9,
            pointerType: 'touch',
            isPrimary: true,
            button: 0,
            clientX: b.left + 1 + dx,
            clientY: b.top + b.height / 2,
          }),
        );
      ev('pointerdown', 0);
      ev('pointermove', Math.min(8, b.width - 2));
      ev('pointerup', Math.min(8, b.width - 2));
      return { w: b.width, head: (document.querySelector('#st-body .st-head h3') || {}).textContent || null };
    });
    const s = await stState(p);
    ok(
      r.head === 'Thu, Nov 19' && !s.reset,
      'F31 ST16: a slide inside one day bar is a tap: that day opens, no zoom ' + JSON.stringify(r),
    );
  });

  /* ST15: speed: 180,000 messages (a year at about 500 a day) are indexed once and each span is one quick pass */
  await hcase('ST15', async () => {
    const p = await stOpen();
    const r = await p.evaluate(() => {
      const W = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const cast = ['Ana', 'Ben', 'Cy', 'Dee', 'You'];
      const L = [];
      const t0 = Date.UTC(2025, 10, 21);
      for (let i = 0; i < 180000; i++) {
        const d = new Date(t0 + Math.floor(i / 493) * 864e5 + (7 * 60 + ((i % 493) * 960) / 493) * 60000);
        const h = d.getUTCHours(),
          mi = d.getUTCMinutes();
        const f = cast[i % 5] + (i % 97 ? '' : String(i % 7));
        L.push({
          i,
          t: W[d.getUTCDay()] + ' ' + (h % 12 || 12) + ':' + String(mi).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM'),
          d: d.toISOString().slice(0, 10),
          f,
          fn: f === 'You' ? undefined : f + ' Test',
          b: i % 9 ? 'message ' + i : '',
          m: 'mid.' + i,
        });
      }
      L.forEach(m => (m.ts = tsOf(m)));
      const t1 = performance.now();
      S.msgs = L;
      indexPeople();
      const t2 = performance.now();
      const B = statsBase();
      const t3 = performance.now();
      const F = stFrame();
      const A = statsAgg(B, F.lo, F.hi);
      const t4 = performance.now();
      S.stats.tf = 'all';
      S.stats.v++;
      renderStats(true);
      const t5 = performance.now();
      /* part 2: threading with a conversation per 30 messages and every third message a reply to the one before; a
         summary with a tag per conversation, a deal per 120 messages (each claimed, every other one sold) and a
         question per 60 (every other one answered) */
      const T = { convs: [], links: {} };
      for (let c = 0; c < 6000; c++)
        T.convs.push({ id: 'c' + c, title: 'Topic ' + c, members: Array.from({ length: 30 }, (_, k) => c * 30 + k) });
      for (let i = 3; i < 180000; i += 3) T.links[i] = [i - 1, 'r'];
      const SM = { convs: [], open: [], answered: [], deals: [] };
      T.convs.forEach((c, k) => SM.convs.push({ id: c.id, tag: ['For sale', 'Trip', 'Gear talk'][k % 3] }));
      for (let i = 0; i + 40 < 180000; i += 120) {
        const x = { conv: 'c' + Math.floor(i / 30), refs: [i], tag: 'For sale', text: 'Item ' + i };
        x.claims = [{ i: i + 5, who: cast[(i + 5) % 5] }];
        if (i % 240 === 0) Object.assign(x, { status: 'sold', statusAt: i + 40 });
        SM.deals.push(x);
      }
      for (let i = 1; i + 10 < 180000; i += 60) {
        if (i % 120 === 1) SM.answered.push({ conv: 'c' + Math.floor(i / 30), ask: i, answer: 'yes', refs: [i + 10] });
        else SM.open.push({ conv: 'c' + Math.floor(i / 30), ask: i, to: 'anyone', note: '' });
      }
      const t6 = performance.now();
      S.threading = T;
      S.summary = SM;
      stLinks(statsBase());
      const t7 = performance.now();
      S.stats.tf = 'd30';
      S.stats.v++;
      renderStats(true);
      const t8 = performance.now();
      const busiest = document.querySelectorAll('#st-body [data-list="busiest"] > li').length;
      const pairs = document.querySelectorAll('#st-body [data-list="pairs"] > li').length;
      const deals = document.querySelectorAll('#st-body [data-list="deals"] > li').length;
      const more = (document.querySelector('#st-body > [data-sec="deals"] > button.link') || {}).textContent;
      const moreC = [...document.querySelectorAll('#st-body > [data-sec="convs"] > p.note')]
        .map(x => x.textContent)
        .find(t => /^And /.test(t));
      S.stats.tf = 'all';
      S.stats.v++;
      renderStats(true);
      const t9 = performance.now();
      S.stats.word = 'message';
      stWordsFill(true);
      const t10 = performance.now();
      const say = document.querySelector('#st-words .note[role="status"]').textContent;
      return {
        people: t2 - t1,
        base: t3 - t2,
        span: t4 - t3,
        render: t5 - t4,
        total: A.total,
        bars: document.querySelectorAll('#st-body .st-chart[data-chart="volume"] g[data-k]').length,
        n: B.n,
        kind: (document.querySelector('#st-body [data-sec="volume"] h3') || {}).textContent,
        links: t7 - t6,
        render30: t8 - t7,
        renderAll: t9 - t8,
        word: t10 - t9,
        busiest,
        pairs,
        deals,
        more,
        moreC,
        say,
      };
    });
    console.log(
      '  stats at 180,000 messages: base ' +
        r.base.toFixed(0) +
        ' ms, a 30-day span ' +
        r.span.toFixed(1) +
        ' ms, a full render of All ' +
        r.render.toFixed(0) +
        ' ms',
    );
    ok(
      r.n === 180000 &&
        r.total > 14000 &&
        r.bars <= 60 &&
        r.kind === 'Messages per week' &&
        r.base < 2000 &&
        r.span < 200 &&
        r.render < 1500,
      'F31 ST15: at 180,000 messages the index takes ' +
        r.base.toFixed(0) +
        ' ms, a 30-day span ' +
        r.span.toFixed(1) +
        ' ms, and All draws ' +
        r.bars +
        ' weekly bars in ' +
        r.render.toFixed(0) +
        ' ms ' +
        JSON.stringify(r),
    );
    console.log(
      '  part 2 at 180,000 messages: threading read in ' +
        r.links.toFixed(0) +
        ' ms, 30 days with every section ' +
        r.render30.toFixed(0) +
        ' ms, All ' +
        r.renderAll.toFixed(0) +
        ' ms, a word over All ' +
        r.word.toFixed(0) +
        ' ms',
    );
    ok(
      r.links < 1500 &&
        r.render30 < 1000 &&
        r.renderAll < 2000 &&
        r.word < 1000 &&
        r.busiest === 10 &&
        r.pairs === 10 &&
        r.deals === 10 &&
        /^Show 1\d\d more$/.test(r.more) &&
        /^And \d\d\d more conversations\.$/.test(r.moreC) &&
        /^160,000 messages mention “message”/.test(r.say),
      'F31 ST15: with 6,000 conversations, 60,000 links, 1,500 deals and 3,000 questions, threading is read in ' +
        r.links.toFixed(0) +
        ' ms, 30 days draw every section in ' +
        r.render30.toFixed(0) +
        ' ms, All in ' +
        r.renderAll.toFixed(0) +
        ' ms, and a word over All counts in ' +
        r.word.toFixed(0) +
        ' ms ' +
        JSON.stringify(r),
    );
    ok(p.errors.length === 0, 'F31 ST15: no page errors ' + JSON.stringify(p.errors));
  });
}

/* ---------- Stats part 2 (F31) ----------
   The same seed as stats (see there): conversations and topics, deals, people, engagement and word trends, each over
   the timeframe, a day and a person, opening what they name. Split from stats so the two run side by side. */
/* one section of the Stats tab, or null when it's switched off: its tiles (and their labels), its lists (rows as
   "name count share", or a deal's text) with the line under each row, its text, and for word trends the status line
   and the bars */
const stPart = (p, sec) =>
  p.evaluate(sec => {
    const s = document.querySelector('#st-body > [data-sec="' + sec + '"]');
    if (!s || s.hidden) return null;
    const tiles = {},
      labels = {},
      lists = {},
      subs = {};
    s.querySelectorAll('.st-tile').forEach(t => {
      tiles[t.dataset.k] = t.querySelector('.n').textContent;
      labels[t.dataset.k] = t.querySelector('.l').textContent;
    });
    s.querySelectorAll('[data-list]').forEach(ol => {
      const li = [...ol.children];
      lists[ol.dataset.list] = li.map(x =>
        ol.matches('.st-deals')
          ? x.querySelector('.who').textContent
          : ['.who', '.c', '.pc']
              .map(c => x.querySelector(c).textContent)
              .join(' ')
              .trim(),
      );
      subs[ol.dataset.list] = li.map(x => (x.querySelector('.sub') || {}).textContent || '');
    });
    const say = s.querySelector('.note[role="status"]');
    return {
      tiles,
      labels,
      lists,
      subs,
      text: s.textContent,
      say: say ? say.textContent : null,
      bars: [...s.querySelectorAll('.st-chart g[data-k]')].map(g => +g.dataset.v),
    };
  }, sec);
/* click row k (from 0) of a list in a section */
const stRow = (p, sec, list, k) =>
  p.click('#st-body > [data-sec="' + sec + '"] [data-list="' + list + '"] > li:nth-child(' + (k + 1) + ') button');
/* open a person's chart from the top 10, by the name shown; returns the chart's heading */
async function stPerson(p, name) {
  await p.evaluate(n => {
    const b = [...document.querySelectorAll('#st-body > [data-sec="top"] li button')].find(x => x.textContent === n);
    b.click();
  }, name);
  await p.waitForTimeout(150);
  return (await stState(p)).head;
}
async function stBack(p) {
  await p.click('#st-body .st-back');
  await p.waitForTimeout(150);
}
async function stDay(p, k) {
  const b = await stBar(p, 'volume', k);
  await p.mouse.click(b.x, b.y);
  await p.waitForTimeout(150);
}
/* after a click that should open message i in Messages: the tab, the row flashing (null if it never does), and
   whether the conversation it's in is open */
const stAtMsg = (p, i) =>
  until(
    p,
    i => {
      const n = document.getElementById('m' + i);
      const d = n && n.closest('details');
      const shown = location.hash === '#messages' && !document.getElementById('v-messages').hidden;
      return shown && n && n.hasAttribute('data-flashed') && { flash: true, inConv: !!d && d.open };
    },
    i,
    3000,
  );
/* type into the word box key by key, as a reader does. The box applies 400 ms after the last key, a real timer that
   fixed waits raced on a busy runner (ST21 failed with the suite run three at a time, Nov 22), so the keys go in with
   the page's clock paused (Playwright's clock, which stOpen installs): during(), if given, runs before the pause may
   pass, and then the clock moves 500 ms (the word applies, at once) and runs on. */
async function stType(p, text, during) {
  await p.click('#st-word', { clickCount: 3 });
  await p.keyboard.press('Backspace');
  await clockPause(p);
  try {
    await p.keyboard.type(text, { delay: 80 });
    if (during) await during();
  } finally {
    await p.clock.runFor(500);
    await p.clock.resume();
  }
}
/* the word box: still the box first seen (window.__box) and focused, what it holds, and the status line under it */
const stBox = p =>
  p.evaluate(() => {
    const b = document.getElementById('st-word');
    const say = document.querySelector('#st-words .note[role="status"]').textContent;
    return [b === window.__box && document.activeElement === b, b.value, say];
  });

async function stats2() {
  /* ST17: conversations and topics: started, active, the busiest (messages, share, who posted) and the summary's
     tags, over 30 days, today, a day and a person; a click opens the conversation in Messages */
  await hcase('ST17', async () => {
    const p = await stOpen();
    const m = await stPart(p, 'convs');
    ok(
      stSame(m.tiles, { started: '4', active: '4' }) &&
        stSame(m.lists.busiest, ['Topic c3 13 48.1%', 'Topic c2 5 18.5%', 'Topic c4 4 14.8%', 'Topic c1 3 11.1%']) &&
        stSame(m.subs.busiest, [
          '6 people: Ana Alvarez, Ben Brooks, Cy, Dee Dalton +2 more',
          '4 people: Ben Brooks, Ana Alvarez, Dee Dalton, You',
          '3 people: Ana Alvarez, Dee Dalton, You',
          '2 people: Ana Alvarez, Ben Brooks',
        ]) &&
        stSame(m.lists.tags, ['For sale 2 50.0%', 'Gear talk 1 25.0%', 'Trip 1 25.0%']),
      'F31 ST17: on 30 days 4 conversations started and were active; the busiest with their messages, share and people; the summary tags by conversations ' +
        JSON.stringify(m),
    );
    await stTf(p, 'today');
    const t = await stPart(p, 'convs');
    ok(
      stSame(t.tiles, { started: '1', active: '2' }) &&
        stSame(t.lists.busiest, ['Topic c4 4 80.0%', 'Topic c2 1 20.0%']) &&
        stSame(t.lists.tags, ['For sale 2 100.0%']),
      'F31 ST17: today one conversation started and two were active (Ben came back to the Nov 12 one) ' +
        JSON.stringify(t),
    );
    await stTf(p, 'd30');
    await stDay(p, 28);
    const d = await stPart(p, 'convs');
    await stPerson(p, 'Ana Alvarez');
    const ana = await stPart(p, 'convs');
    await stBack(p);
    await stBack(p);
    const head = await stPerson(p, 'Ana Alvarez');
    const anaAll = await stPart(p, 'convs');
    ok(
      stSame(d.tiles, { started: '1', active: '1' }) &&
        stSame(d.lists.busiest, ['Topic c3 13 100.0%']) &&
        stSame(d.lists.tags, ['Gear talk 1 100.0%']) &&
        stSame(ana.lists.busiest, ['Topic c3 4 100.0%']) &&
        head === 'Ana Alvarez' &&
        stSame(anaAll.tiles, { started: '4', active: '4' }) &&
        stSame(anaAll.lists.busiest, [
          'Topic c3 4 44.4%',
          'Topic c1 2 22.2%',
          'Topic c4 2 22.2%',
          'Topic c2 1 11.1%',
        ]) &&
        /Where Ana Alvarez posted most/.test(anaAll.text),
      "F31 ST17: Nov 19 has its one conversation; Ana Alvarez's chart, that day and over 30 days, counts her own messages " +
        JSON.stringify([d.lists, ana.lists, anaAll.tiles, anaAll.lists]),
    );
    await stBack(p);
    await flashReset(p);
    await stRow(p, 'convs', 'busiest', 0);
    const at = await stAtMsg(p, 9);
    ok(
      at && at.flash && at.inConv,
      'F31 ST17: a click on the busiest conversation opens Messages at its first message in the span (#9), its thread open ' +
        JSON.stringify(at),
    );
    ok(p.errors.length === 0, 'F31 ST17: no page errors ' + JSON.stringify(p.errors));
  });

  /* ST18: deals: posted, claims, sold, pending and the median time from posted to sold (with how many it's based on),
     top sellers and claimers, and the deals posted, each opening its first message; over a day and a person too */
  await hcase('ST18', async () => {
    const p = await stOpen();
    const m = await stPart(p, 'deals');
    ok(
      stSame(m.tiles, { posted: '2', claims: '3', sold: '1', pending: '1', tosold: '6 days 20 h' }) &&
        m.labels.tosold === 'posted to sold, median of 1' &&
        stSame(m.lists.sellers, ['Ana Alvarez 2 100.0%']) &&
        stSame(m.lists.claimers, ['Dee Dalton 2 66.7%', 'You 1 33.3%']) &&
        stSame(m.lists.deals, ['For sale: Stove, $40', 'For sale: Tent, $80']) &&
        stSame(m.subs.deals, ['Ana Alvarez · Nov 20 · Pending · 1 claim', 'Ana Alvarez · Nov 12 · Sold · 2 claims']),
      'F31 ST18: on 30 days 2 posted, 3 claims, 1 sold after 6 days 20 h (Nov 12 7:30 PM to Nov 19 3 PM), 1 pending; Ana Alvarez posted both, Dee Dalton claimed twice ("Deedee" is Dee Dalton) ' +
        JSON.stringify(m),
    );
    await stTf(p, 'today');
    const t = await stPart(p, 'deals');
    await stTf(p, 'lastwk');
    const lw = await stPart(p, 'deals');
    ok(
      stSame(t.tiles, { posted: '1', claims: '1', sold: '0', pending: '1', tosold: '—' }) &&
        t.labels.tosold === 'posted to sold, median' &&
        stSame(lw.tiles, { posted: '1', claims: '2', sold: '0', pending: '0', tosold: '—' }),
      'F31 ST18: today one deal was posted, claimed and put on pending; last week the tent was posted and claimed twice ' +
        JSON.stringify([t.tiles, lw.tiles]),
    );
    await stTf(p, 'd30');
    await stDay(p, 28);
    const d = await stPart(p, 'deals');
    await stBack(p);
    await stPerson(p, 'Dee Dalton');
    const dee = await stPart(p, 'deals');
    await stBack(p);
    ok(
      stSame(d.tiles, { posted: '0', claims: '0', sold: '1', pending: '0', tosold: '6 days 20 h' }) &&
        !d.lists.deals &&
        stSame(dee.tiles, { posted: '0', claims: '2', sold: '0', pending: '0', tosold: '—' }) &&
        dee.labels.claims === 'claims made' &&
        !dee.lists.sellers,
      'F31 ST18: Nov 19 is the day the tent sold; Dee Dalton made two claims and posted no deal ' +
        JSON.stringify([d.tiles, dee.tiles]),
    );
    /* a seller's name opens their chart, and Back comes back to it */
    await stRow(p, 'deals', 'sellers', 0);
    await p.waitForTimeout(150);
    const head = (await stState(p)).head;
    await stBack(p);
    const f = await p.evaluate(() => {
      const a = document.activeElement;
      return a && a.closest('[data-list]') && [a.closest('[data-list]').dataset.list, a.closest('li').dataset.pk];
    });
    ok(
      head === 'Ana Alvarez' && stSame(f, ['sellers', 'FAna Alvarez']),
      "F31 ST18: a seller's name opens their chart; Back focuses it again " + JSON.stringify([head, f]),
    );
    await flashReset(p);
    await p.click('#st-body > [data-sec="deals"] [data-list="deals"] > li:nth-child(2) button');
    const at = await stAtMsg(p, 5);
    ok(at && at.flash, 'F31 ST18: a click on a deal opens its first message (#5) in Messages ' + JSON.stringify(at));
    ok(p.errors.length === 0, 'F31 ST18: no page errors ' + JSON.stringify(p.errors));
  });

  /* ST19: people: new voices (first stored message in the span) and gone quiet (posted in the 30 days before, not in
     it), over 30 days, today, last week and 7 days; first and last seen on a person's chart, each opening its message */
  await hcase('ST19', async () => {
    const p = await stOpen();
    const m = await stPart(p, 'people');
    ok(
      stSame(m.tiles, { new: '6', quiet: '0' }) &&
        stSame(m.lists.new, [
          'Ana Alvarez 9 33.3%',
          'Ben Brooks 6 22.2%',
          'Cy 3 11.1%',
          'Dee Dalton 5 18.5%',
          'You 3 11.1%',
          'Ben Ortiz 1 3.7%',
        ]) &&
        m.subs.new[5] === 'first message Nov 19' &&
        /Stored history starts Nov 1: everyone posting from then counts as new\./.test(m.text),
      'F31 ST19: on 30 days, which reach the start of the history, all six are new, in the order they first posted; a note says why ' +
        JSON.stringify(m),
    );
    await stTf(p, 'today');
    const t = await stPart(p, 'people');
    await stTf(p, 'lastwk');
    const lw = await stPart(p, 'people');
    await stTf(p, 'd7');
    const d7 = await stPart(p, 'people');
    ok(
      stSame(t.tiles, { new: '0', quiet: '2' }) &&
        stSame(t.lists.quiet, ['Cy 3', 'Ben Ortiz 1']) &&
        stSame(t.subs.quiet, ['last message Nov 19', 'last message Nov 19']) &&
        stSame(lw.lists.new, ['You 1 25.0%']) &&
        stSame(lw.lists.quiet, ['Cy 1']) &&
        stSame(d7.lists.new, ['Ben Ortiz 1 5.6%']) &&
        d7.tiles.quiet === '0' &&
        !/Stored history starts/.test(t.text),
      'F31 ST19: today Cy and Ben Ortiz went quiet; last week You were new and Cy quiet; the last 7 days brought Ben Ortiz ' +
        JSON.stringify([t.lists, lw.lists, d7.lists]),
    );
    await stTf(p, 'd30');
    await stPerson(p, 'Dee Dalton');
    const dee = await stPart(p, 'people');
    const secs = (await stState(p)).secs;
    ok(
      stSame(dee.tiles, { first: 'Nov 1', last: 'Nov 20' }) &&
        dee.text.endsWith(
          'First message #4 (Sun, Nov 1, 2:05 PM); last #25 (Fri, Nov 20, 10:20 AM). Stored history starts Nov 1, so they may have posted before.',
        ) &&
        secs[1] === 'people',
      "F31 ST19: Dee Dalton's chart says when she was first and last seen, under her numbers " +
        JSON.stringify([dee, secs]),
    );
    await stBack(p);
    await stPerson(p, 'Ben Ortiz');
    const bo = await stPart(p, 'people');
    ok(
      stSame(bo.tiles, { first: 'Nov 19', last: 'Nov 19' }) && / New in this span\.$/.test(bo.text),
      "F31 ST19: Ben Ortiz's chart: first seen inside the span, so he's new in it " + JSON.stringify(bo),
    );
    await stBack(p);
    await stPerson(p, 'Dee Dalton');
    await flashReset(p);
    await p.click('#st-body > [data-sec="people"] p.note a:nth-of-type(2)');
    const at = await stAtMsg(p, 25);
    ok(at && at.flash, 'F31 ST19: "#25" opens her last message in Messages ' + JSON.stringify(at));
    ok(p.errors.length === 0, 'F31 ST19: no page errors ' + JSON.stringify(p.errors));
  });

  /* ST20: engagement: replies and who replies to whom (Messenger's pi and r, then threading's r, rq, rg and i links;
     never c), the summary's questions, how many were answered and the median wait for the first answer */
  await hcase('ST20', async () => {
    const p = await stOpen();
    const m = await stPart(p, 'engage');
    ok(
      stSame(m.tiles, { replies: '6', share: '22.2%', asked: '5', answered: '3', wait: '10 min' }) &&
        m.labels.wait === 'to the first answer, median of 3' &&
        stSame(m.lists.pairs, [
          'Ben Brooks → Ana Alvarez 3 50.0%',
          'Dee Dalton → Ana Alvarez 1 16.7%',
          'Dee Dalton → You 1 16.7%',
          'Ben Ortiz → You 1 16.7%',
        ]),
      'F31 ST20: on 30 days 6 replies, Ben Brooks to Ana Alvarez most (by name, an answer link and a quote link; Cy going on is no reply); 5 questions, 3 answered after 10, 20 and 5 minutes ' +
        JSON.stringify(m),
    );
    await stTf(p, 'today');
    const t = await stPart(p, 'engage');
    await stTf(p, 'd30');
    await stDay(p, 28);
    const d = await stPart(p, 'engage');
    ok(
      stSame(t.tiles, { replies: '1', share: '20.0%', asked: '2', answered: '1', wait: '5 min' }) &&
        stSame(d.tiles, { replies: '4', share: '30.8%', asked: '1', answered: '1', wait: '20 min' }) &&
        stSame(d.lists.pairs, [
          'Ben Brooks → Ana Alvarez 2 50.0%',
          'Dee Dalton → Ana Alvarez 1 25.0%',
          'Ben Ortiz → You 1 25.0%',
        ]),
      'F31 ST20: today and Nov 19 count their own replies and questions ' + JSON.stringify([t.tiles, d.tiles, d.lists]),
    );
    await stBack(p);
    await stPerson(p, 'Ana Alvarez');
    const ana = await stPart(p, 'engage');
    ok(
      stSame(ana.tiles, { got: '4', asked: '4', answered: '2', wait: '15 min' }) &&
        stSame(ana.lists.repliedBy, ['Ben Brooks 3 75.0%', 'Dee Dalton 1 25.0%']) &&
        ana.labels.got === 'replies to Ana Alvarez',
      "F31 ST20: Ana Alvarez's chart: 4 replies to her; her 4 questions, 2 answered after a median 15 minutes " +
        JSON.stringify(ana),
    );
    const text = await p.evaluate(() => document.getElementById('v-stats').textContent);
    ok(!/reaction/i.test(text), 'F31 ST20: still no reactions anywhere on the tab');
    ok(p.errors.length === 0, 'F31 ST20: no page errors ' + JSON.stringify(p.errors));
  });

  /* ST21: word trends: the box keeps its focus and what's typed while typing (nothing applies until the pause), and
     while the tab redraws for new data; whole words in any case, per bar of the span, who mentions it most; as a
     table; a click on a day opens it, and on an hour opens its first mention */
  await hcase('ST21', async () => {
    const p = await stOpen();
    await p.evaluate(() => (window.__box = document.getElementById('st-word')));
    const before = (await stPart(p, 'words')).say;
    let mid = null;
    await stType(p, 'tent', async () => (mid = await stBox(p)));
    const w = await stPart(p, 'words');
    ok(
      mid[0] && mid[1] === 'tent' && mid[2] === before && /^Type a word or phrase/.test(before),
      'F31 ST21: while typing, the box keeps its focus and text, and nothing applies yet ' +
        JSON.stringify([mid, before]),
    );
    ok(
      w.say === '6 messages mention “tent”: 22.2% of the messages in Oct 22 – Nov 20.' &&
        w.bars.length === 30 &&
        w.bars[10] === 1 &&
        w.bars[21] === 1 &&
        w.bars[28] === 2 &&
        w.bars[29] === 2 &&
        w.bars.reduce((a, b) => a + b, 0) === 6 &&
        stSame(w.lists.mentions, ['Ben Brooks 3 50.0%', 'Ana Alvarez 1 16.7%', 'Cy 1 16.7%', 'You 1 16.7%']),
      'F31 ST21: after the pause, "tent" in 6 messages by day (TENT and tent-pole count, Tents and contents don\'t), Ben Brooks most ' +
        JSON.stringify(w),
    );
    /* new data redraws the tab while the box has the focus: the same box, focused, with its text */
    await p.focus('#st-word');
    await p.evaluate(() => {
      const c = __rt.get('chunks/c0000');
      c.msgs.push({ i: 27, t: 'Fri 11:30 AM', d: '2026-11-20', f: 'Cy', b: 'Tent pegs too', m: 'mid.27' });
      __rt.write('chunks/c0000', c);
    });
    await until(p, () => S.msgs.length === 28, null);
    await p.waitForTimeout(150);
    const kept = await stBox(p);
    ok(
      kept[0] && kept[1] === 'tent' && /^7 messages mention/.test(kept[2]),
      'F31 ST21: a redraw for a new message keeps the box, its focus and text, and counts the new mention ' +
        JSON.stringify(kept),
    );
    /* Enter, with the clock still paused: it applies without the pause */
    let ph = null;
    await stType(p, 'Tent  trip', async () => {
      await p.keyboard.press('Enter');
      ph = (await stPart(p, 'words')).say;
    });
    await stType(p, 'ten');
    const none = await stPart(p, 'words');
    ok(
      /^1 message mentions “Tent trip”/.test(ph) &&
        none.say === 'No message mentions “ten” in Oct 22 – Nov 20.' &&
        !none.bars.length,
      'F31 ST21: a phrase applies at once on Enter (spacing and case don\'t matter); "ten" is no whole word here ' +
        JSON.stringify([ph, none.say]),
    );
    await stType(p, 'tent');
    /* the table, then a click on Nov 19: its day, the word by the hour; a click on 10 AM opens its first mention */
    await p.click('#st-words details.st-tbl > summary');
    await p.waitForTimeout(100);
    const rows = await p.evaluate(() =>
      [...document.querySelectorAll('#st-words details.st-tbl tbody tr')].map(r => r.textContent),
    );
    const b = await stBar(p, 'words', 28);
    await p.mouse.click(b.x, b.y);
    await p.waitForTimeout(150);
    const day = await stPart(p, 'words');
    const head = (await stState(p)).head;
    ok(
      rows.length === 30 &&
        rows[28] === 'Thu, Nov 192' &&
        head === 'Thu, Nov 19' &&
        day.bars.length === 24 &&
        day.bars[10] === 1 &&
        day.bars[11] === 1 &&
        /^2 messages mention “tent”: 15\.4% of the messages in Thu, Nov 19\./.test(day.say),
      'F31 ST21: as a table, then a click on Nov 19 opens its day, where the word shows by the hour ' +
        JSON.stringify([rows[28], head, day.bars, day.say]),
    );
    const h = await stBar(p, 'words', 10);
    await flashReset(p);
    await p.mouse.click(h.x, h.y);
    const at = await stAtMsg(p, 13);
    ok(at && at.flash, 'F31 ST21: a click on 10 AM opens its first mention (#13) in Messages ' + JSON.stringify(at));
    ok(p.errors.length === 0, 'F31 ST21: no page errors ' + JSON.stringify(p.errors));
  });

  /* ST22: a person's word trend; the keyboard on the word chart; over a long span the word goes by week and a week bar
     zooms in */
  await hcase('ST22', async () => {
    const p = await stOpen();
    await stType(p, 'tent');
    await stPerson(p, 'Ben Brooks');
    const ben = await stPart(p, 'words');
    ok(
      ben.say === '3 messages from Ben Brooks mention “tent”: 50.0% of theirs in Oct 22 – Nov 20.' &&
        ben.bars[21] === 1 &&
        ben.bars[28] === 1 &&
        ben.bars[29] === 1 &&
        !ben.lists.mentions,
      "F31 ST22: on Ben Brooks' chart the word counts his messages only " + JSON.stringify(ben),
    );
    await stBack(p);
    await stTf(p, 'd90');
    await p.focus('#st-body .st-chart[data-chart="words"]');
    await p.keyboard.press('End');
    await p.keyboard.press('ArrowLeft');
    const said = await p.evaluate(() => document.querySelector('#st-words .st-chart .sr').textContent);
    await p.keyboard.press('ArrowRight');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(150);
    const s = await stState(p);
    ok(
      said === 'Thu, Nov 19, 2 messages' && s.head === 'Fri, Nov 20',
      "F31 ST22: the arrow keys read the word chart's bars and Enter opens a day " + JSON.stringify([said, s.head]),
    );
    await stBack(p);
    await p.click('#v-stats [data-tf="custom"]');
    await p.fill('#st-from', '2026-07-01');
    await p.fill('#st-to', '2026-11-20');
    await p.press('#st-to', 'Enter');
    await p.waitForTimeout(150);
    const wk = await stPart(p, 'words');
    const label = await p.evaluate(() => document.querySelector('#st-words .st-chart').getAttribute('aria-label'));
    const bb = await stBar(p, 'words', wk.bars.length - 1);
    await p.mouse.click(bb.x, bb.y);
    await p.waitForTimeout(150);
    const z = await stState(p);
    const zw = await stPart(p, 'words');
    ok(
      /per week/.test(label) &&
        wk.bars[wk.bars.length - 1] === 4 &&
        z.reset &&
        /^Nov 15 – Nov 20 \(zoomed in/.test(z.span) &&
        zw.bars.length === 6 &&
        zw.bars.join() === '0,0,0,0,2,2',
      'F31 ST22: from Jul 1 the word goes by week, and the last week bar zooms into its days ' +
        JSON.stringify([label, wk.bars.slice(-3), z.span, zw.bars]),
    );
    ok(p.errors.length === 0, 'F31 ST22: no page errors ' + JSON.stringify(p.errors));
  });

  /* ST23: each new section's switch stays off after a reload (this browser only), word trends included, on a
     person's chart too */
  await hcase('ST23', async () => {
    const p = await stOpen();
    const NEW = ['convs', 'deals', 'people', 'engage', 'words'];
    for (const k of NEW) await p.click('#v-stats input[data-sec="' + k + '"]');
    await p.waitForTimeout(100);
    const s1 = await stState(p);
    await p.reload();
    await until(p, () => S.msgs.length === 27 && S.threading && S.summary, null);
    await stGo(p);
    const s2 = await stState(p);
    const boxes = await p.evaluate(
      ks => ks.map(k => document.querySelector('#v-stats input[data-sec="' + k + '"]').checked),
      NEW,
    );
    const words = await p.evaluate(() => document.getElementById('st-words').hidden);
    await stPerson(p, 'Ana Alvarez');
    const per = (await stState(p)).secs;
    ok(
      stSame(s1.secs, ['tiles', 'volume', 'top', 'heat']) &&
        stSame(s2.secs, ['tiles', 'volume', 'top', 'heat']) &&
        boxes.join() === 'false,false,false,false,false' &&
        words &&
        stSame(per, ['p-tiles', 'p-volume', 'p-hours', 'p-replies']),
      "F31 ST23: the five new sections switched off stay off after a reload, on a person's chart too " +
        JSON.stringify([s1.secs, s2.secs, boxes, per]),
    );
    await stBack(p);
    await p.click('#v-stats input[data-sec="words"]');
    await p.waitForTimeout(100);
    const on = await stState(p);
    ok(
      stSame(on.secs, ['tiles', 'volume', 'top', 'heat', 'words']) && p.errors.length === 0,
      'F31 ST23: switched back on, word trends shows again; no page errors ' + JSON.stringify([on.secs, p.errors]),
    );
  });

  /* ST24: at 390 px nothing scrolls sideways with every new section showing, a word typed and very long words in a
     title and a deal, on 30 days, a tapped day and a person */
  await hcase('ST24', async () => {
    const p = await stOpen({ ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
    await p.evaluate(() => {
      const t = __rt.get('threading/current');
      t.convs[2].title = 'Supercalifragilisticexpialidocious-tent-and-stove-swap-meet-planning-thread';
      __rt.write('threading/current', t);
      const s = __rt.get('summary/current');
      s.deals[0].text = 'Tent-with-footprint-and-stakes-and-guylines-and-the-original-stuff-sack-barely-used';
      __rt.write('summary/current', s);
    });
    await until(p, () => /Supercali/.test(document.getElementById('st-body').textContent), null, 3000);
    await stType(p, 'tent');
    const wide = () =>
      p.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        w: innerWidth,
        over: [...document.querySelectorAll('#v-stats *')]
          .filter(e => e.getClientRects().length && e.getBoundingClientRect().right > innerWidth + 0.5)
          .map(e => e.tagName + '.' + (e.getAttribute('class') || ''))
          .slice(0, 5),
      }));
    const m = await wide();
    const b = await stBar(p, 'volume', 28);
    await p.touchscreen.tap(b.x, b.y);
    await p.waitForTimeout(150);
    const day = await wide();
    await p.tap('#st-body > [data-sec="top"] li:nth-child(1) button');
    await p.waitForTimeout(150);
    const per = await wide();
    const head = (await stState(p)).head;
    const fit = x => x.sw <= x.w && !x.over.length;
    ok(
      fit(m) && fit(day) && fit(per) && head === 'Ana Alvarez',
      'F31 ST24: at 390 px nothing runs past the right edge with the new sections (main, a day, a person) ' +
        JSON.stringify({ m, day, per }),
    );
    ok(p.errors.length === 0, 'F31 ST24: no page errors ' + JSON.stringify(p.errors));
  });
}

/* ---------- R13: day packs ----------
   With meta/chat.photoPack on, the page packs each finished day's stored photos into one full pack (the originals'
   bytes) and one preview pack, checks the full pack against the originals' SHA-256, repoints the slots
   ("/_blob/<pack>#<n>", and pv) and deletes the originals. Days are the chat's (meta/chat.tz, America/Los_Angeles here),
   by each message's d. The stand-in serves fetch("/_blob/<id>") from what was uploaded (opts.blobs: files from before). */
const PACK_T = { startMs: 50, idleMs: 300, waitMs: 250, gapMs: 30, delMs: 2, errMs: 300, maxErrMs: 1200 };
const GIF1 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const laDay = back => {
  const d = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
};
const b64sha = b64 => crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
/* A chat of 4 messages a day on the days `backs` (days before today, oldest first). On each day message 4j+1 has one
   photo and 4j+2 two (pad: bytes added to each). o.tweak({msgs, put, file, gifs, docs, idOf}) changes it; o.on false
   leaves the switch off. Returns {seed, files: {id: {type, b64}}, at: (i, k) => the original id}. */
function packWorld(o = {}) {
  const backs = o.backs || [5, 4, 3, 2, 1, 0];
  const msgs = [];
  backs.forEach(b => {
    for (let q = 0; q < 4; q++) msgs.push(mk(msgs.length, { d: laDay(b) }));
  });
  const files = {},
    byK = {},
    pv = {},
    gifs = [],
    docs = {},
    orig = {};
  let nb = 0;
  const put = (i, k, v) => ((byK[i] = byK[i] || {})[k] = v);
  const file = (type, b64) => {
    const id = 'a1' + String(++nb).padStart(30, '0');
    files[id] = { type, b64, sha: b64sha(b64) };
    return id;
  };
  const photo = (i, k) => {
    const id = file('image/png', phB64(i, k, o.pad || 0));
    orig[i + '.' + k] = id;
    put(i, k, '/_blob/' + id);
  };
  backs.forEach((b, j) => {
    photo(4 * j + 1, 0);
    photo(4 * j + 2, 0);
    photo(4 * j + 2, 1);
  });
  if (o.tweak) o.tweak({ msgs, put, file, photo, gifs, docs, pv, orig, backs });
  const last = msgs[msgs.length - 1];
  const meta = Object.assign({}, META, {
    lastI: last.i,
    lastMid: last.m,
    anchorMids: msgs.slice(-3).map(m => m.m),
  });
  if (o.on !== false) meta.photoPack = { on: true, at: new Date().toISOString() };
  const seed = Object.assign(SEED(), { 'meta/chat': meta }, docs);
  for (let k = 0; k < msgs.length; k += 82)
    seed['chunks/c' + String(k).padStart(4, '0')] = { start: k, msgs: msgs.slice(k, k + 82) };
  seed['photos/b0'] = { start: 0, byK, pv, gifs };
  seed.__opts = Object.assign(
    { tune: TUNE, packTune: Object.assign({}, PACK_T, o.packTune || {}), blobs: files },
    o.opts || {},
  );
  return { seed, files, orig, msgs };
}
const packsDoc = p => get(p, 'photos/packs');
const packList = async p => ((await packsDoc(p)) || {}).list || [];
const block0 = p => get(p, 'photos/b0');
const liveIds = p => p.evaluate(() => __rt.uploads.filter(u => !u.deleted).map(u => u.id));
const blobJson = async (p, id) => JSON.parse(await p.evaluate(id => __rt.blobText(id), id));
const packSt = p => txt(p, '#phpack-st');
/* A case that waits out packing's backoff opens its page on Playwright's clock (packOpen) with the backoff set to
   PACK_RETRY, which never comes round on its own while the case runs. packRetry waits until the loop is idle with its
   next try scheduled, then moves the clock to that try. K8 slept a real 1.5 s backoff and missed it on a busy runner
   (Nov 23). */
const PACK_RETRY = { errMs: 60000, maxErrMs: 60000 };
const packOpen = seed => open(seed, PAGE, { clockAt: Date.now() });
async function packRetry(p) {
  await until(p, () => !PK.busy && PK.timer && PK.backoff > 0);
  await p.clock.runFor(Math.max(0, await p.evaluate(() => PK.next - Date.now())) + 50);
}
/* the Messages view with every stored message shown, flat */
async function showAll(p) {
  await p.evaluate(() => {
    location.hash = '#messages';
    const f = document.getElementById('lay-flat');
    if (f) f.click();
    const a = document.getElementById('msg-all');
    if (a && !a.checked) a.click();
  });
  await p.waitForTimeout(150);
}

async function packs() {
  // K1-K4: eligibility, a full pack and repoint, the originals deleted, usage updated, the lease let go
  let W = packWorld({
    tweak: w => {
      /* the oldest day (5 days back) was packed before: its slots point at a pack, and photos/packs lists it */
      const day5 = w.backs.indexOf(5);
      const items = [
        [4 * day5 + 1, 0],
        [4 * day5 + 2, 0],
        [4 * day5 + 2, 1],
      ];
      const full = w.file(
        'application/json',
        Buffer.from(
          JSON.stringify({
            v: 1,
            kind: 'full',
            day: laDay(5),
            items: items.map(([i, k]) => ({ i, k, id: 'gone', type: 'image/png', sha: b64sha(PNG), b64: PNG })),
          }),
        ).toString('base64'),
      );
      const prev = w.file(
        'application/json',
        Buffer.from(
          JSON.stringify({
            v: 1,
            kind: 'preview',
            day: laDay(5),
            items: items.map(([i, k]) => ({ i, k, type: 'image/png', w: 1, h: 1, b64: PNG })),
          }),
        ).toString('base64'),
      );
      items.forEach(([i, k], n) => {
        w.put(i, k, '/_blob/' + full + '#' + n);
        (w.pv[i] = w.pv[i] || {})[k] = '/_blob/' + prev + '#' + n;
      });
      w.docs['photos/packs'] = {
        list: [{ full, pv: prev, day: laDay(5), part: 1, n: 3, bytes: 1, pvBytes: 1, at: 'x' }],
      };
      /* 3 days back: one photo still owed */
      w.put(4 * w.backs.indexOf(3) + 2, 1, null);
    },
  });
  // the files of day 5 that the tweak's photo() calls made are unused once its slots point at the pack
  const before = Object.keys(W.files);
  let p = await open(W.seed);
  await until(p, () => ((__rt.get('photos/packs') || {}).list || []).length >= 3, null, 10000);
  /* the entry it had isn't checked for leftovers yet, so after the 2 days the sweep reads all 3 (finding none: that
     pack's items name no stored file), then lets the lease go */
  await until(p, () => ((__rt.get('photos/packs') || {}).reclaim || {}).checked === 3, null, 10000);
  await until(p, () => {
    const l = __rt.leases.get('refresh/importLock');
    return l && l.exp - Date.now() <= 1000;
  });
  let list = await packList(p);
  let b0 = await block0(p);
  const dayOf = i => W.msgs[i].d;
  const slotsOn = back =>
    Object.entries(b0.byK).flatMap(([i, m]) =>
      dayOf(+i) === laDay(back) ? Object.entries(m).map(([k, v]) => ({ i: +i, k: +k, v })) : [],
    );
  const packed = back => slotsOn(back).filter(s => /#\d+$/.test(s.v));
  ok(
    list.length === 3 &&
      list[0].day === laDay(5) &&
      list[1].day === laDay(4) &&
      list[2].day === laDay(2) &&
      list.slice(1).every(e => e.part === 1 && e.n === 3 && e.bytes > 0 && e.pvBytes > 0 && e.at && e.full && e.pv),
    'K1: days 4 and 2 back are packed, oldest first; photos/packs keeps the entry it had (merged with a fresh read): ' +
      JSON.stringify(list.map(e => [e.day, e.part, e.n])),
  );
  ok(
    packed(3).length === 0 &&
      packed(1).length === 0 &&
      packed(0).length === 0 &&
      slotsOn(1).every(s => /^\/_blob\/a1\d+$/.test(s.v)) &&
      slotsOn(0).every(s => /^\/_blob\/a1\d+$/.test(s.v)),
    'K1: a day with an owed slot (3 back), yesterday and today are never packed',
  );
  const live = await liveIds(p);
  const ids = back => slotsOn(back).map(s => W.orig[s.i + '.' + s.k]);
  ok(
    packed(4).length === 3 &&
      packed(2).length === 3 &&
      ids(4)
        .concat(ids(2))
        .every(id => before.includes(id) && !live.includes(id)) &&
      ids(3)
        .concat(ids(1), ids(0))
        .filter(Boolean)
        .every(id => live.includes(id)) &&
      list.slice(1).every(e => live.includes(e.full) && live.includes(e.pv)) &&
      live.includes(list[0].full),
    'K2: every slot of the packed days points at its pack, their originals are deleted, every other file stays',
  );
  const e4 = list[1];
  const full4 = await blobJson(p, e4.full);
  const pv4 = await blobJson(p, e4.pv);
  const want = slotsOn(4).sort((a, b) => a.i - b.i || a.k - b.k);
  ok(
    full4.v === 1 &&
      full4.kind === 'full' &&
      full4.day === laDay(4) &&
      full4.items.length === 3 &&
      full4.items.every(
        (it, n) =>
          it.i === want[n].i &&
          it.k === want[n].k &&
          it.id === W.orig[it.i + '.' + it.k] &&
          it.type === 'image/png' &&
          it.b64 === W.files[it.id].b64 &&
          it.sha === W.files[it.id].sha &&
          want[n].v === '/_blob/' + e4.full + '#' + n &&
          b0.pv[it.i][it.k] === '/_blob/' + e4.pv + '#' + n,
      ),
    'K2: the full pack holds each original byte for byte with its id, type and SHA-256; byK[i][k] = full#n and ' +
      'pv[i][k] = preview#n',
  );
  ok(
    pv4.v === 1 &&
      pv4.kind === 'preview' &&
      pv4.items.length === 3 &&
      pv4.items.every((it, n) => it.i === want[n].i && it.k === want[n].k && it.type === 'image/jpeg') &&
      pv4.items.every(
        it => it.w === 1 && it.h === 1 && Buffer.from(it.b64, 'base64').slice(0, 2).toString('hex') === 'ffd8',
      ),
    'K2: the preview pack holds a JPEG per photo, in the same order, never upscaled (1×1 stays 1×1)',
  );
  const mu = (await get(p, 'meta/chat')).assetUsage;
  const ru = await p.evaluate(() => __rt.usage());
  const lease = await p.evaluate(() => {
    const l = __rt.leases.get('refresh/importLock');
    return l && { holder: l.holder, left: l.exp - Date.now() };
  });
  ok(
    mu &&
      mu.files === ru.files &&
      mu.files === before.length - 6 + 4 &&
      mu.bytes === ru.bytes &&
      /This page holds 1\d of 5,000 files \(0%\) and .* of 1 GiB\./.test(await txt(p, '#phstore-use')),
    'K3: asset usage is updated after packing (meta/chat.assetUsage ' +
      (mu && mu.files) +
      ' files = the store) and the Photo storage box shows it',
  );
  ok(
    lease && /:pack$/.test(lease.holder) && lease.left <= 1000,
    'K3: the import lease is let go between days (holder ' + (lease && lease.holder) + ')',
  );
  const st = await packSt(p);
  ok(
    /Last packed day: \w{3}, \w{3} \d+\./.test(st) &&
      /Every finished day is packed\./.test(st) &&
      /1 day waits for photos still to be stored\./.test(st) &&
      (await p.$eval('#phpack-on', e => e.checked && !e.disabled)),
    'K4: the status names the last packed day, nothing left to pack, and the day waiting for photos (' + st + ')',
  );
  // K5: display. Inline previews from the preview pack (loaded once), full size in the lightbox, unpacked as before
  await showAll(p);
  const i4 = 4 * 1 + 1;
  const iToday = 4 * 5 + 1;
  await until(p, i => (document.querySelector('#m' + i + ' .pics img') || {}).src?.startsWith('data:'), i4);
  const inline = await p.evaluate(
    ([a, b]) => ({
      a: (document.querySelector('#m' + a + ' .pics img') || {}).src || '',
      b: (document.querySelector('#m' + b + ' .pics img') || {}).getAttribute?.('src') || '',
      hash: [...document.querySelectorAll('img')].filter(im => /#\d+$/.test(im.getAttribute('src') || '')).length,
    }),
    [i4, iToday],
  );
  const pvIdOf = i => (b0.pv[i][0] || '').slice(7).split('#')[0];
  const fetched = await p.evaluate(id => __rt.fetches.filter(x => x === id).length, pvIdOf(i4));
  ok(
    inline.a.startsWith('data:image/jpeg;base64,') &&
      inline.a.slice(23) === pv4.items[0].b64 &&
      inline.b === '/_blob/' + W.orig[iToday + '.0'] &&
      inline.hash === 0,
    'K5: a packed photo shows its preview inline as a data: URL; an unpacked one keeps its /_blob/ URL; no img src ' +
      'is ever a #n value',
  );
  /* a redraw (a photos change) uses the loaded pack: no new fetch */
  await p.evaluate(() => {
    const b = __rt.get('photos/b0');
    b.note = 'redraw';
    __rt.write('photos/b0', b);
  });
  await p.waitForTimeout(300);
  const fetched2 = await p.evaluate(id => __rt.fetches.filter(x => x === id).length, pvIdOf(i4));
  ok(
    fetched2 === fetched && fetched <= 2,
    'K5: the preview pack is fetched once per page view (' +
      fetched +
      ' fetches: the check after upload and the first draw; ' +
      fetched2 +
      ' after a redraw)',
  );
  await p.click('#m' + i4 + ' .pics a');
  const lb = await until(p, () => {
    const im = document.querySelector('#lb .stage img');
    return im && /^data:image\/png/.test(im.src) ? im.src : null;
  });
  ok(
    lb === 'data:image/png;base64,' + W.files[W.orig[i4 + '.0']].b64,
    'K5: the lightbox shows the original from the full pack, byte for byte',
  );
  await p.keyboard.press('Escape');
  ok(!p.errors.length, 'K1-K5: no page errors (' + p.errors.join('; ') + ')');
  await p.close();

  // K6: a pack that can't load shows a "Photo couldn't load" tile, never a broken image
  W = packWorld({
    on: false,
    backs: [3, 0],
    tweak: w => {
      w.put(1, 0, '/_blob/' + 'f'.repeat(32) + '#0');
      w.pv[1] = { 0: '/_blob/' + 'e'.repeat(32) + '#0' };
    },
  });
  p = await open(W.seed);
  await showAll(p);
  const tile = await until(p, () => document.querySelector('#m1 .pics .phfail'));
  ok(
    !!tile &&
      (await txt(p, '#m1 .pics .phfail')) === "Photo couldn't load" &&
      !(await p.$('#m1 .pics img')) &&
      (await p.$eval(
        '#m1 .pics .phfail',
        e => e.getAttribute('role') === 'img' && /couldn't load/.test(e.getAttribute('aria-label')),
      )),
    'K6: a packed photo whose pack won\'t load is a "Photo couldn\'t load" tile (role img), with no img',
  );
  await p.click('#m1 .pics a');
  ok(
    !!(await until(p, () => document.querySelector('#lb .stage .phfail'))),
    'K6: the lightbox shows the same tile for it',
  );
  await p.close();

  // K7: the switch off: nothing happens; on from the box writes meta/chat.photoPack; no assets: can't switch it on
  W = packWorld({ on: false });
  p = await open(W.seed);
  await p.waitForTimeout(900);
  const nPack = await p.evaluate(() => __rt.uploads.filter(u => u.type === 'application/json').length);
  ok(
    nPack === 0 &&
      (await nWrites(p, '^photos/')) === 0 &&
      (await p.$eval('#phpack-on', e => !e.checked && !e.disabled)) &&
      /^Off: each photo is its own file\.$/.test(await packSt(p)),
    'K7: switch off (no meta/chat.photoPack): nothing is packed or written; the switch is off and can be turned on',
  );
  await p.click('#phstore summary');
  await p.click('#phpack-on');
  const pp = await until(p, () => (__rt.get('meta/chat') || {}).photoPack);
  await until(p, () => ((__rt.get('photos/packs') || {}).list || []).length >= 4);
  ok(
    pp && pp.on === true && pp.at && (await packList(p)).map(e => e.day).join() === [5, 4, 3, 2].map(laDay).join(),
    'K7: switching it on in the Photo storage box writes meta/chat.photoPack {on:true, at} and packs the 4 finished days',
  );
  await p.click('#phpack-on');
  ok(
    (await until(p, () => (__rt.get('meta/chat').photoPack || {}).on === false)) && /^Off/.test(await packSt(p)),
    'K7: switching it off writes {on:false} and says so',
  );
  await p.close();
  W = packWorld({ opts: { noAssets: true } });
  p = await open(W.seed);
  await p.waitForTimeout(600);
  ok(
    (await p.$eval('#phpack-on', e => e.disabled)) &&
      (await p.evaluate(() => __rt.uploads.filter(u => u.type === 'application/json').length)) === 0 &&
      /this view can't store photos/.test(await packSt(p)),
    "K7: a view without assets can't switch it, packs nothing, and says why (" + (await packSt(p)) + ')',
  );
  await p.close();

  // K8: a full pack that doesn't match the originals: nothing repointed, the new packs deleted, the originals kept,
  // the error shown; the next try (after the backoff) packs it
  W = packWorld({ on: false, backs: [2, 0], packTune: PACK_RETRY });
  p = await packOpen(W.seed);
  await setUp(p, { mangle: 1 });
  const b0before = await block0(p);
  await p.click('#phstore summary');
  await p.click('#phpack-on');
  const err = await until(p, () => (__rt.get('photos/packs') || {}).err);
  const b0after = await block0(p);
  const ups = await uploads(p);
  const jsonUps = ups.filter(u => u.type === 'application/json');
  ok(
    err &&
      err.code === 'verify' &&
      /didn't match the originals \(the photo on #1 changed\)/.test(err.msg) &&
      JSON.stringify(b0after.byK) === JSON.stringify(b0before.byK) &&
      !b0after.pv?.['1'] &&
      jsonUps.length === 2 &&
      jsonUps.every(u => u.deleted) &&
      ups.filter(u => u.type === 'image/png').every(u => !u.deleted),
    'K8: a sha mismatch: slots unchanged, both new packs deleted, every original kept, err recorded (' +
      (err && err.msg) +
      ')',
  );
  const st8 = await packSt(p);
  ok(
    /The last try failed \(.*\): the pack for .* didn't match the originals .*\. The originals are kept; it tries again at /.test(
      st8,
    ),
    'K8: the Photo storage box says the try failed, the originals are kept, and when it tries again (' + st8 + ')',
  );
  await packRetry(p);
  /* the end state, not the first part listed: the error is cleared only once the whole day has packed */
  await until(p, () => {
    const d = __rt.get('photos/packs') || {};
    return (d.list || []).length === 1 && d.err === null && !PK.busy;
  });
  const pk8 = await packsDoc(p);
  ok(
    pk8.list.length === 1 && pk8.list[0].day === laDay(2) && pk8.err === null && !/failed/.test(await packSt(p)),
    'K8: after the backoff the day packs, and the error is cleared',
  );
  await p.close();

  // K9: a refresh holding the run lock, a held import lease, or photos uploading: packing waits, then goes on
  W = packWorld({
    backs: [2, 0],
    tweak: w => (w.docs['refresh/status'] = { state: 'running', startedAt: new Date().toISOString(), step: 'scan' }),
  });
  p = await open(W.seed);
  await p.waitForTimeout(800);
  ok(
    (await packList(p)).length === 0 && /Waiting: Claude is refreshing\./.test(await packSt(p)),
    'K9: a refresh holding the run lock (started now): nothing packed, "Waiting: Claude is refreshing."',
  );
  await p.evaluate(() => __rt.write('refresh/status', { state: 'done', finishedAt: new Date().toISOString() }));
  ok(
    !!(await until(p, () => ((__rt.get('photos/packs') || {}).list || []).length === 1, null, 4000)),
    'K9: once the refresh is done, the day packs',
  );
  await p.close();
  W = packWorld({
    backs: [2, 0],
    tweak: w =>
      (w.docs['refresh/status'] = {
        state: 'running',
        startedAt: new Date(Date.now() - 25 * 60000).toISOString(),
      }),
  });
  p = await open(W.seed);
  ok(
    !!(await until(p, () => ((__rt.get('photos/packs') || {}).list || []).length === 1, null, 4000)),
    'K9: a run lock older than 20 minutes is a dead run: the day packs',
  );
  await p.close();
  W = packWorld({
    backs: [2, 0],
    opts: { leases: { 'refresh/importLock': { holder: 'other', exp: Date.now() + 120000 } } },
  });
  /* the lease is held well past the checks (a 2.5 s one lapsed before them on a busy runner, Nov 22), and the test
     ends it itself */
  p = await open(W.seed);
  const w9 = await until(p, () =>
    /Waiting: another import is running until \d+:\d\d:\d\d [AP]M\./.test(
      document.getElementById('phpack-st').textContent,
    ),
  );
  ok(
    !!w9 && (await packList(p)).length === 0,
    'K9: the import lease held by another tab: nothing packed, and the status says until when (' +
      (await packSt(p)) +
      ')',
  );
  await p.evaluate(() => __rt.leases.set('refresh/importLock', { holder: 'other', exp: Date.now() - 1 }));
  ok(
    !!(await until(p, () => ((__rt.get('photos/packs') || {}).list || []).length === 1, null, 6000)),
    'K9: once that lease lapses, the day packs',
  );
  await p.close();
  W = packWorld({
    backs: [2, 0],
    tweak: w =>
      (w.docs['refresh/lastImport'] = {
        state: 'uploading',
        at: new Date().toISOString(),
        beat: new Date().toISOString(),
      }),
  });
  p = await open(W.seed);
  await p.waitForTimeout(700);
  const up9 = (await packList(p)).length;
  await p.evaluate(() =>
    __rt.write('refresh/lastImport', { state: 'uploading', beat: new Date(Date.now() - 11 * 60000).toISOString() }),
  );
  ok(
    up9 === 0 && !!(await until(p, () => ((__rt.get('photos/packs') || {}).list || []).length === 1, null, 4000)),
    'K9: never while refresh/lastImport is "uploading" with a live heartbeat; one silent for 10 minutes is a closed ' +
      "tab's, and the day packs",
  );
  await p.close();

  // K10: a paste while a day is packing finds the import lease taken and saves nothing
  W = packWorld({ backs: [2, 0], opts: { up: { delayMs: 1500 } } });
  p = await packOpen(W.seed);
  await until(p, () => __rt.calls() > 0);
  const r10 = await paste(p, JSON.stringify(cap([mk(W.msgs.length)], { base: W.msgs.length - 1 })));
  ok(
    r10 &&
      r10.ok === false &&
      /^Another import is running in another open copy of this page, or the page is packing photos\. Nothing saved\. Try again in a minute \(after \d+:\d\d:\d\d [AP]M\)\.$/.test(
        r10.msg,
      ) &&
      (await get(p, 'meta/chat')).lastI === W.msgs.length - 1,
    'K10: a paste during packing: "Another import is running … or the page is packing photos", nothing saved (' +
      (r10 && r10.msg) +
      ')',
  );
  await setUp(p, {});
  /* the day done and the loop stopped (refresh/packing goes once there's nothing left), so packing has let its lease
     go with 1 s left; the clock passes that second, not a real sleep that a slow finish outran */
  await until(p, () => ((__rt.get('photos/packs') || {}).list || []).length === 1, null, 6000);
  await until(p, () => __rt.writes.some(w => w.p === 'refresh/packing' && w.op === 'delete') && !PK.busy);
  await p.clock.runFor(1050);
  const r10b = await paste(p, JSON.stringify(cap([mk(W.msgs.length)], { base: W.msgs.length - 1 })));
  ok(
    r10b && r10b.ok && (await get(p, 'meta/chat')).lastI === W.msgs.length,
    'K10: after the day is packed, the same paste imports (' + (r10b && r10b.msg) + ')',
  );
  await p.close();
}

async function packs2() {
  // K11: a day over partBytes is split into parts, each its own full and preview pack
  let W = packWorld({
    backs: [2, 0],
    pad: 1000,
    packTune: { partBytes: 2300 },
    tweak: w => {
      w.photo(3, 0);
      w.photo(3, 1);
    },
  });
  let p = await open(W.seed);
  await until(p, () => ((__rt.get('photos/packs') || {}).list || []).length >= 3, null, 6000);
  await p.waitForTimeout(300);
  let list = await packList(p);
  let b0 = await block0(p);
  const okParts = [];
  for (const e of list) {
    const f = await blobJson(p, e.full);
    const v = await blobJson(p, e.pv);
    okParts.push(
      f.items.length === e.n &&
        v.items.length === e.n &&
        f.items.every(
          (it, n) => b0.byK[it.i][it.k] === '/_blob/' + e.full + '#' + n && it.b64 === W.files[it.id].b64,
        ) &&
        v.items.every((it, n) => b0.pv[it.i][it.k] === '/_blob/' + e.pv + '#' + n),
    );
  }
  const live = await liveIds(p);
  ok(
    list.length === 3 &&
      list.map(e => e.part + ':' + e.n).join() === '1:2,2:2,3:1' &&
      list.every(e => e.day === laDay(2)) &&
      okParts.every(Boolean) &&
      Object.entries(W.orig)
        .filter(([s]) => +s.split('.')[0] < 4)
        .every(([, id]) => !live.includes(id)),
    'K11: 5 photos of about 1 KB with parts of 2.3 KB: 3 parts (2, 2, 1), each slot pointing at its own part and ' +
      'place, every original deleted (' +
      list.map(e => e.part + ':' + e.n).join() +
      ')',
  );
  await p.close();

  // K12: a GIF is packed byte for byte; its preview is a JPEG of its first frame; the lightbox shows the GIF
  W = packWorld({
    backs: [2, 0],
    tweak: w => {
      const id = w.file('image/gif', GIF1);
      w.orig['3.0'] = id;
      w.put(3, 0, '/_blob/' + id);
      w.gifs.push(3);
    },
  });
  p = await open(W.seed);
  await until(p, () => ((__rt.get('photos/packs') || {}).list || []).length === 1, null, 6000);
  list = await packList(p);
  const f12 = await blobJson(p, list[0].full);
  const v12 = await blobJson(p, list[0].pv);
  const g = f12.items.findIndex(it => it.i === 3);
  ok(
    g >= 0 &&
      f12.items[g].type === 'image/gif' &&
      f12.items[g].b64 === GIF1 &&
      f12.items[g].sha === b64sha(GIF1) &&
      v12.items[g].type === 'image/jpeg' &&
      v12.items[g].w === 1 &&
      v12.items[g].h === 1,
    'K12: a GIF stays byte for byte in the full pack (type image/gif); its preview is a 1×1 JPEG',
  );
  await showAll(p);
  await until(p, () => (document.querySelector('#m3 .pics img') || {}).src?.startsWith('data:'));
  await p.click('#m3 .pics a');
  ok(
    (await until(p, () => {
      const im = document.querySelector('#lb .stage img');
      return im && /^data:image\/gif/.test(im.src) ? im.src : null;
    })) ===
      'data:image/gif;base64,' + GIF1,
    'K12: the lightbox shows the GIF itself',
  );
  await p.close();

  // K13: a delete that fails for now (store_unavailable) stops the deletes; the leftover sweep deletes the rest on a
  // later turn. One refused for good (not_uploader) is an orphan, counted in photos/packs and shown.
  W = packWorld({ backs: [2, 0], opts: { up: { delFail: 1 } } });
  p = await open(W.seed);
  await until(p, () => ((__rt.get('photos/packs') || {}).reclaim || {}).checked === 1, null, 6000);
  const day13 = ['1.0', '2.0', '2.1'].map(s => W.orig[s]);
  let pk13 = await packsDoc(p);
  ok(
    !pk13.orphans &&
      pk13.reclaim.n === 3 &&
      (await liveIds(p)).filter(id => day13.includes(id)).length === 0 &&
      /3 original files left over after packing were removed/.test(await packSt(p)) &&
      !/couldn't be deleted/.test(await packSt(p)),
    'K13: a delete that fails for now: the pack stands, and the sweep deletes the 3 originals later (no orphan) (' +
      (await packSt(p)) +
      ')',
  );
  await p.close();
  W = packWorld({ backs: [2, 0], opts: { up: { delFail: 2, delCode: 'not_uploader' } } });
  p = await open(W.seed);
  await until(p, () => ((__rt.get('photos/packs') || {}).reclaim || {}).checked === 1, null, 6000);
  pk13 = await packsDoc(p);
  ok(
    pk13.orphans === 1 &&
      pk13.reclaim.n === 2 &&
      (await liveIds(p)).filter(id => day13.includes(id)).length === 1 &&
      /1 original file couldn't be deleted after packing\. Ask Claude to tidy up photo storage/.test(await packSt(p)),
    'K13: a delete refused for good: photos/packs.orphans is 1, the other 2 go, and the box says Cleanup removes it (' +
      (await packSt(p)) +
      ')',
  );
  await p.close();

  // K14: an already packed slot is never packed again; an unpacked slot on a packed day goes in a new part
  W = packWorld({ backs: [2, 0] });
  p = await open(W.seed);
  await until(p, () => ((__rt.get('photos/packs') || {}).list || []).length === 1, null, 6000);
  const id14 = await p.evaluate(async () => {
    const r = await (await claude.use('assets')).upload(new Blob(['x'], { type: 'image/png' }), { type: 'image/png' });
    const b = __rt.get('photos/b0');
    b.byK['3'] = { 0: '/_blob/' + r.id };
    __rt.write('photos/b0', b);
    return r.id;
  });
  await until(p, () => ((__rt.get('photos/packs') || {}).list || []).length === 2, null, 6000);
  list = await packList(p);
  b0 = await block0(p);
  const f14 = await blobJson(p, list[1].full);
  ok(
    list[1].day === laDay(2) &&
      list[1].part === 2 &&
      list[1].n === 1 &&
      f14.items.length === 1 &&
      f14.items[0].id === id14 &&
      b0.byK['1'][0].startsWith('/_blob/' + list[0].full + '#'),
    'K14: a photo stored later on a packed day goes in part 2 alone; the packed slots are left as they are',
  );
  await p.close();

  // K15: the preview of a phone-sized photo (measured): at most 320 px on the long side, JPEG quality 0.72
  const gen = await browser.newPage();
  const big = await gen.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 960;
    c.height = 1280;
    const g = c.getContext('2d');
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const sky = g.createLinearGradient(0, 0, 0, 1280);
    sky.addColorStop(0, '#7fa8d8');
    sky.addColorStop(0.55, '#d9e4ea');
    sky.addColorStop(0.56, '#5d6b3a');
    sky.addColorStop(1, '#2f3a1e');
    g.fillStyle = sky;
    g.fillRect(0, 0, 960, 1280);
    for (let k = 0; k < 260; k++) {
      g.fillStyle =
        'hsla(' +
        Math.floor(rnd() * 360) +
        ',' +
        Math.floor(20 + rnd() * 50) +
        '%,' +
        Math.floor(20 + rnd() * 60) +
        '%,' +
        (0.2 + rnd() * 0.6) +
        ')';
      g.beginPath();
      g.ellipse(rnd() * 960, rnd() * 1280, 4 + rnd() * 90, 4 + rnd() * 60, rnd() * 3, 0, 7);
      g.fill();
    }
    const im = g.getImageData(0, 0, 960, 1280);
    for (let k = 0; k < im.data.length; k += 4) {
      const n = (rnd() - 0.5) * 18;
      im.data[k] += n;
      im.data[k + 1] += n;
      im.data[k + 2] += n;
    }
    g.putImageData(im, 0, 0);
    return c.toDataURL('image/jpeg', 0.5).split(',')[1];
  });
  await gen.close();
  W = packWorld({
    backs: [2, 0],
    tweak: w => {
      const id = w.file('image/jpeg', big);
      w.orig['3.0'] = id;
      w.put(3, 0, '/_blob/' + id);
    },
  });
  p = await open(W.seed);
  await until(p, () => ((__rt.get('photos/packs') || {}).list || []).length === 1, null, 6000);
  list = await packList(p);
  const v15 = await blobJson(p, list[0].pv);
  const it15 = v15.items.find(it => it.i === 3);
  const kb = n => (n / 1024).toFixed(1) + ' KB';
  const pvBytes = Buffer.from(it15.b64, 'base64').length;
  console.log(
    '    preview of a 960×1280 JPEG of ' +
      kb(Buffer.from(big, 'base64').length) +
      ': ' +
      it15.w +
      '×' +
      it15.h +
      ', ' +
      kb(pvBytes) +
      '; the preview pack for the day: ' +
      kb(list[0].pvBytes) +
      ' (' +
      v15.items.length +
      ' photos)',
  );
  ok(
    it15.w === 240 && it15.h === 320 && pvBytes < 40000,
    'K15: a 960×1280 photo previews at 240×320 (' + kb(pvBytes) + ')',
  );
  ok(!p.errors.length, 'K11-K15: no page errors (' + p.errors.join('; ') + ')');
  await p.close();
}

/* ---------- v1.31.3: originals packing left behind ----------
   Up to v1.31.2 packing checked each block on its own, merged with the old photos/index, which still names every
   original: a day whose photos sat in two or more blocks kept all of its originals as unused files (on a live page, 10
   of 12 packed days). spanWorld: o.days [[back, messages]] oldest first, so a day can cross the 500-message photo
   blocks; o.photos [[i, k]] stored as originals in the old index, as on a page from before v1.22 (o.inBlocks: in their
   blocks, as since). o.tweak(w) changes it: w.put(i, k, v, true) writes a slot in its block instead, w.file(type, b64)
   stores a file, w.docs adds documents. Returns w with seed. */
function spanWorld(o) {
  const msgs = [];
  o.days.forEach(([b, n]) => {
    for (let q = 0; q < n; q++) msgs.push(mk(msgs.length, { d: laDay(b) }));
  });
  const w = { msgs, files: {}, orig: {}, docs: Object.assign({}, o.docs || {}), blocks: {} };
  const index = { byI: {}, byK: {}, gifs: [] };
  let nb = 0;
  w.file = (type, b64) => {
    const id = 'a3' + String(++nb).padStart(30, '0');
    w.files[id] = { type, b64, sha: b64sha(b64) };
    return id;
  };
  w.blk = i => {
    const s = Math.floor(i / 500) * 500;
    return (w.blocks['b' + s] = w.blocks['b' + s] || { start: s, byK: {}, pv: {}, gifs: [] });
  };
  w.put = (i, k, v, inBlock) => {
    const m = inBlock ? w.blk(i).byK : index.byK;
    (m[i] = m[i] || {})[k] = v;
  };
  (o.photos || []).forEach(([i, k]) => {
    const id = w.file('image/png', phB64(i, k));
    w.orig[i + '.' + k] = id;
    w.put(i, k, '/_blob/' + id, o.inBlocks);
  });
  if (o.tweak) o.tweak(w);
  const last = msgs[msgs.length - 1];
  const meta = Object.assign({}, META, { lastI: last.i, lastMid: last.m, anchorMids: msgs.slice(-3).map(m => m.m) });
  meta.photoPack = { on: true, at: new Date().toISOString() };
  w.seed = Object.assign(SEED(), { 'meta/chat': meta, 'photos/index': index }, w.docs);
  for (let k = 0; k < msgs.length; k += 82)
    w.seed['chunks/c' + String(k).padStart(4, '0')] = { start: k, msgs: msgs.slice(k, k + 82) };
  Object.entries(w.blocks).forEach(([id, b]) => (w.seed['photos/' + id] = b));
  w.seed.__opts = Object.assign(
    { tune: TUNE, packTune: Object.assign({}, PACK_T, o.packTune || {}), blobs: w.files },
    o.opts || {},
  );
  return w;
}
/* A day packed by v1.30.0-v1.31.2 that left its originals behind: a full pack of the slots (each original's bytes, id
   and SHA-256) and a preview pack, the slots (in their blocks) and pv pointing at them, an entry in photos/packs, and
   the originals still stored (and named by the old index, unless spanWorld put them in blocks). o.mangle changes a
   photo in the full pack after its SHA-256 was taken (a pack that fails its check); o.missing leaves the full pack
   unstored; o.garbage stores it as text that isn't JSON. Returns the entry. */
function oldPack(w, back, slots, o = {}) {
  const day = laDay(back);
  const items = slots.map(([i, k]) => {
    const b64 = phB64(i, k);
    return { i, k, id: w.orig[i + '.' + k], type: 'image/png', sha: b64sha(b64), b64 };
  });
  if (o.mangle) items[1].b64 = (items[1].b64[0] === 'A' ? 'B' : 'A') + items[1].b64.slice(1);
  const j = v => Buffer.from(JSON.stringify(v)).toString('base64');
  const full = w.file('application/json', j({ v: 1, kind: 'full', day, items }));
  const pvItems = items.map(({ i, k }) => ({ i, k, type: 'image/png', w: 1, h: 1, b64: PNG }));
  const pv = w.file('application/json', j({ v: 1, kind: 'preview', day, items: pvItems }));
  items.forEach(({ i, k }, n) => {
    w.put(i, k, '/_blob/' + full + '#' + n, true);
    const b = w.blk(i);
    (b.pv[i] = b.pv[i] || {})[k] = '/_blob/' + pv + '#' + n;
  });
  if (o.missing) delete w.files[full];
  if (o.garbage) w.files[full] = { type: 'application/json', b64: Buffer.from('{"v":1,"kind":"fu').toString('base64') };
  const P = (w.docs['photos/packs'] = w.docs['photos/packs'] || { list: [] });
  const at = new Date(Date.now() - back * 86400000).toISOString();
  const e = { full, pv, day, part: 1, n: items.length, bytes: 1, pvBytes: 1, at };
  P.list.push(e);
  return e;
}
const reclaimOf = async p => ((await packsDoc(p)) || {}).reclaim || {};
/* the leftover sweep's documents, photos/swept-<key>, by key */
const sweptOf = p =>
  p.evaluate(() =>
    Object.fromEntries([...__rt.store].filter(([k]) => /^photos\/swept-/.test(k)).map(([k, v]) => [k.slice(13), v])),
  );
/* Cleanup's rule, as references/photos.md › Cleanup gives it to Claude: referenced = every "/_blob/<id>" in any photos
   document (the old index as it is), plus every photos/packs entry's full and pv; unused = stored files not referenced;
   while any swept document is lost, only duplicates (same SHA-256 as a referenced file) may be deleted. deletable: the
   files Cleanup could delete. */
const cleanupView = p =>
  p.evaluate(() => {
    const refs = new Set();
    const walk = v => {
      const m = typeof v === 'string' ? /^\/_blob\/([^#?\s/]+)/.exec(v) : null;
      if (m) refs.add(m[1]);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    const docs = [...__rt.store].filter(([k]) => /^photos\//.test(k));
    docs.forEach(([, v]) => walk(v));
    ((__rt.get('photos/packs') || {}).list || []).forEach(e => e && [e.full, e.pv].forEach(x => x && refs.add(x)));
    const lost = docs.some(([k, v]) => /^photos\/swept-/.test(k) && v && v.lost);
    const live = __rt.uploads.filter(u => !u.deleted);
    const refHash = new Set(live.filter(u => refs.has(u.id)).map(u => u.hash));
    const unused = live.filter(u => !refs.has(u.id));
    const deletable = unused.filter(u => !lost || (u.hash && refHash.has(u.hash))).map(u => u.id);
    return { refs: [...refs], lost, unused: unused.map(u => u.id), deletable };
  });
const nFiles = p => p.evaluate(() => __rt.usage().files);
/* the original ids of these slots ("i.k") */
const origs = (w, ss) => ss.map(s => w.orig[s]);

async function packs3() {
  // S1: a day across three blocks (b0, b500, b1000) and one across two (b1000, b1500), their originals in the old
  // index; the oldest day sits in one block (the case that worked before)
  let W = spanWorld({
    days: [
      [6, 499],
      [4, 502],
      [3, 520],
      [1, 5],
      [0, 5],
    ],
    photos: [
      [10, 0],
      [20, 0],
      [20, 1],
      [499, 0],
      [499, 1],
      [700, 0],
      [1000, 0],
      [1100, 0],
      [1499, 0],
      [1500, 0],
      [1510, 0],
      [1522, 0],
      [1527, 0],
    ],
  });
  const n1 = Object.keys(W.files).length;
  let p = await open(W.seed);
  await until(p, () => ((__rt.get('photos/packs') || {}).list || []).length >= 3, null, 20000);
  /* the last day's deletes come after its entry: wait for the count to settle (on v1.31.2 it never gets there) */
  await until(p, n => __rt.usage().files <= n, n1 - 5, 5000);
  let list = await packList(p);
  let st = await photoState(p);
  let live = await liveIds(p);
  const span = (a, b) => Object.keys(W.orig).filter(s => +s.split('.')[0] >= a && +s.split('.')[0] <= b);
  const onPack = (ss, e) =>
    ss.every(s => {
      const [i, k] = s.split('.');
      return new RegExp('^/_blob/' + e.full + '#\\d+$').test(st.byK[i][k]);
    });
  ok(
    list.map(e => e.day).join() === [6, 4, 3].map(laDay).join() &&
      onPack(span(0, 498), list[0]) &&
      onPack(span(499, 1000), list[1]) &&
      onPack(span(1001, 1520), list[2]) &&
      origs(W, span(499, 1520)).every(id => !live.includes(id)) &&
      origs(W, span(0, 498)).every(id => !live.includes(id)) &&
      origs(W, span(1521, 1530)).every(id => live.includes(id)) &&
      list.every(e => live.includes(e.full) && live.includes(e.pv)),
    'S1: a day across three blocks and a day across two, their originals in the old index: every slot points at its ' +
      "pack and every original is deleted; yesterday's and today's files stay " +
      JSON.stringify(origs(W, span(0, 1520)).map(id => live.includes(id))),
  );
  const f1 = await nFiles(p);
  ok(
    f1 === n1 - (3 - 2) - (4 - 2) - (4 - 2),
    "S1: the file count falls by each packed day's photos less its 2 packs (3, 4 and 4 photos: " +
      n1 +
      ' → ' +
      f1 +
      ', want ' +
      (n1 - 5) +
      ')',
  );
  let R = await reclaimOf(p);
  const reads = await p.evaluate(
    ids => ids.map(id => __rt.fetches.filter(x => x === id).length),
    [list[0].full, list[1].full, list[2].full],
  );
  ok(
    R.checked === 3 && R.last === list[2].full && !R.n && reads.join() === '1,1,1' && !p.errors.length,
    'S1: a pack that left nothing behind is marked checked (photos/packs.reclaim.checked 3), so the leftover sweep ' +
      'never reads it again: each full pack was read once, by its own check; no page errors ' +
      JSON.stringify({ R, reads, errors: p.errors }),
  );
  await p.close();

  // S2: an original another slot still uses (yesterday's, outside the day) stays; the rest of the day's go; while it
  // packs, refresh/packing names this tab: written once when the work starts, deleted once at the end
  W = spanWorld({
    days: [
      [3, 498],
      [2, 6],
      [1, 3],
      [0, 3],
    ],
    photos: [
      [498, 0],
      [501, 0],
      [502, 0],
    ],
    tweak: w => w.put(505, 0, '/_blob/' + w.orig['501.0'], true),
  });
  p = await open(W.seed);
  await until(p, () => ((__rt.get('photos/packs') || {}).list || []).length >= 1, null, 10000);
  await until(p, () => __rt.usage().files <= 3, null, 5000);
  await until(p, () => __rt.writes.some(w => w.p === 'refresh/packing' && w.op === 'delete'), null, 5000);
  list = await packList(p);
  st = await photoState(p);
  live = await liveIds(p);
  ok(
    list.length === 1 &&
      onPack(['498.0', '501.0', '502.0'], list[0]) &&
      st.byK[505][0] === '/_blob/' + W.orig['501.0'] &&
      live.includes(W.orig['501.0']) &&
      origs(W, ['498.0', '502.0']).every(id => !live.includes(id)) &&
      (await nFiles(p)) === 3,
    "S2: a day across two blocks: its originals are deleted, except the one yesterday's slot still uses (#505 shows " +
      'it as before) ' +
      JSON.stringify(origs(W, ['498.0', '501.0', '502.0']).map(id => live.includes(id))),
  );
  const busy = await p.evaluate(() =>
    __rt.writes.filter(w => w.p === 'refresh/packing').map(w => (w.op === 'delete' ? 'delete' : w.v)),
  );
  const packsBusy = await p.evaluate(
    () => __rt.writes.filter(w => w.p === 'photos/packs' && w.v && 'busy' in w.v).length,
  );
  ok(
    busy.length === 2 &&
      typeof busy[0].tab === 'string' &&
      busy[0].tab &&
      !isNaN(Date.parse(busy[0].at)) &&
      busy[1] === 'delete' &&
      packsBusy === 0 &&
      !(await get(p, 'refresh/packing')),
    'S2: while it packs, refresh/packing {tab, at} names this tab: one write when the work starts, one delete at the ' +
      'end, and nothing about it in photos/packs ' +
      JSON.stringify({ busy, packsBusy }),
  );
  await p.close();

  // R1: a page that packed with v1.30.0-v1.31.2. Day 5's leftovers go; day 4's pack fails its check, so it gives up
  // nothing; on day 3, the original today's #36 also uses stays and one that's already gone is skipped; a pack that's
  // missing (day 6) gives up nothing; a file in no pack and no slot stays (Cleanup's to find). In batches of 2.
  W = spanWorld({
    days: [
      [5, 10],
      [4, 10],
      [3, 10],
      [1, 4],
      [0, 4],
    ],
    photos: [
      [1, 0],
      [2, 0],
      [2, 1],
      [11, 0],
      [12, 0],
      [12, 1],
      [21, 0],
      [22, 0],
      [22, 1],
      [23, 0],
      [31, 0],
      [35, 0],
    ],
    packTune: { sweepMax: 2 },
    tweak: w => {
      const at = new Date(Date.now() - 6 * 86400000).toISOString();
      w.docs['photos/packs'] = {
        list: [{ full: 'f'.repeat(32), pv: 'e'.repeat(32), day: laDay(6), part: 1, n: 2, bytes: 1, pvBytes: 1, at }],
      };
      oldPack(w, 5, [
        [1, 0],
        [2, 0],
        [2, 1],
      ]);
      oldPack(
        w,
        4,
        [
          [11, 0],
          [12, 0],
          [12, 1],
        ],
        { mangle: true },
      );
      delete w.files[w.orig['23.0']];
      oldPack(w, 3, [
        [21, 0],
        [22, 0],
        [22, 1],
        [23, 0],
      ]);
      w.put(36, 0, '/_blob/' + w.orig['22.1'], true);
      w.stray = w.file('image/png', phB64(99, 0));
    },
  });
  const r1 = Object.keys(W.files).length;
  p = await open(W.seed);
  await until(p, () => ((__rt.get('photos/packs') || {}).reclaim || {}).checked === 4, null, 15000);
  list = await packList(p);
  live = await liveIds(p);
  const gone1 = origs(W, ['1.0', '2.0', '2.1', '21.0', '22.0']);
  const kept1 = origs(W, ['11.0', '12.0', '12.1', '22.1', '31.0', '35.0']).concat(W.stray);
  ok(
    gone1.every(id => !live.includes(id)) &&
      kept1.every(id => live.includes(id)) &&
      list.slice(1).every(e => live.includes(e.full) && live.includes(e.pv)) &&
      (await nFiles(p)) === r1 - 5,
    "R1: the leftovers of the packs that check out are deleted (5); the failed pack's 3 originals, the one #36 still " +
      'uses, a stray file and every pack stay ' +
      JSON.stringify({ gone: gone1.map(id => live.includes(id)), kept: kept1.map(id => live.includes(id)) }),
  );
  R = await reclaimOf(p);
  let sw = await sweptOf(p);
  const sw4 = sw[list[2].full] || {};
  const swMiss = sw['f'.repeat(32)] || {};
  ok(
    R.n === 5 &&
      R.last === list[3].full &&
      JSON.stringify(R.swept) === JSON.stringify(['f'.repeat(32), list[2].full]) &&
      Object.keys(sw).length === 2 &&
      swMiss.lost === true &&
      swMiss.bad === 'missing' &&
      swMiss.day === laDay(6) &&
      !swMiss.kept.length &&
      sw4.lost === false &&
      sw4.bad === 'the photo on #12 changed' &&
      JSON.stringify(sw4.kept.slice().sort()) ===
        JSON.stringify(
          origs(W, ['11.0', '12.0', '12.1'])
            .map(id => '/_blob/' + id)
            .sort(),
        ) &&
      !isNaN(Date.parse(R.at)) &&
      !(await packsDoc(p)).orphans,
    'R1: photos/packs.reclaim records 5 deleted; a swept document for each pack that failed: the missing one (lost) ' +
      'and the changed one, which keeps its 3 originals as /_blob/ ids ' +
      JSON.stringify({ R, sw }),
  );
  const ns = await p.evaluate(() =>
    __rt.writes.filter(w => w.p === 'photos/packs').map(w => ((w.v || {}).reclaim || {}).n || 0),
  );
  const steps = ns.slice(1).map((n, k) => n - ns[k]);
  ok(
    steps.every(d => d >= 0 && d <= 2) && steps.filter(d => d > 0).length >= 3,
    'R1: in batches of at most sweepMax (2) deletions ' + JSON.stringify(ns),
  );
  await until(p, () => __rt.writes.some(w => w.p === 'refresh/packing' && w.op === 'delete'), null, 5000);
  const busy1 = await p.evaluate(() => __rt.writes.filter(w => w.p === 'refresh/packing').map(w => w.op));
  ok(
    busy1.join() === 'set,delete',
    'R1: the whole sweep (several batches) writes refresh/packing once and deletes it once ' + JSON.stringify(busy1),
  );
  st = await packSt(p);
  ok(
    /5 original files left over after packing were removed \(last \w{3}, \w{3} \d+[^)]*\d:\d\d [AP]M\)\./.test(st) &&
      st.includes(
        'The pack for ' +
          (await p.evaluate(d => dayTitle(d), laDay(4))) +
          " didn't pass a check, so the 3 original files it holds are kept.",
      ) &&
      st.includes(
        'The pack for ' +
          (await p.evaluate(d => dayTitle(d), laDay(6))) +
          " is missing or can't be read, so its photos can't show. Cleanup deletes only duplicate files while it's " +
          'like this.',
      ) &&
      !/still to check|couldn't be deleted/.test(st) &&
      !p.errors.length,
    'R1: the Photo storage box says how many leftovers were removed and which packs kept their originals; no page ' +
      'errors (' +
      st +
      ') ' +
      JSON.stringify(p.errors),
  );
  await p.close();

  // R2: the sweep waits like packing: never while a refresh holds the run lock; once it's done, it goes on. Here the
  // listing doesn't cover every file (usage counts 3 it doesn't list), so whether a file is gone is read file by file
  const seed2 = JSON.parse(JSON.stringify(W.seed));
  seed2['refresh/status'] = { state: 'running', startedAt: new Date().toISOString(), step: 'scan' };
  seed2.__opts.assetUse = { files: 3, bytes: 0 };
  p = await open(seed2);
  const w2 = await until(p, () =>
    /Waiting: Claude is refreshing\./.test(document.getElementById('phpack-st').textContent),
  );
  const live2 = await liveIds(p);
  ok(
    !!w2 &&
      gone1.every(id => live2.includes(id)) &&
      /Removing original files left over after packing: 4 packs still to check\./.test(await packSt(p)),
    'R2: while a refresh holds the run lock nothing is deleted, and the box says it waits and how many packs are ' +
      'still to check (' +
      (await packSt(p)) +
      ')',
  );
  await p.evaluate(() => __rt.write('refresh/status', { state: 'done', finishedAt: new Date().toISOString() }));
  await until(p, () => ((__rt.get('photos/packs') || {}).reclaim || {}).checked === 4, null, 15000);
  live = await liveIds(p);
  R = await reclaimOf(p);
  ok(
    gone1.every(id => !live.includes(id)) && kept1.every(id => live.includes(id)) && R.n === 5,
    'R2: once the refresh is done the same 5 leftovers go, with a listing that misses files ' +
      JSON.stringify({ gone: gone1.map(id => live.includes(id)), kept: kept1.map(id => live.includes(id)), R }) +
      ' ' +
      (await packSt(p)),
  );
  await p.close();

  // R3: the lease held by another open copy that's packing (refresh/packing names it, written just now): the box says
  // so; once that record is 11 minutes old (a closed tab's), it's the lease's own wording again
  W = spanWorld({
    days: [
      [2, 4],
      [0, 2],
    ],
    photos: [[1, 0]],
    docs: { 'refresh/packing': { tab: 'zz', at: new Date().toISOString() } },
    opts: { leases: { 'refresh/importLock': { holder: 'zz:pack', exp: Date.now() + 120000 } } },
  });
  p = await open(W.seed);
  const w3 = await until(p, () =>
    /Waiting: packing is running in another open copy of this page\./.test(
      document.getElementById('phpack-st').textContent,
    ),
  );
  const st3 = await packSt(p);
  const packed3 = (await packList(p)).length;
  await p.evaluate(() =>
    __rt.write('refresh/packing', { tab: 'zz', at: new Date(Date.now() - 11 * 60000).toISOString() }),
  );
  const w3b = await until(p, () =>
    /Waiting: another import is running until \d+:\d\d:\d\d [AP]M\./.test(
      document.getElementById('phpack-st').textContent,
    ),
  );
  ok(
    !!w3 && !!w3b && packed3 === 0,
    'R3: the import lease held by another copy that is packing: "Waiting: packing is running in another open copy ' +
      'of this page." (' +
      st3 +
      "); once that busy record is 11 minutes old (a closed tab's), the lease's own wording again (" +
      (await packSt(p)) +
      ')',
  );
  await p.close();

  // R4: packs that left nothing and no unused file anywhere: every entry is marked checked without reading a pack
  W = spanWorld({
    days: [
      [3, 6],
      [0, 2],
    ],
    photos: [
      [1, 0],
      [2, 0],
    ],
    tweak: w => {
      oldPack(w, 3, [
        [1, 0],
        [2, 0],
      ]);
      origs(w, ['1.0', '2.0']).forEach(id => delete w.files[id]);
    },
  });
  p = await open(W.seed);
  await until(p, () => ((__rt.get('photos/packs') || {}).reclaim || {}).checked === 1, null, 8000);
  list = await packList(p);
  R = await reclaimOf(p);
  const reads4 = await p.evaluate(id => __rt.fetches.filter(x => x === id).length, list[0].full);
  const w4 = await p.evaluate(() => ({
    packing: __rt.writes.filter(w => w.p === 'refresh/packing').length,
    packs: __rt.writes.filter(w => w.p === 'photos/packs').length,
  }));
  ok(
    R.checked === 1 &&
      R.last === list[0].full &&
      !R.n &&
      reads4 === 0 &&
      !/still to check/.test(await packSt(p)) &&
      w4.packing === 0 &&
      w4.packs === 1,
    'R4: with no unused file the old entries are marked checked without reading their packs, in one write to ' +
      'photos/packs and none to refresh/packing (no work started) ' +
      JSON.stringify({ R, reads4, w4 }),
  );
  await p.close();

  // R5: some leftovers were removed already (Cleanup, or another copy): day 5's pack lost 2 of its 4 originals and
  // day 4's both, and the listing still shows one of day 3's that's gone (a ghost: it 404s). Each pack checks out from
  // its own bytes and SHA-256; the 2 originals still stored go; the missing ones are skipped quietly: never passed to
  // delete, and no error, orphan, kept file or failed pack
  W = spanWorld({
    days: [
      [5, 6],
      [4, 6],
      [3, 6],
      [0, 2],
    ],
    photos: [
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [7, 0],
      [8, 0],
      [13, 0],
      [14, 0],
    ],
    tweak: w => {
      oldPack(w, 5, [
        [1, 0],
        [2, 0],
        [3, 0],
        [4, 0],
      ]);
      oldPack(w, 4, [
        [7, 0],
        [8, 0],
      ]);
      oldPack(w, 3, [
        [13, 0],
        [14, 0],
      ]);
      origs(w, ['1.0', '3.0', '7.0', '8.0', '13.0']).forEach(id => delete w.files[id]);
    },
    opts: {},
  });
  W.seed.__opts.listGhosts = origs(W, ['13.0']);
  const r5 = Object.keys(W.files).length;
  p = await open(W.seed);
  await until(p, () => ((__rt.get('photos/packs') || {}).reclaim || {}).checked === 3, null, 10000);
  live = await liveIds(p);
  const pk5 = await packsDoc(p);
  R = pk5.reclaim;
  const dels5 = await p.evaluate(() => __rt.deletes.slice());
  const missing5 = origs(W, ['1.0', '3.0', '7.0', '8.0', '13.0']);
  st = await packSt(p);
  ok(
    origs(W, ['2.0', '4.0', '14.0']).every(id => !live.includes(id)) &&
      (await nFiles(p)) === r5 - 3 &&
      R.n === 3 &&
      !Object.keys(await sweptOf(p)).length &&
      !pk5.orphans &&
      !pk5.err &&
      dels5.length === 3 &&
      !dels5.some(id => missing5.includes(id)) &&
      /^Last packed day: .*\. Every finished day is packed\. 3 original files left over after packing were removed \(last [^)]+\)\.$/.test(
        st,
      ) &&
      !p.errors.length,
    'R5: originals already removed are skipped quietly (never passed to delete; no error, orphan, kept file or ' +
      'failed pack); the packs check out from their own bytes, and the 3 still stored go (' +
      st +
      ') ' +
      JSON.stringify({ R, dels: dels5.length, errors: p.errors }),
  );
  await p.close();
}

/* PR #58's review: what the sweep keeps is never left unprotected, refusals are counted once, it survives a failed
   listing, broken entries and a runtime that lists in pages, and the box tells each cause apart */
const tidyDone = (p, n) => until(p, n => ((__rt.get('photos/packs') || {}).reclaim || {}).checked === n, n, 15000);
async function packs4() {
  let W, p, R, sw, cv, st, live;
  const titleOf = (p, back) => p.evaluate(d => dayTitle(d), laDay(back));

  // V1: deletes refused for that file (not_uploader) are recorded once and skipped: 3 refusals with batches of 2
  // count 3 orphans, each file is tried once, and the sweep moves on (before, it retried them for ever)
  W = spanWorld({
    days: [
      [5, 6],
      [0, 2],
    ],
    photos: [
      [1, 0],
      [2, 0],
      [3, 0],
    ],
    inBlocks: true,
    packTune: { sweepMax: 2 },
    opts: { up: { delFail: 100, delCode: 'not_uploader' } },
    tweak: w =>
      oldPack(w, 5, [
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
  });
  p = await open(W.seed);
  await tidyDone(p, 1);
  const pk1 = await packsDoc(p);
  sw = (await sweptOf(p))[pk1.list[0].full] || {};
  live = await liveIds(p);
  cv = await cleanupView(p);
  const dels1 = await p.evaluate(() => __rt.deletes.slice());
  const day1 = origs(W, ['1.0', '2.0', '3.0']);
  ok(
    pk1.orphans === 3 &&
      JSON.stringify((sw.refused || []).slice().sort()) === JSON.stringify(day1.slice().sort()) &&
      !sw.kept.length &&
      !sw.own.length &&
      dels1.length === 3 &&
      day1.every(id => live.includes(id) && cv.deletable.includes(id)) &&
      /3 original files couldn't be deleted after packing\. Ask Claude to tidy up photo storage/.test(await packSt(p)),
    'V1: 3 deletes refused for good: orphans 3, each file tried once and recorded (refused, bare, so Cleanup can still ' +
      'remove them), the entry checked ' +
      JSON.stringify({ orphans: pk1.orphans, sw, dels: dels1.length }),
  );
  await p.close();
  // ... and a refusal for the whole view (not_granted) counts nothing: the batch stops with an error and is tried later
  W.seed.__opts.up = { delFail: 100, delCode: 'not_granted' };
  p = await open(W.seed);
  const err1 = await until(p, () => (__rt.get('photos/packs') || {}).err, null, 10000);
  const pk1b = await packsDoc(p);
  ok(
    err1 &&
      err1.code === 'not_granted' &&
      /this view can't delete files \(not_granted\)/.test(err1.msg) &&
      !pk1b.orphans &&
      !Object.keys(await sweptOf(p)).length &&
      ((pk1b.reclaim || {}).checked || 0) === 0 &&
      /The last try failed .*this view can't delete files \(not_granted\)\. The originals are kept/.test(
        await packSt(p),
      ),
    "V1: a refusal for the whole view counts no orphan and records nothing; the box says the view can't delete files " +
      '(' +
      (await packSt(p)) +
      ')',
  );
  await p.close();

  // V2: packs whose photos can't be read (one missing, one not JSON) keep what can be named (the originals the old
  // index names), and hold Cleanup to duplicates, so an original only the lost pack knew (stored in a block) is never
  // deletable; the box says so
  W = spanWorld({
    days: [
      [5, 6],
      [4, 6],
      [0, 2],
    ],
    photos: [
      [1, 0],
      [7, 0],
    ],
    tweak: w => {
      [
        [2, 0],
        [8, 0],
      ].forEach(([i, k]) => {
        const id = w.file('image/png', phB64(i, k));
        w.orig[i + '.' + k] = id;
        w.put(i, k, '/_blob/' + id, true);
      });
      oldPack(
        w,
        5,
        [
          [1, 0],
          [2, 0],
        ],
        { missing: true },
      );
      oldPack(
        w,
        4,
        [
          [7, 0],
          [8, 0],
        ],
        { garbage: true },
      );
    },
  });
  p = await open(W.seed);
  await tidyDone(p, 2);
  const list2 = await packList(p);
  sw = await sweptOf(p);
  cv = await cleanupView(p);
  live = await liveIds(p);
  const s5 = sw[list2[0].full] || {},
    s4 = sw[list2[1].full] || {};
  st = await packSt(p);
  ok(
    s5.lost === true &&
      s5.bad === 'missing' &&
      JSON.stringify(s5.kept) === JSON.stringify(['/_blob/' + W.orig['1.0']]) &&
      s4.lost === true &&
      s4.bad === 'unreadable' &&
      JSON.stringify(s4.kept) === JSON.stringify(['/_blob/' + W.orig['7.0']]) &&
      origs(W, ['1.0', '2.0', '7.0', '8.0']).every(id => live.includes(id)) &&
      cv.lost &&
      origs(W, ['2.0', '8.0']).every(id => cv.unused.includes(id) && !cv.deletable.includes(id)),
    'V2: a missing and an unreadable pack are lost: each keeps the original the old index names, and Cleanup may ' +
      "delete only duplicates, so the originals only those packs knew can't be deleted " +
      JSON.stringify({ s5, s4, deletable: cv.deletable.length }),
  );
  ok(
    st.includes(
      'The packs for ' +
        (await titleOf(p, 5)) +
        ', ' +
        (await titleOf(p, 4)) +
        " are missing or can't be read, so their photos can't show. The page keeps the 2 original files it can name " +
        "for them, and Cleanup deletes only duplicate files while they're like this.",
    ) && !p.errors.length,
    'V2: the box says which packs are lost, what the page keeps, and that Cleanup deletes duplicates only (' + st + ')',
  );
  await p.close();

  // V3: nothing kept is ever cut short: a failed pack of 1,001 photos keeps all 1,001 originals in its swept document,
  // and Cleanup's rule counts every one as in use
  W = spanWorld({
    days: [
      [5, 1002],
      [0, 2],
    ],
    photos: range(1, 1001, i => [i, 0]),
    inBlocks: true,
    tweak: w =>
      oldPack(
        w,
        5,
        range(1, 1001, i => [i, 0]),
        { mangle: true },
      ),
  });
  p = await open(W.seed);
  await tidyDone(p, 1);
  const list3 = await packList(p);
  sw = (await sweptOf(p))[list3[0].full] || {};
  cv = await cleanupView(p);
  const all3 = range(1, 1001, i => W.orig[i + '.0']);
  ok(
    (sw.kept || []).length === 1001 &&
      all3.every(id => cv.refs.includes(id)) &&
      (await nFiles(p)) === Object.keys(W.files).length,
    "V3: a failed pack of 1,001 photos keeps all 1,001 originals, in use by Cleanup's rule (kept " +
      (sw.kept || []).length +
      ')',
  );
  await p.close();

  // V4: a listing that fails (assets.list rejects): the sweep reads each original instead and still removes the 3
  W = spanWorld({
    days: [
      [5, 6],
      [0, 2],
    ],
    photos: [
      [1, 0],
      [2, 0],
      [3, 0],
    ],
    opts: { listReject: true },
    tweak: w =>
      oldPack(w, 5, [
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
  });
  p = await open(W.seed);
  await tidyDone(p, 1);
  live = await liveIds(p);
  R = await reclaimOf(p);
  ok(
    R.n === 3 && origs(W, ['1.0', '2.0', '3.0']).every(id => !live.includes(id)) && !(await packsDoc(p)).err,
    'V4: with a listing that fails, the sweep reads each original itself and removes the 3, with no error ' +
      JSON.stringify(R),
  );
  await p.close();

  // V5: broken entries in photos/packs (null, and one with no pack id) are recorded as lost and skipped; the entry
  // after them is swept, and nothing stops
  W = spanWorld({
    days: [
      [5, 6],
      [0, 2],
    ],
    photos: [
      [1, 0],
      [2, 0],
    ],
    tweak: w => {
      w.docs['photos/packs'] = { list: [null, { day: laDay(6), part: 1, n: 1 }] };
      oldPack(w, 5, [
        [1, 0],
        [2, 0],
      ]);
    },
  });
  p = await open(W.seed);
  await tidyDone(p, 3);
  sw = await sweptOf(p);
  live = await liveIds(p);
  const pk5 = await packsDoc(p);
  st = await packSt(p);
  ok(
    sw.n0 &&
      sw.n0.lost === true &&
      sw.n0.full === null &&
      sw.n1 &&
      sw.n1.lost === true &&
      sw.n1.day === laDay(6) &&
      pk5.reclaim.n === 2 &&
      origs(W, ['1.0', '2.0']).every(id => !live.includes(id)) &&
      !pk5.err &&
      /2 packs \(.*\) are missing or can't be read|The packs for .* are missing or can't be read/.test(st) &&
      !p.errors.length,
    "V5: two broken entries are recorded (swept-n0, swept-n1, lost) and skipped; the next entry's 2 leftovers go, no " +
      'error (' +
      st +
      ')',
  );
  await p.close();

  // V6: the box counts each cause on its own: a pack that failed its check (2 originals kept) and an original that
  // doesn't match its packed copy, in a pack that's fine (1 kept; its other leftover goes)
  W = spanWorld({
    days: [
      [5, 6],
      [4, 6],
      [0, 2],
    ],
    photos: [
      [1, 0],
      [2, 0],
      [7, 0],
      [8, 0],
    ],
    tweak: w => {
      oldPack(
        w,
        5,
        [
          [1, 0],
          [2, 0],
        ],
        { mangle: true },
      );
      oldPack(w, 4, [
        [7, 0],
        [8, 0],
      ]);
      const b = phB64(8, 0, 7);
      w.files[w.orig['8.0']] = { type: 'image/png', b64: b, sha: b64sha(b) };
    },
  });
  p = await open(W.seed);
  await tidyDone(p, 2);
  live = await liveIds(p);
  const list6 = await packList(p);
  sw = await sweptOf(p);
  st = await packSt(p);
  ok(
    !live.includes(W.orig['7.0']) &&
      ['1.0', '2.0', '8.0'].every(s => live.includes(W.orig[s])) &&
      JSON.stringify((sw[list6[1].full] || {}).own) === JSON.stringify(['/_blob/' + W.orig['8.0']]) &&
      st.includes(
        'The pack for ' + (await titleOf(p, 5)) + " didn't pass a check, so the 2 original files it holds are kept.",
      ) &&
      st.includes("1 original file is kept because it doesn't match its packed copy."),
    'V6: the box shows the failed pack (2 files) and the mismatched original (1) on lines of their own (' + st + ')',
  );
  await p.close();

  // V8: a day in 3 parts reads the whole photos collection once (after the last part), and still deletes every original
  W = packWorld({
    backs: [2, 0],
    pad: 1000,
    packTune: { partBytes: 2300 },
    tweak: w => {
      w.photo(3, 0);
      w.photo(3, 1);
    },
  });
  p = await open(W.seed);
  await tidyDone(p, 3);
  const reads8 = await p.evaluate(() => __rt.colGets.filter(c => c === 'photos').length);
  live = await liveIds(p);
  ok(
    reads8 === 1 &&
      (await packList(p)).length === 3 &&
      Object.entries(W.orig)
        .filter(([s]) => +s.split('.')[0] < 4)
        .every(([, id]) => !live.includes(id)),
    'V8: a day of 3 parts reads the photos collection once (' + reads8 + ') and deletes all 5 originals',
  );
  await p.close();

  // V13: a runtime whose listing comes in pages of 100, with 150+ photos documents (150 swept documents): the page
  // reads each document it can name that the listing missed, so a day still packs and deletes its originals and the
  // sweep still works (before, the read counted as incomplete: nothing deleted, the sweep stopped on an error)
  const pageWorld = o =>
    spanWorld({
      days: [
        [6, 6],
        [3, 6],
        [0, 2],
      ],
      photos: [
        [1, 0],
        [2, 0],
        [7, 0],
        [8, 0],
      ],
      inBlocks: true,
      opts: o,
      tweak: w => {
        const fake = n => 'c3' + String(n).padStart(30, '0');
        const list = range(0, 149, n => ({ full: fake(n), pv: fake(n + 500), day: laDay(9), part: n + 1, n: 1 }));
        w.docs['photos/packs'] = {
          list,
          reclaim: { n: 0, checked: 150, last: fake(149), swept: list.map(e => e.full) },
        };
        list.forEach(
          e =>
            (w.docs['photos/' + 'swept-' + e.full] = {
              full: e.full,
              day: e.day,
              bad: null,
              lost: false,
              kept: [],
              own: [],
              refused: ['r' + e.part],
            }),
        );
        oldPack(w, 6, [
          [1, 0],
          [2, 0],
        ]);
      },
    });
  W = pageWorld({ getPage: 100 });
  p = await open(W.seed);
  await until(p, () => ((__rt.get('photos/packs') || {}).list || []).length === 152, null, 10000);
  await tidyDone(p, 152);
  live = await liveIds(p);
  const n13 = await p.evaluate(() => [...__rt.store.keys()].filter(k => /^photos\//.test(k)).length);
  ok(
    n13 > 150 &&
      origs(W, ['1.0', '2.0', '7.0', '8.0']).every(id => !live.includes(id)) &&
      (await reclaimOf(p)).n === 2 &&
      !(await packsDoc(p)).err,
    'V13: ' +
      n13 +
      ' photos documents, listed 100 at a time: the new day packs and loses its originals, and the sweep removes ' +
      "the old pack's 2 leftovers, with no error",
  );
  await p.close();
  // ... and when the live listener comes in pages too (here of 2), comparing the two listings can't catch it: a block
  // neither holds still counts, so the original a slot there shares with the day being packed stays. The day before
  // yesterday (#498-#503) holds both photos in b0; yesterday's #600 shares #499's in b500, which in id order (b0,
  // b1000, b1500, b500, index) is past the page of 2
  W = spanWorld({
    days: [
      [3, 498],
      [2, 6],
      [1, 1096],
      [0, 2],
    ],
    photos: [
      [498, 0],
      [499, 0],
      [1100, 0],
      [1550, 0],
    ],
    inBlocks: true,
    opts: { getPage: 2, snapPage: 2 },
    tweak: w => w.put(600, 0, '/_blob/' + w.orig['499.0'], true),
  });
  p = await open(W.seed);
  await until(p, () => ((__rt.get('photos/packs') || {}).list || []).length === 1, null, 10000);
  await until(p, () => __rt.writes.some(w => w.p === 'refresh/packing' && w.op === 'delete'), null, 8000);
  live = await liveIds(p);
  ok(
    !live.includes(W.orig['498.0']) && live.includes(W.orig['499.0']),
    'V13: with both listings paged, the original a slot in another block shares stays, the other goes ' +
      JSON.stringify(origs(W, ['498.0', '499.0']).map(id => live.includes(id))),
  );
  await p.close();

  // V14: while a day packs, the box shows one state: "Packing <day> now…", not also "Last packed day: <day>" from
  // the parts listed so far (the second part's upload never answers here)
  W = packWorld({
    backs: [2, 0],
    pad: 1000,
    packTune: { partBytes: 2300, uploadTimeoutMs: 600000 },
    tweak: w => {
      w.photo(3, 0);
      w.photo(3, 1);
    },
    opts: { up: { script: { 2: { hang: 1e9 } } } },
  });
  p = await open(W.seed);
  await until(p, () => ((__rt.get('photos/packs') || {}).list || []).length === 1, null, 10000);
  st = await until(p, () => {
    const t = document.getElementById('phpack-st').textContent;
    return /Packing .* now…/.test(t) ? t : null;
  });
  ok(
    !!st && /^No day packed yet\./.test(st) && st.includes('Packing ' + (await titleOf(p, 2)) + ' now…'),
    'V14: mid-day, the box says "No day packed yet." and "Packing <day> now…", not that day as packed (' + st + ')',
  );
  await p.close();

  // V15: "packs still to check" leaves out packs made since that left nothing behind: with an old entry still to
  // check (the sweep waits while a day keeps failing to pack), a new clean pack isn't counted, and the sweep later
  // skips it without reading it
  W = spanWorld({
    days: [
      [6, 4],
      [4, 4],
      [3, 4],
      [0, 2],
    ],
    photos: [
      [1, 0],
      [5, 0],
      [9, 0],
    ],
    inBlocks: true,
    packTune: PACK_RETRY,
    tweak: w => oldPack(w, 6, [[1, 0]]),
  });
  W.seed.__opts.up = { blobFail: [W.orig['9.0']] };
  p = await packOpen(W.seed);
  await until(p, () => (((__rt.get('photos/packs') || {}).reclaim || {}).clean || []).length === 1, null, 10000);
  await until(p, () => (__rt.get('photos/packs') || {}).err, null, 5000);
  st = await packSt(p);
  live = await liveIds(p);
  const clean15 = (await reclaimOf(p)).clean;
  ok(
    /Removing original files left over after packing: 1 pack still to check\./.test(st) &&
      !live.includes(W.orig['5.0']) &&
      clean15.length === 1,
    'V15: a new pack that left nothing behind goes in reclaim.clean and isn\'t counted: "1 pack still to check" (' +
      st +
      ')',
  );
  await setUp(p, {});
  await packRetry(p);
  await tidyDone(p, 3);
  live = await liveIds(p);
  const l15 = await packList(p);
  const reads15 = await p.evaluate(
    ids => ids.map(id => __rt.fetches.filter(x => x === id).length),
    [l15[1].full, l15[2].full],
  );
  R = await reclaimOf(p);
  st = await packSt(p);
  ok(
    !live.includes(W.orig['1.0']) &&
      R.n === 1 &&
      !R.clean.length &&
      reads15.join() === '1,1' &&
      !/still to check/.test(st),
    'V15: once the day packs, the sweep removes the old leftover and passes the clean packs without reading them ' +
      '(each read once, by its own check) ' +
      JSON.stringify({ R, reads15 }),
  );
  ok(!p.errors.length, 'V1-V15: no page errors (' + p.errors.join('; ') + ')');
  await p.close();
}

/* R13: photo captions (captions/b<start>, written by Claude's refresh). The Messages view's seed, with #40 a photo-only
   message whose slot 0 is owed and slots 1 and 2 stored, so a caption has to find its photo by slot, not position. */
const CAP31 = 'green Ultra Monolith pack, side view, coyote straps, price tag $180';
const CAP40 = 'red two-person tent, pitched, rain fly off';
const CAP41 = 'green Ultra pack, front view, red zip';
const CAPS_DOC = () => ({ start: 0, byK: { 31: { 0: CAP31 }, 40: { 1: CAP40 }, 41: { 0: CAP41 } } });
/* F39: a GIF message whose GIF the helper stored (slot 0, with the message in gifs) shows a still with a GIF badge and
   plays while hovered; one without a stored GIF keeps "open in Messenger"; a photo is unchanged. */
async function gifs() {
  const p = await open(SEED(), PAGE);
  const ms = range(0, 9, i => mk(i, i === 3 || i === 5 || i === 7 ? { p: 'a' + i, b: '' } : {}));
  const r = await paste(
    p,
    JSON.stringify(
      cap(ms, {
        photos: [
          { i: 3, k: 0, type: 'image/png', b64: PNG },
          { i: 5, k: 0, type: 'image/png', b64: PNG },
        ],
        gifs: [5, 7],
      }),
    ),
  );
  ok(
    r && r.ok && /2 photos stored/.test(r.msg),
    'F39: a capture with a stored GIF imports like a photo (' + (r && r.msg) + ')',
  );
  await p.evaluate(() => {
    location.hash = '#messages';
  });
  await until(p, () => document.querySelector('#m5 .pics img') && document.querySelector('#m3 .pics img'));
  await p.click('#lay-flat').catch(() => {});
  await until(p, () => /^data:image\/png/.test((document.querySelector('#m5 .pics img') || {}).src || ''));
  const id5 = await p.evaluate(() => __rt.uploads[1].id);
  const st = () =>
    p.evaluate(() => {
      const a = document.querySelector('#m5 .pics a');
      const im = a && a.querySelector('img');
      return {
        gif: !!a && a.classList.contains('gifpic'),
        badge: ((a && a.querySelector('.gifbadge')) || {}).textContent || '',
        playing: !!a && a.classList.contains('playing'),
        src: im ? im.getAttribute('src') : '',
        alt: im ? im.alt : '',
        photo3: !!document.querySelector('#m3 .pics a.gifpic'),
        link7: (document.querySelector('#m7') || {}).textContent || '',
      };
    });
  let s0 = await st();
  ok(
    s0.gif &&
      s0.badge === 'GIF' &&
      !s0.playing &&
      /^data:image\/png/.test(s0.src) &&
      /^GIF from /.test(s0.alt) &&
      !s0.photo3 &&
      s0.link7.includes('GIF (open in Messenger)'),
    'F39: a stored GIF shows a still (its first frame) with a GIF badge; a photo has no badge; a GIF not stored keeps "open in Messenger" ' +
      JSON.stringify(Object.assign({}, s0, { src: s0.src.slice(0, 22), link7: s0.link7.slice(0, 60) })),
  );
  await p.hover('#m5 .pics a');
  await until(p, () => document.querySelector('#m5 .pics a.playing'));
  const s1 = await st();
  await p.mouse.move(0, 0);
  await until(p, () => !document.querySelector('#m5 .pics a.playing'));
  const s2 = await st();
  ok(
    s1.playing && s1.src === '/_blob/' + id5 && !s2.playing && /^data:image\/png/.test(s2.src),
    'F39: hovering plays the GIF (its stored file, animated) and leaving shows the still again ' +
      JSON.stringify([s1.src, s2.src.slice(0, 22)]),
  );
  const tap = () =>
    p.evaluate(() => {
      const a = document.querySelector('#m5 .pics a');
      a.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
      a.click();
      return { playing: a.classList.contains('playing'), lb: !!document.getElementById('lb') };
    });
  const t1 = await tap();
  const t2 = await tap();
  ok(
    t1.playing && !t1.lb && !t2.playing && !t2.lb,
    'F39: on a touch screen a tap plays the GIF and a second tap stops it, without opening the viewer ' +
      JSON.stringify([t1, t2]),
  );
  await p.close();
}
async function capPage(o = {}) {
  const V = viewSeed();
  V.msgs[40] = mk(40, { f: 'Cy', b: '', p: 'att40' });
  /* #41 names the pack in its text; only its caption says it's green (all-words matching) */
  V.msgs[41] = mk(41, { f: 'Ben', b: 'My Monolith is up for grabs', p: 'att41' });
  const p = await open(SEED(), PAGE, o.ctx);
  await paste(p, JSON.stringify(cap(V.msgs)));
  await p.evaluate(
    ([th, sm, u, caps]) => {
      __rt.write('threading/current', th);
      __rt.write('summary/current', sm);
      __rt.write('photos/b0', { start: 0, byK: { 31: { 0: u }, 40: { 0: null, 1: u, 2: u }, 41: { 0: u } } });
      if (caps) __rt.write('captions/b0', caps);
      location.hash = '#messages';
    },
    [V.th, V.sm, SWATCH, o.caps === undefined ? CAPS_DOC() : o.caps],
  );
  await until(p, () => document.querySelector('#m31 .pics img') && document.querySelector('#m40 .pics img'));
  await p.waitForTimeout(200);
  return p;
}
async function capFilter(p, q) {
  await msgFilter(p, q);
}
const capRows = p =>
  p.evaluate(() => ({
    ids: [...document.querySelectorAll('#msgs .msg[id]')].map(r => +r.id.slice(1)),
    hits: [...document.querySelectorAll('#msgs .caphit')].map(d => [+d.closest('.msg').id.slice(1), d.textContent]),
  }));
const capImgs = p =>
  p.evaluate(() =>
    [...document.querySelectorAll('#m31 .pics img, #m40 .pics img')].map(i => [
      i.closest('.msg').id,
      i.alt,
      i.getAttribute('title'),
    ]),
  );
async function capLightbox(p, sel) {
  await p.evaluate(s => document.querySelector(s).click(), sel);
  await p.waitForTimeout(100);
  return p.evaluate(() => {
    const c = document.querySelector('#lb .lbcap');
    return {
      open: !!document.querySelector('#lb'),
      cap: c ? c.textContent : null,
      shown: !!c && !c.hidden && c.getBoundingClientRect().height > 0,
      alt: (document.querySelector('#lb .stage img') || {}).alt,
    };
  });
}
async function captions() {
  const p = await capPage();
  const p0 = await capPage({ caps: null });

  // search finds a photo-only message by its caption, and says the match came from the caption
  await capFilter(p, 'side view, coyote');
  let r = await capRows(p);
  ok(
    r.ids.includes(31) &&
      !r.ids.some(i => i < 30 || i > 35) &&
      JSON.stringify(r.hits) === JSON.stringify([[31, '📷 caption: ' + CAP31]]),
    'R13: the filter finds a photo-only message by its caption, with a "📷 caption" line under it ' + JSON.stringify(r),
  );

  // all words: every word of a query of 2 or more somewhere in the text and the captions together
  await capFilter(p, 'green ultra monolith');
  r = await capRows(p);
  ok(
    r.ids.includes(31) &&
      r.ids.includes(41) &&
      JSON.stringify(r.hits) ===
        JSON.stringify([
          [31, '📷 caption: ' + CAP31],
          [41, '📷 caption: ' + CAP41],
        ]),
    'R13: "green ultra monolith" finds #41, whose text says Monolith and caption "green Ultra pack", with its caption line ' +
      JSON.stringify(r),
  );
  await capFilter(p, 'monolith red');
  r = await capRows(p);
  ok(
    r.ids.includes(41) &&
      r.ids.includes(40) &&
      JSON.stringify(r.hits) === JSON.stringify([[41, '📷 caption: ' + CAP41]]),
    "R13: the caption line only on rows the filter found: #40's caption says red, but #40 doesn't match " +
      JSON.stringify(r),
  );
  for (const pg of [p, p0]) {
    await capFilter(pg, 'hip buckles  pockets');
    r = await capRows(pg);
    ok(
      JSON.stringify(r) === JSON.stringify({ ids: [30, 31, 32, 33, 34, 35], hits: [] }),
      "R13: words far apart in a message's text match too (" +
        (pg === p ? 'with' : 'without') +
        ' captions) ' +
        JSON.stringify(r),
    );
  }
  await capFilter(p, 'green ultra monolith tent');
  r = await capRows(p);
  ok(
    !r.ids.length && !r.hits.length,
    'R13: a message missing one of the words is not found ("tent" is only in #40\'s caption) ' + JSON.stringify(r),
  );
  await capFilter(p, 'COYOTE');
  r = await capRows(p);
  ok(r.ids.includes(31) && r.hits.length === 1, 'R13: any case, any part of the caption ' + JSON.stringify(r));
  await capFilter(p, 'tent, pitched');
  r = await capRows(p);
  ok(
    r.ids.includes(40) && JSON.stringify(r.hits) === JSON.stringify([[40, '📷 caption: ' + CAP40]]),
    "R13: a caption on a message's second slot is found too " + JSON.stringify(r),
  );
  await p.click('#lay-flat');
  await capFilter(p, 'monolith');
  r = await capRows(p);
  ok(
    JSON.stringify(r) === JSON.stringify({ ids: [31, 41], hits: [[31, '📷 caption: ' + CAP31]] }),
    'R13: the timeline layout finds it the same way (#41 by its text, so no caption line) ' + JSON.stringify(r),
  );
  await capFilter(p, '#31');
  r = await capRows(p);
  ok(r.ids.join() === '31' && !r.hits.length, 'R13: "#31" finds the message by number, with no caption line');
  await p.click('#lay-thread');
  await p0.click('#lay-thread');

  // a message matched by its text alone is drawn exactly as without captions
  for (const q of ['pack', 'still available']) {
    await capFilter(p, q);
    await capFilter(p0, q);
    const [a, b] = [await capRows(p), await capRows(p0)];
    const html = pg =>
      pg.evaluate(
        ids => ids.map(i => document.querySelector('#m' + i).outerHTML),
        b.ids.filter(i => i !== 31 && i !== 41),
      );
    const same = JSON.stringify(await html(p)) === JSON.stringify(await html(p0));
    ok(
      same && b.ids.every(i => a.ids.includes(i)) && a.hits.every(h => h[0] === 31 || h[0] === 41) && !b.hits.length,
      'R13: "' +
        q +
        '": messages matched by text are unchanged, the caption line only on #31 and #41 ' +
        JSON.stringify(a.hits),
    );
  }
  await capFilter(p, 'pack');
  r = await capRows(p);
  ok(
    JSON.stringify(r.hits.map(h => h[0])) === '[31,41]' && r.ids.includes(30) && r.ids.includes(35),
    'R13: "pack" matches #30 and #35 by text and #31 and #41 by their captions ' + JSON.stringify(r.hits),
  );
  await capFilter(p, '');
  await capFilter(p0, '');
  ok(!(await capRows(p)).hits.length, 'R13: no filter, no caption lines');

  // alt and title
  ok(
    JSON.stringify(await capImgs(p)) ===
      JSON.stringify([
        ['m31', CAP31, CAP31],
        ['m40', CAP40, CAP40],
        ['m40', 'Photo 2 from Cy', null],
      ]),
    "R13: each photo's caption is its alt and title, by slot (#40's slot 0 is owed); one without keeps its alt " +
      JSON.stringify(await capImgs(p)),
  );

  // the viewer shows the caption under the photo
  let lb = await capLightbox(p, '#m31 .pics a');
  ok(
    lb.open && lb.cap === CAP31 && lb.shown && lb.alt === CAP31,
    'R13: the photo viewer shows the caption on a line under the photo ' + JSON.stringify(lb),
  );
  await p.keyboard.press('Escape');
  lb = await capLightbox(p, '#m40 .pics a');
  ok(lb.cap === CAP40 && lb.shown, "R13: #40's first stored photo shows slot 1's caption " + JSON.stringify(lb));
  await p.keyboard.press('ArrowRight');
  lb = await p.evaluate(() => {
    const c = document.querySelector('#lb .lbcap');
    return { cap: c.textContent, hidden: c.hidden, alt: document.querySelector('#lb .stage img').alt };
  });
  ok(
    lb.hidden && lb.cap === '' && lb.alt === 'Photo 2 of 2',
    'R13: the next photo, with no caption, shows no caption line ' + JSON.stringify(lb),
  );
  await p.keyboard.press('Escape');

  // Ask and Views read them in the message lines
  const lines = await p.evaluate(() => [31, 40, 32].map(i => lineFor(S.byI.get(i))));
  ok(
    lines[0].endsWith('Ana:  [photo: ' + CAP31 + ']') &&
      lines[1].endsWith('Cy:  [photo: ' + CAP40 + ']') &&
      !/\[photo/.test(lines[2]),
    'R13: the message lines Ask and Views send carry each photo caption ' + JSON.stringify(lines.slice(0, 2)),
  );

  // a caption written while the page is open shows at once
  await p.evaluate(() => __rt.write('captions/b0', { start: 0, byK: { 31: { 0: 'blue Ultra Monolith pack' } } }));
  await p.waitForTimeout(300);
  await capFilter(p, 'green');
  r = await capRows(p);
  await capFilter(p, '');
  const imgs = await capImgs(p);
  ok(
    !r.ids.includes(31) && imgs[0][1] === 'blue Ultra Monolith pack' && imgs[1][1] === 'Photo 1 from Cy',
    'R13: a new captions document replaces the old at once ' + JSON.stringify(imgs),
  );
  ok(p.errors.length === 0, 'R13: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();

  // no captions collection: everything as before, no errors
  ok(
    JSON.stringify(await capImgs(p0)) ===
      JSON.stringify([
        ['m31', 'Photo 1 from Ana', null],
        ['m40', 'Photo 1 from Cy', null],
        ['m40', 'Photo 2 from Cy', null],
      ]),
    'R13: no captions: the usual alt text, no title',
  );
  await capFilter(p0, 'green');
  r = await capRows(p0);
  ok(!r.ids.includes(31) && !r.hits.length, 'R13: no captions: the filter finds only text ' + JSON.stringify(r));
  await capFilter(p0, '');
  lb = await capLightbox(p0, '#m31 .pics a');
  ok(lb.open && !lb.shown && lb.alt === 'Photo 1 of 1', 'R13: no captions: the viewer has no caption line');
  await p0.keyboard.press('Escape');
  ok(
    (await p0.evaluate(() => lineFor(S.byI.get(31)))).endsWith('Ana:  [photo]'),
    'R13: no captions: the line says [photo]',
  );
  // documents it can't use are skipped
  await p0.evaluate(() => {
    __rt.write('captions/index', { byK: { 31: { 0: 'not a block' } } });
    __rt.write('captions/b500', { start: 500, byK: 'nonsense' });
    __rt.write('captions/b0', { start: 0, byK: { abc: { 0: 'x' }, 31: { 0: 5, k: 'y', 1: '  ' }, 40: null } });
  });
  await p0.waitForTimeout(300);
  ok(
    JSON.stringify(await capImgs(p0)) ===
      JSON.stringify([
        ['m31', 'Photo 1 from Ana', null],
        ['m40', 'Photo 1 from Cy', null],
        ['m40', 'Photo 2 from Cy', null],
      ]) && (await p0.evaluate(() => Object.keys(S.caps).length)) === 0,
    'R13: malformed captions documents and entries are ignored',
  );
  ok(p0.errors.length === 0, 'R13: no captions: no page errors ' + JSON.stringify(p0.errors));
  await p0.context().close();
}
/* ---------- askSearch: Ask and Views over the whole history, with the page's search tools (F32) ---------- */
const CAP42 = 'navy backpack, front flap open showing red tartan lining';
/* 1,200 messages over 12 days: #42 a photo whose caption says tartan, #43 a reply about the lining, #1150 a backpack
   for sale; opts as the stand-in takes them (tools: true for a view that runs page tools) */
function asSeed(opts = { tools: true }, n = 1200) {
  const body = i =>
    ({ 42: 'finally came in', 43: 'that lining is gorgeous', 1150: 'anyone want a backpack? selling mine' })[i] ||
    'message ' + i + ' about the ridge trail and spare tent poles';
  const msgs = hmsgs(n, { perDay: 100, body });
  msgs[42].p = ['https://example.invalid/42.jpg'];
  return hseed(msgs, {
    threads: true,
    meta: { markerMode: 'time', markerFrom: '2026-10-12T00:00', markerTo: null },
    docs: { 'captions/b0': { start: 0, byK: { 42: { 0: CAP42 } } } },
    opts,
  });
}
const AS_PLAN = [
  { say: 'Let me search for that.', calls: [{ name: 'search_messages', input: { words: 'plaid' } }] },
  {
    say: 'Nothing for plaid; trying backpack.',
    calls: [
      { name: 'search_messages', input: { words: 'backpack' } },
      { name: 'read_messages', input: { from: '#38', to: '#46' } },
    ],
  },
  {
    calls: [
      { name: 'search_messages', input: { words: 'lining', from: '2026-10-01', to: '2026-10-01', sender: 'Cy' } },
      { name: 'day_summaries', input: { from: '2026-10-01', to: '2026-10-03' } },
      { name: 'read_messages', input: { from: 'yesterday' } },
    ],
  },
  { say: 'Ben posted it [#42]; Cy loved the lining [#43].' },
];
async function asOpen(seed, plan) {
  const p = await hopen(seed, 1200);
  await p.evaluate(pl => (window.__toolPlan = pl), plan || AS_PLAN);
  return p;
}
const asTools = p => p.evaluate(() => __rt.toolLog.map(x => Object.assign({}, x, { out: x.out && JSON.parse(x.out) })));
async function askSearch() {
  await hcase('AS1-AS9', async () => {
    const p = await asOpen(asSeed());
    ok(
      !(await p.$('#ask-all')) &&
        /whole history/.test(await p.$eval('#v-ask .sec-head p', e => e.textContent)) &&
        (await p.evaluate(() => S.tools)) === true,
      'AS1: no "include older" box, the header says Claude reads the whole history, and this view has tools',
    );
    const r = await hask(p, 'Who posted the backpack with the plaid lining?');
    const log = await asTools(p);
    const call = r.calls[0];
    ok(
      r.calls.length === 1 &&
        /\n- SEARCH: three tools over every stored message/.test(r.prompt) &&
        /- Search before saying something isn't in the chat/.test(r.prompt) &&
        /read them with read_messages first/.test(r.prompt) &&
        /- Never offer to dig deeper, look later or read more in a follow-up/.test(r.prompt) &&
        /- MESSAGES: every message from #\d+ to #1199/.test(r.prompt) &&
        /- OLDER HISTORY: #0 to #/.test(r.prompt) &&
        call.bytes <= 98304,
      'AS2: one call; the prompt is the whole history (newest word for word, summaries from #0) within 96 KiB, with the SEARCH line and its rules (' +
        call.bytes +
        ' bytes)',
    );
    ok(
      /Older than #\d+: summaries, plus what the tools read \(below\)\./.test(r.note) && !/summaries only/.test(r.note),
      'B74: with tools the note never says "summaries only": the older part is summaries plus what the tools read (' +
        r.note.slice(0, 160) +
        ')',
    );
    const [plaid, backpack, read1, lining, days, bad] = [
      log.find(x => x.input.words === 'plaid'),
      log.find(x => x.input.words === 'backpack'),
      log.find(x => x.name === 'read_messages' && x.input.from === '#38'),
      log.find(x => x.input.words === 'lining'),
      log.find(x => x.name === 'day_summaries'),
      log.find(x => x.name === 'read_messages' && x.input.from === 'yesterday'),
    ];
    ok(
      plaid.out.total === 0 &&
        backpack.out.total === 2 &&
        backpack.out.newestFirst &&
        /^#1150 /.test(backpack.out.matches[0]) &&
        /^#42 .*\[photo: navy backpack, front flap open showing red tartan lining\]/.test(backpack.out.matches[1]),
      'AS3: search_messages covers the whole history and photo captions: "plaid" 0, "backpack" 2, newest first, #42 by its caption ' +
        JSON.stringify(backpack.out),
    );
    ok(
      read1.out.from === 38 &&
        read1.out.to === 46 &&
        read1.out.lines.length === 9 &&
        /^#42 /.test(read1.out.lines[4]) &&
        !read1.out.next,
      'AS4: read_messages gives #38–#46 word for word ' + JSON.stringify([read1.out.from, read1.out.to]),
    );
    ok(
      lining.out.total === 1 && /^#43 /.test(lining.out.matches[0]),
      'AS5: a date range and a sender narrow a search ("lining" by Cy on Oct 1: #43 only, not #42) ' +
        JSON.stringify(lining.out),
    );
    ok(
      days.out.days.length === 3 &&
        /^\[#0–#99, Oct 1\]/.test(days.out.days[0]) &&
        bad.err &&
        /from must be/.test(bad.err),
      'AS6: day_summaries gives a line per day; an unreadable bound comes back as an error Claude reads ' +
        JSON.stringify([days.out.days[0], bad.err]),
    );
    const turn = await p.evaluate(() => {
      const t = [...document.querySelectorAll('#chat .turn.assistant')].pop();
      const mb = t.querySelector('.matches');
      return {
        txt: t.querySelector('.txt').textContent,
        cites: [...t.querySelectorAll('.txt a.cite')].map(a => a.textContent),
        chips: mb
          ? [...mb.querySelectorAll('.seg button')].map(b => [b.textContent, b.getAttribute('aria-pressed')])
          : null,
        rows: mb ? [...mb.querySelectorAll('li.snip')].map(li => li.textContent) : null,
      };
    });
    ok(
      turn.txt === 'Ben posted it #42; Cy loved the lining #43.' && turn.cites.join() === '#42,#43',
      'AS7: the answer is only the last round: no "Let me search" or remarks between searches, citations linked "' +
        turn.txt +
        '"',
    );
    ok(
      r.note.includes('Searched “plaid” (0), “backpack” (2), “lining” by Cy (2026-10-01 to 2026-10-01) (1).') &&
        r.note.includes('Read #38–#46.') &&
        r.note.includes('Read day summaries.') &&
        /^Read #\d+–#1199 word for word/.test(r.note),
      'AS8: the note says what was read word for word, what Claude searched (with counts) and read: "' + r.note + '"',
    );
    ok(
      JSON.stringify(turn.chips) ===
        JSON.stringify([
          ['“plaid” · 0', 'false'],
          ['“backpack” · 2', 'true'],
          ['“lining” by Cy (2026-10-01 to 2026-10-01) · 1', 'false'],
        ]) &&
        turn.rows.length === 2 &&
        /^#1150 · /.test(turn.rows[0]) &&
        /^#42 · .*finally came in📷 navy backpack/.test(turn.rows[1]),
      'AS9: under the answer, each search with its count; the first with matches is open, newest first, with the caption ' +
        JSON.stringify(turn),
    );
    await p.close();
  });

  await hcase('AS10-AS13', async () => {
    const p = await asOpen(asSeed());
    await hask(p, 'Who posted the backpack with the plaid lining?');
    /* a row opens its message in Messages */
    await p.evaluate(() => [...document.querySelectorAll('#chat .matches li.snip')].pop().click());
    await until(p, () => location.hash === '#messages' && document.getElementById('m42'));
    ok(true, 'AS10: a matching row opens its message on the Messages tab');
    const row = await until(p, () =>
      Object.values(Object.fromEntries(__rt.store)).find(v => v && v.q && /plaid lining/.test(v.q)),
    );
    ok(
      row.scope === 'all' &&
        JSON.stringify(row.sent.searches) ===
          JSON.stringify([
            { q: 'plaid', n: 0 },
            { q: 'backpack', n: 2 },
            { q: 'lining', n: 1, from: '2026-10-01', to: '2026-10-01', sender: 'Cy' },
          ]) &&
        JSON.stringify(row.sent.reads) === '[[38,46]]' &&
        row.sent.to === 1199 &&
        row.a === 'Ben posted it [#42]; Cy loved the lining [#43].',
      'AS11: the saved question keeps the answer, scope "all", what was read and every search with its count ' +
        JSON.stringify(row),
    );
    await p.evaluate(() => (location.hash = '#ask'));
    const listed = await until(p, () => {
      const q = document.querySelector('#qa-list .item.qa');
      return q && q.textContent;
    });
    ok(
      /searched “plaid” \(0\), “backpack” \(2\)/.test(listed),
      'AS12: Earlier questions says what each one searched "' + listed.slice(0, 200) + '"',
    );
    /* the page's own matches for the question's words, when there are some */
    await p.evaluate(() => (window.__toolPlan = [{ say: 'Ana offered one [#1150].' }]));
    await hask(p, 'Is anyone selling a backpack?');
    const chips = await p.evaluate(() =>
      [...[...document.querySelectorAll('#chat .turn.assistant')].pop().querySelectorAll('.matches .seg button')].map(
        b => b.textContent,
      ),
    );
    ok(
      JSON.stringify(chips) === JSON.stringify(['Your words · 1']),
      'AS13: with no search by Claude, the page still lists the messages holding all the question\'s words ("selling backpack") ' +
        JSON.stringify(chips),
    );
    const st = await p.evaluate(() =>
      [1, 3].map(n => recStatus({ searches: [{ q: 'pouch', ms: Array(n).fill(0) }], reads: [], lastKind: 'search' })),
    );
    ok(
      st.join('|') === 'Searched “pouch”: 1 match. Thinking…|Searched “pouch”: 3 matches. Thinking…',
      'AS13b: the live status counts matches in plain English ' + JSON.stringify(st),
    );
    ok(p.errors.length === 0, 'AS10-13: no page errors ' + JSON.stringify(p.errors));
    await p.close();
  });

  await hcase('AS14', async () => {
    /* a small cap: the prompt takes 60%, and results past what's left are refused, so the call stays within the cap */
    const p = await asOpen(asSeed({ tools: true, promptMax: 40000 }), [
      {
        calls: [
          { name: 'read_messages', input: { from: '#0', to: '#1199' } },
          { name: 'search_messages', input: { words: 'ridge' } },
        ],
      },
      { say: 'Partly checked [#5].' },
    ]);
    const r = await hask(p, 'Everything about the ridge?');
    const log = await asTools(p);
    const refused = log.filter(x => x.err && /budget/.test(x.err));
    ok(
      r.calls[0].bytes <= 24000 &&
        refused.length >= 1 &&
        log.every(x => !x.out || JSON.stringify(x.out).length <= 16384),
      'AS14: at a 40,000-byte cap the prompt keeps to 60% (' +
        r.calls[0].bytes +
        ') and a result past the reading budget is refused, so Claude answers ' +
        JSON.stringify(log.map(x => [x.name, x.err || 'ok'])),
    );
    await p.close();
  });

  await hcase('AS15', async () => {
    /* a view that doesn't run page tools: one more call without them, and the page stops offering them */
    const p = await asOpen(asSeed({ tools: true, toolsUnavailable: true }));
    const r = await hask(p, 'What happened?');
    const st = await p.evaluate(() => [S.tools, __rt.samples.length]);
    ok(
      r.answer === 'Ben offered one #1. Ana asked #0 #2.' &&
        st[0] === false &&
        !/- SEARCH:/.test(r.prompt) &&
        /- MESSAGES: every stored message, #0 to #1199, word for word/.test(r.prompt) &&
        r.calls.length === 2,
      'AS15: tools_unavailable: asked again without tools, over the whole history at the full cap, and the page stops offering them ' +
        JSON.stringify({ st, calls: r.calls, answer: r.answer }),
    );
    await p.close();
  });

  await hcase('AS16', async () => {
    /* without tools (the stand-in's default) nothing changes but the scope: the whole history, no SEARCH line */
    const p = await hopen(asSeed({}), 1200);
    const r = await hask(p, 'What happened?');
    ok(
      (await p.evaluate(() => S.tools)) === false &&
        !/- SEARCH:/.test(r.prompt) &&
        /- MESSAGES: every stored message, #0 to #1199, word for word/.test(r.prompt) &&
        !/OLDER HISTORY/.test(r.prompt),
      'AS16: without tools the whole history goes in at the full cap, as "include older" did: all 1,200 word for word here (' +
        r.calls[0].bytes +
        ' bytes)',
    );
    await p.close();
  });

  await hcase('AS17', async () => {
    /* Views search too: the final round is the view; what it searched is saved and shown */
    const viewJson = {
      title: 'Backpacks',
      intro: 'Every backpack in the chat.',
      sections: [{ heading: 'Ben', summary: 'A tartan-lined one [#42].', refs: [42] }],
    };
    const p = await asOpen(asSeed(), [
      { say: 'Searching.', calls: [{ name: 'search_messages', input: { words: 'backpack' } }] },
      { say: JSON.stringify(viewJson) },
    ]);
    await p.evaluate(() => {
      location.hash = '#views';
      document.getElementById('view-in').value = 'every backpack';
      document.getElementById('view-go').click();
    });
    const view = await until(p, () =>
      Object.values(Object.fromEntries(__rt.store)).find(v => v && v.kind === 'view' && v.title === 'Backpacks'),
    );
    const vp = await lastSample(p);
    const note = await until(p, () => {
      const e = document.querySelector('#view-out .sent');
      return e && e.textContent;
    });
    ok(
      /- SEARCH: three tools/.test(vp) &&
        /Cover the whole history, not only the messages above/.test(vp) &&
        JSON.stringify(view.sent.searches) === JSON.stringify([{ q: 'backpack', n: 2 }]) &&
        /Searched “backpack” \(2\)\./.test(note),
      'AS17: a view gets the search tools and the whole-history task; its searches are saved and in its note "' +
        note +
        '"',
    );
    ok(p.errors.length === 0, 'AS17: no page errors ' + JSON.stringify(p.errors));
    await p.close();
  });
}

/* ---------- several chats (F1 stage A) ----------
   The mock page holds Trail Crew (its first chat, key trail, the page's own documents) plus Camera Club (cam) and Book
   Room (book), each in collections under its key. Every chat has #0-#n, so the same number exists in each. */
const MC_THREAD = { cam: '5151', book: '6161' };
const MC_NAME = { trail: 'Trail Crew', cam: 'Camera Club', book: 'Book Club' };
const MC_URL = k => 'https://www.facebook.com/messages/t/' + MC_THREAD[k];
const mcMsgs = (k, n) => range(0, n - 1, i => mk(i, { b: k + ' message ' + i, m: 'mid.' + k + i }));
function mcSeed(o = {}) {
  const s = SEED();
  const n = { trail: 12, cam: 8, book: 6 };
  const msgs = { trail: mcMsgs('trail', 12), cam: mcMsgs('cam', 8), book: mcMsgs('book', 6) };
  const sum = (k, ment) => ({
    version: 2,
    convs: [],
    open: [],
    answered: [],
    deals: [],
    mentions: [{ note: MC_NAME[k] + ': someone asked you', refs: [[ment]] }],
    toI: n[k] - 1,
  });
  const meta = k =>
    Object.assign(
      {
        lastI: n[k] - 1,
        anchorMids: msgs[k].slice(-3).map(m => m.m),
        caughtUpI: 1,
        markerMode: 'caught',
        lastRefresh: 'Fri 9:10 AM',
      },
      k === 'trail'
        ? {}
        : {
            key: k,
            thread: MC_THREAD[k],
            chatUrl: MC_URL(k),
            threadName: MC_NAME[k],
            shortName: MC_NAME[k].split(' ')[0],
            chunkSize: 82,
          },
    );
  s['meta/chat'] = Object.assign({}, META, { pageVersion: '4.1', versions: { page: '4.1' } }, meta('trail'));
  s['chunks/c0000'] = { start: 0, msgs: msgs.trail };
  s['summary/current'] = sum('trail', 8);
  s['threading/current'] = { convs: [], links: {}, to: 11, note: '' };
  if (o.one) return s;
  s['meta/chat'].chats = {
    trail: { name: 'Trail Crew', tag: 'Trail', color: 1, order: 0, state: 'active', home: true },
    cam: { name: 'Camera Club', tag: 'Cam', color: 2, order: 1, state: 'active', thread: '5151', url: MC_URL('cam') },
    book: { name: 'Book Club', tag: 'Book', color: 3, order: 2, state: 'active', thread: '6161', url: MC_URL('book') },
  };
  ['cam', 'book'].forEach(k => {
    s['meta/chat-' + k] = meta(k);
    s[k + '_chunks/c0000'] = { start: 0, msgs: msgs[k] };
    s[k + '_summary/current'] = sum(k, k === 'cam' ? 6 : 3);
    s[k + '_threading/current'] = { convs: [], links: {}, to: n[k] - 1, note: '' };
  });
  Object.assign(s['meta/chat'].chats, o.chats || {});
  return Object.assign(s, o.extra || {});
}
const mcOpen = (o, ctx) => open(Object.assign(mcSeed(o), o && o.opts ? { __opts: o.opts } : {}), PAGE, ctx);
const mcText = (p, sel) => p.evaluate(s => (document.querySelector(s) || {}).textContent || '', sel);
/* Messages' text without the React buttons (new in F37), so MIG4 compares what the messages read */
const msgsText = p =>
  p.evaluate(() => {
    const c = document.querySelector('#msgs');
    if (!c) return '';
    const x = c.cloneNode(true);
    x.querySelectorAll('button.rh').forEach(b => b.textContent === 'React' && b.remove());
    return x.textContent;
  });
async function mcPick(p, key) {
  await p.click('#h1');
  await p.click('#picker-list button[data-key="' + key + '"]');
  await p.waitForTimeout(300);
}
const mcWrites = (p, from = 0) => p.evaluate(n => __rt.writes.slice(n).map(w => w.p), from);
const mcNWrites = p => p.evaluate(() => __rt.writes.length);
/* paste() for a chat: its import record is refresh/lastImport-<key> (the first chat's is refresh/lastImport) */
async function mcPaste(p, c, key) {
  const doc = key === 'trail' ? 'refresh/lastImport' : 'refresh/lastImport-' + key;
  const before = JSON.stringify(await get(p, doc));
  await p.evaluate(t => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, JSON.stringify(c));
  return until(
    p,
    ([d, b]) => {
      const v = __rt.get(d);
      return v && JSON.stringify(v) !== b && v.state !== 'uploading' ? v : null;
    },
    [doc, before],
  );
}
async function mcSettings(p) {
  await p.click('#settings-open');
  await p.waitForTimeout(150);
}
async function multiChat() {
  // MIG5, PG1: a page from before F1 (no chats) is one chat and looks as it did, opening on that chat
  let p = await mcOpen({ one: true });
  ok(
    (await mcText(p, '#h1')) === 'Trail Catch-up' &&
      !(await p.evaluate(() => document.body.classList.contains('allchats'))) &&
      (await p.isVisible('#v-summary')) &&
      (await p.isHidden('#v-all')),
    'F1 MIG5/PG1: a page with no chats list opens on its one chat, titled as before',
  );
  ok((await mcText(p, '#v-summary')).includes('Trail Crew: someone asked you'), 'F1 MIG5: its Needs you shows');
  await p.click('#h1');
  let items = await p.$$eval('#picker-list button', bs =>
    bs.map(b => b.dataset.key + ':' + b.querySelector('.nm').textContent),
  );
  ok(
    JSON.stringify(items) === JSON.stringify(['trail:Trail Crew', 'add:Add a chat']),
    'F1 MIG5: the picker offers only the chat and Add a chat (' + items + ')',
  );
  // PH2: Escape closes it, focus back on the title
  await p.keyboard.press('Escape');
  ok(
    (await p.isHidden('#picker-list')) && (await p.evaluate(() => document.activeElement.id)) === 'h1',
    'F1 PH2: Escape closes the picker and keeps focus on the title',
  );
  await p.click('#h1');
  await p.mouse.click(5, 880);
  ok(await p.isHidden('#picker-list'), 'F1 PH2: a tap outside closes the picker');
  const oneText = {
    summary: await mcText(p, '#v-summary'),
    strip: await mcText(p, '#strip'),
    window: await mcText(p, '#window'),
    msgs: await msgsText(p),
  };
  ok(p.errors.length === 0, 'F1: one chat, no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
  // MIG4: the last release draws the same tabs from the same one-chat database
  const last = (() => {
    try {
      const t = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).split(/\s+/)[0];
      const src = execFileSync('git', ['show', t + ':plugin/skills/refresh/assets/page.html'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /^<!doctype/i.test(src) ? src : SKELETON + src + '</body></html>';
    } catch (e) {
      return null;
    }
  })();
  if (!last) console.log('NOTE F1 MIG4: no release tag in this clone; the comparison with the last release is skipped');
  else {
    p = await open(mcSeed({ one: true }), last);
    const was = {
      summary: await mcText(p, '#v-summary'),
      strip: await mcText(p, '#strip'),
      window: await mcText(p, '#window'),
      msgs: await msgsText(p),
    };
    const diff = Object.keys(was).filter(k => was[k] !== oneText[k]);
    ok(
      !diff.length,
      'F1 MIG4: Summary, the counts, the window and Messages read the same as the last release (' + diff + ')',
    );
    await p.context().close();
  }

  // PG1: several chats open on All chats; a chat's tabs once picked; a fresh load is All chats again
  p = await mcOpen();
  ok(
    (await mcText(p, '#h1')) === 'All chats' &&
      (await p.evaluate(() => document.body.classList.contains('allchats'))) &&
      (await p.isVisible('#v-all')) &&
      (await p.isHidden('#v-summary')) &&
      JSON.stringify(await p.$$eval('nav.tabs a', as => as.filter(a => !a.hidden).map(a => a.dataset.tab))) ===
        '["summary","ask","days","stats"]',
    'F1 PG1: with several chats the page opens on All chats, on its Summary (a card per chat), with only its own tabs: Summary, Ask, By day and Stats (stage C)',
  );
  // PG3: every live chat's Needs you, tagged; the picker's counts add up to All chats'
  const cards = await p.$$eval('#v-all .chatcard', cs => cs.map(c => c.dataset.chat + '|' + c.textContent));
  ok(
    cards.length === 3 &&
      cards[0].startsWith('trail|') &&
      cards[1].includes('Camera Club: someone asked you') &&
      cards[1].includes('Cam #6') &&
      cards[2].includes('Book #3') &&
      cards[0].includes('10 new · 1 needs you'),
    'F1 PG3: All chats has a card per chat with its new count and tagged Needs you (' +
      cards.map(c => c.slice(0, 60)) +
      ')',
  );
  await p.click('#h1');
  const counts = await p.$$eval('#picker-list button', bs =>
    bs.map(b => [b.dataset.key, +((b.querySelector('.cnt') || {}).textContent || '0').split(' ')[0]]),
  );
  const tot = counts.find(c => c[0] === 'all')[1];
  ok(
    tot === 3 && counts.filter(c => !['all', 'add'].includes(c[0])).reduce((a, c) => a + c[1], 0) === tot,
    'F1 PG3: the picker counts each chat and they add up to All chats (' + JSON.stringify(counts) + ')',
  );
  await p.keyboard.press('Escape');
  // DM9: under All chats, the first chat is loaded (its chunks), the others only by meta, summary and outbox (B56)
  let L = await p.evaluate(() => __rt.listeners());
  ok(
    L['c:chunks'] &&
      !L['c:cam_chunks'] &&
      !L['c:book_chunks'] &&
      L['d:meta/chat-cam'] &&
      L['c:cam_summary'] &&
      L['c:cam_outbox'],
    'F1 DM9: All chats listens to the first chat in full and to the others lightly (' + Object.keys(L).join(' ') + ')',
  );
  // PG2: in Book Club only Book's items, nothing of the others
  await mcPick(p, 'book');
  const bookSum = await mcText(p, '#v-summary');
  ok(
    (await mcText(p, '#h1')) === 'Book Club' &&
      (await p.isVisible('nav.tabs')) &&
      bookSum.includes('Book Club: someone asked you') &&
      !/Trail|Camera|Cam #/.test(bookSum),
    "F1 PG2: Book Club's Needs you holds its items only and names no other chat",
  );
  L = await p.evaluate(() => __rt.listeners());
  ok(
    L['c:book_chunks'] === 1 && !L['c:chunks'] && !L['c:cam_chunks'],
    "F1 DM9: switching chats drops the old chat's listeners (" + Object.keys(L).filter(k => /chunks/.test(k)) + ')',
  );
  // SD1/SD6: Stats count only this chat's messages; switching redraws
  await p.click('nav a[data-tab="messages"]');
  await p.waitForTimeout(200);
  const bookMsgs = await mcText(p, '#msgs');
  await mcPick(p, 'cam');
  await p.click('nav a[data-tab="messages"]');
  await p.waitForTimeout(300);
  const camMsgs = await mcText(p, '#msgs');
  ok(
    bookMsgs.includes('book message 5') &&
      !bookMsgs.includes('cam message') &&
      camMsgs.includes('cam message 7') &&
      !camMsgs.includes('book message'),
    'F1: Messages shows only the chat on screen, and switching redraws it',
  );
  // CT5: no two elements share an id after switching back and forth
  await mcPick(p, 'book');
  await mcPick(p, 'cam');
  const dupIds = await p.evaluate(() => {
    const seen = new Map();
    document.querySelectorAll('[id]').forEach(e => seen.set(e.id, (seen.get(e.id) || 0) + 1));
    return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  });
  ok(!dupIds.length, 'F1 CT5: element ids stay unique after switching chats (' + dupIds + ')');
  // HP7: links from Camera Club point at its own thread
  const camLink = await p.evaluate(() => jumpHref(S.byI.get(3)));
  ok(
    camLink.includes('5151') && !camLink.includes('4242'),
    "F1 HP7: a chat's reply links open its own thread (" + camLink.slice(0, 80) + ')',
  );
  // CT4: the same number in two chats never cross-links: All chats › Book #3 opens Book's #3
  await p.click('#h1');
  await p.click('#picker-list button[data-key="all"]');
  await p.waitForTimeout(200);
  await flashReset(p);
  await p.click('#v-all .chatcard[data-chat="book"] button.cite');
  await until(p, () => document.querySelector('#m3[data-flashed]'), null, 3000);
  ok(
    (await mcText(p, '#h1')) === 'Book Club' &&
      (await p.isVisible('#v-messages')) &&
      (await mcText(p, '#m3')).includes('book message 3'),
    "F1 CT4: All chats › Book #3 switches to Book Club and opens its #3, not another chat's",
  );
  // DM10, PG4: in Book Club, Mark caught up writes only meta/chat-book; other chats' windows stay
  await p.click('nav a[data-tab="summary"]');
  let w0 = await mcNWrites(p);
  await p.click('#caught');
  await until(p, () => __rt.get('meta/chat-book').caughtUpI === 5);
  ok(
    JSON.stringify(await mcWrites(p, w0)) === JSON.stringify(['meta/chat-book']) &&
      (await get(p, 'meta/chat')).caughtUpI === 1 &&
      (await get(p, 'meta/chat-cam')).caughtUpI === 1,
    "F1 PG4/DM10: Mark caught up in Book Club moves only Book's window, one write to meta/chat-book",
  );
  // DM10, OB1: Reply here in Book Club queues book_outbox/r<ms> with Book's i and mid
  await p.click('nav a[data-tab="messages"]');
  await p.click('#lay-flat');
  await p.check('#msg-all'); /* #4 is before the window Mark caught up just moved */
  await p.waitForTimeout(200);
  w0 = await mcNWrites(p);
  await p.hover('#m4 .who');
  await p.click('#m4 button.rh');
  await p.fill('#m4 .compose textarea', 'see you there');
  await p.click('#m4 .compose button.primary');
  const ob = await until(p, () => {
    const k = [...__rt.store.keys()].find(k => /outbox\//.test(k));
    return k ? Object.assign({ k }, __rt.get(k)) : null;
  });
  ok(
    ob &&
      /^book_outbox\/r\d+$/.test(ob.k) &&
      ob.i === 4 &&
      ob.mid === 'mid.book4' &&
      (await mcWrites(p, w0)).every(x => x.startsWith('book_outbox/')),
    "F1 OB1/DM10: Reply here in Book Club writes book_outbox/r<ms> with Book's message (" +
      JSON.stringify(ob && ob.k) +
      ')',
  );
  // HP3: a capture from Camera Club is refused in Book Club, nothing written
  w0 = await mcNWrites(p);
  let r = await mcPaste(p, Object.assign(cap(mcMsgs('cam', 9).slice(8)), { thread: '5151' }), 'book');
  ok(
    r &&
      r.ok === false &&
      /This capture is from Camera Club, not Book Club/.test(r.msg) &&
      !(await mcWrites(p, w0)).some(x => /chunks|meta\/chat/.test(x)),
    'F1 HP3: a capture from another chat is refused, naming both, nothing saved (' + (r && r.msg) + ')',
  );
  // DM10: Book's own capture lands in Book's documents only
  w0 = await mcNWrites(p);
  r = await mcPaste(p, Object.assign(cap(mcMsgs('book', 8).slice(6)), { thread: '6161' }), 'book');
  /* the page-wide storage figures (meta/chat.assetUsage) are the one shared write an import makes */
  const tw = await p.evaluate(
    n =>
      __rt.writes
        .slice(n)
        .filter(w => !(w.p === 'meta/chat' && Object.keys(w.v).join() === 'assetUsage'))
        .map(w => w.p),
    w0,
  );
  ok(
    r &&
      r.ok &&
      (await get(p, 'meta/chat-book')).lastI === 7 &&
      tw.every(x => /^(book_|meta\/chat-book$|refresh\/lastImport-book$)/.test(x)),
    "F1 DM10: Book Club's capture writes only book_chunks, meta/chat-book and refresh/lastImport-book (" +
      [...new Set(tw)] +
      ')',
  );
  // MIG6: saved answers stay with their chat: a row with no chat is the first chat's
  await p.evaluate(() => {
    __rt.write('qa/old1', { q: 'Who has the stove?', a: 'Ana [#5]', at: '2026-11-01T10:00:00Z', scope: 'all' });
    __rt.write('qa/book1', {
      q: 'Any book tips left?',
      a: 'Ben [#2]',
      at: '2026-11-02T10:00:00Z',
      scope: 'all',
      chat: 'book',
    });
  });
  await p.click('nav a[data-tab="ask"]');
  await until(p, () => /Any book tips/.test(document.getElementById('qa-list').textContent));
  const bookQa = await mcText(p, '#qa-list');
  await mcPick(p, 'trail');
  await until(p, () => /Who has the stove/.test(document.getElementById('qa-list').textContent));
  const trailQa = await mcText(p, '#qa-list');
  ok(
    bookQa.includes('Any book tips') &&
      !bookQa.includes('stove') &&
      trailQa.includes('stove') &&
      !trailQa.includes('book tips'),
    "F1 MIG6: saved answers show in their own chat; an old one with no chat is the first chat's",
  );
  ok(p.errors.length === 0, 'F1: several chats, no page errors ' + JSON.stringify(p.errors));
  await p.context().close();

  // On All chats a paste imports into the first chat, as a scheduled refresh expects
  p = await mcOpen();
  r = await mcPaste(p, Object.assign(cap(mcMsgs('trail', 13).slice(12)), { thread: '4242' }), 'trail');
  ok(
    r && r.ok && (await get(p, 'meta/chat')).lastI === 12 && (await get(p, 'meta/chat-book')).lastI === 5,
    'F1: a paste on All chats imports into the first chat, as a scheduled refresh expects',
  );
  // PG5: Mark all caught up moves every live chat's window; a refused write is named; hidden chats untouched
  await p.evaluate(() => __rt.fails.push({ p: 'meta/chat-cam', op: 'update' }));
  await p.click('#caught-all');
  await until(p, () => /Couldn't/.test((document.getElementById('caught-all-st') || {}).textContent || ''));
  ok(
    (await mcText(p, '#caught-all-st')).includes('Camera Club') &&
      (await get(p, 'meta/chat')).caughtUpI === 12 &&
      (await get(p, 'meta/chat-book')).caughtUpI === 5 &&
      (await get(p, 'meta/chat-cam')).caughtUpI === 1,
    "F1 PG5: Mark all caught up moves each chat's window and names the one it couldn't save (" +
      (await mcText(p, '#caught-all-st')) +
      ')',
  );
  // OB2: All chats lists queued replies tagged with their chat
  await p.evaluate(() =>
    __rt.write('book_outbox/r1', {
      i: 2,
      mid: 'mid.book2',
      to: 'You',
      snip: 'x',
      text: 'on it',
      state: 'queued',
      queuedAt: new Date().toISOString(),
    }),
  );
  await until(p, () => /Book #2 · to You: on it/.test(document.getElementById('v-all').textContent));
  ok(
    /Book #2 · to You: on it/.test(await mcText(p, '#v-all')),
    "F1 OB2: All chats lists every chat's queued replies, tagged",
  );
  await p.context().close();

  // CMP1: a refresh skill older than the page leaves added chats unrefreshed, and the page says so
  p = await mcOpen({ extra: {} });
  await p.evaluate(() => __rt.write('meta/chat', Object.assign(__rt.get('meta/chat'), { versions: { page: '3.9' } })));
  await until(p, () =>
    /isn't refreshed: the refresh skill is older/.test(document.getElementById('v-all').textContent),
  );
  ok(
    /Camera Club isn't refreshed: the refresh skill is older than the page/.test(await mcText(p, '#v-all')) &&
      !/Trail Crew isn't refreshed/.test(await mcText(p, '#v-all')),
    "F1 CMP1: with an older refresh skill, each added chat says it isn't refreshed",
  );
  await p.context().close();

  // Settings: Your chats (the owner manages chats without Claude)
  p = await mcOpen({ chats: { chess: { name: 'Chess Swap', tag: 'Chess', color: 4, order: 3, state: 'deleted' } } });
  const s0 = await p.evaluate(() => __rt.samples.length);
  await mcSettings(p);
  const unlabeled = await p.$$eval('#set-body input:not([type=radio]):not([type=checkbox]), #set-body select', xs =>
    xs.filter(x => !x.id || !document.querySelector('label[for="' + x.id + '"]')).map(x => x.outerHTML.slice(0, 60)),
  );
  ok(!unlabeled.length, 'F1 PH3: every field in Settings has an id and a label (' + unlabeled + ')');
  ok(
    (await p.evaluate(() => getComputedStyle(document.getElementById('settings')).overflowY)) === 'auto',
    'F1 PH3: Settings is a sheet that scrolls inside itself',
  );
  // SET1: not a Messenger link
  for (const bad of ['', 'hello', 'https://www.facebook.com/groups/12345']) {
    w0 = await mcNWrites(p);
    await p.fill('#add-link', bad);
    await p.click('#add-go');
    await p.waitForTimeout(100);
    ok(
      (/groups/.test(bad) ? /That's a Facebook group: add it under Add a group/ : /isn't a Messenger chat link/).test(
        await mcText(p, '#set-st-add'),
      ) && (await mcNWrites(p)) === w0,
      'F1 SET1: "' + bad + '" is refused inline and writes nothing (a group link points to Add a group)',
    );
  }
  // SET2: a chat already on the page
  w0 = await mcNWrites(p);
  await p.fill('#add-link', 'https://www.facebook.com/messages/t/6161/');
  await p.click('#add-go');
  await p.waitForTimeout(100);
  ok(
    /already on the page: Book Club/.test(await mcText(p, '#set-st-add')) && (await mcNWrites(p)) === w0,
    'F1 SET2: a link already on the page is refused, naming the chat',
  );
  // SET3, DM5: one entry, pending; a deleted chat's key isn't reused
  w0 = await mcNWrites(p);
  await p.fill('#add-link', 'https://www.facebook.com/messages/e2ee/t/7171');
  await p.fill('#add-name', 'Chess Club');
  await p.fill('#add-tag', 'Chess');
  await p.selectOption('#add-start', '7');
  await p.click('#add-go');
  await until(p, () => __rt.get('meta/chat').chats.chess2);
  const ws = await p.evaluate(n => __rt.writes.slice(n), w0);
  const e = (await get(p, 'meta/chat')).chats.chess2;
  ok(
    ws.length === 1 &&
      ws[0].p === 'meta/chat' &&
      JSON.stringify(Object.keys(ws[0].v)) === '["chats"]' &&
      JSON.stringify(Object.keys(ws[0].v.chats)) === '["chess2"]' &&
      JSON.stringify(Object.keys(e).sort()) ===
        JSON.stringify(
          ['addedAt', 'color', 'days', 'name', 'order', 'photos', 'state', 'tag', 'thread', 'url'].sort(),
        ) &&
      e.state === 'pending' &&
      e.days === 7 &&
      e.thread === '7171' &&
      e.url === 'https://www.facebook.com/messages/e2ee/t/7171' &&
      (await get(p, 'meta/chat')).chats.chess.state === 'deleted',
    'F1 SET3/DM5: Add a chat writes one pending entry (no auto unless chosen) under a key never used before (' +
      JSON.stringify(e) +
      ')',
  );
  await until(p, () => document.querySelector('.chatrow[data-chat="chess2"]'));
  ok(
    (await mcText(p, '#set-body')).includes(
      'Waiting for its first refresh. Ask Claude to “refresh Chess Club” (or “refresh my catch-up” for every chat).',
    ),
    'F1 SET4, stage B: a pending chat on a page with no schedule says to ask Claude',
  );
  ok(
    (await mcText(p, '#set-st-add')) ===
      'Chess Club is added. Waiting for its first refresh. Ask Claude to “refresh Chess Club” (or “refresh my catch-up” for every chat).',
    'F34: the note after adding a chat says how its first refresh comes, as its row does (' +
      (await mcText(p, '#set-st-add')) +
      ')',
  );
  ok(
    JSON.stringify(await p.$$eval('#add-start option', os => os.map(o => o.value + ' ' + o.textContent))) ===
      JSON.stringify([
        '1 The last day',
        '3 The last 3 days',
        '7 The last week',
        '14 The last 2 weeks',
        '30 The last month',
      ]),
    'F34: Add a chat asks how far back to read in days, a day by default',
  );
  // SET12, DM4, CT7: renaming a tag: empty, too long and duplicate refused; a good one shows at once, nothing else written
  for (const [t, why] of [
    ['', /can't be empty/],
    ['Cam', /already Camera Club's tag/],
  ]) {
    w0 = await mcNWrites(p);
    await p.fill('#tag-book', t);
    await p.click('.chatrow[data-chat="book"] .fld button');
    await p.waitForTimeout(100);
    ok(
      why.test(await mcText(p, '#set-st-book')) && (await mcNWrites(p)) === w0,
      'F1 SET12: the tag "' + t + '" is refused (' + (await mcText(p, '#set-st-book')) + ')',
    );
  }
  w0 = await mcNWrites(p);
  await p.fill('#tag-book', 'Brew');
  await p.click('.chatrow[data-chat="book"] .fld button');
  await until(p, () => __rt.get('meta/chat').chats.book.tag === 'Brew');
  const keys0 = await p.evaluate(() =>
    [...__rt.store.keys()]
      .filter(k => /^book_/.test(k))
      .sort()
      .join(),
  );
  ok(
    JSON.stringify(await mcWrites(p, w0)) === '["meta/chat"]' && keys0.includes('book_chunks/c0000'),
    "F1 SET12/DM4: a new tag is one meta/chat write; the chat's collections keep their names",
  );
  await p.click('#settings-close');
  await until(p, () => /Brew #3/.test(document.getElementById('v-all').textContent));
  ok(/Brew #3/.test(await mcText(p, '#v-all')), 'F1 CT7: the new tag shows at once in citations');
  // OB4, OB8: the page default and a chat's own setting
  await mcSettings(p);
  w0 = await mcNWrites(p);
  await p.check('#set-auto');
  await until(p, () => __rt.get('meta/chat').outboxAuto === true);
  await p.selectOption('#auto-cam', 'off');
  await until(p, () => __rt.get('meta/chat').chats.cam.auto === false);
  await p.selectOption('#auto-cam', '');
  await until(p, () => __rt.get('meta/chat').chats.cam.auto === null);
  ok(
    JSON.stringify(await mcWrites(p, w0)) === '["meta/chat","meta/chat","meta/chat"]',
    "F1 OB8: each reply setting is one meta/chat write (page default, a chat's own, cleared)",
  );
  // SET6: pause and resume
  await p.click('.chatrow[data-chat="cam"] .btns button:text("Pause")');
  await until(p, () => __rt.get('meta/chat').chats.cam.state === 'paused');
  await until(p, () =>
    /Paused: refreshes skip it/.test(document.querySelector('.chatrow[data-chat="cam"]').textContent),
  );
  ok(true, 'F1 SET6: Pause marks the chat paused and its line says so');
  await p.click('.chatrow[data-chat="cam"] .btns button:text("Resume")');
  await until(p, () => __rt.get('meta/chat').chats.cam.state === 'active');
  // SET7: Remove: delete chosen by default; Cancel writes nothing; Keep it hidden keeps every document
  await p.click('.chatrow[data-chat="book"] .btns button:text("Remove…")');
  ok(await p.isChecked('#rm-delete-book'), 'F1 SET7: Remove opens with "Delete its messages and photos" chosen');
  w0 = await mcNWrites(p);
  await p.click('.chatrow[data-chat="book"] .rmbox button:text("Cancel")');
  ok((await mcNWrites(p)) === w0 && !(await p.$('.rmbox')), 'F1 SET7: Cancel writes nothing');
  await p.click('.chatrow[data-chat="book"] .btns button:text("Remove…")');
  await p.check('#rm-hide-book');
  await p.click('#rm-go-book');
  await until(p, () => __rt.get('meta/chat').chats.book.state === 'hidden');
  ok(
    (await p.evaluate(() => [...__rt.store.keys()].filter(k => /^book_|chat-book/.test(k)).length)) >= 4,
    'F1 SET7: Keep it hidden deletes nothing',
  );
  await p.click('#settings-close');
  await until(p, () => !document.querySelector('#v-all .chatcard[data-chat="book"]'));
  ok(true, 'F1 PG3: a hidden chat leaves All chats');
  ok(s0 === (await p.evaluate(() => __rt.samples.length)), 'F1 SET13: managing chats asks Claude nothing');
  ok(p.errors.length === 0, 'F1: settings, no page errors ' + JSON.stringify(p.errors));
  await p.context().close();

  // SET7, STO6: deleting a chat removes its files, then its documents, and marks it deleted for good
  const camBlob = 'b10b' + '9'.repeat(28);
  p = await mcOpen({
    extra: { 'cam_photos/b0': { start: 0, byK: { 2: { 0: '/_blob/' + camBlob } }, gifs: [] } },
    opts: { blobs: { [camBlob]: { type: 'image/png', b64: PNG } } },
  });
  await mcSettings(p);
  await p.click('.chatrow[data-chat="cam"] .btns button:text("Remove…")');
  await until(p, () => /frees 1 file/.test((document.getElementById('rm-free-cam') || {}).textContent || ''));
  ok(
    /frees 1 file/.test(await mcText(p, '#rm-free-cam')),
    'F1 STO6: Remove says what deleting frees (' + (await mcText(p, '#rm-free-cam')) + ')',
  );
  await p.click('#rm-go-cam');
  await until(p, () => __rt.get('meta/chat').chats.cam.state === 'deleted', null, 8000);
  const left = await p.evaluate(() => [...__rt.store.keys()].filter(k => /^cam_|chat-cam|lastImport-cam/.test(k)));
  ok(
    !left.length &&
      (await p.evaluate(b => __rt.deletes.includes(b), camBlob)) &&
      (await get(p, 'chunks/c0000')) &&
      (await get(p, 'book_chunks/c0000')),
    "F1 STO6: Delete removes the chat's files and documents, and only its (" + left + ')',
  );
  ok(p.errors.length === 0, 'F1: delete, no page errors ' + JSON.stringify(p.errors));
  await p.context().close();

  // SET11: a viewer who can't write sees no chat controls
  p = await mcOpen({ opts: { canWrite: false } });
  await mcSettings(p);
  ok(
    /Only people who can edit this page/.test(await mcText(p, '#set-body')) && !(await p.$('#add-link')),
    'F1 SET11: a viewer without write access gets no controls',
  );
  await p.context().close();

  // SET3 on a page from before F1: the first write adds the first chat too
  p = await mcOpen({ one: true });
  await mcSettings(p);
  await p.fill('#add-link', 'https://www.messenger.com/t/8181');
  await p.fill('#add-name', 'Book Club');
  await p.click('#add-go');
  await until(p, () => __rt.get('meta/chat').chats);
  let cs = (await get(p, 'meta/chat')).chats;
  ok(
    JSON.stringify(Object.keys(cs).sort()) === '["bookcl","trail"]' &&
      cs.trail.home === true &&
      cs.trail.tag === 'Trail' &&
      cs.bookcl.tag === 'Book',
    'F1 SET3/MIG: adding a chat to a one-chat page writes its first chat too (' + Object.keys(cs) + ')',
  );
  ok((await mcText(p, '#h1')) === 'Trail Catch-up', "F1: a pending chat doesn't switch the page to All chats");
  await p.context().close();

  // STO2: the 80% warning names the chat that uses most; STO5: a chat with photos off stores none
  p = await mcOpen({
    chats: {
      book: { name: 'Book Club', tag: 'Book', color: 3, order: 2, state: 'active', thread: '6161', photos: false },
    },
    extra: {},
  });
  await p.evaluate(() => {
    const m = __rt.get('meta/chat');
    m.assetUsage = {
      files: 100,
      bytes: 0.85 * (1 << 30),
      maxFiles: 5000,
      maxBytes: 1 << 30,
      at: new Date(Date.now() + 864e5).toISOString(),
      byChat: { trail: { files: 30, bytes: 1e8 }, cam: { files: 70, bytes: 8e8 } },
    };
    __rt.write('meta/chat', m);
  });
  await until(p, () => /Most of it is Camera Club's/.test(document.getElementById('storage-st').textContent));
  ok(
    /Most of it is Camera Club's/.test(await mcText(p, '#storage-st')),
    'F1 STO2: the storage warning names the chat that uses most',
  );
  await mcPick(p, 'book');
  const up0 = await p.evaluate(() => __rt.uploads.length);
  r = await mcPaste(
    p,
    Object.assign(cap(mcMsgs('book', 7).slice(6), { photos: [{ i: 6, k: 0, type: 'image/png', b64: PNG }] }), {
      thread: '6161',
    }),
    'book',
  );
  ok(
    r && r.ok && (await p.evaluate(() => __rt.uploads.length)) === up0,
    'F1 STO5: a chat set not to store photos stores none',
  );
  // STO1: an import in a chat records that chat's share of the page's files
  await mcPick(p, 'cam');
  r = await mcPaste(
    p,
    Object.assign(cap(mcMsgs('cam', 9).slice(8), { photos: [{ i: 8, k: 0, type: 'image/png', b64: PNG }] }), {
      thread: '5151',
    }),
    'cam',
  );
  await until(p, () => ((__rt.get('meta/chat').assetUsage || {}).byChat || {}).cam?.files === 1, null, 8000);
  const au = (await get(p, 'meta/chat')).assetUsage;
  ok(
    au.byChat.cam.files === 1 &&
      au.byChat.cam.bytes > 0 &&
      au.byChat.trail.files === 30 &&
      !(await get(p, 'meta/chat-cam')).assetUsage,
    "F1 STO1: an import records its chat's share in meta/chat.assetUsage.byChat (" + JSON.stringify(au.byChat) + ')',
  );
  ok(p.errors.length === 0, 'F1: storage, no page errors ' + JSON.stringify(p.errors));
  await p.context().close();

  // PH1, PH4: at 390 px, a long chat name and a long status line fit with no sideways scroll
  for (const vp of [
    { width: 390, height: 844 },
    { width: 360, height: 740 },
  ]) {
    p = await mcOpen(
      {
        chats: {
          cam: {
            name: 'Camera Club and Friends of the Lens',
            tag: 'Cam',
            color: 2,
            order: 1,
            state: 'active',
            thread: '5151',
          },
          book: {
            name: 'Book Club',
            tag: 'Book',
            color: 3,
            order: 2,
            state: 'pending',
            thread: '6161',
            reason:
              'Messenger said the chat isn’t available, which can happen when the link is for a chat you left long ago.',
          },
        },
      },
      { viewport: vp },
    );
    const fit = async () =>
      p.evaluate(() => [
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        (q => !q || q.scrollWidth <= q.clientWidth + 1)(document.querySelector('nav.tabs')),
      ]);
    const a1 = await fit();
    await mcPick(p, 'cam');
    const a2 = await fit();
    await mcSettings(p);
    const a3 = await fit();
    ok(
      [a1, a2, a3].every(x => x[0] && x[1]),
      'F1 PH1/PH4: ' +
        vp.width +
        ' px, All chats, a long-named chat and Settings fit with no sideways scroll (' +
        JSON.stringify([a1, a2, a3]) +
        ')',
    );
    await p.context().close();
  }
  // PH6: dark mode: the chat tags keep their text
  p = await mcOpen({}, { colorScheme: 'dark' });
  const tags = await p.$$eval('#v-all .ctag', ts =>
    ts.map(t => t.textContent + ':' + getComputedStyle(t).borderTopColor),
  );
  ok(
    tags.length === 3 && tags[0].startsWith('Trail:') && new Set(tags.map(t => t.split(':')[1])).size === 3,
    'F1 PH6: in dark mode each tag shows its text and its own colour (' + tags + ')',
  );
  await p.context().close();

  // DM6: twelve chats with long names keep meta/chat small
  p = await mcOpen({ one: true });
  for (let k = 0; k < 12; k++)
    await p.evaluate(
      k =>
        addChat({
          link: 'https://www.facebook.com/messages/t/9' + k + '000',
          name: 'A rather long chat name number ' + k,
          start: 300,
          photos: true,
          auto: null,
        }),
      k,
    );
  await until(p, () => Object.keys(__rt.get('meta/chat').chats || {}).length === 13);
  const sz = await p.evaluate(() => new TextEncoder().encode(JSON.stringify(__rt.get('meta/chat').chats)).length);
  const ks = Object.keys((await get(p, 'meta/chat')).chats);
  ok(
    sz < 8192 && new Set(ks).size === 13 && ks.every(k => /^[a-z0-9]{1,6}$/.test(k)),
    'F1 DM5/DM6: 13 chats, unique short keys, the list ' + sz + ' bytes (under 8 KiB)',
  );
  await p.context().close();
}

/* F1 stage A, review of PR #60: each check failed on the code before its fix */
async function multiChat2() {
  const pend = {
    chess: {
      name: 'Chess Club',
      tag: 'Chess',
      color: 4,
      order: 3,
      state: 'pending',
      thread: '7171',
      url: 'https://www.facebook.com/messages/t/7171',
      start: 300,
    },
  };
  const seeded = {
    'meta/chat-chess': {
      key: 'chess',
      thread: '7171',
      chatUrl: 'https://www.facebook.com/messages/t/7171',
      threadName: 'Chess Club',
      shortName: 'Chess',
      chunkSize: 82,
      lastI: -1,
      anchorMids: [],
      markerMode: null,
    },
  };
  // 1: a pending chat opens for its first paste, which the guard accepts
  let p = await mcOpen({ chats: pend, extra: seeded });
  await p.evaluate(() => openChat('chess'));
  await p.waitForTimeout(300);
  ok(
    (await mcText(p, '#h1')) === 'Chess Club' && (await mcText(p, '#window')).includes('refresh Chess Club'),
    'F1 review 1: a pending chat opens, saying it waits for its first refresh (' + (await mcText(p, '#h1')) + ')',
  );
  let r = await mcPaste(p, Object.assign(cap(mcMsgs('chess', 3)), { thread: '7171' }), 'chess');
  ok(
    r && r.ok && (await get(p, 'meta/chat-chess')).lastI === 2 && (await get(p, 'chess_chunks/c0000')),
    'F1 review 1: its first capture imports into its own documents (' + (r && r.msg) + ')',
  );
  // 9: a jump waiting for a message that never loaded doesn't follow the page into another chat
  await p.evaluate(() => openChat('book', 7)); /* Book Club has #0-#5 only */
  await p.waitForTimeout(300);
  await flashReset(p);
  await p.evaluate(() => openChat('cam'));
  await p.waitForTimeout(500);
  ok(
    (await p.evaluate(() => S.goAfterLoad == null)) && !(await p.$('#m7[data-flashed]')),
    'F1 review 9: a pending jump is dropped when another chat opens',
  );
  // 2: no chat switch while this tab imports, stores photos or packs
  for (const busy of ['S.importing = true', 'PK.busy = true']) {
    await p.evaluate(b => {
      openChat('trail');
      eval(b);
    }, busy);
    await p.evaluate(() => openChat('cam'));
    await p.waitForTimeout(200);
    await p.click('#h1');
    const dis = await p.$eval('#picker-list button[data-key="cam"]', b => b.disabled);
    const note = await mcText(p, '#picker-list');
    await p.keyboard.press('Escape');
    ok(
      (await p.evaluate(() => CUR.key)) === 'trail' && dis && /switch chats once/.test(note),
      'F1 review 2: with ' + busy + " the chat can't change and the picker says why (" + note.slice(-80) + ')',
    );
    await p.evaluate(() => {
      S.importing = false;
      PK.busy = false;
    });
  }
  // 10: the schedule line names the first chat's phrase, whichever chat is open
  await p.evaluate(() => {
    const m = __rt.get('meta/chat');
    delete m.refreshPhrase;
    m.schedule = { mode: 'chain', every: 60, tz: 'America/Los_Angeles' };
    __rt.write('meta/chat', m);
    __rt.write('refresh/schedule', { armId: 'a1', tool: 'send_later', problem: 'chain stopped', nextAt: null });
  });
  await p.evaluate(() => openChat('cam'));
  await p.waitForTimeout(400);
  const sched = await mcText(p, '#sched');
  ok(
    !/refresh Camera Club/.test(sched),
    "F1 review 10: the schedule line in an added chat doesn't name it (" + sched + ')',
  );
  // claude.ai check B: back on All chats, the phrase is the first chat's, not the chat looked at last
  await p.evaluate(() => {
    S.view = 'all';
    showView();
  });
  await p.waitForTimeout(200);
  const rpAll = await p.evaluate(() => RP());
  ok(!/Camera Club/.test(rpAll), "F1 check B: All chats doesn't use the last chat's phrase (" + rpAll + ')');
  // 7 (v1.35.1): a capture that doesn't name its chat (helper 2.2 or older) is refused in an added chat only
  await p.evaluate(() => openChat('cam'));
  await p.waitForTimeout(200);
  const w0 = await mcNWrites(p);
  r = await mcPaste(p, cap(mcMsgs('cam', 9).slice(8)), 'cam');
  ok(
    r &&
      r.ok === false &&
      /doesn't say which chat.*Camera Club is an added chat.*Update the helper/.test(r.msg) &&
      !(await mcWrites(p, w0)).some(x => /chunks/.test(x)),
    'F1 review 7: a capture without its chat is refused in an added chat (' + (r && r.msg) + ')',
  );
  await p.evaluate(() => openChat('trail'));
  await p.waitForTimeout(200);
  // PR #61 review 1: one an older helper read from an added chat (its scan stopped at Camera Club's #7, numbered on
  // from the first chat's #11, as a scan with the first chat's base would) is refused
  const w2 = await mcNWrites(p);
  r = await mcPaste(p, Object.assign(cap(mcMsgs('cam', 13).slice(12)), { anchor: 'mid.cam7' }), 'trail');
  ok(
    r &&
      r.ok === false &&
      /doesn't say which chat.*doesn't continue from Trail Crew's saved messages.*Update the helper/.test(r.msg) &&
      !(await mcWrites(p, w2)).some(x => /chunks/.test(x)) &&
      (await get(p, 'meta/chat')).lastI === 11,
    "PR #61 review 1: in the first chat, a capture without its chat that doesn't continue the first chat's anchors is refused (" +
      (r && r.msg) +
      ')',
  );
  r = await mcPaste(p, Object.assign(cap(mcMsgs('trail', 13).slice(12)), { anchor: 'mid.trail11' }), 'trail');
  ok(
    r && r.ok && r.fresh === 1 && (await get(p, 'meta/chat')).lastI === 12,
    'F1 review 7: the first chat takes a capture without its chat that continues its anchors, as before F1 (' +
      (r && r.msg) +
      ')',
  );
  ok(p.errors.length === 0, 'F1 review: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
  // v1.35.1: a page with its first chat and one pending chat (no meta/chat-chess yet) still takes the first chat's
  // capture from an older helper (no thread), as scheduled refreshes paste it; the pending chat refuses one
  const one = mcSeed({ one: true });
  one['meta/chat'].chats = {
    trail: { name: 'Trail Crew', tag: 'Trail', color: 1, order: 0, state: 'active', home: true },
    chess: pend.chess,
  };
  p = await open(one, PAGE);
  r = await mcPaste(p, Object.assign(cap(mcMsgs('trail', 14).slice(12)), { anchor: 'mid.trail10' }), 'trail');
  ok(
    r &&
      r.ok &&
      r.fresh === 2 &&
      (await get(p, 'meta/chat')).lastI === 13 &&
      (await get(p, 'chunks/c0000')).msgs.length === 14,
    'v1.35.1: with a pending chat added, the first chat imports a capture without its chat (' + (r && r.msg) + ')',
  );
  await p.evaluate(() => openChat('chess'));
  await p.waitForTimeout(300);
  const w1 = await mcNWrites(p);
  r = await mcPaste(p, cap(mcMsgs('chess', 3)), 'chess');
  ok(
    r &&
      r.ok === false &&
      /doesn't say which chat.*Chess Club is an added chat/.test(r.msg) &&
      !(await mcWrites(p, w1)).some(x => /chunks/.test(x)),
    'v1.35.1: the pending chat refuses a capture without its chat (' + (r && r.msg) + ')',
  );
  ok(p.errors.length === 0, 'v1.35.1: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
  // 5: Bring back puts a chat removed while pending back to pending
  p = await mcOpen({ chats: pend });
  await mcSettings(p);
  await p.click('.chatrow[data-chat="chess"] .btns button:text("Remove…")');
  await p.check('#rm-hide-chess');
  await p.click('#rm-go-chess');
  await until(p, () => __rt.get('meta/chat').chats.chess.state === 'hidden');
  await until(p, () => document.querySelector('.chatrow[data-chat="chess"] .btns button'));
  await p.click('.chatrow[data-chat="chess"] .btns button:text("Bring back")');
  await until(p, () => __rt.get('meta/chat').chats.chess.state !== 'hidden');
  ok(
    (await get(p, 'meta/chat')).chats.chess.state === 'pending',
    'F1 review 5: Bring back restores a pending chat to pending (' +
      (await get(p, 'meta/chat')).chats.chess.state +
      ')',
  );
  await p.context().close();
  // 8: deleting reads every photos block (a listing in pages), holds the import lease, and waits for a running refresh
  const b1 = 'b10b' + '7'.repeat(28),
    b2 = 'b10b' + '8'.repeat(28);
  const del = () =>
    mcOpen({
      extra: {
        'cam_photos/b0': { start: 0, byK: { 2: { 0: '/_blob/' + b1 } }, gifs: [] },
        'cam_photos/b500': { start: 500, byK: { 520: { 0: '/_blob/' + b2 } }, gifs: [] },
        'meta/chat-cam': Object.assign(mcSeed()['meta/chat-cam'], { lastI: 600 }),
      },
      opts: { getPage: 1, blobs: { [b1]: { type: 'image/png', b64: PNG }, [b2]: { type: 'image/png', b64: PNG } } },
    });
  p = await del();
  await p.evaluate(() =>
    __rt.write('refresh/status', { state: 'running', startedAt: new Date().toISOString(), step: 'scan' }),
  );
  await mcSettings(p);
  await p.click('.chatrow[data-chat="cam"] .btns button:text("Remove…")');
  await p.click('#rm-go-cam');
  await p.waitForTimeout(500);
  ok(
    (await get(p, 'meta/chat')).chats.cam.state === 'active' &&
      (await get(p, 'cam_chunks/c0000')) &&
      /refresh is running/.test(await mcText(p, '#set-st-cam')),
    'F1 review 8: Delete waits while a refresh holds the run lock (' + (await mcText(p, '#set-st-cam')) + ')',
  );
  await p.context().close();
  p = await del();
  await mcSettings(p);
  await p.click('.chatrow[data-chat="cam"] .btns button:text("Remove…")');
  await p.click('#rm-go-cam');
  await until(p, () => __rt.get('meta/chat').chats.cam.state === 'deleted', null, 8000);
  const left = await p.evaluate(() => [...__rt.store.keys()].filter(k => /^cam_/.test(k)));
  const gone = await p.evaluate(([x, y]) => [__rt.deletes.includes(x), __rt.deletes.includes(y)], [b1, b2]);
  const leased = await p.evaluate(() => __rt.leases.has('refresh/importLock'));
  ok(
    !left.length && gone.every(Boolean) && leased,
    'F1 review 8: Delete reads every block, takes the import lease and leaves nothing (' +
      JSON.stringify([left, gone, leased]) +
      ')',
  );
  await p.context().close();
  // B54: an ISO lastRefresh (the first chat's, as a scheduled run wrote it) shows in the display form everywhere: each
  // All chats card and each Settings row; an added chat's line no longer says it isn't in scheduled refreshes (stage B)
  const s54 = mcSeed();
  s54['meta/chat'].lastRefresh = '2026-11-23T17:04:30Z';
  s54['meta/chat-cam'].lastRefresh = '2026-11-23T16:34:00Z';
  p = await open(s54);
  const cards54 = await p.$$eval('#v-all .chatcard', cs => cs.map(c => c.dataset.chat + '|' + c.textContent));
  await mcSettings(p);
  const rows54 = await p.$$eval('.chatrow', rs => rs.map(r => r.dataset.chat + '|' + r.textContent));
  const both = cards54.concat(rows54);
  const trail54 = both.filter(t => t.startsWith('trail|'));
  const cam54 = both.filter(t => t.startsWith('cam|'));
  ok(
    trail54.length === 2 &&
      cam54.length === 2 &&
      trail54.every(t => t.includes('Last refreshed Mon Nov 23, 9:04 AM.')) &&
      cam54.every(t => t.includes('Last refreshed Mon Nov 23, 8:34 AM.')) &&
      !both.some(t => /2026-11-23T/.test(t)),
    'B54: an ISO lastRefresh shows as "Mon Nov 23, 9:04 AM" on the All chats card and the Settings row (' +
      JSON.stringify(both.map(t => t.slice(0, 160))) +
      ')',
  );
  ok(
    !both.some(t => /scheduled refreshes yet|Scheduled runs refresh only|To refresh it, ask Claude/.test(t)),
    "F1 stage B: an added chat's line no longer says it's left out of scheduled refreshes (" +
      JSON.stringify(cam54.map(t => t.slice(0, 200))) +
      ')',
  );
  ok(
    (await mcText(p, '#set-body')).includes(
      'Send queued replies automatically (all chats, unless a chat below says otherwise)',
    ),
    'Settings: the page default for replies reads "Send queued replies automatically (…)"',
  );
  const opts54 = await p.$$eval('#auto-cam option', os => os.map(o => o.value + '=' + o.textContent));
  const camRow = rows54.find(t => t.startsWith('cam|')) || '';
  ok(
    JSON.stringify(opts54) ===
      JSON.stringify(['=Same as all chats (wait for my OK)', 'on=Send automatically', 'off=Wait for my OK']) &&
      camRow.includes("Short tag (up to 8 letters), shown beside this chat's messages and citations") &&
      camRow.includes('Queued replies in this chat') &&
      camRow.includes('Pause this chat') &&
      camRow.includes('Pausing stops refreshes of this chat until you resume it. Its messages stay on the page.'),
    "Settings: a chat row's tag, reply and Pause wording, each option keeping its value (" +
      JSON.stringify([opts54, camRow.slice(0, 400)]) +
      ')',
  );
  ok(!p.errors.length, 'B54: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
  // F1 stage B: one schedule refreshes every chat. A chat the last run didn't reach (refresh/skipped, which only a
  // run's end writes) says so on its All chats card and Settings row; Add a chat says the next refresh reads the chat
  // with the others; a pending chat names the next scheduled run only while a schedule is on
  const LIVE = { mode: 'chain', every: 60, tz: 'America/Los_Angeles' };
  const FUTURE = { armId: '20261123T170000Z-ab12', nextAt: '2099-01-01T00:00:00Z' };
  const sB = mcSeed({ chats: pend, extra: seeded });
  sB['meta/chat'].schedule = LIVE;
  sB['refresh/schedule'] = FUTURE;
  sB['refresh/skipped'] = { keys: ['book', 'chess'], at: '2026-11-23T17:21:00Z', run: '2026-11-23T17:00:00Z' };
  p = await open(sB);
  const SKIP = 'Not refreshed in the last run: it reached the 15-minute limit. The next run starts with this chat.';
  const SCHED = 'Gets its first refresh at the next scheduled run (or ask Claude to “refresh Chess Club”).';
  const MANUAL =
    'Waiting for its first refresh. Ask Claude to “refresh Chess Club” (or “refresh my catch-up” for every chat).';
  const lines = async () => {
    const o = {};
    for (const c of await p.$$eval('#v-all .chatcard', cs => cs.map(c => [c.dataset.chat, c.textContent])))
      o['all:' + c[0]] = c[1];
    for (const c of await p.$$eval('.chatrow', rs => rs.map(r => [r.dataset.chat, r.textContent])))
      o['set:' + c[0]] = c[1];
    return o;
  };
  let L = await lines();
  ok(
    (L['all:book'] || '').includes(SKIP) && ['all:trail', 'all:cam'].every(k => L[k] && !L[k].includes(SKIP)),
    "F1 stage B: All chats: the skipped chat's card says so, the others not (" + JSON.stringify(L) + ')',
  );
  await mcSettings(p);
  L = await lines();
  ok(
    (L['set:book'] || '').includes(SKIP) &&
      ['set:trail', 'set:cam', 'set:chess'].every(k => L[k] && !L[k].includes(SKIP)) &&
      L['set:chess'].includes(SCHED),
    'F1 stage B: Settings: the skipped chat says so; the others do not; a pending chat names the next scheduled run (' +
      JSON.stringify(L) +
      ')',
  );
  const addNote = await mcText(p, '.addform');
  ok(
    addNote.includes(
      "You don't need Claude for this: the page saves it, and the next refresh, scheduled or asked for, reads it with your other chats. To read it sooner, ask Claude to “refresh” and the chat's name.",
    ) && !/scheduled refreshes yet/.test(addNote),
    'F1 stage B: Add a chat says the next refresh reads the new chat with the others (' + addNote.slice(0, 600) + ')',
  );
  // review 6c: a status change never rebuilds Settings: a half-typed link survives, focus elsewhere, while the
  // skipped notes update in place
  await p.fill('#add-link', 'https://www.facebook.com/messages/t/99');
  await p.click('.addform h3');
  await p.evaluate(() => {
    __rt.write('refresh/status', { state: 'running', startedAt: new Date().toISOString(), step: 'scan' });
    __rt.write('refresh/skipped', { keys: ['trail'], at: new Date().toISOString(), run: new Date().toISOString() });
  });
  const moved = await until(
    p,
    s => document.querySelector('.chatrow[data-chat="trail"] .chatline').textContent.includes(s),
    SKIP,
  );
  ok(
    moved &&
      (await p.inputValue('#add-link')) === 'https://www.facebook.com/messages/t/99' &&
      !(await mcText(p, '.chatrow[data-chat="book"]')).includes(SKIP),
    'F1 review 6c: a status and skipped change update the notes in place; a half-typed Add a chat link survives (' +
      (await p.inputValue('#add-link')) +
      ')',
  );
  await p.click('#settings-close');
  await p.waitForTimeout(150);
  await p.evaluate(() =>
    __rt.write('refresh/status', { state: 'done', finishedAt: new Date().toISOString(), added: 3 }),
  );
  await p.evaluate(() =>
    __rt.write('refresh/skipped', { keys: ['cam'], at: new Date().toISOString(), run: new Date().toISOString() }),
  );
  await until(p, s => document.querySelector('#v-all .chatcard[data-chat="cam"]').textContent.includes(s), SKIP);
  L = await lines();
  ok(
    L['all:cam'].includes(SKIP) && !L['all:book'].includes(SKIP) && !L['all:trail'].includes(SKIP),
    'F1 review 1: the note follows refresh/skipped, whatever refresh/status says (' + JSON.stringify(L) + ')',
  );
  // review 6b: a chain that has stopped is no schedule to wait for
  await p.evaluate(() => __rt.write('refresh/schedule', { armId: 'x', nextAt: '2026-01-01T00:00:00Z' }));
  await mcSettings(p);
  ok(
    await until(p, s => document.querySelector('.chatrow[data-chat="chess"]').textContent.includes(s), MANUAL),
    'F1 review 6b: a stopped chain: the pending chat says to ask Claude (' +
      (await mcText(p, '.chatrow[data-chat="chess"]')) +
      ')',
  );
  ok(!p.errors.length, 'F1 stage B: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
  // review 6b: no schedule, "manual" or an unknown mode: ask Claude; "recurring": the next scheduled run. 6a: the
  // phrase for every chat is "refresh my catch-up" even with an added chat open
  for (const [sc, want, why] of [
    [undefined, MANUAL, 'no schedule'],
    [{ mode: 'manual' }, MANUAL, 'refreshes only on request'],
    [{ mode: 'B', every: 60 }, MANUAL, 'an unknown mode'],
    [{ mode: 'recurring', every: 60 }, SCHED, 'a recurring task'],
  ]) {
    const sM = mcSeed({ chats: pend, extra: seeded });
    if (sc) sM['meta/chat'].schedule = sc;
    p = await open(sM);
    await p.evaluate(() => openChat('cam'));
    await p.waitForTimeout(200);
    await mcSettings(p);
    const t = await mcText(p, '.chatrow[data-chat="chess"]');
    ok(
      t.includes(want) && !/for every chat/.test(t.replace(want, '')),
      'F1 review 6a/6b: ' + why + ', with Camera Club open: the pending line (' + t.slice(0, 200) + ')',
    );
    await p.context().close();
  }
  // B57: every All chats card's title starts just right of its tag, with or without an Open link (a pending chat has
  // none); B56: a chat with no messages shows no counter strip left from the chat before; the pending chat's own
  // header says how it gets its first refresh, as its card does
  const s57 = mcSeed({ chats: pend, extra: seeded });
  s57['meta/chat'].schedule = LIVE;
  s57['refresh/schedule'] = FUTURE;
  p = await open(s57);
  const heads = await p.$$eval('#v-all .chatcard', cs =>
    cs.map(c => {
      const t = c.querySelector('.chathead .ctag').getBoundingClientRect();
      const h = c.querySelector('.chathead h2').getBoundingClientRect();
      return [c.dataset.chat, Math.round(h.left - t.right)];
    }),
  );
  ok(
    heads.length === 4 && heads.every(([, gap]) => gap >= 4 && gap <= 12),
    'B57: each card title sits just right of its tag, the pending card (no Open) too (' + JSON.stringify(heads) + ')',
  );
  await p.evaluate(() => openChat('cam'));
  const camStrip = await until(p, () => document.querySelector('#strip').textContent.includes('new messages'));
  await p.evaluate(() => openChat('chess'));
  await until(p, () => document.querySelector('#h1').textContent === 'Chess Club');
  await p.waitForTimeout(300);
  ok(
    camStrip && (await mcText(p, '#strip')) === '',
    'B56: a chat with no messages shows no counter strip from the chat before (' + (await mcText(p, '#strip')) + ')',
  );
  ok(
    (await mcText(p, '#window')) === 'No messages stored yet. ' + SCHED,
    "F1 review 8: the pending chat's header says how it gets its first refresh (" + (await mcText(p, '#window')) + ')',
  );
  ok(!p.errors.length, 'B56/B57: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
}

// F1 stage B leftovers: the chats' order (q6) and How often per chat with a page default (q10), both in Settings › Your
// chats. The page writes each chat's `order` (Move up / Move down, by mouse, keyboard or touch: plain buttons), the
// page default `meta/chat.chatEvery` and each chat's `every`; catchup.py's run-plan reads them (TestRunPlan)
async function multiChat3() {
  const chess = { chess: { name: 'Chess Club', tag: 'Chess', color: 4, order: 3, state: 'active', thread: '7171' } };
  /* tall enough that Settings shows every row without scrolling, for the drag below */
  let p = await mcOpen({ chats: chess }, { viewport: { width: 1000, height: 2400 } });
  await mcSettings(p);
  const body = await mcText(p, '#set-body');
  ok(
    body.includes(
      "Trail Crew always refreshes first. Use Move up and Move down to set the order of the others. A run starts with any chat the last one didn't reach, and a new chat's first refresh comes after the rest.",
    ) &&
      !(await p.$('#mv-up-trail')) &&
      !(await p.$('#mv-dn-trail')),
    'F1 q6: Settings says the first chat always refreshes first, and it has no Move buttons',
  );
  const dis = await p.$$eval('[id^="mv-"]', bs =>
    bs.map(b => b.id + ':' + b.disabled + ':' + b.getAttribute('aria-label')),
  );
  ok(
    JSON.stringify(dis) ===
      JSON.stringify([
        'mv-up-cam:true:Move up: Camera Club',
        'mv-dn-cam:false:Move down: Camera Club',
        'mv-up-book:false:Move up: Book Club',
        'mv-dn-book:false:Move down: Book Club',
        'mv-up-chess:false:Move up: Chess Club',
        'mv-dn-chess:true:Move down: Chess Club',
      ]),
    'F1 q6: each chat after the first has Move up and Move down, named for screen readers, off at the ends (' +
      dis +
      ')',
  );
  // by mouse: Camera Club down, below Book Club: one meta/chat update holding the whole order after the first chat
  const rowsAre = want =>
    until(p, w => [...document.querySelectorAll('.chatrow')].map(x => x.dataset.chat).join() === w, want.join());
  const w0 = await mcNWrites(p);
  await p.click('#mv-dn-cam');
  await until(p, () => __rt.get('meta/chat').chats.cam.order === 2);
  await until(p, () => document.getElementById('set-st-cam').textContent === 'Order saved.');
  const wr = await p.evaluate(n => __rt.writes.slice(n), w0);
  let ch = (await get(p, 'meta/chat')).chats;
  ok(
    wr.length === 1 &&
      wr[0].p === 'meta/chat' &&
      JSON.stringify(wr[0].v.chats) ===
        JSON.stringify({ book: { order: 1 }, cam: { order: 2 }, chess: { order: 3 } }) &&
      ch.trail.order === 0 &&
      (await rowsAre(['trail', 'book', 'cam', 'chess'])),
    'F1 q6: Move down writes the order of every chat after the first, in one update, and the rows follow (' +
      JSON.stringify(wr) +
      ')',
  );
  ok(
    (await p.evaluate(() => document.activeElement.id)) === 'mv-dn-cam',
    'F1 q6: focus stays on the button pressed, and the row says "Order saved."',
  );
  // by keyboard, two presses before the first write's snapshot can arrive (Enter, then Space at once): Chess Club up
  // above Camera Club, then above Book Club. The second press moves from the order the first made (the page applies a
  // move at once), so the store ends with one order for each chat
  await p.focus('#mv-up-chess');
  await p.keyboard.press('Enter');
  await p.keyboard.press('Space');
  await until(p, () => __rt.get('meta/chat').chats.chess.order === 1);
  const rows = await rowsAre(['trail', 'chess', 'book', 'cam']);
  ch = (await get(p, 'meta/chat')).chats;
  ok(
    JSON.stringify([ch.chess.order, ch.book.order, ch.cam.order, ch.trail.order]) === JSON.stringify([1, 2, 3, 0]) &&
      rows &&
      (await p.evaluate(() => document.activeElement.id)) === 'mv-dn-chess',
    'F1 q6: Move up works from the keyboard (Enter and Space, pressed at once), the rows follow, and at the top focus moves to Move down (Move up is off there) (' +
      JSON.stringify(ch) +
      ')',
  );
  // by mouse drag (desktop): Camera Club's handle onto Chess Club's row puts it in that place, the same write
  const w1 = await mcNWrites(p);
  await p.dragAndDrop('.chatrow[data-chat="cam"] .draghandle', '.chatrow[data-chat="chess"]');
  await until(p, () => __rt.get('meta/chat').chats.cam.order === 1);
  const wd = await p.evaluate(n => __rt.writes.slice(n), w1);
  ok(
    wd.length === 1 &&
      JSON.stringify(wd[0].v.chats) ===
        JSON.stringify({ cam: { order: 1 }, chess: { order: 2 }, book: { order: 3 } }) &&
      (await rowsAre(['trail', 'cam', 'chess', 'book'])) &&
      !(await p.$('.chatrow[data-chat="trail"] .draghandle')),
    'F1 q6: dragging a row by its handle writes the whole order, as the buttons do; the first chat has no handle (' +
      JSON.stringify(wd) +
      ')',
  );
  // the title's chat list and All chats follow the order; the first chat stays first
  await p.click('#settings-close');
  await p.click('#h1');
  const picks = await p.$$eval('#picker-list button', bs => bs.map(b => b.dataset.key));
  await p.keyboard.press('Escape');
  const cards = await p.$$eval('#v-all .chatcard', cs => cs.map(c => c.dataset.chat));
  ok(
    JSON.stringify(picks) === JSON.stringify(['all', 'trail', 'cam', 'chess', 'book', 'add']) &&
      JSON.stringify(cards) === JSON.stringify(['trail', 'cam', 'chess', 'book']),
    "F1 q6: the title's chat list and All chats follow the new order (" + JSON.stringify([picks, cards]) + ')',
  );
  // How often: the page default and each chat's own, with plain labels
  await mcSettings(p);
  const dflt = await p.$$eval('#set-every option', os => os.map(o => o.value + '=' + o.textContent));
  const own = await p.$$eval('#every-book option', os => os.map(o => o.value + '=' + o.textContent));
  ok(
    JSON.stringify(dflt) ===
      JSON.stringify(['0=Every scheduled run', '120=Every 2 hours', '240=Every 4 hours', '1440=Once a day']) &&
      JSON.stringify(own) ===
        JSON.stringify([
          '=Same as all chats (every scheduled run)',
          '0=Every scheduled run',
          '120=Every 2 hours',
          '240=Every 4 hours',
          '1440=Once a day',
        ]) &&
      (await p.inputValue('#set-every')) === '0' &&
      (await p.inputValue('#every-book')) === '',
    'F1 q10: How often offers every scheduled run, 2 hours, 4 hours and once a day, a chat also "Same as all chats" (' +
      JSON.stringify([dflt, own]) +
      ')',
  );
  const sb = await mcText(p, '#set-body');
  ok(
    sb.includes('How often scheduled runs refresh each chat') &&
      sb.includes('A refresh you ask for (“refresh my catch-up”) always refreshes every chat.') &&
      (await mcText(p, '.chatrow[data-chat="book"]')).includes('How often scheduled runs refresh this chat'),
    'F1 q10: the labels, and that a refresh you ask for refreshes every chat',
  );
  ok(
    !(await p.$('#every-trail')) &&
      (await mcText(p, '.chatrow[data-chat="trail"]')).includes(
        "Scheduled runs always refresh this chat: it's the first chat.",
      ),
    'F1 q10: the first chat has no How often; its row says scheduled runs always refresh it',
  );
  await p.selectOption('#every-book', '240');
  await until(p, () => __rt.get('meta/chat').chats.book.every === 240);
  await until(p, () => document.getElementById('set-st-book').textContent === 'Saved.');
  ok(true, 'F1 q10: a chat\'s How often writes its `every` (240) and says "Saved."');
  ok(
    await until(p, () =>
      document
        .querySelector('.chatrow[data-chat="book"] .chatline')
        .textContent.includes('Scheduled runs refresh it every 4 hours.'),
    ),
    "F1 q10: the chat's line says its new How often at once, while the select keeps focus",
  );
  await p.selectOption('#every-book', '');
  await until(p, () => __rt.get('meta/chat').chats.book.every === null);
  ok(true, 'F1 q10: "Same as all chats" writes `every` null');
  await p.selectOption('#every-cam', '0');
  await until(p, () => __rt.get('meta/chat').chats.cam.every === 0);
  ok(true, 'F1 q10: "Every scheduled run" on a chat writes `every` 0 (it overrides a slower default)');
  await p.selectOption('#set-every', '120');
  await until(p, () => __rt.get('meta/chat').chatEvery === 120);
  await until(p, () => document.getElementById('set-st-every').textContent === 'Saved.');
  ok(true, 'F1 q10: the page default writes meta/chat.chatEvery (120) and says "Saved."');
  ok(
    await until(
      p,
      () => document.querySelector('#every-book option[value=""]').textContent === 'Same as all chats (every 2 hours)',
    ),
    'F1 q10: each chat\'s "Same as all chats (…)" names the new default at once, while #set-every keeps focus',
  );
  await p.click('#settings-close');
  await mcSettings(p);
  ok(
    (await p.$eval('#every-book option', o => o.textContent)) === 'Same as all chats (every 2 hours)' &&
      (await p.inputValue('#every-cam')) === '0' &&
      (await p.inputValue('#set-every')) === '120',
    'F1 q10: reopened, Settings shows each choice, "Same as all chats" naming the default',
  );
  await p.evaluate(() => {
    const m = JSON.parse(JSON.stringify(__rt.get('meta/chat')));
    m.chats.cam.every = 60;
    __rt.write('meta/chat', m);
  });
  ok(
    await until(
      p,
      () =>
        (document.querySelector('#every-cam option[value="60"]') || {}).textContent === 'Hourly' &&
        document
          .querySelector('.chatrow[data-chat="cam"] .chatline')
          .textContent.includes('Scheduled runs refresh it hourly.'),
    ),
    'F1 q10: a How often the page doesn\'t offer (60) reads "Hourly", as the schedule says it',
  );
  // opened from an added chat, the note still names the page's own phrase (the one that refreshes every chat)
  await p.click('#settings-close');
  await p.evaluate(() => openChat('book'));
  await until(p, () => document.querySelector('#h1').textContent === 'Book Club');
  await mcSettings(p);
  ok(
    (await mcText(p, '#set-body')).includes(
      'A refresh you ask for (“refresh my catch-up”) always refreshes every chat.',
    ),
    "F1 q10: from an added chat, the note names the page's refresh phrase, not the chat's",
  );
  ok(!p.errors.length, 'F1 q6/q10: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();

  // each chat's line: its How often and, with a schedule on, about when its next refresh is: the later of when it's due
  // (the start of the run that last refreshed it, refresh/skipped.last, plus its interval less 15 minutes) and the
  // schedule's next run. On the page's clock: 9:00 AM in Los Angeles
  const T = Date.parse('2026-11-23T17:00:00Z');
  const sL = mcSeed();
  sL['meta/chat'].chats.book.every = 240;
  sL['meta/chat'].chats.cam.every = 1440;
  sL['meta/chat'].chats.trail.every = 240;
  sL['meta/chat'].chatEvery = 0;
  sL['meta/chat'].schedule = {
    mode: 'chain',
    every: 60,
    hours: { from: '05:00', to: '22:00' },
    tz: 'America/Los_Angeles',
  };
  sL['refresh/schedule'] = {
    armId: '20261123T170000Z-ab12',
    nextAt: '2026-11-23T17:57:00Z',
    lastRunAt: '2026-11-23T17:00:00Z',
  };
  sL['refresh/skipped'] = {
    keys: [],
    at: '2026-11-23T17:05:00Z',
    run: '2026-11-23T17:00:00Z',
    last: { book: '2026-11-23T17:00:00Z', cam: '2026-11-22T17:00:00Z' },
  };
  p = await open(sL, PAGE, { clockAt: T });
  await mcSettings(p);
  const line = k => mcText(p, '.chatrow[data-chat="' + k + '"] .chatline');
  const [lb, lc, lt] = [await line('book'), await line('cam'), await line('trail')];
  ok(
    lb.endsWith(' Scheduled runs refresh it every 4 hours. Next refresh about 12:45 PM.') &&
      lc.endsWith(' Scheduled runs refresh it once a day. Next refresh about 9:57 AM.') &&
      !lt.includes('Scheduled runs refresh it'),
    "F1 q10: a chat's line says its How often and about when it's next refreshed; the first chat (always every run) says nothing more (" +
      JSON.stringify([lb, lc, lt]) +
      ')',
  );
  // a due time outside the schedule's hours (Camera Club: 10:30 PM) leaves the time out
  await p.evaluate(() =>
    __rt.write(
      'refresh/skipped',
      Object.assign({}, __rt.get('refresh/skipped'), {
        last: { book: '2026-11-23T17:00:00Z', cam: '2026-11-23T06:45:00Z' },
      }),
    ),
  );
  await until(
    p,
    () => !/once a day\. Next/.test(document.querySelector('.chatrow[data-chat="cam"] .chatline').textContent),
  );
  ok(
    (await line('cam')).endsWith(' Scheduled runs refresh it once a day.'),
    "F1 q10: a next refresh outside the schedule's hours is left out (" + (await line('cam')) + ')',
  );
  // only while the schedule is healthy: missed runs leave the time out
  const NEXT = 'Next refresh about 12:45 PM.';
  const bookHas = (t, want) =>
    until(p, ([t, w]) => document.querySelector('.chatrow[data-chat="book"] .chatline').textContent.includes(t) === w, [
      t,
      want,
    ]);
  await p.evaluate(() =>
    __rt.write('refresh/schedule', Object.assign({}, __rt.get('refresh/schedule'), { misses: 2 })),
  );
  ok(await bookHas(NEXT, false), 'F1 q10: with missed runs (misses 2), no "Next refresh about …"');
  await p.evaluate(() =>
    __rt.write('refresh/schedule', Object.assign({}, __rt.get('refresh/schedule'), { misses: 0 })),
  );
  ok(await bookHas(NEXT, true), 'F1 q10: misses back to 0, the time is back');
  // the minute timer drops a time that has passed (4 hours on: 1 PM, the next run at 9:57 AM long gone)
  await p.clock.fastForward('04:00:00');
  ok(await bookHas(NEXT, false), 'F1 q10: the minute timer rewrites the line once its time has passed');
  // a scheduled run with no chat due still shows it ran
  await p.evaluate(() =>
    __rt.write('refresh/status', { state: 'done', finishedAt: new Date().toISOString(), added: 0, due: 0 }),
  );
  ok(
    await until(p, () =>
      document.getElementById('refresh-st').textContent.includes('Last scheduled run: no chat was due.'),
    ),
    'F1 q10: the status line says when the last scheduled run had no chat due',
  );
  ok(!p.errors.length, 'F1 q10: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();

  // a hidden chat has no Move buttons and gets no order; a chat without an order comes last, as in run-plan
  const sH = mcSeed({ chats: { chess: { name: 'Chess Club', tag: 'Chess', color: 4, order: 3, state: 'hidden' } } });
  delete sH['meta/chat'].chats.book.order;
  p = await open(sH);
  await p.click('#h1');
  const picksH = await p.$$eval('#picker-list button', bs => bs.map(b => b.dataset.key));
  await p.keyboard.press('Escape');
  await mcSettings(p);
  const idsH = await p.$$eval('[id^="mv-"]', bs => bs.map(b => b.id));
  ok(
    JSON.stringify(picksH) === JSON.stringify(['all', 'trail', 'cam', 'book', 'add']) &&
      JSON.stringify(idsH) === JSON.stringify(['mv-up-cam', 'mv-dn-cam', 'mv-up-book', 'mv-dn-book']),
    'F1 q6: a chat without an order comes last; a hidden chat has no Move buttons (' +
      JSON.stringify([picksH, idsH]) +
      ')',
  );
  const w2 = await mcNWrites(p);
  await p.click('#mv-dn-cam');
  await until(p, () => __rt.get('meta/chat').chats.cam.order === 2);
  const wh = await p.evaluate(n => __rt.writes.slice(n), w2);
  ok(
    JSON.stringify(wh.map(w => w.v.chats)) === JSON.stringify([{ book: { order: 1 }, cam: { order: 2 } }]),
    'F1 q6: a move writes no order to a hidden chat (' + JSON.stringify(wh) + ')',
  );
  ok(!p.errors.length, 'F1 q6: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();

  // a page with one chat shows no How often or Move buttons: its runs don't read them
  p = await mcOpen({ one: true });
  await mcSettings(p);
  ok(
    !(await p.$('#set-every')) && !(await p.$('[id^="every-"]')) && !(await p.$('[id^="mv-"]')),
    'F1 q6/q10: a one-chat page has no How often and no Move buttons',
  );
  await p.context().close();
}

/* B56: several-chats oddities seen on the owner's page. The counts and the activation checks failed on page 5.7; the
   last one keeps the fix from moving you off a view you picked. */
async function multiChatB56() {
  // 1. the "need you" counts: Trail and Cam each have mentions older than summary/current's activeFrom, in a block
  const blk = ments => ({ start: 0, convs: [], open: [], answered: [], deals: [], mentions: ments, syn: {} });
  const cur = (k, toI, from, ment) => ({
    version: 2,
    layout: 2,
    block: 1000,
    blocks: ['b0-' + k],
    activeFrom: from,
    convs: [],
    open: [],
    answered: [],
    deals: [],
    mentions: [{ note: MC_NAME[k] + ': someone asked you', refs: [[ment]] }],
    toI,
  });
  const extra = {
    'summary/current': cur('trail', 11, 6, 8),
    'summary/b0-trail': blk([
      { note: 'Trail Crew: Ana asked you about the map', refs: [[3]] },
      { note: 'Trail Crew: Ben replied to you', refs: [[4, 'yes']] },
      { note: 'Trail Crew: before you caught up', refs: [[1]] },
    ]),
    'cam_summary/current': cur('cam', 7, 5, 6),
    'cam_summary/b0-cam': blk([{ note: 'Camera Club: Cy replied to you', refs: [[2]] }]),
  };
  let p = await mcOpen({ extra });
  const want = { trail: 3, cam: 2, book: 1 };
  const cardN = () =>
    p.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll('#v-all .chatcard')].map(c => [
          c.dataset.chat,
          +((/· (\d+) needs? you/.exec(c.querySelector('.chatnums').textContent) || [])[1] ?? -1),
        ]),
      ),
    );
  await until(
    p,
    w => {
      const n = [...document.querySelectorAll('#v-all .chatcard .chatnums')].map(e => e.textContent);
      return n.length === 3 && n.every((t, k) => t.includes(' ' + w[k] + ' need'));
    },
    Object.values(want),
  );
  const cards = await cardN();
  await p.click('#h1');
  const pick = await p.$$eval('#picker-list button', bs =>
    Object.fromEntries(
      bs.map(b => [b.dataset.key, +((b.querySelector('.cnt') || {}).textContent || '0').split(' ')[0]]),
    ),
  );
  await p.keyboard.press('Escape');
  ok(
    JSON.stringify(cards) === JSON.stringify(want) &&
      pick.all === 6 &&
      pick.trail === 3 &&
      pick.cam === 2 &&
      pick.book === 1,
    'B56: All chats counts the mentions in older summary blocks too: cards 3, 2 and 1, and the picker says 6 for All chats, the sum of its rows (' +
      JSON.stringify({ cards, pick }) +
      ')',
  );
  // each chat's own Summary and counter strip say the same as its card
  const own = async k => {
    await mcPick(p, k);
    await until(p, k => document.querySelector('#h1').textContent === k, MC_NAME[k]);
    return p.evaluate(() => {
      const nb = [...document.querySelectorAll('#v-summary .block')].find(b => /^Needs you/.test(b.textContent));
      const st = [...document.querySelectorAll('#strip .stat')].find(s => /mentions of you/.test(s.textContent));
      return [nb ? nb.querySelectorAll('.item.mention').length : -1, st ? +st.querySelector('.n').textContent : -1];
    });
  };
  const mine = { trail: await own('trail'), cam: await own('cam'), book: await own('book') };
  ok(
    Object.keys(want).every(k => mine[k][0] === cards[k] && mine[k][1] === cards[k]),
    "B56: each chat's Summary › Needs you and its strip's mentions of you match its All chats card (" +
      JSON.stringify(mine) +
      ')',
  );
  ok(p.errors.length === 0, 'B56 counts: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();

  // 2. the opening view: the page opened while Cam was pending; Cam's first refresh makes it active (chats.md step 5)
  const pend = {
    cam: { name: 'Camera Club', tag: 'Cam', color: 2, order: 1, state: 'pending', thread: '5151', url: MC_URL('cam') },
    book: { name: 'Book Club', tag: 'Book', color: 3, order: 2, state: 'pending', thread: '6161', url: MC_URL('book') },
  };
  const activate = () =>
    p.evaluate(() => {
      const m = JSON.parse(JSON.stringify(__rt.get('meta/chat')));
      m.chats.cam.state = 'active';
      __rt.write('meta/chat', m);
    });
  const viewNow = () =>
    p.evaluate(() => ({
      h1: document.querySelector('#h1').textContent,
      all: !document.querySelector('#v-all').hidden,
      tabs: [...document.querySelectorAll('nav.tabs a')]
        .filter(a => !a.hidden)
        .map(a => a.dataset.tab)
        .join(','),
      messages: !document.querySelector('#v-messages').hidden,
    }));
  p = await mcOpen({ chats: pend });
  await until(p, () => document.querySelector('#h1').textContent === 'Trail Catch-up');
  const v0 = await viewNow();
  await activate();
  await until(p, () => document.querySelector('#h1').textContent === 'All chats');
  const v1 = await viewNow();
  ok(
    v0.h1 === 'Trail Catch-up' && !v0.all && v1.h1 === 'All chats' && v1.all && v1.tabs === 'summary,ask,days,stats',
    'B56/PG1: a page opened with one live chat turns to All chats when a second chat becomes active, as a reload would (' +
      JSON.stringify({ v0, v1 }) +
      ')',
  );
  ok(p.errors.length === 0, 'B56 activation: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
  // a view you picked stays: in Messages when Cam becomes active, you stay there
  p = await mcOpen({ chats: pend });
  await until(p, () => document.querySelector('#h1').textContent === 'Trail Catch-up');
  await p.click('nav a[data-tab="messages"]');
  await activate();
  await until(p, () => document.querySelector('#h1').textContent === 'Trail Crew');
  const v2 = await viewNow();
  ok(
    v2.h1 === 'Trail Crew' && !v2.all && v2.tabs.includes('messages') && v2.messages,
    'B56: with a tab picked first, a chat turning active leaves you where you were (' + JSON.stringify(v2) + ')',
  );
  await p.context().close();
}

/* F25 G1: Add a group in Settings, and the picker's Chats and Groups headings */
/* F1 stage C: Ask across chats. Three chats with "tripod" in two of them; Dee goes by "Dee" in Trail Crew and by
   "Deedee" in Camera Club, with the same full name (fn) in both. */
const XA_CAP3 = 'a carbon tripod folded on a table';
function xaSeed(o = {}) {
  const tr = mcMsgs('trail', 12);
  tr[4] = Object.assign(tr[4], { f: 'Dee', fn: 'Dee Moss', b: 'anyone have a spare tripod plate?' });
  tr[9] = Object.assign(tr[9], { f: 'Ben', fn: 'Ben Ash', b: 'tripod legs are back from repair' });
  const cm = mcMsgs('cam', 8);
  cm[2] = Object.assign(cm[2], { f: 'Deedee', fn: 'Dee Moss', b: 'selling my tripod, barely used' });
  cm[3] = Object.assign(cm[3], { f: 'Ana', fn: 'Ana Reyes', b: '', p: '7003' });
  cm[6] = Object.assign(cm[6], { f: 'Cy', fn: 'Cy Park', b: 'which tripod head is that?' });
  const extra = {
    'chunks/c0000': { start: 0, msgs: tr },
    'cam_chunks/c0000': { start: 0, msgs: cm },
    'cam_captions/b0': { start: 0, byK: { 3: { 0: XA_CAP3 } } },
  };
  return Object.assign({}, o, { extra: Object.assign(extra, o.extra || {}), opts: o.opts || { tools: true } });
}
const XA_PLAN = [
  { say: 'Searching every chat.', calls: [{ name: 'search_messages', input: { words: 'tripod' } }] },
  {
    calls: [
      { name: 'read_messages', input: { chat: 'cam', from: '#1', to: '#4' } },
      { name: 'day_summaries', input: { chat: 'trail', from: '#0', to: '#11' } },
      { name: 'read_messages', input: { from: '#1' } },
      { name: 'search_messages', input: { words: 'tripod', chat: 'cam' } },
    ],
  },
  {
    say: 'Dee Moss is selling one [cam#2] and asked about a plate [trail#4]. More: [cam#3, #6]. Bare [#9]. Unknown [zzz#1]. By tag [Book#2].',
  },
];
/* Asks q on All chats' Ask; returns what hask returns, from #xchat */
async function xask(p, q) {
  const n0 = await p.evaluate(() => __rt.sampleLog.length);
  await p.evaluate(q => {
    location.hash = '#ask';
    document.getElementById('ask-in').value = q;
    document.getElementById('ask-go').click();
  }, q);
  await until(
    p,
    n0 =>
      (__rt.sampleLog.length > n0 || document.getElementById('ask-note').textContent) &&
      !document.getElementById('ask-go').disabled,
    n0,
  );
  await sleep(100);
  return p.evaluate(n0 => {
    const ts = document.querySelectorAll('#xchat .turn.assistant');
    const t = ts[ts.length - 1];
    const s = __rt.samples[__rt.samples.length - 1];
    return {
      calls: __rt.sampleLog.slice(n0),
      prompt: Array.isArray(s) ? s[0].content : s,
      note: (t && t.querySelector('.sent') && t.querySelector('.sent').textContent) || '',
      askNote: document.getElementById('ask-note').textContent,
      answer: (t && t.querySelector('.txt').textContent) || '',
      cites: t ? [...t.querySelectorAll('.txt .cite')].map(c => c.textContent) : [],
    };
  }, n0);
}
const xaRows = p =>
  p.$$eval('#xchat .turn.assistant:last-of-type .xhits > li', ls =>
    ls.map(l =>
      l.classList.contains('xhit-h')
        ? 'h:' + l.dataset.chat
        : l.classList.contains('xhit')
          ? l.dataset.chat + '#' + l.querySelector('.cite').textContent.replace(/^\S+ #/, '')
          : 'note',
    ),
  );
const xaChips = p =>
  p.$$eval('#xchat .turn.assistant:last-of-type .xchips button', bs =>
    bs.map(b => (b.dataset.filt || b.dataset.act) + ':' + b.textContent + (b.disabled ? ':off' : '')),
  );
async function multiChatAsk() {
  let p = await mcOpen(xaSeed());
  await p.evaluate(pl => (window.__toolPlan = pl), XA_PLAN);
  await p.click('nav a[data-tab="ask"]');
  ok(
    (await mcText(p, '#v-ask .sec-head h2')) === 'Ask about your chats' &&
      !(await p.$eval('#xchat', e => e.hidden)) &&
      (await p.$eval('#chat', e => e.hidden)) &&
      !(await p.$('#v-ask .composer select, #v-ask .composer input[type="checkbox"]')),
    'F1 SR4: All chats has an Ask tab over every chat, with no chat choice before asking (the results are filtered instead)',
  );
  const r = await xask(p, 'Anyone have a tripod?');
  const log = await p.evaluate(() => __rt.toolLog.map(x => Object.assign({}, x, { out: x.out && JSON.parse(x.out) })));
  const recent = r.prompt.split('\n').filter(l => /^\[?\w*#\d+\]/.test(l) || /^#\d+ \[/.test(l));
  ok(
    r.calls.length === 1 &&
      /- CHATS \(key: name\):\n {2}- trail: Trail Crew, 12 messages stored, #0 to #11/.test(r.prompt) &&
      /\n {2}- cam: Camera Club, 8 messages/.test(r.prompt) &&
      /\n {2}- book: Book Club, 6 messages/.test(r.prompt) &&
      /Never write a bare \[#123\]/.test(r.prompt) &&
      /\n- SEARCH: three tools over every stored message in every chat/.test(r.prompt) &&
      recent.length === 26 &&
      recent.every(l => /^\[(trail|cam|book)#\d+\] \[/.test(l)),
    "F1 SR1/CT6: one request; the prompt lists every chat and gives each chat's newest messages, every line starting [key#n], and tells Claude to cite that way (" +
      recent.length +
      ' lines)',
  );
  const [s1, rd, days, bad, s2] = [
    log.find(x => x.name === 'search_messages' && !x.input.chat),
    log.find(x => x.name === 'read_messages' && x.input.chat === 'cam'),
    log.find(x => x.name === 'day_summaries'),
    log.find(x => x.name === 'read_messages' && !x.input.chat),
    log.find(x => x.name === 'search_messages' && x.input.chat === 'cam'),
  ];
  ok(
    s1.out.total === 5 &&
      JSON.stringify(s1.out.byChat) === '{"trail":2,"cam":3,"book":0}' &&
      s1.out.newestFirst &&
      JSON.stringify(s1.out.matches.map(l => l.match(/^\[(\w+#\d+)\]/)[1])) ===
        '["trail#9","cam#6","trail#4","cam#3","cam#2"]' &&
      s1.out.matches[3].includes('[photo: ' + XA_CAP3 + ']'),
    'F1 SR1: search_messages covers every chat and its photo captions: 5 matches, counted per chat, newest first across chats, each line [key#n] ' +
      JSON.stringify(s1.out.byChat),
  );
  ok(
    / Dee Moss \(Deedee\): selling my tripod/.test(s1.out.matches[4]) &&
      / Dee Moss: anyone have a spare tripod/.test(s1.out.matches[2]),
    "F1 SR11: Claude gets each chat's name for a person with the full name, so the same person reads the same across chats (" +
      s1.out.matches[4].slice(0, 60) +
      ')',
  );
  ok(
    rd.out.chat === 'cam' &&
      rd.out.lines.length === 4 &&
      /^\[cam#1\] /.test(rd.out.lines[0]) &&
      days.out.chat === 'trail' &&
      days.out.cite === '[trail#n]' &&
      days.out.days.length === 1 &&
      bad.err &&
      /chat must be one of: trail, cam, book/.test(bad.err) &&
      s2.out.total === 3 &&
      JSON.stringify(s2.out.byChat) === '{"cam":3}',
    'F1 SR1: read_messages and day_summaries read one named chat; without a chat they say which keys there are; a search can be narrowed to one chat ' +
      JSON.stringify([rd.out.lines[0], bad.err]),
  );
  ok(
    JSON.stringify(r.cites) ===
      '["Cam #2","Trail #4","Cam #3","Cam #6","#9 · which chat?","#1 · which chat?","Book #2"]' &&
      /More: Cam #3 Cam #6\./.test(r.answer),
    'F1 CT3: [cam#2] and [cam#3, #6] become tagged citations (a bare number after a keyed one is that chat\'s); a bare [#9] and an unknown key show "which chat?"; a tag works as a key ' +
      JSON.stringify(r.cites),
  );
  ok(
    /^Searched 3 chats: Trail, Cam, Book\. Read Trail #0–#11, Cam #0–#7, Book #0–#5 word for word\. Searched “tripod” \(5\), “tripod” in Cam \(3\)\. Read Cam #1–#4\. Read day summaries of Trail\.$/.test(
      r.note,
    ),
    'F1: the note under the answer names the chats searched, what was read word for word and every search, with tags (' +
      r.note +
      ')',
  );
  // SR2: the match list is the page's own search over every chat, newest first, every row tagged
  const rows = await xaRows(p);
  const n0 = await p.evaluate(() => __rt.samples.length);
  ok(
    JSON.stringify(rows) === '["trail#9","cam#6","trail#4","cam#3","cam#2"]' &&
      (await p.$$eval('#xchat .xhits .cite', cs => cs.every(c => /^(Trail|Cam|Book) #\d+$/.test(c.textContent)))) &&
      /Dee Moss \(Deedee\)/.test(await mcText(p, '#xchat .xhits li[data-chat="cam"]:last-child')),
    'F1 SR2/CT2/SR10: the match list holds every match in every chat, newest first, each row tagged and named with the full name ' +
      JSON.stringify(rows),
  );
  ok(
    JSON.stringify(await xaChips(p)) ===
      '["all:All 5","trail:Trail 2","cam:Cam 3","book:Book 0:off","photos:Photos only"]',
    'F1 SR3: a chip per chat with its count (none: disabled), All, and Photos only ' + JSON.stringify(await xaChips(p)),
  );
  await p.click('#xchat .xchips button[data-filt="cam"]');
  const camRows = await xaRows(p);
  await p.click('#xchat .xchips button[data-act="photos"]');
  const camPh = await xaRows(p);
  await p.click('#xchat .xorder button[data-order="chat"]');
  const camPhChat = await xaRows(p);
  await p.click('#xchat .xchips button[data-act="photos"]');
  await p.click('#xchat .xchips button[data-filt="all"]');
  const byChat = await xaRows(p);
  ok(
    JSON.stringify(camRows) === '["cam#6","cam#3","cam#2"]' &&
      JSON.stringify(camPh) === '["cam#3"]' &&
      JSON.stringify(camPhChat) === '["h:cam","cam#3"]' &&
      JSON.stringify(byChat) === '["h:trail","trail#9","trail#4","h:cam","cam#6","cam#3","cam#2"]' &&
      (await p.evaluate(() => __rt.samples.length)) === n0,
    "F1 SR3/SR12: the chips and Photos only filter, By chat groups each chat's matches under it in the chats' order, together, and none of it asks Claude anything " +
      JSON.stringify([camRows, camPh, camPhChat, byChat]),
  );
  const kept = await p.evaluate(() => {
    const v = localStorage.getItem('mcAskOrder');
    const g = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('blocked');
    };
    const off = xOrder();
    Storage.prototype.getItem = g;
    return [v, off];
  });
  ok(
    JSON.stringify(kept) === '["chat","new"]',
    'F1 SR12: the order is remembered in this browser, and without browser storage it is Newest first ' +
      JSON.stringify(kept),
  );
  // SR4: the answer is saved with the chats it searched
  const row = await until(p, () => (S.qaAll || []).find(r => r.scope === 'chats'));
  ok(
    row &&
      row.q === 'Anyone have a tripod?' &&
      JSON.stringify(row.chats) === '["trail","cam","book"]' &&
      JSON.stringify(row.toI) === '{"trail":11,"cam":7,"book":5}' &&
      row.sent.searches.length === 2 &&
      row.sent.searches[1].chat === 'cam' &&
      !row.chat,
    'F1 SR4: the answer is saved in qa with scope "chats", the chats searched and each one\'s newest message ' +
      JSON.stringify(row && { chats: row.chats, toI: row.toI, s: row.sent && row.sent.searches }),
  );
  // PH5: at phone width the chips and order switch wrap, and nothing pushes the page wider
  await p.setViewportSize({ width: 390, height: 844 });
  await sleep(150);
  const ph = await p.evaluate(() => {
    const cites = [...document.querySelectorAll('#xchat .xhits .cite')];
    return {
      wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      oneLine: cites.every(c => c.getClientRects().length === 1),
    };
  });
  ok(
    ph.wide <= 0 && ph.oneLine,
    'F1 PH5: at 390 px the match list fits the screen and each tag and number stays on one line ' + JSON.stringify(ph),
  );
  await p.setViewportSize({ width: 1000, height: 900 });
  // CT9-like: a citation in the answer switches to its chat and opens the message
  await flashReset(p);
  await p.click('#xchat .turn.assistant:last-of-type .txt button.cite[data-chat="cam"][data-i="2"]');
  await until(p, () => document.querySelector('#m2[data-flashed]'), null, 3000);
  ok(
    (await mcText(p, '#h1')) === 'Camera Club' &&
      (await p.isVisible('#v-messages')) &&
      (await mcText(p, '#m2')).includes('selling my tripod'),
    "F1 CT4: an answer's Cam #2 switches to Camera Club and opens its #2",
  );
  // single chat unchanged: Camera Club's Ask asks about Camera Club alone, as before, and lists only its own questions
  await p.click('nav a[data-tab="ask"]');
  const one = {
    h: await mcText(p, '#v-ask .sec-head h2'),
    chat: !(await p.$eval('#chat', e => e.hidden)),
    xchat: !(await p.$eval('#xchat', e => e.hidden)),
    list: await mcText(p, '#qa-list'),
  };
  await p.evaluate(() => (window.__toolPlan = [{ say: 'Deedee sells one [#2].' }]));
  const r1 = await hask(p, 'Who is selling a tripod in here?');
  ok(
    one.h === 'Ask about the chat' &&
      one.chat &&
      !one.xchat &&
      !one.list.includes('Anyone have a tripod?') &&
      /- MESSAGES: every stored message, #0 to #7, word for word/.test(r1.prompt) &&
      !/\[cam#/.test(r1.prompt) &&
      /^Deedee sells one #2\.$/.test(r1.answer),
    "F1: inside a chat, Ask is that chat's alone, as before: its own header, conversation, questions, prompt and bare citations " +
      JSON.stringify([one, r1.answer]),
  );
  const camRefresh = await mcText(p, '#refresh-st');
  // back on All chats: the answer and its conversation are still there; a chat added since shows as not searched
  await mcPick(p, 'all');
  const allRefresh = await mcText(p, '#refresh-st');
  ok(
    /refresh Camera Club/.test(camRefresh) &&
      !/refresh Camera Club/.test(allRefresh) &&
      /refresh my catch-up/.test(allRefresh),
    "F1: the refresh line names the chat's phrase in Camera Club and the page's on All chats, also after switching back " +
      JSON.stringify([camRefresh.slice(0, 90), allRefresh.slice(0, 90)]),
  );
  // B71: the chat loaded last has its own refreshPhrase (a group's run wrote "refresh pa"): All chats still says the page's
  const b71 = await p.evaluate(() => {
    S.meta = Object.assign({}, S.meta, { refreshPhrase: 'refresh pa' });
    return RP();
  });
  ok(
    b71 === 'refresh my catch-up',
    "B71: on All chats the refresh phrase is the page's, not the last chat's (" + b71 + ')',
  );
  await p.evaluate(() =>
    S.rawDb.doc('meta/chat').update({
      chats: { pine: { name: 'Pine Club', tag: 'Pine', color: 4, order: 3, state: 'active', thread: '7171' } },
    }),
  );
  await sleep(200);
  await p.click('nav a[data-tab="ask"]');
  const back = {
    turns: await p.$$eval('#xchat .turn', ts => ts.length),
    list: await mcText(p, '#qa-list'),
  };
  ok(
    back.turns === 2 &&
      /Anyone have a tripod\?/.test(back.list) &&
      !/in here\?/.test(back.list) &&
      /across 3 chats \(Trail, Cam, Book\) · not searched: Pine/.test(back.list),
    "F1 SR4/SR6: All chats' Ask keeps its conversation; its saved question says which chats it searched, and a chat added since as not searched " +
      JSON.stringify(back),
  );
  ok(p.errors.length === 0, 'F1 Ask across chats: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();

  // SR5/SR9: a paused chat is searched, a hidden one isn't; without tools the question's words go to every chat
  p = await mcOpen(
    xaSeed({
      opts: {},
      chats: {
        cam: {
          name: 'Camera Club',
          tag: 'Cam',
          color: 2,
          order: 1,
          state: 'paused',
          thread: '5151',
          url: MC_URL('cam'),
        },
        book: {
          name: 'Book Club',
          tag: 'Book',
          color: 3,
          order: 2,
          state: 'hidden',
          thread: '6161',
          url: MC_URL('book'),
        },
      },
    }),
  );
  await p.click('nav a[data-tab="ask"]');
  const r2 = await xask(p, 'tripod');
  ok(
    /\n {2}- cam: Camera Club \(paused: not refreshed now\)/.test(r2.prompt) &&
      !/book#|Book Club/.test(r2.prompt) &&
      /\nMATCHES \(5 of 5, newest first\):\n\[trail#9\] /.test(r2.prompt) &&
      !/- SEARCH:/.test(r2.prompt) &&
      JSON.stringify(r2.cites) === '["#1 · which chat?","#0 · which chat?","#2 · which chat?"]' &&
      /^Searched 2 chats: Trail, Cam\./.test(r2.note),
    'F1 SR5/SR9: a paused chat is searched (and says so), a hidden one is not; without tools the prompt carries every chat\'s matches; bare numbers show "which chat?" ' +
      JSON.stringify([r2.cites, r2.note.slice(0, 60)]),
  );
  // the page's matches need no Claude: a declined request still lists them
  await p.evaluate(() => (window.__sampleError = 'not_granted'));
  const r3 = await xask(p, 'tripod plate');
  const r3rows = await xaRows(p);
  ok(
    r3.answer === '' && r3.askNote.length > 0 && JSON.stringify(r3rows) === '["trail#4"]',
    'F1 SR2: when the request is refused, the note says so and the page still lists its own matches ' +
      JSON.stringify([r3.askNote.slice(0, 40), r3rows]),
  );
  ok(p.errors.length === 0, 'F1 Ask across chats without tools: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
}
/* F1 stage C, part 2: All chats' Stats (the chats compared), By day (a section per chat) and the summary across
   chats (allchats/summary), on part 1's three chats */
const XS_YDAY = (() => {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - 1);
  return ymd(d);
})();
const xsDay = (h, t, refs, open) => ({
  sections: [{ h, bullets: [{ t, refs }] }],
  open: open || [],
  fromI: 0,
  toI: 11,
  at: new Date().toISOString(),
});
function xsSeed(o = {}) {
  const extra = {
    ['daySummaries/d' + ymd(TODAY)]: xsDay(
      'Gear',
      'Dee asked for a tripod plate',
      [4],
      [{ t: 'Who has a plate?', refs: [4] }],
    ),
    ['cam_daySummaries/d' + ymd(TODAY)]: xsDay('Selling', 'A tripod is for sale', [2, 3]),
    ['cam_daySummaries/d' + XS_YDAY]: xsDay('Meetup', 'Photo walk planned', [1]),
  };
  if (!o.noSum)
    extra['allchats/summary'] = {
      at: new Date(Date.now() - 3600000).toISOString(),
      run: new Date(Date.now() - 3700000).toISOString(),
      points: [
        { h: 'Needs you', t: 'Dee Moss asked about a tripod in two chats [cam#2, trail#4].' },
        { t: 'Bare [#3] and gone [zzz#1].' },
      ],
      chats: { trail: 'new', cam: 'new', book: 'failed' },
    };
  return xaSeed(Object.assign({}, o, { extra: Object.assign(extra, o.extra || {}) }));
}
const xsRows = p =>
  p.$$eval('#v-stats table.xcmp tbody tr', trs =>
    trs.map(tr => [
      tr.dataset.chat || 'all',
      ...[...tr.querySelectorAll('td.num')].map(td => +td.textContent.replace(/,/g, '')),
    ]),
  );
async function xsTab(p, tab) {
  await p.click('nav a[data-tab="' + tab + '"]');
  await p.waitForTimeout(150);
}
async function multiChatAll() {
  let p = await mcOpen(xsSeed());
  // SD7: the summary across chats, above the cards
  const sum = await p.evaluate(() => {
    const b = document.querySelector('#v-all .xsum');
    return b
      ? {
          first:
            b.compareDocumentPosition(document.querySelector('#v-all .chatcard')) & Node.DOCUMENT_POSITION_FOLLOWING,
          pts: [...b.querySelectorAll('.xsum-points li')].map(li => li.textContent),
          cites: [...b.querySelectorAll('.cite')].map(c => c.textContent),
          stale: [...b.querySelectorAll('.xsum-stale')].map(x => x.dataset.chat + ':' + x.textContent),
          note: b.querySelector('.note').textContent,
        }
      : null;
  });
  ok(
    sum &&
      sum.first &&
      sum.pts.length === 2 &&
      /^Needs you: Dee Moss asked about a tripod in two chats Cam #2 Trail #4\.$/.test(sum.pts[0]) &&
      JSON.stringify(sum.cites) === '["Cam #2","Trail #4","#3 · which chat?","#1 · which chat?"]' &&
      sum.stale.length === 1 &&
      /^book:Book Club wasn't refreshed in that run \(it failed\), so its part is from its last refresh \(Fri 9:10 AM\)\.$/.test(
        sum.stale[0],
      ) &&
      /^Written at the end of the refresh at /.test(sum.note),
    'F1 SD7/CT2: All chats opens with "Across your chats" above the cards: the points with tagged citations ("which chat?" for a bare or unknown one), and the chat that run failed named as from its last refresh ' +
      JSON.stringify(sum),
  );
  // SD2: Stats compares the chats; each chat's numbers are its own Stats', and All is their sum, in every timeframe
  await xsTab(p, 'stats');
  await until(p, () => document.querySelectorAll('#v-stats table.xcmp tbody tr').length === 4);
  const hidden = await p.evaluate(() => getComputedStyle(document.querySelector('#v-stats .st-show')).display);
  const sums = {};
  for (const tf of ['today', 'wk', 'lastwk', 'd7', 'd30', 'd90', 'all']) {
    await p.click('#v-stats [data-tf="' + tf + '"]');
    await p.waitForTimeout(60);
    const rs = await xsRows(p);
    const all = rs.find(r => r[0] === 'all');
    const each = rs.filter(r => r[0] !== 'all');
    sums[tf] = {
      ok: [1, 2, 3].every(c => all[c] === each.reduce((n, r) => n + r[c], 0)),
      msgs: each.map(r => r[0] + ':' + r[1]).join(','),
    };
  }
  ok(
    hidden === 'none' && Object.values(sums).every(x => x.ok) && sums.all.msgs === 'trail:12,cam:8,book:6',
    "F1 SD2: All chats › Stats has a row per chat (messages, people, photos) and an All row that is their sum in every timeframe; the switches for one chat's sections are hidden " +
      JSON.stringify(sums),
  );
  const bars = await p.$$eval('#v-stats ul.xbars li', ls =>
    ls.map(l => l.dataset.chat + ':' + l.querySelector('.v').textContent),
  );
  const cmp = await xsRows(p);
  ok(
    JSON.stringify(bars) === '["trail:12","cam:8","book:6"]',
    "F1 SD2: a bar per chat, in the chats' order " + JSON.stringify(bars),
  );
  // SD1 with SD2: each chat's own Stats tiles say the same (same timeframe: All)
  const own = {};
  for (const k of ['trail', 'cam', 'book']) {
    await mcPick(p, k);
    await xsTab(p, 'stats');
    own[k] = await p.evaluate(() =>
      ['messages', 'people', 'photos'].map(
        t => +document.querySelector('#st-body .st-tile[data-k="' + t + '"] .n').textContent.replace(/,/g, ''),
      ),
    );
  }
  ok(
    ['trail', 'cam', 'book'].every(k => JSON.stringify(own[k]) === JSON.stringify(cmp.find(r => r[0] === k).slice(1))),
    "F1 SD1/SD2: each chat's row on All chats equals that chat's own Stats (messages, people posting, photos) " +
      JSON.stringify({ own, cmp }),
  );
  // SD4: By day on All chats: a card per day, a section per chat, tagged citations; a day only one chat has shows it alone
  await mcPick(p, 'all');
  await xsTab(p, 'days');
  await until(p, () => document.querySelectorAll('#days-list article.xday').length === 2);
  const days = await p.$$eval('#days-list article.xday', as =>
    as.map(a => ({
      day: a.dataset.day,
      chats: [...a.querySelectorAll('.xday-chat')].map(s => s.dataset.chat),
      cites: [...a.querySelectorAll('.cite')].map(c => c.textContent),
    })),
  );
  ok(
    days.length === 2 &&
      days[0].day > days[1].day &&
      JSON.stringify(days[0].chats) === '["trail","cam"]' &&
      JSON.stringify(days[0].cites) === '["Trail #4","Trail #4","Cam #2","Cam #3"]' &&
      JSON.stringify(days[1].chats) === '["cam"]' &&
      JSON.stringify(days[1].cites) === '["Cam #1"]',
    "F1 SD4/CT2: By day on All chats: newest day first, a section per chat in the chats' order (Still open too), every number tagged; a day only Camera Club has shows it alone " +
      JSON.stringify(days),
  );
  // a By day number opens its message in its chat
  await flashReset(p);
  await p.click('#days-list article.xday .xday-chat[data-chat="cam"] button.cite[data-i="3"]');
  await until(p, () => document.querySelector('#m3[data-flashed]'), null, 3000);
  ok(
    (await mcText(p, '#h1')) === 'Camera Club' && (await p.isVisible('#v-messages')),
    'F1 SD4: Cam #3 in By day opens Camera Club at #3',
  );
  // SD6: a chat's own By day is its own (bare numbers), and switching back to All chats redraws it
  await xsTab(p, 'days');
  const camDays = await p.evaluate(() => ({
    head: document.querySelector('#v-days .sec-head p').textContent,
    x: document.querySelectorAll('#days-list article.xday').length,
    cites: [...document.querySelectorAll('#days-list .cite')].map(c => c.textContent),
  }));
  await mcPick(p, 'all');
  await xsTab(p, 'days');
  const back = await p.$$eval('#days-list article.xday', as => as.length);
  const heads = await p.evaluate(() => document.querySelector('#v-days .sec-head p').textContent);
  ok(
    !/Copy for chat/.test(heads) && /a section per chat/.test(heads),
    "F1 SD4: All chats' By day header describes every chat's days and doesn't offer Copy for chat (" + heads + ')',
  );
  ok(
    /Copy for chat/.test(camDays.head) &&
      camDays.x === 0 &&
      camDays.cites.length &&
      camDays.cites.every(c => /^#\d+$/.test(c)) &&
      back === 2,
    "F1 SD6: Camera Club's By day shows its own days with bare numbers (and its header offers Copy for chat); back on All chats, every chat's again " +
      JSON.stringify({ camDays, back }),
  );
  // PH: at 390 px, All chats' Stats and By day fit the screen
  await p.setViewportSize({ width: 390, height: 844 });
  const wide = {};
  for (const t of ['days', 'stats', 'summary']) {
    await xsTab(p, t);
    await p.waitForTimeout(100);
    wide[t] = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  }
  ok(
    Object.values(wide).every(x => x <= 0),
    "F1 PH: at 390 px All chats' Summary, By day and Stats fit the screen " + JSON.stringify(wide),
  );
  await p.setViewportSize({ width: 1000, height: 900 });
  // SD7: once every chat is marked caught up after it was written, it says so instead of the points
  await p.click('#caught-all');
  await until(p, () =>
    /caught up in every chat since/.test((document.querySelector('#v-all .xsum') || {}).textContent || ''),
  );
  ok(
    !(await p.$('#v-all .xsum .xsum-points')),
    'F1 SD7: after Mark all caught up, the summary across chats says you are caught up everywhere since it was written',
  );
  ok(p.errors.length === 0, 'F1 All chats Stats, By day and summary: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();

  // before Claude has written one: a line says where it comes from
  p = await mcOpen(xsSeed({ noSum: true }));
  const none = await mcText(p, '#v-all .xsum');
  ok(
    /Claude writes a short summary across your chats here at the end of each refresh/.test(none),
    'F1 SD7: with no summary across chats yet, All chats says Claude writes one at the end of each refresh (' +
      none.slice(0, 80) +
      ')',
  );
  ok(p.errors.length === 0, 'F1 All chats with no summary: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
}
async function groupsAdd() {
  let p = await mcOpen();
  await mcSettings(p);
  let w0 = await mcNWrites(p);
  for (const [bad, want] of [
    ['https://www.facebook.com/messages/t/6161/', /That's a Messenger chat: add it under Add a chat/],
    ['hello', /isn't a Facebook group link/],
    ['https://www.facebook.com/groups/joins/', /isn't a Facebook group link/],
  ]) {
    await p.fill('#grp-link', bad);
    await p.click('#grp-go');
    await p.waitForTimeout(100);
    ok(
      want.test(await mcText(p, '#set-st-grp')) && (await mcNWrites(p)) === w0,
      'G1-02: Add a group refuses "' + bad + '" inline and writes nothing',
    );
  }
  await p.fill('#grp-link', 'https://www.facebook.com/groups/1000000000000001/posts/2000000000000003/');
  await p.fill('#grp-name', 'Gear Swap');
  await p.fill('#grp-tag', 'Gear');
  await p.selectOption('#grp-chat', 'book');
  await p.selectOption('#grp-read', 'mine');
  await p.uncheck('#grp-rollup');
  const startDefault = await p.$eval('#grp-start', x => x.value);
  await p.click('#grp-go');
  await until(p, () => __rt.get('meta/chat').chats.gear);
  const ws = await p.evaluate(n => __rt.writes.slice(n), w0);
  const e = (await get(p, 'meta/chat')).chats.gear;
  ok(
    ws.length === 1 &&
      JSON.stringify(Object.keys(ws[0].v.chats)) === '["gear"]' &&
      e.kind === 'group' &&
      e.state === 'pending' &&
      e.group === '1000000000000001' &&
      e.url === 'https://www.facebook.com/groups/1000000000000001/' &&
      e.chat === 'book' &&
      e.read === 'mine' &&
      e.rollup === false &&
      e.start.days === 7 &&
      startDefault === '7' &&
      e.tag === 'Gear',
    'G1-02/03: Add a group writes one pending kind:"group" entry: group id from a post link, goes with Book Club, Read only mine, Show in All off, first read 7 days by default (' +
      JSON.stringify(e) +
      ')',
  );
  w0 = await mcNWrites(p);
  await p.fill('#grp-link', 'https://m.facebook.com/groups/1000000000000001');
  await p.click('#grp-go');
  await p.waitForTimeout(100);
  ok(
    /already on the page: Gear Swap/.test(await mcText(p, '#set-st-grp')) && (await mcNWrites(p)) === w0,
    'G1-02: the same group again (another link form) is refused, naming it',
  );
  await p.keyboard.press('Escape');
  await p.click('#h1');
  const items = await p.$$eval('#picker-list > *', xs =>
    xs.map(x => (x.classList.contains('pick-head') ? '#' + x.textContent : x.dataset.key)),
  );
  ok(
    items.indexOf('#Chats') >= 0 &&
      items.indexOf('#Groups') > items.indexOf('#Chats') &&
      items.indexOf('gear') > items.indexOf('#Groups') &&
      items.indexOf('trail') > items.indexOf('#Chats') &&
      items.indexOf('trail') < items.indexOf('#Groups') &&
      items[items.length - 1] === 'add' &&
      /Add a chat or group/.test(await mcText(p, '#picker-list')),
    'G1-17: the picker lists chats, then groups, under headings, and offers "Add a chat or group" (' + items + ')',
  );
  ok(p.errors.length === 0, 'G1: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
}
/* F25 G1: a group capture pasted on its group: posts and comments stored with page numbers, re-paste changes nothing */
function gcap(group, posts, comments, notifs = []) {
  const body = { posts, comments, notifs };
  const sha = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return Object.assign({ kind: 'mc-gcapture', v: 1, group, run: 'r1' }, body, { sha });
}
async function groupsImport() {
  const G = '1000000000000001';
  let p = await mcOpen({
    chats: {
      gear: {
        kind: 'group',
        name: 'Gear Swap',
        tag: 'Gear',
        color: 2,
        order: 3,
        state: 'active',
        group: G,
        url: 'https://www.facebook.com/groups/' + G + '/',
        start: { days: 7 },
        read: 'all',
        rollup: true,
      },
    },
  });
  await mcPick(p, 'gear');
  const post = (k, count) => ({
    pid: String(2000000000000000 + k),
    who: 'Ana Alvarez',
    uid: '9100',
    age: k + ' hours ago',
    text: 'Post ' + k,
    more: false,
    photos: [],
    count,
  });
  const cmt = (k, c, who, rid) => ({
    cid: String(4000000000000000 + k * 100 + c),
    rid: rid || null,
    parent: rid ? String(4000000000000000 + k * 100 + c) : null,
    who,
    uid: '9101',
    text: 'Comment ' + c,
    age: '1h',
  });
  const cap1 = gcap(G, [post(0, 2), post(1, 0)], { [post(0).pid]: [cmt(0, 1, 'Ben Brooks'), cmt(0, 0, 'Sam')] });
  const li = await mcPaste(p, cap1, 'gear');
  const p0 = await get(p, 'gear_posts/p' + post(0).pid);
  const p1 = await get(p, 'gear_posts/p' + post(1).pid);
  const c0 = await get(p, 'gear_comments/p' + post(0).pid);
  const meta = await get(p, 'meta/chat-gear');
  ok(
    li &&
      li.posts === 2 &&
      li.comments === 2 &&
      p0 &&
      p0.n === 1 &&
      p1 &&
      p1.n === 2 &&
      meta.nextP === 3 &&
      c0 &&
      c0.comments.length === 2 &&
      c0.comments[0].cid === cmt(0, 0).cid &&
      c0.comments[0].c === 1 &&
      c0.comments[0].byYou === true &&
      c0.comments[1].c === 2 &&
      c0.comments[1].byYou === false,
    'G1: a group capture stores posts p1, p2 (meta/chat-gear nextP 3) and the comments numbered oldest first, yours marked (' +
      JSON.stringify({ li, n: [p0 && p0.n, p1 && p1.n], c: c0 && c0.comments.map(x => [x.c, x.byYou]) }) +
      ')',
  );
  // the same capture again: nothing changes
  const w0 = await mcNWrites(p);
  await p.evaluate(t => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, JSON.stringify(cap1));
  await p.waitForTimeout(400);
  const again = (await mcWrites(p, w0)).filter(x => !/^refresh\/lastImport/.test(x));
  ok(!again.length, 'G1: the same group capture pasted again changes no post or comment (' + again + ')');
  // a later capture: a new comment on p1 keeps numbering; a new post gets p3; known posts keep their numbers
  const reply = {
    cid: cmt(0, 0).cid,
    rid: '5000000000000001',
    parent: cmt(0, 0).cid,
    who: 'Dee Diaz',
    uid: '9103',
    text: 'Agreed',
    age: '5m',
  };
  const mention = {
    id: '7000000000000001',
    kind: 'group_comment_mention',
    group: G,
    post: post(0).pid,
    comment: cmt(0, 2).cid,
    reply: null,
    unread: true,
    age: '3m',
    text: 'Cy Chen mentioned you in a comment in Gear Swap.',
  };
  const cap2 = gcap(
    G,
    [post(2, 0), post(0, 3)],
    { [post(0).pid]: [reply, cmt(0, 2, 'Cy Chen'), cmt(0, 1, 'Ben Brooks')] },
    [mention],
  );
  await mcPaste(p, cap2, 'gear');
  const c0b = await get(p, 'gear_comments/p' + post(0).pid);
  ok(
    (await get(p, 'gear_posts/p' + post(2).pid)).n === 3 &&
      (await get(p, 'gear_posts/p' + post(0).pid)).n === 1 &&
      (await get(p, 'gear_posts/p' + post(0).pid)).count === 3 &&
      c0b.comments.length === 4 &&
      c0b.comments[2].c === 3 &&
      c0b.comments[2].who === 'Cy Chen' &&
      c0b.comments[3].rid === '5000000000000001',
    'G1: a later capture: the new post is p3, known posts keep their numbers, only the new comment is added (#3) (' +
      JSON.stringify(c0b && c0b.comments.map(x => x.c)) +
      ')',
  );
  // Posts: newest activity first, new post and new comments marked, earlier comments folded, the Facebook link
  await p.evaluate(() => {
    location.hash = '#posts';
  });
  const pv = await until(p, () => {
    const cards = [...document.querySelectorAll('#v-posts article.gpost')];
    return cards.length === 3
      ? {
          ids: cards.map(c => c.id),
          chips: cards.map(c => [...c.querySelectorAll(':scope > .row .chip')].map(x => x.textContent).join('|')),
          folded: (cards[1].querySelector('details > summary') || {}).textContent,
          news: cards[1].querySelectorAll(':scope > .gc.new').length,
          fb: cards[0].querySelector('a[target="_blank"]').getAttribute('href'),
          tabs: [...document.querySelectorAll('nav.tabs a')].filter(a => !a.hidden).map(a => a.dataset.tab),
        }
      : null;
  });
  ok(
    pv &&
      JSON.stringify(pv.ids) === '["p3","p1","p2"]' &&
      pv.chips[0] === 'new post' &&
      pv.chips[1] === '2 new comments' &&
      pv.folded === '2 earlier comments' &&
      pv.news === 2 &&
      pv.fb === 'https://www.facebook.com/groups/' + G + '/posts/' + post(2).pid + '/' &&
      JSON.stringify(pv.tabs) === '["summary","posts"]',
    'G1-18: Posts lists the group newest activity first (#p3 new, #p1 with 2 new comments, 2 earlier folded), each with its Facebook link; a group shows only Summary and Posts (' +
      JSON.stringify(pv) +
      ')',
  );
  // Summary: counts and Needs you (a reply to your comment); its citation opens the post and comment in place (B62)
  await p.evaluate(() => {
    location.hash = '#summary';
  });
  const sv = await until(p, () => {
    const t = document.getElementById('v-summary').textContent;
    return /3 posts and 4 comments stored/.test(t) ? t : null;
  });
  await p.click('#v-summary a.cite');
  const jumped = await until(p, () => {
    const d = document.querySelector('#v-summary .item details.thr');
    const c = d && d.open && d.querySelector('.gc[data-c="4"]');
    return location.hash === '#summary' && c && c.hasAttribute('data-flashed') && /Agreed/.test(c.textContent);
  });
  ok(
    sv &&
      /Dee Diaz replied to you: “Agreed”/.test(sv) &&
      /Gear #p1\/c4/.test(sv) &&
      /Cy Chen mentioned you in a comment in Gear Swap\. Gear #p1\/c3 from notifications/.test(sv) &&
      jumped,
    'G1-20: a group Summary counts posts and comments; Needs you lists a reply to your comment and a mention from notifications (matched to #p1/c3); a citation opens #p1 in place with c4 marked (' +
      (sv || '').slice(0, 200) +
      ')',
  );
  // All: the group's card has its new posts and comments and its unread mention; Show filters; Show in All off
  await mcPick(p, 'all');
  const allOf = () =>
    p.evaluate(() => ({
      cards: [...document.querySelectorAll('#v-all .chatcard')].map(c => c.dataset.chat),
      gear: (document.querySelector('#v-all .chatcard[data-chat="gear"] .chatnums') || {}).textContent || '',
      tot: (document.querySelector('#v-all [aria-label="Show"]') || {}).textContent || '',
    }));
  await p.click('#v-all [data-show="groups"]');
  const a1 = await allOf();
  await p.evaluate(() => {
    const m = JSON.parse(JSON.stringify(__rt.get('meta/chat')));
    m.chats.gear.rollup = false;
    __rt.write('meta/chat', m);
  });
  await p.waitForTimeout(300);
  const a2 = await allOf();
  ok(
    JSON.stringify(a1.cards) === '["gear"]' &&
      /^1 new post · 2 new comments · 1 needs you$/.test(a1.gear) &&
      /1 needs you/.test(a1.tot) &&
      /0 need you/.test(a2.tot) &&
      /\(not counted in All\)/.test(a2.gear),
    'G1-30: All shows the group card (1 new post, 2 new comments, 1 needs you), Show: Groups lists only groups; with Show in All off the total drops it but its card keeps its count (' +
      JSON.stringify({ a1, a2 }) +
      ')',
  );
  await mcPick(p, 'gear');
  // a capture from another group is refused
  await mcPaste(p, gcap('999', [post(5, 0)], {}), 'gear').catch(() => null);
  ok(!(await get(p, 'gear_posts/p' + post(5).pid)), 'G1: a capture from another group is refused, nothing stored');
  ok(p.errors.length === 0, 'G1 import: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
}
/* B69: a capture's rx (helper 4.1), the reactions read again on stored messages by Messenger id: the import updates
   those messages' x and xw in place, in their chunks, and nothing else; it ignores malformed entries and ones that name
   no stored message; it keeps the helper's digest (meta/chat.rxSum) and where the refresh's messages start (lastFromI) */
async function lateReactions() {
  const p = await open(SEED());
  const first = range(0, 99, i =>
    mk(
      i,
      i === 10
        ? { x: '1 👍', xw: [['Ana Alvarez', '👍']] }
        : i === 20
          ? { x: '1 😂', xw: [['Ben Brooks', '😂']] }
          : i === 50
            ? { x: '1 ❤️' }
            : {},
    ),
  );
  let r = await paste(p, JSON.stringify(cap(first)));
  ok(r && r.state === 'done', 'B69: the first capture (#0-#99) imports ' + JSON.stringify(r && r.msg));
  const before = { c0: await get(p, 'chunks/c0000'), c82: await get(p, 'chunks/c0082') };
  const XW10 = [
    ['Ana Alvarez', '👍'],
    ['You', '👍'],
  ];
  const rx = [
    { m: 'mid.10', x: '2 👍', xw: XW10 },
    { m: 'mid.20' },
    { m: 'mid.30', x: '1 😂' },
    { m: 'mid.50', x: '1 ❤️' },
    { m: 'mid.90', x: '1 👍', xw: [['You', '👍']] },
    null,
    'mid.40',
    { m: 5, x: '1 👍' },
    { m: 'mid.60', x: 7 },
    { m: 'mid.61', x: '1 👍', xw: 'not a list' },
    { m: 'mid.62', x: '1 👍', xw: [['You']] },
    { m: 'mid.nosuch', x: '1 👍' },
    { m: 'mid.101', x: '1 👍' },
  ];
  r = await paste(p, JSON.stringify(Object.assign(cap(range(100, 104)), { rx, rxsum: '30:0123456789abcdef' })));
  const c0 = await get(p, 'chunks/c0000');
  const c82 = await get(p, 'chunks/c0082');
  const mt = await get(p, 'meta/chat');
  ok(
    r &&
      r.state === 'done' &&
      /IMPORT OK: 5 new messages, #100–#104/.test(r.msg) &&
      r.msg.includes('Reactions changed on 4 stored messages (#10, #20, #30, #90; chunks c0000, c0082).') &&
      JSON.stringify(r.chunks) === JSON.stringify(['c0000', 'c0082']),
    'B69: the import names the stored messages whose reactions changed and their chunks (' +
      JSON.stringify(r && [r.msg, r.chunks]) +
      ')',
  );
  ok(
    c0.msgs[10].x === '2 👍' &&
      JSON.stringify(c0.msgs[10].xw) === JSON.stringify(XW10) &&
      !('x' in c0.msgs[20]) &&
      !('xw' in c0.msgs[20]) &&
      c0.msgs[30].x === '1 😂' &&
      !('xw' in c0.msgs[30]) &&
      c0.msgs[50].x === '1 ❤️' &&
      c82.msgs[90 - 82].x === '1 👍' &&
      JSON.stringify(c82.msgs[90 - 82].xw) === JSON.stringify([['You', '👍']]),
    'B69: x and xw updated in place: a new count and who reacted, a reaction taken away, a new one, one unchanged (' +
      JSON.stringify([c0.msgs[10], c0.msgs[20], c0.msgs[30], c82.msgs[8]]) +
      ')',
  );
  const strip = m => {
    const o = Object.assign({}, m);
    delete o.x;
    delete o.xw;
    return o;
  };
  const same = (a, b, skip) =>
    a.msgs.length === b.msgs.length &&
    a.msgs.every((m, k) =>
      skip.includes(m.i)
        ? JSON.stringify(strip(m)) === JSON.stringify(strip(b.msgs[k]))
        : JSON.stringify(m) === JSON.stringify(b.msgs[k]),
    );
  ok(
    same(before.c0, c0, [10, 20, 30]) &&
      same({ msgs: before.c82.msgs }, { msgs: c82.msgs.slice(0, before.c82.msgs.length) }, [90]) &&
      c82.msgs.length === before.c82.msgs.length + 5 &&
      c0.start === before.c0.start &&
      !('x' in c0.msgs[60]) &&
      !('x' in c0.msgs[61]) &&
      !('x' in c0.msgs[62]) &&
      !('x' in c0.msgs[40]) &&
      !('x' in c82.msgs[101 - 82]),
    'B69: nothing else changes: every other message and field as before, malformed entries and a new message’s entry ignored',
  );
  ok(
    mt.rxSum === '30:0123456789abcdef' && mt.lastFromI === 100 && mt.lastI === 104,
    'B69: meta/chat keeps the helper’s digest (rxSum) and where this refresh’s messages start (lastFromI) (' +
      JSON.stringify([mt.rxSum, mt.lastFromI, mt.lastI]) +
      ')',
  );
  // a reactions-only capture (nothing new): the same reactions change nothing; a new one is stored
  r = await paste(
    p,
    JSON.stringify(Object.assign(cap([], { base: 104 }), { rx: rx.slice(0, 5), rxsum: '5:1111111111111111' })),
  );
  const c0b = await get(p, 'chunks/c0000');
  ok(
    r &&
      r.state === 'done' &&
      /^Nothing new: everything in this capture is already stored\. Reactions on 5 stored messages: no changes\./.test(
        r.msg,
      ) &&
      JSON.stringify(c0b) === JSON.stringify(c0) &&
      (await get(p, 'meta/chat')).rxSum === '5:1111111111111111',
    'B69: a reactions-only capture with nothing changed writes no chunk and keeps the new digest (' +
      JSON.stringify(r && r.msg) +
      ')',
  );
  r = await paste(
    p,
    JSON.stringify(
      Object.assign(cap([], { base: 104 }), { rx: [{ m: 'mid.40', x: '1 👍' }], rxsum: '0:2222222222222222' }),
    ),
  );
  const c0c = await get(p, 'chunks/c0000');
  ok(
    r &&
      r.state === 'done' &&
      r.msg.includes('Reactions changed on 1 stored message (#40; chunk c0000).') &&
      c0c.msgs[40].x === '1 👍' &&
      (await p.evaluate(() => S.byI.get(40).x)) === '1 👍',
    'B69: a reactions-only capture updates the store and the page (' + JSON.stringify(r && r.msg) + ')',
  );
  ok(p.errors.length === 0, 'B69: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
}
/* B69: a mention you answered with your own yes or no reaction leaves Needs you, its counts and the picker's: from who
   reacted (xw, also read later), a reaction sent from this page, or the build's `answered` on the mention. A laugh,
   someone else's 👍 or a count alone (x) don't. needsIn decides, for every place that counts. An open question to you
   that you answered the same way leaves the open count. */
async function settledMentions() {
  const p = await open(SEED());
  const msgs = [
    mk(0, { f: 'Ben', b: 'Sam, the permit came through' }),
    mk(1, { f: 'Ana', b: 'Sam, can you bring the stove?', x: '1 👍', xw: [['You', '👍🏽']] }),
    mk(2, { f: 'Ben', b: 'Sam is late again', x: '1 😂', xw: [['You', '😂']] }),
    mk(3, { f: 'Cy', b: 'Sam, ok for Friday?', x: '1 👍', xw: [['Dee Diaz', '👍']] }),
    mk(4, { f: 'Dee', b: 'Sam, still selling?', x: '1 👍' }),
    mk(5, { f: 'Ana', b: 'Sam, lot at 7?' }),
    mk(6, { f: 'Ben', b: 'Who has a map?' }),
  ];
  await paste(p, JSON.stringify(cap(msgs)));
  await p.evaluate(() => {
    __rt.write('outbox/r1', {
      kind: 'react',
      i: 5,
      mid: 'mid.5',
      emoji: '👍',
      state: 'sent',
      queuedAt: '2026-11-26T10:00:00Z',
    });
    __rt.write('threading/current', {
      convs: [{ id: 'a', title: 'A', members: [0, 1, 2, 3, 4, 5, 6] }],
      links: {},
      to: 6,
      note: '',
    });
    __rt.write('summary/current', {
      version: 2,
      convs: [{ id: 'a', tag: '', synopsis: [], outcome: '', key: [] }],
      open: [
        { conv: 'a', ask: 1, to: 'Sam', note: '' },
        { conv: 'a', ask: 6, to: 'anyone', note: '' },
      ],
      answered: [],
      deals: [],
      mentions: [
        { note: 'permit', refs: [[0]], answered: 'You: 👍 (reaction)' },
        { note: 'stove', refs: [[1]] },
        { note: 'late', refs: [[2]] },
        { note: 'friday', refs: [[3]] },
        { note: 'selling', refs: [[4]] },
        { note: 'lot', refs: [[5]] },
      ],
      toI: 6,
      generatedAt: 'now',
    });
  });
  await p.waitForTimeout(400);
  const st = await p.evaluate(() => ({
    needs: needsIn(S.summary, () => true).map(x => x.note),
    other: needsIn(S.summary, () => true, { byI: null, outbox: S.outbox }).map(x => x.note),
    cards: [...document.querySelectorAll('#v-summary .item.mention')].length,
    strip: $('#strip').textContent,
  }));
  ok(
    JSON.stringify(st.needs) === JSON.stringify(['late', 'friday', 'selling']),
    'B69: Needs you leaves out a mention you answered with your 👍 (xw), one with your 👍 sent from the page, and one the build marked answered; a laugh, someone else’s 👍 and a count alone stay (' +
      JSON.stringify(st.needs) +
      ')',
  );
  ok(
    st.cards === 3 && /3mentions of you/.test(st.strip) && /1open questions/.test(st.strip),
    'B69: the Needs you cards and the strip agree (3 mentions; 1 open question: the one to you answered by your 👍 leaves it) (' +
      JSON.stringify(st) +
      ')',
  );
  ok(
    JSON.stringify(st.other) === JSON.stringify(['stove', 'late', 'friday', 'selling']),
    'B69: for a chat whose messages aren’t loaded, the page’s own sent reaction and the build’s mark still count (' +
      JSON.stringify(st.other) +
      ')',
  );
  ok(p.errors.length === 0, 'B69 settled mentions: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
  // several chats: the picker's and All chats' "need you" counts (needsOf) follow the same rule. Trail (on screen):
  // your 👍 on #8 (xw); Camera Club: a 👍 sent from the page on #6; Book Club: your laugh on #3 (still needs you)
  const seed = mcSeed();
  seed['chunks/c0000'].msgs[8] = Object.assign({}, seed['chunks/c0000'].msgs[8], { x: '1 👍', xw: [['You', '👍']] });
  seed['book_chunks/c0000'].msgs[3] = Object.assign({}, seed['book_chunks/c0000'].msgs[3], {
    x: '1 😂',
    xw: [['You', '😂']],
  });
  seed['cam_outbox/r1'] = {
    kind: 'react',
    i: 6,
    mid: seed['cam_chunks/c0000'].msgs[6].m,
    emoji: '👍',
    state: 'sent',
    queuedAt: '2026-11-26T10:00:00Z',
  };
  const q = await open(seed);
  const counts = await until(
    q,
    () => {
      const v = Object.fromEntries(S.chats.map(c => [c.key, needsOf(c).length]));
      return S.chats.every(c => (LIGHT.get(c.key) || {}).sum && (LIGHT.get(c.key) || {}).outbox) ? v : null;
    },
    null,
    8000,
  );
  ok(
    counts && counts.trail === 0 && counts.cam === 0 && counts.book === 1,
    'B69: the picker’s and All chats’ counts: 0 for Trail (your 👍), 0 for Camera Club (your 👍 sent from the page), 1 for Book Club (a laugh) (' +
      JSON.stringify(counts) +
      ')',
  );
  ok(q.errors.length === 0, 'B69 settled mentions, several chats: no page errors ' + JSON.stringify(q.errors));
  await q.context().close();
}
/* B67: reactions in the message lines Claude reads (who reacted, or "probably answered"), and the meaning table, the
   owner's corrections and the context rules in Ask's prompts. The owner is "Sam" (META). */
async function reactions() {
  const p = await open(SEED());
  const RXW = [
    ['You', '👍'],
    ['Cy Chen', '😂'],
  ];
  const msgs = [
    mk(0, { f: 'Ana', b: 'Sam, can you bring the stove Saturday?', x: '1 👍🏽' }),
    mk(1, { f: 'Ben', b: 'Who has a map?', x: '2 👍 and 😂', xw: RXW }),
    mk(2, { f: 'Cy', b: 'Ok', r: 'you', x: '1 😂' }),
    mk(3, { f: 'Dee', b: 'Trail is muddy', x: '1 👍' }),
    mk(4, { f: 'Ana', b: 'Selling my pack', r: 'you', x: '1 🔥' }),
    mk(5, { f: 'Ben', b: 'Sam?', x: '1 👍', xw: 'not a list' }),
    mk(6, { f: 'You', b: 'Anyone at the lot, Sam here?', x: '1 👍' }),
    mk(7, { f: 'Cy', b: '', p: 'att7' }),
    mk(8, { f: 'Dee', b: 'trail '.repeat(30).trim() }),
  ];
  const r = await paste(p, JSON.stringify(cap(msgs)));
  ok(r && r.state === 'done', 'B67: a capture with reactions imports ' + JSON.stringify(r && r.state));
  const c0 = await get(p, 'chunks/c0000');
  ok(
    JSON.stringify(c0.msgs[1].xw) === JSON.stringify(RXW) && !('xw' in c0.msgs[5]) && c0.msgs[5].x === '1 👍',
    'B67: the importer stores who reacted (xw) with the message, and drops an xw of the wrong shape ' +
      JSON.stringify([c0.msgs[1].xw, c0.msgs[5]]),
  );
  const lines = () => p.evaluate(() => S.msgs.map(lineFor));
  let L = await lines();
  ok(
    L[1].endsWith('Ben: Who has a map? {reactions: 👍 You; 😂 Cy Chen}'),
    'B67: a line names who reacted when the helper read it ' + L[1],
  );
  ok(
    L[0].endsWith('{reactions: 1 👍🏽; probably answered (a 👍🏽 on it, likely yours)}') &&
      L[4].endsWith('{reactions: 1 🔥; probably answered (a 🔥 on it, likely yours)}'),
    'B67: without who reacted, an answering reaction on a message that names you or replies to you is "probably answered" ' +
      JSON.stringify([L[0], L[4]]),
  );
  ok(
    L[2].endsWith('Cy (replying to you): Ok {reactions: 1 😂}') &&
      L[3].endsWith('{reactions: 1 👍}') &&
      L[5].endsWith('Ben: Sam? {reactions: 1 👍; probably answered (a 👍 on it, likely yours)}') &&
      L[6].endsWith('{reactions: 1 👍}'),
    'B67: a laugh is never an answer, a message to nobody in particular and your own get only the count ' +
      JSON.stringify([L[2], L[3], L[5], L[6]]),
  );
  // the prompts carry the table from references/reactions.md, word for word, and the rules
  const md = fs.readFileSync(path.join(ROOT, 'plugin/skills/refresh/references/reactions.md'), 'utf8');
  const rows = md
    .split('\n')
    .filter(l => /^\| \S/.test(l) && !/^\| Reaction/.test(l))
    .map(l =>
      l
        .split('|')
        .slice(1, -1)
        .map(c => c.trim()),
    );
  const rules = md
    .split("<!-- the page's copy ends here -->")[0]
    .split('\n')
    .filter(l => /^- /.test(l));
  const prompts = () =>
    p.evaluate(() => ({
      ask: askPrompt(true, [], 200000, false).text,
      view: viewPrompt('x', 200000, false).text,
      x: xRules(false),
    }));
  let P = await prompts();
  const hasTable = t => rows.every(([e, m, a]) => t.includes('  ' + e + ': ' + m + ' (as an answer: ' + a + ')'));
  ok(
    rows.length === 11 &&
      rules.length === 7 &&
      ['ask', 'view', 'x'].every(k => hasTable(P[k]) && rules.every(l => P[k].includes(l))),
    'B67: Ask (one chat and across chats) and Views send the meaning table and the context rules from reactions.md ' +
      JSON.stringify([rows.length, rules.length]),
  );
  ok(
    P.ask.includes('In these rules, you and your mean Sam ("You" in the data)') &&
      P.ask.includes(
        'A reaction from You on a message addressed to you (a reply to you, or one that names you) counts as your answer.',
      ) &&
      P.ask.includes('"probably answered (a 👍 on it, likely yours)"') &&
      !P.ask.includes("owner's corrections"),
    'B67: the rules say a reaction of yours on a message to you is your answer, and explain "probably answered"; no corrections yet',
  );
  ok(P.ask.includes('{reactions: 👍 You; 😂 Cy Chen}'), 'B67: Ask reads the line with who reacted');
  // the owner's corrections (meta/chat.reactionMeanings) win over the table
  await p.evaluate(() =>
    __rt.write(
      'meta/chat',
      Object.assign(__rt.get('meta/chat'), {
        reactionMeanings: { '🔥': 'funny here', '😂': 'Yes, agreed', bad: 'x', '👀': 7 },
      }),
    ),
  );
  await until(p, () => ((S.page || {}).reactionMeanings || {})['🔥']);
  L = await lines();
  P = await prompts();
  ok(
    L[4].endsWith('{reactions: 1 🔥}') &&
      L[2].endsWith('{reactions: 1 😂; probably answered (a 😂 on it, likely yours)}'),
    'B67: a correction changes what a reaction answers: 🔥 no longer, 😂 now a yes ' + JSON.stringify([L[4], L[2]]),
  );
  ok(
    ['ask', 'x'].every(k =>
      P[k].includes("The owner's corrections, which win over that table: 🔥 means funny here; 😂 means Yes, agreed."),
    ) && !/means x\b|means 7/.test(P.ask),
    'B67: both prompts carry the corrections; malformed ones are left out',
  );
  // under the message: who reacted, else the count
  await p.evaluate(() => (location.hash = '#messages'));
  const sub = await until(p, () => {
    const a = document.querySelector('#m1 .sub');
    const b = document.querySelector('#m3 .sub');
    return a && b && [a.textContent, b.textContent];
  });
  ok(
    sub && sub[0].includes('👍 You · 😂 Cy Chen') && sub[1].includes('1 👍'),
    'B67: Messages shows who reacted under a message, else the count ' + JSON.stringify(sub),
  );
  // F41 (#95): a citation in an answer shows a card on hover: who, when, the start of the message, its reactions
  await p.evaluate(() => {
    location.hash = '#ask';
    addTurn('assistant', 'Ben asked [#1]; Ana asked you [#0]. Photo [#7]. Long [#8].');
  });
  const cites = await p.$$eval('#chat .cite', as =>
    as.map(a => [a.textContent, a.title, a.getAttribute('aria-label')]),
  );
  const day = await p.evaluate(() => dayOf(S.byI.get(1).d));
  const want = [
    'Ben · ' + day + ' Fri 9:01 AM\nWho has a map?\nReactions: 👍 You; 😂 Cy Chen',
    'Ana · ' + day + ' Fri 9:00 AM\nSam, can you bring the stove Saturday?\nReactions: 1 👍🏽',
    'Cy · ' + day + ' Fri 9:07 AM\n📷 photo',
    'Dee · ' + day + ' Fri 9:08 AM\n' + 'trail '.repeat(17).slice(0, 100) + '…',
  ];
  ok(
    JSON.stringify(cites.map(c => c[1])) === JSON.stringify(want) &&
      cites[0][2] === '#1: ' + want[0].replace(/\n/g, '; ') &&
      cites.every(c => /^#\d+$/.test(c[0])),
    'F41: each citation carries its card text as title and aria-label: name, day and time, the first 100 characters (or 📷 photo), reactions with who reacted, else the count ' +
      JSON.stringify(cites),
  );
  const card = () =>
    p.evaluate(() => {
      const c = document.getElementById('citecard');
      return c && !c.hidden ? c.textContent : null;
    });
  await p.hover('#chat .cite >> nth=0');
  const h1 = await card();
  await p.mouse.move(5, 5);
  const h0 = await card();
  ok(
    h1 === want[0] && h0 === null,
    'F41: hovering a citation shows its card, moving away hides it ' + JSON.stringify([h1, h0]),
  );
  await p.click('#chat .cite >> nth=0');
  ok(
    await until(p, () => !document.getElementById('v-messages').hidden),
    'F41: a click (not a tap) follows the citation to the message at once',
  );
  ok(p.errors.length === 0, 'B67: no page errors ' + JSON.stringify(p.errors));
  await p.context().close();
  // on a touch screen the first tap shows the card, the second follows the citation
  const pt = await open(SEED(), PAGE, { hasTouch: true });
  await paste(pt, JSON.stringify(cap(msgs)));
  await pt.evaluate(() => {
    location.hash = '#ask';
    addTurn('assistant', 'Ben asked [#1].');
  });
  await pt.tap('#chat .cite');
  const t1 = await pt.evaluate(() => [
    (c => (c && !c.hidden ? c.textContent : null))(document.getElementById('citecard')),
    document.getElementById('v-messages').hidden,
  ]);
  await pt.tap('#chat .cite');
  const t2 = await until(pt, () => !document.getElementById('v-messages').hidden);
  ok(
    t1[0] === want[0] && t1[1] === true && t2,
    'F41: on touch, the first tap shows the card without following; the second opens the message ' + JSON.stringify(t1),
  );
  ok(pt.errors.length === 0, 'F41 touch: no page errors ' + JSON.stringify(pt.errors));
  await pt.context().close();
  // across chats: "Cam #2" shows the Camera Club message, named that chat's way, with its reactions
  const xs = xaSeed();
  Object.assign(xs.extra['cam_chunks/c0000'].msgs[2], { x: '1 👍', xw: [['You', '👍']] });
  for (const touch of [false, true]) {
    const px = await mcOpen(xs, touch ? { hasTouch: true } : undefined);
    await px.evaluate(pl => (window.__toolPlan = pl), XA_PLAN);
    await px.click('nav a[data-tab="ask"]');
    await xask(px, 'Anyone have a tripod?');
    const sel = '#xchat .turn.assistant .txt .cite[data-chat="cam"]';
    const xc = await px.$$eval(sel, bs => bs.map(b => [b.textContent, b.title]));
    const rx2 =
      /^Dee Moss \(Deedee\) · \w{3} \d+ \w{3} \d+:\d\d [AP]M\nselling my tripod, barely used\nReactions: 👍 You$/;
    if (!touch) {
      ok(
        xc[0][0] === 'Cam #2' && rx2.test(xc[0][1]) && /\n📷 a carbon tripod folded on a table$/.test(xc[1][1]),
        "F41: a citation across chats carries its chat's message: full name (that chat's nickname), time, text, who reacted; a photo shows its caption " +
          JSON.stringify(xc.slice(0, 2)),
      );
      await px.hover(sel + ' >> nth=0');
      const hc = await px.evaluate(() => document.getElementById('citecard').textContent);
      ok(rx2.test(hc), 'F41: hovering "Cam #2" on All chats shows its card ' + JSON.stringify(hc));
    } else {
      await px.tap(sel + ' >> nth=0');
      const a1 = await px.evaluate(() => [
        !document.getElementById('citecard').hidden,
        document.querySelector('#h1').textContent,
      ]);
      await px.tap(sel + ' >> nth=0');
      const a2 = await until(px, () => document.querySelector('#h1').textContent !== 'All chats');
      ok(
        a1[0] && a1[1] === 'All chats' && a2,
        'F41: on touch, "Cam #2" shows its card first and opens Camera Club on the second tap ' + JSON.stringify(a1),
      );
    }
    ok(px.errors.length === 0, 'F41 across chats: no page errors ' + JSON.stringify(px.errors));
    await px.context().close();
  }
  // a chat whose messages carry no reactions isn't sent the table (about 2 KB of every prompt)
  const p2 = await open(SEED());
  await paste(p2, JSON.stringify(cap(range(0, 5))));
  const P2 = await p2.evaluate(() => ({
    ask: askPrompt(true, [], 200000, false).text,
    x: xRules(false, false),
    lines: S.msgs.map(lineFor).join('\n'),
  }));
  ok(
    !P2.ask.includes('Reactions can be answers') &&
      !P2.x.includes('Reactions can be answers') &&
      !/reactions/.test(P2.lines),
    'B67: no reactions in the chat, no reaction rules in its prompts',
  );
  await p2.context().close();
}
const SECTIONS = {
  reactions,
  lateReactions,
  settledMentions,
  groupsAdd,
  groupsImport,
  importer,
  multiChat,
  multiChat2,
  multiChat3,
  multiChatAsk,
  multiChatB56,
  multiChatAll,
  robustness,
  pipeline,
  variants,
  ranges,
  layouts,
  deepThreads,
  names,
  messagesView,
  speed,
  photos,
  photos2,
  photoKeys,
  bigPaste,
  standIn,
  stats,
  stats2,
  history,
  history2,
  digests,
  byDay,
  byDayReports,
  daySums,
  askDaySums,
  askErrors,
  notices,
  schedule,
  claims,
  deeper,
  deeperBudget,
  longRanges,
  longRanges2,
  olderByDay,
  crossReply,
  savedQuestions,
  viewsTab,
  packs,
  packs2,
  packs3,
  packs4,
  captions,
  askSearch,
  gifs,
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
