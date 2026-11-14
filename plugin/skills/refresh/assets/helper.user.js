// ==UserScript==
// @name         Messenger Catch-up Helper
// @namespace    https://claude.ai/
// @version      2.1
// @description  Jump-to-message links for your Messenger Catch-up page, plus the scan/verify/capture steps Claude runs during a refresh. Read-only except opening the Reply box when you follow a Reply link, and posting a reply you queued only if you turned that on.
// @match        https://www.facebook.com/messages/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://github.com/roopesh/messenger-catchup/releases/latest/download/helper.user.js
// @downloadURL  https://github.com/roopesh/messenger-catchup/releases/latest/download/helper.user.js
// ==/UserScript==
(function () {
  if (window.__mcHelper || document.documentElement.hasAttribute('data-mc-helper')) return;
  window.__mcHelper = '2.1';
  document.documentElement.setAttribute('data-mc-helper', '2.1');
  /* While a scan runs, clicks on links are swallowed so scrolling can't navigate away. Registered once per page load. */
  document.addEventListener(
    'click',
    e => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (a && window.__rf && !window.__rf.done) e.preventDefault();
    },
    true,
  );
  /* Messenger's label on every message: "At <time>, <name>: <text>". The time is 12-hour ("9:15 AM") or 24-hour
     ("17:52"), after an optional day ("Yesterday", "Mon", "November 3, 2026", "3 November 2026"). */
  const AT = /^At (.*?\d{1,2}:\d{2}(?:\s?[AaPp][Mm])?), /;
  const N = s => (s || '').replace(/\s+/g, ' ').trim();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  /* The sender in a label: the name Messenger prints (a nickname or the first name), or "You". */
  const nameOf = label => {
    const a = String(label || '').replace(AT, '');
    const k = a.indexOf(': ');
    return k > 0 ? a.slice(0, k) : a;
  };
  const LANG = l =>
    'page language is "' +
    l +
    '", not English: the reader reads Messenger\'s English labels, so dates, replies and names may be missed (Facebook settings › Language: English)';
  const CLOCK24 =
    '24-hour clock (times like 17:52): read and stored as 12-hour times; this form is tested on a simulated Messenger only';
  /* A message's date from its Messenger time label: "9:15 AM" (today), "Yesterday 9:15 AM", "Monday 9:15 AM" or "Mon 9:15 AM"
   (the last 7 days), "November 3, 2026 9:15 AM", "Nov 3 9:15 AM" or "3 Nov 2026 17:52" (a year-less date in the future
   means last year). Returns "YYYY-MM-DD", or null for a label it can't read. */
  function mcDate(when, now) {
    now = now || new Date();
    const W = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
      M = [
        'january',
        'february',
        'march',
        'april',
        'may',
        'june',
        'july',
        'august',
        'september',
        'october',
        'november',
        'december',
      ];
    const ymd = d =>
      d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const ago = n => {
      const d = new Date(now);
      d.setDate(d.getDate() - n);
      return ymd(d);
    };
    const pick = (names, w) => {
      w = w.toLowerCase();
      return w.length >= 3 ? names.findIndex(x => x.indexOf(w) === 0) : -1;
    };
    const day = (y, mi, d) => {
      let x = new Date(y ? +y : now.getFullYear(), mi, +d);
      if (!y && x - now > 864e5) x = new Date(now.getFullYear() - 1, mi, +d);
      return ymd(x);
    };
    const s = String(when || '').trim();
    if (/^\d{1,2}:\d{2}/.test(s) || /^today\b/i.test(s)) return ymd(now);
    if (/^yesterday\b/i.test(s)) return ago(1);
    const md = s.match(/^([A-Za-z]+)\.? (\d{1,2})(?![\d:])(?:,? (\d{4}))?/);
    if (md && pick(M, md[1]) >= 0) return day(md[3], pick(M, md[1]), md[2]);
    const dm = s.match(/^(\d{1,2}) ([A-Za-z]+)\.?(?:,? (\d{4}))?(?![\d:])/);
    if (dm && pick(M, dm[2]) >= 0) return day(dm[3], pick(M, dm[2]), dm[1]);
    const dw = s.match(/^([A-Za-z]+)\.?\s/);
    if (dw) {
      const wi = pick(W, dw[1]);
      if (wi >= 0) return ago((now.getDay() - wi + 7) % 7 || 7);
    }
    return null;
  }
  window.__mcDate = mcDate;
  /* Minutes after midnight from a label's time, 12- or 24-hour (the last time in it); null when it has none. */
  function mcMinutes(when) {
    const all = [...String(when || '').matchAll(/(\d{1,2}):(\d{2})(?:\s?([AaPp])[Mm])?/g)];
    if (!all.length) return null;
    const t = all[all.length - 1];
    const h = t[3] ? (+t[1] % 12) + (/p/i.test(t[3]) ? 12 : 0) : +t[1];
    return h > 23 || +t[2] > 59 ? null : h * 60 + +t[2];
  }
  /* The scrolling message list. Path "message": the nearest scrollable ancestor of a message that holds (nearly) all of
     the log's messages, so a scrollable box inside one message (a code block, a carousel) is never taken for the list.
     Failing that, helper 1.9's rule, the first scrollable element in the chat log ("first-div"), or a scrollable ancestor
     with nothing to scroll yet ("message-short", a chat too short to scroll). Returns {el, path} or null. */
  function mcScroller(log) {
    if (!log) return null;
    const can = x => /(auto|scroll)/.test(getComputedStyle(x).overflowY);
    const all = log.querySelectorAll('[data-message-id]').length;
    const most = x => x.querySelectorAll('[data-message-id]').length >= Math.max(1, all * 0.9);
    const m = log.querySelector('[data-message-id]');
    let quiet = null;
    for (let x = m && m.parentElement; x && x !== document.body; x = x.parentElement) {
      if (!can(x) || !most(x)) continue;
      if (x.scrollHeight > x.clientHeight) return { el: x, path: log.contains(x) ? 'message' : 'message-outside-log' };
      quiet = quiet || x;
    }
    const first = Array.from(log.querySelectorAll('div')).find(x => can(x) && x.scrollHeight > x.clientHeight);
    if (first) return { el: first, path: 'first-div' };
    return quiet ? { el: quiet, path: 'message-short' } : null;
  }
  /* Messenger shows a spinner at the top of the list while it loads older messages: that isn't the top of the chat. Only a
     visible progress bar near the top of the list counts, never one inside a message (a poll, a voice clip, an upload). */
  function loadingTop(sc) {
    if (!sc) return false;
    const r = sc.getBoundingClientRect();
    return Array.from(sc.querySelectorAll('[role="progressbar"]')).some(p => {
      if (p.closest('[data-message-id]')) return false;
      const b = p.getBoundingClientRect();
      const seen = p.checkVisibility
        ? p.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        : !!p.offsetParent;
      return seen && b.height > 0 && b.width > 0 && b.top < r.top + 200;
    });
  }
  const TOP_TRIES = 8;
  const TOP_MS = 12000;
  /* The top-of-chat wait: TOP_TRIES steps and TOP_MS with nothing new. A test option, topMs, shortens it: topMs with
     nothing new, and at least 2 steps at the top (the steps scale with it, 8 at the default 12 s). */
  const topWait = o => {
    const ms = +(o && o.topMs) || TOP_MS;
    return { ms, tries: Math.max(2, Math.min(TOP_TRIES, Math.round((ms * TOP_TRIES) / TOP_MS))) };
  };
  /* The sender's avatar (a ~28 px square image at the message's left edge) carries their full name as alt text; the
     name Messenger prints is a nickname or the first name. Reaction emoji and "seen" faces are smaller. Messenger shows
     the avatar once per run of messages from one sender; the scan gives the run's other messages its name (avr). */
  function avatar(e) {
    const er = e.getBoundingClientRect();
    const im = Array.from(e.querySelectorAll('img[alt]')).find(i => {
      const r = i.getBoundingClientRect();
      return r.width >= 24 && r.width <= 40 && Math.abs(r.width - r.height) < 2 && r.left - er.left < 60;
    });
    const a = im ? im.alt.trim() : '';
    return a.length <= 80 && !/^(GIF|Photo|Sticker|Open|Seen)\b/.test(a) ? a : '';
  }
  /* A photo link with no Facebook CDN image in it: the capture would miss that photo. Videos are left out. */
  function photoNoImage(e) {
    if (!e.querySelector('a[href*="messenger_media"]') || e.querySelector('video')) return false;
    return !Array.from(e.querySelectorAll('a[href*="messenger_media"] img, [aria-label^="Open photo"] img')).some(i =>
      /fbcdn/.test(i.currentSrc || i.getAttribute('src') || ''),
    );
  }
  /* R16: a message's photos, one per photo link ("tile") in page order, so a photo keeps its slot k even when an image
     before it hasn't loaded yet (a quick backfill scan). Each tile: u = its loaded Facebook image ('' while it hasn't
     loaded) and aid = Messenger's attachment id from the link's attachment_id (the same on every visit; '' when there is
     none). A tile holding only a small Facebook image (a GIF's still) or an image from elsewhere (GIPHY) is no photo;
     one whose image has no source yet, or only a data:/blob: placeholder, is a photo that hasn't loaded. */
  function photoTiles(e) {
    const links = Array.from(e.querySelectorAll('a[href*="messenger_media"]'));
    let cands = links.length ? links : Array.from(e.querySelectorAll('[aria-label^="Open photo"]'));
    cands = cands.filter(x => !cands.some(y => y !== x && y.contains(x)));
    const out = [];
    for (const t of cands) {
      const a = t.matches('a[href*="messenger_media"]') ? t : t.querySelector('a[href*="messenger_media"]');
      const m = a && (a.getAttribute('href') || '').match(/[?&]attachment_id=(\d+)/);
      const aid = m ? m[1] : '';
      const im = Array.from(t.querySelectorAll('img'));
      const fb = im.filter(i => i.currentSrc && /fbcdn/.test(i.currentSrc));
      const big = fb.filter(i => !(i.naturalWidth && i.naturalWidth <= 220 && i.naturalHeight <= 120));
      const src = i => i.currentSrc || i.getAttribute('src') || '';
      let u = '';
      if (big.length) u = big[0].currentSrc;
      else if (fb.length) continue;
      else if (!im.some(i => i.alt !== 'GIF Image' && (!src(i) || /^(data|blob):/.test(src(i))))) continue;
      if (out.some(o => (aid && o.aid === aid) || (u && o.u === u))) continue;
      out.push({ u, aid });
    }
    return out;
  }
  /* The scan reads a message many times while it scrolls: keep what each read saw. The read with more tiles wins, and a
     tile it saw unloaded takes the URL another read saw for the same attachment id (or the same place, when neither
     read had ids and both saw as many tiles). */
  function mergePh(a, b) {
    if (!a) return b;
    const at = a.tiles || [];
    const bt = b.tiles || [];
    const base = bt.length >= at.length ? bt : at;
    const other = base === bt ? at : bt;
    const tiles = base.map((t, j) => {
      if (t.u) return t;
      const o = t.aid ? other.find(x => x.aid === t.aid) : other.length === base.length && !other[j].aid && other[j];
      return o && o.u ? { u: o.u, aid: t.aid } : t;
    });
    return { srcs: a.srcs.length > b.srcs.length ? a.srcs : b.srcs, tiles, gif: !!(a.gif || b.gif) };
  }
  const refList = refs => refs.slice(0, 3).join(', ') + (refs.length > 3 ? ', …' : '');
  /* Reply markers that disagree. Without this a reworded "X replied to Y" line reads as a reply to nobody, and both
     markers reworded read as no replies at all. items: [{text, reply (has a "Go to replied message" link), ref}]. */
  function replyWarn(items) {
    const w = [];
    const line = it => / replied to /.test((it.text || '').split('\n')[0]);
    const noLine = items.filter(it => it.reply && !line(it));
    const quoteOnly = items.filter(it => !it.reply && !line(it) && (it.text || '').includes('Original message:'));
    if (noLine.length)
      w.push(
        noLine.length +
          ' reply link(s) without an "X replied to Y" line (' +
          refList(noLine.map(it => it.ref)) +
          "): who they reply to can't be read, so they get no Messenger link (perr noreplyline). Messenger may have reworded that line",
      );
    if (quoteOnly.length)
      w.push(
        quoteOnly.length +
          ' message(s) with an "Original message:" quote but no reply link or reply line (' +
          refList(quoteOnly.map(it => it.ref)) +
          '): their reply links are missed. Messenger may have reworded its reply markers',
      );
    return w;
  }
  /* Times that go backwards, or lie in the future, mean dates are being read wrong: a time-only label taken as today when
     it isn't, or messages out of order. A step back of an hour or less is allowed (clock changes). seq: [{when, ref}]. */
  function timeWarn(seq, now) {
    const back = [];
    const fut = [];
    let prev = null;
    for (const it of seq) {
      const d = mcDate(it.when, now);
      const mn = mcMinutes(it.when);
      if (!d || mn == null) continue;
      const ts = new Date(d + 'T00:00:00').getTime() + mn * 60000;
      if (prev && ts < prev.ts - 3600000)
        back.push(prev.ref + ' "' + prev.when + '" then ' + it.ref + ' "' + it.when + '"');
      if (ts > now.getTime() + 600000) fut.push(it.ref + ' "' + it.when + '"');
      prev = { ts, ref: it.ref, when: it.when };
    }
    const w = [];
    if (back.length)
      w.push(
        'time labels go backwards ' +
          back.length +
          ' time(s) (' +
          back.slice(0, 2).join('; ') +
          '): those dates may be wrong',
      );
    if (fut.length)
      w.push(
        fut.length +
          ' message(s) dated in the future (' +
          refList(fut) +
          '): a time-only label may not mean today, so those dates may be wrong',
      );
    return w;
  }
  /* One shown name with full names that don't share a first name: one of them likely came from the wrong avatar. Two
     people who share a first name ("Ben" = Ben Brooks and Ben Ortiz) are normal and not reported. pairs: [[shown, full]]. */
  function nameWarn(pairs) {
    const by = new Map();
    for (const [s, f] of pairs) {
      if (!s || !f || s === 'You') continue;
      if (!by.has(s)) by.set(s, new Set());
      by.get(s).add(f);
    }
    const w = [];
    for (const [s, fs] of by) {
      const firsts = new Set([...fs].map(f => f.split(' ')[0].toLowerCase()));
      if (fs.size > 1 && firsts.size > 1)
        w.push(
          '"' +
            s +
            '" shows as ' +
            [...fs].join(' and ') +
            ' in one capture: one of those full names may come from the wrong avatar',
        );
    }
    return w;
  }
  /* selfcheck: read-only and immediate. Confirms that each part of Messenger's page the reader relies on is present in
     the open chat, so a markup change reads "Messenger changed: <what>" instead of failing somewhere inside a scan.
     missing = the reader can't work; warn = it works with less (no full names, guessed dates) or may read wrong. */
  function mcSelfcheck() {
    const missing = [];
    const warn = [];
    const lang = document.documentElement.lang || '';
    if (lang && !/^en\b/i.test(lang)) warn.push(LANG(lang));
    const log = document.querySelector('[role="log"]');
    if (!log || log.getBoundingClientRect().width < 300) missing.push('chat log ([role="log"])');
    const msgs = log ? Array.from(log.querySelectorAll('[data-message-id]')) : [];
    if (log && !msgs.length) missing.push('message ids (data-message-id)');
    const S = mcScroller(log);
    if (log && msgs.length && !S) missing.push('scrolling message list');
    const labels = msgs.map(e => e.getAttribute('aria-label') || '').filter(l => AT.test(l));
    if (msgs.length && labels.length < msgs.length / 2) missing.push('message labels ("At <time>, <name>: ...")');
    const whens = labels.map(l => l.match(AT)[1]);
    if (whens.length && whens.filter(w => !/[AaPp][Mm]$/.test(w)).length > whens.length / 2) warn.push(CLOCK24);
    const texts = msgs.map(e => e.innerText || '');
    const replyLines = texts.filter(t => / replied to /.test(t.split('\n')[0])).length;
    const replyLinks = msgs.filter(e => e.querySelector('[aria-label="Go to replied message"]')).length;
    if (replyLines && !replyLinks) missing.push('"Go to replied message" links');
    if (replyLinks && !texts.some(t => t.includes('Original message:'))) missing.push('"Original message:" quotes');
    warn.push(
      ...replyWarn(
        msgs.map((e, k) => ({
          text: texts[k],
          reply: !!e.querySelector('[aria-label="Go to replied message"]'),
          ref: '"' + (e.getAttribute('aria-label') || '').slice(0, 40) + '"',
        })),
      ),
    );
    const noImg = msgs.filter(photoNoImage).length;
    if (noImg)
      warn.push(
        noImg +
          " photo link(s) with no Facebook image: the capture can't fetch those photos (Messenger's photo markup?)",
      );
    const others = msgs.filter(e => nameOf(e.getAttribute('aria-label')) !== 'You');
    const named = others.filter(e => avatar(e)).length;
    if (others.length >= 3 && !named) warn.push('sender avatars (full names)');
    const now = new Date();
    const undated = whens.filter(w => !mcDate(w, now)).length;
    if (whens.length && undated > whens.length / 2)
      warn.push('date labels (' + undated + ' of ' + whens.length + ' unreadable)');
    warn.push(
      ...timeWarn(
        whens.map((w, k) => ({ when: w, ref: 'label ' + (k + 1) })),
        now,
      ),
    );
    return {
      ok: !missing.length,
      missing,
      warn,
      lang,
      counts: {
        messages: msgs.length,
        labeled: labels.length,
        named,
        replies: replyLinks,
        scroller: S ? S.path : null,
      },
    };
  }
  /* people{count,maxMs}: read-only. Scrolls back through up to count messages (or to the top, or for maxMs) and reads
     each sender's shown name and avatar name. Stops early, with `stalled` (and `spinner` when a loading spinner stays at
     the top), when nothing new loads for stallMs (30 s). Returns {seen, top, stalled, spinner, ms, people:[[shown, full,
     messages]]}. */
  async function mcPeople(a) {
    const count = (a && a.count) || 2000;
    const maxMs = (a && a.maxMs) || 480000;
    const STALL = +(a && a.stallMs) || 30000;
    const t0 = Date.now();
    let log = null;
    for (let w = 0; w < 40 && !(log && log.getBoundingClientRect().width >= 300); w++) {
      log = document.querySelector('[role="log"]');
      if (!log || log.getBoundingClientRect().width < 300) await sleep(500);
    }
    if (!log) return { err: 'chat not loaded' };
    const sc = () => (mcScroller(log) || {}).el;
    const seen = new Set();
    const loaded = new Set();
    const pairs = new Map();
    const collect = () =>
      log.querySelectorAll('[data-message-id]').forEach(e => {
        const id = e.getAttribute('data-message-id');
        loaded.add(id);
        if (seen.has(id)) return;
        const l = e.getAttribute('aria-label') || '';
        const m = AT.test(l) ? nameOf(l) : null;
        const full = avatar(e);
        if (m && m !== 'You' && !full) return; /* avatar not laid out yet: read it on a later pass */
        seen.add(id);
        if (!m || m === 'You') return;
        const k = m + '\u0000' + full;
        pairs.set(k, (pairs.get(k) || 0) + 1);
      });
    for (let b = 0; b < 4; b++) {
      const s0 = sc();
      if (s0) s0.scrollTop = s0.scrollHeight;
      await sleep(600);
    }
    collect();
    let tops = 0,
      len = loaded.size,
      grownAt = Date.now(),
      stalled = false,
      spinner = false;
    while (seen.size < count && Date.now() - t0 < maxMs && tops <= TOP_TRIES) {
      const s = sc();
      if (!s) break;
      s.scrollTop = Math.max(0, s.scrollTop - Math.round(s.clientHeight * 0.7));
      await sleep(s.scrollTop < 5 ? 1500 : 600);
      collect();
      const grew = loaded.size > len;
      if (grew) {
        len = loaded.size;
        grownAt = Date.now();
      }
      spinner = s.scrollTop < 5 && loadingTop(s);
      tops = s.scrollTop < 5 && !grew && !spinner ? tops + 1 : 0;
      if (Date.now() - grownAt > STALL) {
        stalled = true;
        break;
      }
    }
    return {
      seen: seen.size,
      top: tops > TOP_TRIES,
      stalled,
      spinner: stalled && spinner,
      ms: Date.now() - t0,
      people: [...pairs].map(([k, n]) => k.split('\u0000').concat(n)),
    };
  }
  /* scan: scroll back from the newest message until a STOP id (or, for a first run, FIRST.count messages, or the top of
     the chat), then settle reply parents. OPT: {base (numbers the warnings), stallMs (default 30 s), topMs (a test
     option: the top-of-chat wait, default 12 s)}. Stops with err "stalled" when nothing new loads for stallMs, so
     Claude retries instead of waiting on a hung scan. */
  async function mcScan(STOPS, FIRST, OPT) {
    STOPS = STOPS || [];
    OPT = OPT || {};
    const STALL = +OPT.stallMs || 30000;
    const TOP = topWait(OPT);
    sessionStorage.removeItem('__mcsave');
    for (let w = 0; w < 40; w++) {
      const l = document.querySelector('[role="log"]');
      if (l && l.getBoundingClientRect().width >= 300) break;
      await sleep(500);
    }
    window.__rf = {
      phase: 'collect',
      order: [],
      info: {},
      parents: {},
      done: false,
      err: null,
      steps: 0,
      t0: Date.now(),
    };
    await (async () => {
      const R = window.__rf;
      try {
        let LOG = null,
          SC = null;
        const log = () => {
          if (!LOG || !LOG.isConnected) LOG = document.querySelector('[role="log"]');
          return LOG;
        };
        const sc = () => {
          if (!SC || !SC.isConnected) {
            const f = mcScroller(log());
            SC = f && f.el;
            if (f) R.scroller = f.path;
          }
          return SC;
        };
        const dec = h => {
          try {
            const u = new URL(h, location.href);
            if (u.hostname === 'l.facebook.com') {
              const t = u.searchParams.get('u');
              if (t) {
                const x = new URL(t);
                x.searchParams.delete('fbclid');
                return x.toString();
              }
            }
            return u.toString();
          } catch (e) {
            return h;
          }
        };
        function photos(e) {
          const imgs = Array.from(
            e.querySelectorAll('a[href*="messenger_media"] img, [aria-label^="Open photo"] img'),
          ).filter(i => i.currentSrc && /fbcdn/.test(i.currentSrc));
          const big = imgs.filter(i => !(i.naturalWidth && i.naturalWidth <= 220 && i.naturalHeight <= 120));
          return {
            srcs: [...new Set(big.map(i => i.currentSrc))],
            tiles: photoTiles(e),
            gif: !!e.querySelector('img[alt="GIF Image"]') || (imgs.length > 0 && big.length === 0),
          };
        }
        function collect() {
          const ids = [];
          log()
            .querySelectorAll('[data-message-id]')
            .forEach(e => {
              const id = e.getAttribute('data-message-id');
              ids.push(id);
              const labels = Array.from(e.querySelectorAll('[aria-label]')).map(x => x.getAttribute('aria-label'));
              const prev = R.info[id];
              const text = e.innerText;
              const ph = photos(e);
              const av = avatar(e);
              if (!prev || text.length > prev.text.length)
                R.info[id] = {
                  label: e.getAttribute('aria-label') || '',
                  text,
                  reply: labels.includes('Go to replied message'),
                  rx: labels.filter(l => /reactions? with/.test(l)),
                  att: labels.filter(l => /^Open Attachment|^Open photo/i.test(l)),
                  links: [...new Set(Array.from(e.querySelectorAll('a[href]')).map(a => dec(a.getAttribute('href'))))],
                  ph: mergePh(prev && prev.ph, ph),
                  av: av || (prev && prev.av) || '',
                  vid: !!e.querySelector('video') || !!(prev && prev.vid),
                };
              else {
                prev.ph = mergePh(prev.ph, ph);
                if (av && !prev.av) prev.av = av;
              }
            });
          if (!ids.length) return;
          if (!R.order.length) {
            R.order = ids;
            return;
          }
          const set = new Set(R.order);
          const k = ids.findIndex(i => set.has(i));
          if (k < 0) {
            R.gap = (R.gap || 0) + 1;
            R.order = ids.concat(R.order);
            return;
          }
          R.order.splice(R.order.indexOf(ids[k]), 0, ...ids.slice(0, k));
          let pos = R.order.indexOf(ids[k]);
          for (let j = k + 1; j < ids.length; j++) {
            if (!set.has(ids[j])) R.order.splice(pos + 1, 0, ids[j]);
            pos = R.order.indexOf(ids[j]);
          }
        }
        for (let w = 0; w < 20 && !(log() && sc()); w++) await sleep(500);
        let s = sc();
        if (!s) throw new Error('no scrolling message list in the chat');
        for (let b = 0; b < 4; b++) {
          s = sc();
          s.scrollTop = s.scrollHeight;
          await sleep(700);
        }
        collect();
        const hit = () => {
          if (FIRST && FIRST.count) {
            if (R.order.length > FIRST.count) return R.order[R.order.length - FIRST.count - 1];
            return R.atTop ? '__top__' : null;
          }
          return STOPS.find(m => R.order.includes(m));
        };
        /* The top of the chat: the list stays at the top for TOP_TRIES steps and TOP_MS with nothing new and no
           loading spinner. A stall: nothing new for STALL, not at the top. */
        let extra = 0,
          tops = 0,
          topSince = 0,
          grownAt = Date.now(),
          len = R.order.length;
        for (let r = 0; r < 1500; r++) {
          if (hit()) {
            if (++extra > 2) break;
          }
          s = sc();
          const st = Math.round(s.clientHeight * 0.6);
          s.scrollTop = s.scrollTop > st ? s.scrollTop - st : 0;
          await sleep(s.scrollTop < 5 ? 1500 : 500);
          collect();
          R.steps++;
          const grew = R.order.length > len;
          if (grew) {
            len = R.order.length;
            grownAt = Date.now();
          }
          if (s.scrollTop < 5 && !grew && !loadingTop(s)) {
            if (!tops++) topSince = Date.now();
            if (tops > TOP.tries && Date.now() - topSince >= TOP.ms) {
              R.atTop = true;
              if (!FIRST) break;
            }
          } else tops = 0;
          if (!hit() && !R.atTop && Date.now() - grownAt > STALL) {
            R.stalled = true;
            R.spinner = s.scrollTop < 5 && loadingTop(s);
            break;
          }
        }
        R.tCollect = Date.now() - R.t0;
        const anchor = hit();
        if (!anchor) {
          /* top-spinner: at the top, a loading spinner stayed for stallMs and nothing loaded */
          R.err = R.stalled
            ? R.spinner
              ? 'top-spinner'
              : 'stalled'
            : FIRST
              ? 'Could not load enough history for the first catch-up'
              : 'None of the stored anchor messages was found while scrolling back' +
                (R.atTop ? ' (reached the top of the chat)' : '');
          R.done = true;
          return;
        }
        R.anchor = anchor;
        R.win = anchor === '__top__' ? R.order.slice() : R.order.slice(R.order.indexOf(anchor) + 1);
        /* B41: Messenger shows a sender's avatar once per group of messages, on the group's last message. So within a run
           of one shown name, each avatar names the messages from the end of the previous group up to itself, and no others:
           two people who share a shown name and post back to back each keep their own name. Messages after the run's last
           avatar get none. */
        for (let a = 0; a < R.order.length; ) {
          const who = nameOf((R.info[R.order[a]] || {}).label);
          let b = a + 1;
          while (b < R.order.length && nameOf((R.info[R.order[b]] || {}).label) === who) b++;
          if (who !== 'You' && AT.test((R.info[R.order[a]] || {}).label || '')) {
            let group = [];
            for (const id of R.order.slice(a, b)) {
              const m = R.info[id];
              if (!m) continue;
              group.push(m);
              if (!m.av) continue;
              group.forEach(g => {
                if (!g.av) g.avr = m.av;
              });
              group = [];
            }
          }
          a = b;
        }
        R.phase = 'replies';
        const reps = R.win.filter(id => R.info[id].reply);
        R.replyCount = reps.length;
        /* 1) quote match: a reply's quote must match exactly one earlier loaded message from the replied-to person (12+ chars) */
        const posOf = id => R.order.indexOf(id);
        for (const id of reps) {
          const m = R.info[id];
          const lines = m.text.split('\n');
          const rm = (lines[0] || '').match(/^(.*) replied to (.*)$/);
          if (!rm) continue;
          let who = rm[2];
          if (/^you$/i.test(who)) who = 'You';
          else if (/^(themself|themselves|himself|herself|yourself)$/i.test(who)) who = rm[1] === 'You' ? 'You' : rm[1];
          else if (/^participant$/i.test(who)) continue;
          const lab = m.label.replace(AT, '');
          const from = rm[1];
          const lb = lab.indexOf(from + ': ') === 0 ? lab.slice(from.length + 2) : '';
          const oi = m.text.indexOf('Original message:\n');
          if (oi < 0) continue;
          const r2 = m.text.slice(oi + 18);
          const bi = lb ? r2.lastIndexOf(lb.slice(0, Math.min(20, lb.length))) : -1;
          const qn = N(bi > 0 ? r2.slice(0, bi) : r2.split('\n')[0])
            .replace(/…$/, '')
            .trim();
          if (qn.length < 12) continue;
          const me = posOf(id);
          const c = R.order.slice(0, me).filter(o => {
            const a = ((R.info[o] || {}).label || '').replace(AT, '');
            return a.indexOf(who + ': ') === 0 && N(a.slice(who.length + 2)).indexOf(qn) === 0;
          });
          if (c.length === 1) {
            const L = R.info[c[0]].label;
            R.parents[id] = { p: c[0], pl: L.slice(0, 120), how: 'q' };
          }
        }
        R.quoteMatched = Object.keys(R.parents).length;
        /* 2) click only what the quotes couldn't settle */
        async function bring(id) {
          const want = posOf(id);
          for (let t = 0; t < 80; t++) {
            const e = log().querySelector('[data-message-id="' + CSS.escape(id) + '"]');
            if (e) {
              e.scrollIntoView({ block: 'center' });
              await sleep(200);
              return log().querySelector('[data-message-id="' + CSS.escape(id) + '"]') || e;
            }
            const els = log().querySelectorAll('[data-message-id]');
            const fi = els.length ? posOf(els[0].getAttribute('data-message-id')) : -1;
            s = sc();
            const st = Math.round(s.clientHeight * 0.8);
            if (fi < 0 || want < fi) s.scrollTop = Math.max(0, s.scrollTop - st);
            else s.scrollTop = s.scrollTop + st;
            await sleep(450);
            collect();
          }
          return null;
        }
        /* Click ONLY replies to a photo/attachment (no quoted text to match). Text replies are matched by Claude against the stored history. */
        const isPhotoReply = id => {
          const t = R.info[id].text || '';
          const oi = t.indexOf('Original message:\n');
          if (oi < 0) return true;
          const f = (t.slice(oi + 18).split('\n')[0] || '').trim();
          return !f || /^(Attachment|Photo|GIF|Video|Sticker)$/i.test(f);
        };
        R.photoReplies = reps.filter(isPhotoReply).length;
        /* A click on "Go to replied message" leaves the view at the parent, possibly far up the chat. Jump back to the
           bottom before the next reply (replies are in the recent window), instead of stepping down from up there. */
        let away = false;
        /* Who the reply is to, from its "X replied to Y" line: the focused parent must be theirs. A parent that loads late
           can take focus while the next reply is being clicked; this keeps that from becoming a wrong link. null = the
           line can't be read (then nothing is linked); {any:true} = "a participant" (anyone; Messenger doesn't say). */
        const repliedTo = id => {
          const rm = ((R.info[id].text || '').split('\n')[0] || '').match(/^(.*) replied to (.*)$/);
          if (!rm) return null;
          if (/^participant$/i.test(rm[2])) return { any: true };
          if (/^you$/i.test(rm[2])) return { who: 'You' };
          if (/^(themself|themselves|himself|herself|yourself)$/i.test(rm[2]))
            return { who: rm[1] === 'You' ? 'You' : rm[1] };
          return { who: rm[2] };
        };
        for (const id of reps.slice().reverse()) {
          if (R.parents[id]) continue;
          const want = repliedTo(id);
          if (!want) {
            R.parents[id] = { err: 'noreplyline' };
            continue;
          }
          if (!isPhotoReply(id)) continue;
          if (away) {
            for (let b = 0; b < 3; b++) {
              s = sc();
              s.scrollTop = s.scrollHeight;
              await sleep(400);
            }
            away = false;
          }
          const e = await bring(id);
          if (!e) {
            R.parents[id] = { err: 'notfound' };
            continue;
          }
          const b = e.querySelector('[aria-label="Go to replied message"]');
          if (!b) {
            R.parents[id] = { err: 'nobtn' };
            continue;
          }
          if (document.activeElement) document.activeElement.blur();
          b.click();
          away = true;
          let got = null;
          for (let t = 0; t < 40; t++) {
            /* up to 10 s: a parent far up takes Messenger a few seconds to load */
            await sleep(250);
            const a = document.activeElement;
            const am = a && a.closest && a.closest('[data-message-id]');
            if (am && am.getAttribute('data-message-id') !== id) {
              got = am;
              break;
            }
          }
          const from = got ? nameOf(got.getAttribute('aria-label')) : '';
          const theirs =
            want.any || from === want.who || from.startsWith(want.who + ' ') || want.who.startsWith(from + ' ');
          if (!got) R.parents[id] = { err: 'nofocus' };
          else if (!theirs) R.parents[id] = { err: 'wrongfocus' };
          else
            R.parents[id] = {
              p: got.getAttribute('data-message-id'),
              pl: (got.getAttribute('aria-label') || '').slice(0, 120),
            };
          R.steps++;
        }
        R.tReplies = Date.now() - R.t0;
        /* Warnings: what the reader may have read wrong, for the refresh report (R3). */
        const ref = k => (OPT.base != null ? '#' + (+OPT.base + 1 + k) : 'new message ' + (k + 1));
        const W = [];
        const lang = document.documentElement.lang || '';
        if (lang && !/^en\b/i.test(lang)) W.push(LANG(lang));
        const wins = R.win.map(id => R.info[id]);
        const whens = wins.map(m => (m.label.match(AT) || [])[1] || '');
        const timed = whens.filter(Boolean);
        if (timed.length && timed.filter(w => !/[AaPp][Mm]$/.test(w)).length > timed.length / 2) W.push(CLOCK24);
        W.push(...replyWarn(wins.map((m, k) => ({ text: m.text, reply: m.reply, ref: ref(k) }))));
        const noImg = [];
        wins.forEach((m, k) => {
          if (m.links.some(l => /messenger_media/.test(l)) && !m.ph.srcs.length && !m.ph.gif && !m.vid)
            noImg.push(ref(k));
        });
        if (noImg.length)
          W.push(
            noImg.length +
              ' photo link(s) with no Facebook image (' +
              refList(noImg) +
              "): those photos are missing from the capture. Messenger's photo markup may have changed",
          );
        const seq = [];
        if (anchor !== '__top__' && R.info[anchor]) {
          const aw = (R.info[anchor].label.match(AT) || [])[1];
          if (aw) seq.push({ when: aw, ref: FIRST ? 'the message before them' : 'the last stored message' });
        }
        whens.forEach((w, k) => seq.push({ when: w, ref: ref(k) }));
        W.push(...timeWarn(seq, new Date()));
        const others = wins.filter(m => AT.test(m.label) && nameOf(m.label) !== 'You');
        W.push(...nameWarn(others.map(m => [nameOf(m.label), m.av || m.avr])));
        if (others.length >= 3 && !others.some(m => m.av || m.avr))
          W.push(
            'no full names: none of the ' + others.length + ' new messages from others had an avatar to read (fn)',
          );
        R.warn = W;
        sessionStorage.setItem(
          '__mcsave',
          JSON.stringify({
            win: R.win,
            info: Object.fromEntries(
              R.win
                .concat(
                  Object.values(R.parents)
                    .map(p => p.p)
                    .filter(Boolean),
                )
                .map(id => [id, R.info[id]])
                .filter(x => x[1]),
            ),
            parents: R.parents,
            anchor: R.anchor,
            replyCount: R.replyCount,
          }),
        );
        R.phase = 'done';
      } catch (e) {
        R.err = String((e && e.stack) || e);
      }
      R.done = true;
    })();
    const R = window.__rf;
    return {
      err: R.err,
      anchor: R.anchor || null,
      win: R.win ? R.win.length : 0,
      reps: R.replyCount || 0,
      qm: R.quoteMatched || 0,
      gap: R.gap || 0,
      perr: Object.values(R.parents || {}).filter(p => p.err).length,
      photoReplies: R.photoReplies || 0,
      top: !!R.atTop,
      stalled: !!R.stalled,
      scroller: R.scroller || null,
      warn: R.warn || [],
      ms: Date.now() - R.t0,
      labels: (R.win || []).slice(-40).map(id => (R.info[id].label || '').slice(0, 90)),
    };
  }
  async function mcVerify(OPT) {
    const STALL = +((OPT && OPT.stallMs) || 30000);
    const TOPW = topWait(OPT);
    window.__v = { order: [], done: false, err: null, gap: 0 };
    await (async () => {
      const V = window.__v;
      try {
        const S = JSON.parse(sessionStorage.getItem('__mcsave'));
        const anchor = S.anchor;
        let LOG = null,
          SC = null;
        const log = () => {
          if (!LOG || !LOG.isConnected) LOG = document.querySelector('[role="log"]');
          return LOG;
        };
        const sc = () => {
          if (!SC || !SC.isConnected) SC = (mcScroller(log()) || {}).el;
          return SC;
        };
        function collect() {
          const ids = [...log().querySelectorAll('[data-message-id]')].map(e => e.getAttribute('data-message-id'));
          if (!ids.length) return;
          if (!V.order.length) {
            V.order = ids;
            return;
          }
          const set = new Set(V.order);
          const k = ids.findIndex(i => set.has(i));
          if (k < 0) {
            V.gap++;
            V.order = ids.concat(V.order);
            return;
          }
          V.order.splice(V.order.indexOf(ids[k]), 0, ...ids.slice(0, k));
          let pos = V.order.indexOf(ids[k]);
          for (let j = k + 1; j < ids.length; j++) {
            if (!set.has(ids[j])) V.order.splice(pos + 1, 0, ids[j]);
            pos = V.order.indexOf(ids[j]);
          }
        }
        async function pass(frac, ms) {
          V.order = [];
          V.gap = 0;
          const TOP = anchor === '__top__';
          let tops = 0,
            topSince = 0,
            atTop = false,
            len = 0,
            grownAt = Date.now();
          let s = sc();
          for (let b = 0; b < 4; b++) {
            s = sc();
            s.scrollTop = s.scrollHeight;
            await sleep(600);
          }
          collect();
          let extra = 0;
          for (let r = 0; r < 1500; r++) {
            if (TOP ? atTop : V.order.includes(anchor)) {
              if (++extra > 2) break;
            }
            s = sc();
            const st = Math.round(s.clientHeight * frac);
            s.scrollTop = s.scrollTop > st ? s.scrollTop - st : 0;
            await sleep(s.scrollTop < 5 ? 1500 : ms);
            collect();
            const grew = V.order.length > len;
            if (grew) {
              len = V.order.length;
              grownAt = Date.now();
            }
            if (s.scrollTop < 5 && !grew && !loadingTop(s)) {
              if (!tops++) topSince = Date.now();
              if (tops > TOPW.tries && Date.now() - topSince >= TOPW.ms) atTop = true;
            } else tops = 0;
            if (!(TOP ? atTop : V.order.includes(anchor)) && Date.now() - grownAt > STALL) {
              V.stalled = true;
              V.spinner = s.scrollTop < 5 && loadingTop(s);
              break;
            }
          }
          if (TOP ? !atTop : !V.order.includes(anchor)) return false;
          const w = TOP ? V.order.slice() : V.order.slice(V.order.indexOf(anchor) + 1);
          V.win = w;
          V.prefixSame = JSON.stringify(w.slice(0, S.win.length)) === JSON.stringify(S.win);
          V.extra = w.length - S.win.length;
          return V.gap === 0 && V.prefixSame;
        }
        for (let w = 0; w < 20 && !(log() && sc()); w++) await sleep(500);
        V.mode = 'fast';
        let ok = await pass(0.6, 500);
        if (!ok && !V.stalled) {
          /* a slower pass helps when Messenger skipped content, not when it stopped loading */
          V.mode = 'slow';
          ok = await pass(0.35, 900);
        }
        V.ok = ok;
        if (!ok && V.stalled) V.err = V.spinner ? 'top-spinner' : 'stalled';
        else if (!ok && anchor !== '__top__' && !V.order.includes(anchor)) V.err = 'anchor not found';
      } catch (e) {
        V.err = String(e);
      }
      V.done = true;
    })();
    const X = window.__v;
    return {
      ok: !!X.ok,
      gap: X.gap,
      prefixSame: !!X.prefixSame,
      extra: X.extra,
      err: X.err,
      win: X.win ? X.win.length : 0,
      mode: X.mode,
    };
  }
  /* capture: the window's messages and photos. OPT.skip (helper 2.1, references/photos.md › Backfill) = {"<i>": [k or
     "aid", ...]}: photos the page already holds, never fetched. Each photo is {i, k, aid?, type, b64}: k is its tile's
     place in the message, aid its attachment id. phfail lists the photos it couldn't get ({i, k, aid?, e}: e "fetch",
     or "unloaded" when the image never loaded), so the page keeps them owed and a later run retries them (R15); phskip
     lists the photos skipped. */
  async function mcCapture(BASE, OPT) {
    return await (async () => {
      const R = JSON.parse(sessionStorage.getItem('__mcsave'));
      const now = new Date();
      const todayD = mcDate('12:00', now);
      const guessed = [];
      let lastD = null;
      const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const pos = new Map(R.win.map((id, k) => [id, BASE + 1 + k]));
      const firsts = Object.values(R.info).map(x => x.text.split('\n')[0]);
      const out = R.win.map((id, k) => {
        const m = R.info[id];
        const lab = m.label;
        const wm = lab.match(AT);
        const when = wm ? wm[1] : '';
        const after = wm ? lab.slice(wm[0].length) : '';
        const lines = m.text.split('\n');
        const first = lines[0] || '';
        let from = '',
          rTo = '';
        const rm = m.reply
          ? first.match(/^(.*) replied to (.*)$/)
          : null; /* only a real reply (it has a reply link): message text can say "X replied to Y" too */
        if (rm) {
          from = rm[1];
          rTo = rm[2];
        } else if (first && (after === first || after.indexOf(first + ': ') === 0)) from = first;
        else from = firsts.find(c => c && (after === c || after.indexOf(c + ': ') === 0)) || after.split(': ')[0];
        if (
          /^You\b/.test(after) ||
          (rm && rm[1] === 'You') ||
          /^You sent (a photo|\d+ photos|an attachment|a GIF|a sticker|a video|a voice message)\.?$/.test(first)
        )
          from = 'You'; /* own status lines only, never a message that starts "You sent…" */
        const lb = after.indexOf(from + ': ') === 0 ? after.slice(from.length + 2) : '';
        let j = 0;
        if (rm) {
          j = 1;
          if (lines[1] === 'Original message:') {
            if (lb) {
              const key = N(lb).slice(0, 20);
              const rest = lines.slice(2);
              let f = -1;
              for (let t = rest.length - 1; t >= 0; t--) {
                if (N(rest.slice(t).join(' ')).indexOf(key) === 0) {
                  f = t;
                  break;
                }
              }
              j = f >= 0 ? 2 + f : 3;
            } else {
              let t2 = 2;
              while (t2 < lines.length && !/…$/.test(lines[t2])) t2++;
              j = t2 < lines.length ? t2 + 1 : 3;
            }
          }
        } else if (lines[0] === from) j = 1;
        const body = lines.slice(j);
        while (
          body.length &&
          (/^\d+$/.test(body[body.length - 1].trim()) ||
            /^(Sent \d+[smhd] ago|Sent|Seen|Delivered)$/.test(body[body.length - 1].trim()))
        )
          body.pop();
        let bt = body
          .join('\n')
          .trim()
          .replace(/^(?:·\s*\n)?Edited\n/, '')
          .trim();
        if (/^(GIPHY|Edited|·)$/.test(N(bt))) bt = '';
        const a =
          m.att.filter(x => /^Open Attachment, /.test(x)).map(x => x.replace(/^Open Attachment, /, ''))[0] || '';
        let b;
        if (a && !lb) b = '';
        else if (lb && N(bt).indexOf(N(lb)) === 0) b = bt;
        else if (lb) b = lb;
        else b = bt;
        if (a && lb && N(b) !== N(lb)) b = lb;
        {
          const del = lines
            .map(x => x.trim())
            .find(x =>
              /^(?:You|.+?) (?:deleted|unsent|removed) a message\.?$/.test(x),
            ); /* Messenger's own line, alone; never a message that merely says it */
          if (del && !lines.some(x => x.trim() && x.trim() !== del && x.trim() !== from)) b = '(deleted a message)';
        }
        let q = '';
        const oi = m.text.indexOf('Original message:\n');
        if (oi >= 0) {
          const r2 = m.text.slice(oi + 18);
          const bi = b ? r2.lastIndexOf(b.slice(0, Math.min(20, b.length))) : -1;
          q = (bi > 0 ? r2.slice(0, bi) : r2.split('\n')[0]).trim();
        }
        const media = m.links.find(l => /messenger_media/.test(l)) || '';
        const pm = media.match(/attachment_id=(\d+)/);
        const ext = m.links
          .filter(l => !/messenger_media|l\.facebook|facebook\.com\/share\//.test(l))
          .map(l =>
            l
              .replace(/[?&](utm_[^&]+|srtk=[^&]+|fs=e|s=m|ref=[^&]+|fbclid=[^&]+)/g, '')
              .replace(/\?&/, '?')
              .replace(/[?&]$/, '')
              .replace(/^([^?#]*)&/, '$1?'),
          );
        let dd = mcDate(when, now);
        if (!dd) {
          guessed.push(BASE + 1 + k);
          dd = lastD || todayD;
        }
        lastD = dd; /* unreadable label: borrow the previous message's date */
        const mn = mcMinutes(when);
        const tm =
          mn == null
            ? '12:00 AM'
            : (Math.floor(mn / 60) % 12 || 12) +
              ':' +
              String(mn % 60).padStart(2, '0') +
              ' ' +
              (mn < 720 ? 'AM' : 'PM');
        const wd = D[new Date(dd + 'T12:00:00').getDay()];
        const o = { i: BASE + 1 + k, t: wd + ' ' + tm, f: from, b, m: id, d: dd };
        if (rTo) o.r = rTo;
        const fn = m.av || m.avr;
        if (fn && from !== 'You') o.fn = fn;
        if (q) o.q = q.slice(0, 160);
        if (m.rx.length)
          o.x = m.rx
            .map(r => r.replace(/; see who reacted to this\.?/, '').replace(/ reactions? with /, ' '))
            .join('; ');
        if (ext.length) o.l = [...new Set(ext)];
        if (a) o.a = a.slice(0, 220);
        if (pm) o.p = pm[1];
        const pr = R.parents[id];
        if (pr) {
          if (pr.p && pos.has(pr.p)) {
            o.pi = pos.get(pr.p);
            if (pr.how === 'q') o.pq = 1;
          } else if (pr.p) {
            o.pmid = pr.p;
            o.pl = pr.pl;
            if (pr.how === 'q') o.pq = 1;
          } else o.perr = pr.err;
        }
        return o;
      });
      const sha = async t => {
        const dg = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
        return [...new Uint8Array(dg)].map(x => x.toString(16).padStart(2, '0')).join('');
      };
      const b64 = blob =>
        new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result).split(',')[1]);
          fr.onerror = rej;
          fr.readAsDataURL(blob);
        });
      const photos = [];
      const gifs = [];
      const failed = [];
      const phfail = [];
      const phskip = [];
      const SKIP = (OPT && OPT.skip) || {};
      for (const [k, id] of R.win.entries()) {
        const m = R.info[id];
        if (!m || !m.ph) continue;
        const i = BASE + 1 + k;
        const tiles = m.ph.tiles || m.ph.srcs.map(u => ({ u, aid: '' }));
        if (!tiles.length) {
          if (m.ph.gif) gifs.push(i);
          continue;
        }
        const sk = Array.isArray(SKIP[i]) ? SKIP[i] : [];
        for (const [j, t] of tiles.entries()) {
          const at = t.aid ? { i, k: j, aid: t.aid } : { i, k: j };
          if (sk.some(x => x === j || (t.aid && x === t.aid))) {
            phskip.push(at);
            continue;
          }
          if (!t.u) {
            failed.push(i);
            phfail.push(Object.assign({}, at, { e: 'unloaded' }));
            continue;
          }
          try {
            const r = await fetch(t.u);
            const bl = await r.blob();
            if (!/^image\/(jpeg|png|webp|gif)$/.test(bl.type)) throw bl.type;
            photos.push(Object.assign({}, at, { type: bl.type, b64: await b64(bl) }));
          } catch (e) {
            failed.push(i);
            phfail.push(Object.assign({}, at, { e: 'fetch' }));
          }
        }
      }
      const msgsTxt = JSON.stringify(out);
      const cap = {
        kind: 'mc-capture',
        base: BASE,
        anchor: R.anchor,
        count: out.length,
        sha: await sha(msgsTxt),
        msgs: out,
        gifs,
        photos,
        phsha: await sha(JSON.stringify(photos)),
        phfail,
        phskip,
      };
      const text = JSON.stringify(cap);
      window.__capText = text;
      document.body.innerHTML = '';
      const bt = document.createElement('button');
      bt.id = '__copy';
      bt.textContent = 'COPY CAPTURE';
      bt.style.cssText =
        'position:fixed;left:16px;top:16px;width:260px;height:56px;font:700 18px system-ui;z-index:2147483647;background:#0a7;color:#fff;border:0;border-radius:8px';
      const st = document.createElement('div');
      st.id = '__copyst';
      st.style.cssText = 'position:fixed;left:300px;top:30px;font:16px system-ui;z-index:2147483647';
      bt.onclick = async () => {
        try {
          await navigator.clipboard.writeText(text);
          st.textContent = 'COPIED ' + text.length + ' chars';
        } catch (e) {
          st.textContent = 'COPY FAILED: ' + e;
        }
      };
      const art = document.createElement('article');
      art.style.marginTop = '90px';
      const pre = document.createElement('pre');
      pre.style.whiteSpace = 'pre-wrap';
      pre.textContent = msgsTxt;
      art.append(pre);
      document.body.append(bt, st, art);
      return (
        'count ' +
        out.length +
        ' len ' +
        text.length +
        ' sha ' +
        cap.sha.slice(0, 8) +
        ' photos ' +
        photos.length +
        (failed.length ? ' FAILED ' + failed : '') +
        (phskip.length ? ' skipped ' + phskip.length : '') +
        ' gifs ' +
        gifs +
        ' you ' +
        out.filter(o => o.f === 'You').map(o => o.i) +
        (guessed.length ? ' DATES-GUESSED ' + guessed : '')
      );
    })();
  }
  function jump() {
    (async function mcJump() {
      var h = location.hash.match(/mcjump=([^&]+)/);
      if (!h) return;
      var mid = decodeURIComponent(h[1]);
      var wantReply = !/noreply/.test(location.hash);
      if (window.__mcJumping === mid) return;
      window.__mcJumping = mid;
      window.__mcJumpAt = Date.now();
      window.__mcJumpRes = { mid: mid, state: 'running' };
      var sleep = function (ms) {
        return new Promise(function (r) {
          setTimeout(r, ms);
        });
      };
      var tip = document.getElementById('mcjump-tip');
      if (!tip) {
        tip = document.createElement('div');
        tip.id = 'mcjump-tip';
        tip.style.cssText =
          'position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:2147483647;background:#1f5fd6;color:#fff;font:600 14px system-ui;padding:8px 14px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.3)';
        document.body.appendChild(tip);
      }
      var say = function (t) {
        tip.textContent = t;
        tip.style.display = 'block';
      };
      /* The outcome, for the helper's post command: ready (Reply is open), found (no Reply), notfound or noload. */
      var done = function (state, via) {
        window.__mcJumpRes = { mid: mid, state: state, via: via || null, tip: tip.textContent };
      };
      say('Jump: finding the message…');
      var log = function () {
        return document.querySelector('[role="log"]');
      };
      for (var w = 0; w < 60 && !(log() && log().getBoundingClientRect().width >= 300); w++) await sleep(250);
      if (!log()) {
        say('Jump: chat not loaded.');
        done('noload');
        window.__mcJumping = null;
        return;
      }
      /* The scrolling list: the nearest scrollable ancestor of a message that holds (nearly) all of the log's messages,
         else the first scrollable element in the log. */
      var sc = function () {
        var can = function (x) {
          return /(auto|scroll)/.test(getComputedStyle(x).overflowY) && x.scrollHeight > x.clientHeight;
        };
        var all = log().querySelectorAll('[data-message-id]').length;
        var m = log().querySelector('[data-message-id]');
        for (var x = m && m.parentElement; x && x !== document.body; x = x.parentElement)
          if (can(x) && x.querySelectorAll('[data-message-id]').length >= Math.max(1, all * 0.9)) return x;
        return Array.prototype.find.call(log().querySelectorAll('div'), can);
      };
      var find = function () {
        return log().querySelector('[data-message-id="' + CSS.escape(mid) + '"]');
      };
      var e = find(),
        n = 0,
        top = 0;
      if (!e) {
        for (var bb = 0; bb < 5; bb++) {
          var s0 = sc();
          if (s0) s0.scrollTop = s0.scrollHeight;
          await sleep(600);
        }
        e = find();
      }
      while (!e && n < 600) {
        var s = sc();
        if (!s) break;
        s.scrollTop = Math.max(0, s.scrollTop - Math.round(s.clientHeight * 0.9));
        if (s.scrollTop < 5) {
          top++;
          if (top > 12) break;
        } else top = 0;
        await sleep(s.scrollTop < 5 ? 1200 : 350);
        n++;
        if (n % 10 === 0) say('Jump: scrolling back… (' + n + ')');
        e = find();
      }
      if (!e) {
        say('Jump: couldn’t find that message.');
        done('notfound');
        window.__mcJumping = null;
        setTimeout(function () {
          tip.style.display = 'none';
        }, 6000);
        return;
      }
      e.scrollIntoView({ block: 'center' });
      await sleep(400);
      e = find();
      e.style.outline = '3px solid #f5b400';
      e.style.borderRadius = '10px';
      setTimeout(function () {
        var x = find();
        if (x) x.style.outline = '';
      }, 8000);
      if (wantReply) {
        /* The message's own toolbar: in the message, or in wrappers around it that hold no other message. */
        var own = e;
        for (var up = 0; up < 4 && own.parentElement; up++) {
          if (own.parentElement.querySelectorAll('[data-message-id]').length > 1) break;
          own = own.parentElement;
        }
        ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove'].forEach(function (t) {
          e.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
        });
        var b = null,
          via = 'button';
        for (var k = 0; k < 10 && !b; k++) {
          await sleep(150);
          b = own.querySelector('[aria-label="Reply to this message"]');
        }
        if (!b) {
          /* A photo-only message has no Reply button on its toolbar: Reply is in its More actions menu. */
          var more = own.querySelector('[aria-label="More actions"]');
          if (more) {
            via = 'menu';
            /* Only the menu this click opens counts: a menu left open elsewhere must never be used. */
            var before = Array.prototype.slice.call(document.querySelectorAll('[role="menu"]'));
            var menu = null;
            more.click();
            for (var j = 0; j < 14 && !b; j++) {
              await sleep(150);
              menu =
                menu ||
                Array.prototype.find.call(document.querySelectorAll('[role="menu"]'), function (x) {
                  return before.indexOf(x) < 0;
                }) ||
                null;
              if (menu)
                b =
                  Array.prototype.find.call(menu.querySelectorAll('[role="menuitem"]'), function (x) {
                    return (x.innerText || '').trim() === 'Reply' && x.getBoundingClientRect().height > 0;
                  }) || null;
            }
            if (!b) {
              /* No Reply in it: close the menu (Escape, then a click outside it) */
              var esc = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true };
              if (menu) menu.dispatchEvent(new KeyboardEvent('keydown', esc));
              document.dispatchEvent(new KeyboardEvent('keydown', esc));
              await sleep(200);
              if (menu && menu.isConnected && menu.getBoundingClientRect().height > 0) {
                document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, view: window }));
                document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, view: window }));
                await sleep(200);
              }
            }
          }
        }
        if (b) {
          b.click();
          say('Jump: reply box is ready. Type and press Enter.');
          done('ready', via);
        } else {
          say('Jump: found it (hover it and click Reply).');
          done('found');
        }
      } else {
        say('Jump: found it.');
        done('found');
      }
      history.replaceState(null, '', location.pathname + location.search);
      window.__mcJumping = null;
      setTimeout(function () {
        tip.style.display = 'none';
      }, 5000);
    })();
  }
  /* post{mid,to,snip,text,helperPost}: sends one approved reply, and only when the user turned helper posting on
     (meta/chat.helperPost, which Claude passes as helperPost:true). Only this bridge command reaches it: no link, URL hash
     or page can. It opens Reply on the message (jump, with the More actions fallback), checks that the "Replying to" bar
     names `to` and shows `snip`, checks that the box is empty, types the text (shift+Enter between lines), checks the bar
     again, presses Enter, and waits up to 15 s for the message to appear.
     Returns {sent:true, mid, at}, or {sent:false, err, stage, entered, detail}. err "unconfirmed" means some or all of the
     reply may have gone out, so the row must stay sending. Every other err means the helper checked that nothing was sent:
     no new message from you appeared and the box still held what was typed. entered: an Enter or shift+Enter was pressed.
     Before each key it records its stage in the command's result ({running:true, stage}) and in sessionStorage mc_post,
     so a result that never arrives can be told apart. After a refusal it cancels the reply bar it opened (barClosed). */
  async function mcPost(a, id) {
    a = a || {};
    const t0 = Date.now();
    const out = o => Object.assign({ sent: false, entered: false, ms: Date.now() - t0 }, o);
    if (a.helperPost !== true)
      return out({
        err: 'not-opted-in',
        stage: 'optin',
        detail: 'helper posting is off (meta/chat.helperPost): post by references/outbox.md instead',
      });
    if (![a.mid, a.to, a.text].every(x => typeof x === 'string' && x.trim()) || (a.snip && typeof a.snip !== 'string'))
      return out({ err: 'bad-args', stage: 'args', detail: 'post needs mid, to and text (strings), and snip' });
    if (window.__mcPosting)
      return out({
        err: 'post-running',
        stage: 'args',
        detail: 'another post (' + window.__mcPosting + ') is still running in this tab: never start a second one',
      });
    if (window.__rf && !window.__rf.done)
      return out({ err: 'scan-running', stage: 'args', detail: 'a scan is running in this tab' });
    if (window.__mcJumping && Date.now() - (window.__mcJumpAt || 0) < 300000)
      return out({ err: 'jump-running', stage: 'args', detail: 'a jump (a Reply link) is running in this tab' });
    window.__mcPosting = a.mid;
    try {
      return await postOne(a, out, t0, id);
    } finally {
      window.__mcPosting = null;
    }
  }
  async function postOne(a, out, t0, id) {
    const box = () => document.querySelector('[role="textbox"][contenteditable="true"]');
    const lines = s =>
      String(s || '')
        .split('\n')
        .map(N)
        .filter(Boolean);
    const same = (x, y) => JSON.stringify(lines(x)) === JSON.stringify(lines(y));
    const press = (el, o) => {
      o = Object.assign({ bubbles: true, cancelable: true }, o);
      el.dispatchEvent(new KeyboardEvent('keydown', o));
      el.dispatchEvent(new KeyboardEvent('keyup', o));
    };
    const key = (el, shift) => press(el, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, shiftKey: shift });
    /* Messenger's editor (Lexical) undoes DOM edits it didn't make, so the box is cleared with keys: select all
       (ctrl+A, or cmd+A on a Mac), then Backspace. Lexical also needs a moment after focus before it takes input. */
    const clear = async el => {
      el.focus();
      await sleep(120);
      press(el, { key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true });
      press(el, { key: 'a', code: 'KeyA', keyCode: 65, metaKey: true });
      press(el, { key: 'Backspace', code: 'Backspace', keyCode: 8 });
      await sleep(150);
    };
    const mark = stage => {
      const st = { running: true, stage, entered: stage === 'typing' || stage === 'enter', mid: a.mid };
      if (id) sessionStorage.setItem('mc_res_' + id, JSON.stringify(st));
      sessionStorage.setItem('mc_post', JSON.stringify({ mid: a.mid, stage, at: Date.now() }));
    };
    /* The "Replying to …" bar: it must name `to` (the first name; "yourself" for You) and show the start of `snip`. */
    const who = a.to === 'You' ? 'yourself' : a.to.split(' ')[0];
    const snip = N(a.snip);
    const barOk = () => {
      const t = document.body.innerText;
      const k = t.lastIndexOf('Replying to ' + who);
      return k >= 0 && (!snip || snip === '[photo]' || N(t.slice(k, k + 300)).indexOf(snip.slice(0, 20)) >= 0);
    };
    const barEl = () => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n,
        found = null;
      while ((n = w.nextNode()))
        if (
          /^\s*Replying to /.test(n.nodeValue) &&
          !n.parentElement.closest('[role="log"]') &&
          n.parentElement.getClientRects().length
        )
          found = n.parentElement;
      return found;
    };
    /* Cancel the reply bar this post opened: its own cancel button (a label about the reply), else Escape in the box. */
    const closeBar = async () => {
      const b = barEl();
      if (!b) return true;
      for (
        let x = b, up = 0;
        x && up < 4 && x !== document.body && !x.closest('[role="log"]');
        x = x.parentElement, up++
      ) {
        const c = Array.from(x.querySelectorAll('[aria-label]')).find(e =>
          /^(cancel|close|remove|stop)\b.*\brepl/i.test(e.getAttribute('aria-label')),
        );
        if (c) {
          c.click();
          break;
        }
      }
      await sleep(250);
      if (barEl() && box()) {
        press(box(), { key: 'Escape', code: 'Escape', keyCode: 27 });
        await sleep(250);
      }
      return !barEl();
    };
    const refuse = async o => out(Object.assign({ barClosed: await closeBar() }, o));
    const ids = () =>
      Array.from(document.querySelectorAll('[role="log"] [data-message-id]')).map(e =>
        e.getAttribute('data-message-id'),
      );
    if (!box())
      return out({ err: 'no-box', stage: 'check', detail: 'no message box ([role="textbox"][contenteditable])' });
    if (N(box().innerText))
      return out({
        err: 'box-not-empty',
        stage: 'check',
        detail: "the message box already holds text (the user's draft), left as it is",
      });
    mark('jump');
    window.__mcJumpRes = null;
    history.replaceState(null, '', location.pathname + location.search + '#mcjump=' + encodeURIComponent(a.mid));
    jump();
    let j = null;
    for (let k = 0; k < 1000; k++) {
      await sleep(250);
      j = window.__mcJumpRes;
      if (j && j.mid === a.mid && j.state !== 'running') break;
    }
    if (!j || j.state !== 'ready')
      return refuse({ err: 'jump-failed', stage: 'jump', detail: (j && j.tip) || 'the jump did not finish' });
    await sleep(300);
    if (!barOk())
      return refuse({
        err: 'wrong-reply-target',
        stage: 'check',
        via: j.via,
        detail: 'the "Replying to ' + who + '" bar is missing or shows another message',
      });
    if (!box() || N(box().innerText))
      return refuse({ err: 'box-not-empty', stage: 'check', detail: 'the message box already holds text' });
    /* From here on, anything new from you in the chat means some of the reply went out. */
    const before = new Set(ids());
    const mine = () =>
      Array.from(document.querySelectorAll('[role="log"] [data-message-id]')).filter(e => {
        if (before.has(e.getAttribute('data-message-id'))) return false;
        return nameOf(e.getAttribute('aria-label')) === 'You' || /^You replied to /.test(e.innerText || '');
      });
    const match = () => {
      const want = lines(a.text);
      return mine()
        .reverse()
        .find(e => {
          const body = N((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || ''));
          return want.every(x => body.includes(x));
        });
    };
    const maybeSent = (stage, entered, detail) =>
      out({ err: 'unconfirmed', stage, entered, partial: true, detail: detail + ': leave the row sending' });
    box().focus();
    await sleep(120);
    const parts = a.text.replace(/\r\n?/g, '\n').split('\n');
    let entered = false,
      typed = '';
    for (let p = 0; p < parts.length; p++) {
      if (p) {
        mark('typing');
        entered = true;
        key(box(), true);
        await sleep(150);
        /* If Messenger took this shift+Enter as Enter, it sent what was typed: the box lost the text, or a new message
           from you shows up. Stop typing; part of the reply may be out. */
        if (mine().length || !box() || !same(box().innerText, typed))
          return maybeSent('typing', true, 'a scripted shift+Enter may have sent the first line(s)');
      }
      if (parts[p]) document.execCommand('insertText', false, parts[p]);
      typed += (p ? '\n' : '') + parts[p];
      await sleep(40);
    }
    await sleep(200);
    /* Before reporting "nothing sent", wait a moment and make sure nothing new from you appeared. */
    const quiet = async () => {
      await sleep(1200);
      return !mine().length;
    };
    if (!box() || !same(box().innerText, a.text)) {
      const now = box() ? box().innerText : '';
      if (!(await quiet())) return maybeSent('type', entered, 'a message from you appeared while typing');
      const bare = s => String(s || '').replace(/\s+/g, '');
      const err = bare(now) === bare(a.text) ? 'linebreak-not-accepted' : 'type-mismatch';
      if (box()) await clear(box());
      return refuse({
        err,
        stage: 'type',
        entered,
        cleared: !box() || !N(box().innerText),
        detail: 'the box did not hold the reply as queued; nothing was sent',
      });
    }
    /* Just before Enter: the bar must still point at this message (a Reply link followed meanwhile moves it). */
    if (!barOk()) {
      if (!(await quiet())) return maybeSent('type', entered, 'a message from you appeared while typing');
      if (box()) await clear(box());
      return refuse({
        err: 'wrong-reply-target',
        stage: 'enter',
        entered,
        cleared: !box() || !N(box().innerText),
        detail: 'the reply bar moved to another message while typing; nothing was sent',
      });
    }
    mark('enter');
    key(box(), false);
    for (let w = 0; w < 60; w++) {
      await sleep(250);
      const el = match();
      if (el && (!box() || !N(box().innerText)))
        return {
          sent: true,
          mid: el.getAttribute('data-message-id'),
          at: new Date().toISOString(),
          entered: true,
          via: j.via,
          ms: Date.now() - t0,
        };
    }
    const el = match();
    if (el)
      return {
        sent: true,
        mid: el.getAttribute('data-message-id'),
        at: new Date().toISOString(),
        entered: true,
        via: j.via,
        boxLeft: true,
        ms: Date.now() - t0,
      };
    if (box() && same(box().innerText, a.text) && !mine().length)
      return out({
        err: 'enter-not-accepted',
        stage: 'enter',
        entered: true,
        held: true,
        detail:
          'the box still holds the whole reply with Reply open, and no new message from you appeared: Enter was not accepted',
      });
    return out({
      err: 'unconfirmed',
      stage: 'confirm',
      entered: true,
      detail: 'the reply may have been sent but did not show up within 15 s: leave the row sending',
    });
  }
  async function probe(anchor) {
    var sleep = function (ms) {
      return new Promise(function (r) {
        setTimeout(r, ms);
      });
    };
    for (var w = 0; w < 60; w++) {
      var l = document.querySelector('[role="log"]');
      if (l && l.getBoundingClientRect().width >= 300) break;
      await sleep(250);
    }
    await sleep(2500);
    var ids = [].map.call(document.querySelectorAll('[role="log"] [data-message-id]'), function (e) {
      return e.getAttribute('data-message-id');
    });
    var k = ids.indexOf(anchor);
    return { vis: document.visibilityState, n: ids.length, found: k >= 0, after: k >= 0 ? ids.length - k - 1 : null };
  }
  /* Full refresh pipeline: scan, reload, verify after the reload, then capture. State rides in sessionStorage across the reload. */
  async function full(a) {
    sessionStorage.removeItem('mc_result');
    const r = await mcScan(a.stops, a.first, { base: a.base, stallMs: a.stallMs, topMs: a.topMs });
    if (r.err || !r.win) {
      const o = Object.assign({ stage: 'scan', run: a.run || null }, r);
      sessionStorage.setItem('mc_result', JSON.stringify(o));
      return o;
    }
    sessionStorage.setItem(
      'mc_pipe',
      JSON.stringify({
        base: a.base,
        run: a.run || null,
        scan: r,
        stallMs: a.stallMs,
        topMs: a.topMs,
        skip: a.skip || null,
        t0: Date.now(),
      }),
    );
    setTimeout(function () {
      location.reload();
    }, 300);
    return { stage: 'reloading', scan: r };
  }
  async function resumePipe() {
    const p = JSON.parse(sessionStorage.getItem('mc_pipe') || 'null');
    if (!p) return;
    sessionStorage.removeItem('mc_pipe');
    let out = { stage: 'verify', run: p.run || null, scan: p.scan, warn: (p.scan && p.scan.warn) || [] };
    try {
      await new Promise(function (r) {
        setTimeout(r, 5000);
      });
      const v = await mcVerify({ stallMs: p.stallMs, topMs: p.topMs });
      out.verify = v;
      if (v.ok) {
        out.stage = 'captured';
        out.capture = await mcCapture(p.base, { skip: p.skip });
      } else out.stage = 'verify-failed';
    } catch (e) {
      out.err = String(e);
    }
    out.ms = Date.now() - p.t0;
    sessionStorage.setItem('mc_result', JSON.stringify(out));
  }
  const CMDS = {
    probe: a => probe(a.anchor),
    scan: a => mcScan(a.stops, a.first, { base: a.base, stallMs: a.stallMs, topMs: a.topMs }),
    verify: a => mcVerify(a),
    capture: a => mcCapture(a.base, a),
    people: a => mcPeople(a),
    selfcheck: () => mcSelfcheck(),
    full: a => full(a),
    jump: a => {
      history.replaceState(
        null,
        '',
        location.pathname + '#mcjump=' + encodeURIComponent(a.mid) + (a.reply === false ? '&noreply' : ''),
      );
      jump();
      return { started: true };
    },
    post: (a, id) => mcPost(a, id),
    ping: () => ({ v: '2.1' }),
  };
  /* Bridge: Claude's browser tool dispatches 'mc-cmd' with a JSON string; the answer lands in sessionStorage 'mc_res_<id>'. Works whether the userscript runs in the page or in the extension's own world. */
  document.addEventListener('mc-cmd', async function (e) {
    let d;
    try {
      d = JSON.parse(e.detail);
    } catch (x) {
      return;
    }
    if (!CMDS[d.cmd]) return;
    sessionStorage.setItem('mc_res_' + d.id, JSON.stringify({ running: true }));
    let res;
    try {
      res = await CMDS[d.cmd](d.args || {}, d.id);
    } catch (x) {
      res = { err: String((x && x.stack) || x) };
    }
    sessionStorage.setItem('mc_res_' + d.id, JSON.stringify(res));
  });
  resumePipe();
  jump();
  addEventListener('hashchange', jump);
  var last = location.href;
  setInterval(function () {
    if (location.href !== last) {
      last = location.href;
      if (/mcjump=/.test(location.hash)) jump();
    }
  }, 800);
})();
