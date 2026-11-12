/* The outbox's posting steps (references/outbox.md › Posting) run word for word against a stand-in for Messenger's
   reply composer (tests/mock/composer.html), with the real helper's jump. Run from the repo root: npm test
   (tests/run.js serves the mock and sets COMPOSER_URL). */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const D = path.join(__dirname, '..') + '/';
const URL = process.env.COMPOSER_URL || 'http://localhost:8765/mock/composer.html';
const HELPER = fs.readFileSync(D + 'plugin/skills/refresh/assets/helper.user.js', 'utf8');
const OUTBOX = fs.readFileSync(D + 'plugin/skills/refresh/references/outbox.md', 'utf8');

const ok = (c, msg) => {
  console.log((c ? 'PASS ' : 'FAIL ') + msg);
  if (!c) process.exitCode = 1;
};
/* The three code blocks in outbox.md, in order: call 1, the check, the confirm. */
const blocks = [...OUTBOX.matchAll(/```js\n([\s\S]*?)```/g)].map(m => m[1]);
/* javascript_tool takes top-level await; page.evaluate awaits the promise the expression returns. */
const code = (k, row, start = true) =>
  blocks[k]
    .replace(/^await /, '')
    .replace('ROW', JSON.stringify(row))
    .replace('START = true', 'START = ' + start);
const insert = line => "document.execCommand('insertText',false," + JSON.stringify(line) + ')';
const boxParas = p => p.evaluate(() => [...document.querySelectorAll('#box p')].map(x => x.textContent));

(async () => {
  ok(
    blocks.length === 3,
    'outbox.md has the three code blocks: call 1, the check, the confirm (' + blocks.length + ')',
  );
  if (blocks.length !== 3) return;
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 900, height: 800 } });
  await ctx.addInitScript('document.addEventListener("DOMContentLoaded",function(){' + HELPER + '\n});');
  const p = await ctx.newPage();
  const fresh = async () => {
    await p.goto(URL);
    await p.waitForFunction(() => document.documentElement.dataset.mcHelper);
  };
  const row = {
    mid: 'mid.$c1',
    to: 'Ana Alvarez',
    snip: 'Is the blue tent still available? I could come by this week.',
    text: 'Yes, still here.\n\nPick it up Friday?\nCash is fine.',
  };
  const lines = row.text.split('\n');

  // The mock behaves like Messenger's editor: line breaks inside inserted text are dropped.
  await fresh();
  await p.evaluate(() => document.getElementById('box').focus());
  await p.evaluate(insert(row.text));
  ok((await boxParas(p)).length === 1, 'composer: inserting the whole reply at once loses its line breaks');

  // Call 1: jump, the "Replying to" bar, the snip, the empty box, then the first line.
  await fresh();
  const r1 = await p.evaluate(code(0, row));
  ok(
    r1 && r1.typed && r1.lines === 4,
    'call 1: jumps, checks the bar and the box, types the first line (' + JSON.stringify(r1) + ')',
  );
  ok(JSON.stringify(await boxParas(p)) === JSON.stringify([lines[0]]), 'call 1: the box holds only the first line');

  // Call 3: shift+Return and insertText per later line, the check, Return, the confirm.
  for (const line of lines.slice(1)) {
    await p.keyboard.press('Shift+Enter');
    if (line) await p.evaluate(insert(line));
  }
  ok(
    JSON.stringify(await boxParas(p)) === JSON.stringify(lines),
    'call 3: the box holds the reply paragraph by paragraph',
  );
  ok((await p.evaluate(code(1, row))) === 'ok', 'call 3: the check passes (whitespace collapsed)');
  await p.keyboard.press('Enter');
  const t0 = Date.now();
  const r3 = await p.evaluate(code(2, row));
  ok(
    r3 && r3.sent && r3.mid === 'mid.$sent1' && Math.abs(Date.parse(r3.at) - t0) < 20000,
    'call 3: the confirm finds the new message, its id and the clock time (' + JSON.stringify(r3) + ')',
  );
  const sent = await p.evaluate(() => window.__sent);
  ok(
    sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify(lines),
    'the reply went out with its paragraphs, blank line included (' + JSON.stringify(sent) + ')',
  );

  // A box that doesn't match the reply: the check throws and leaves the box, so Return sends nothing.
  await fresh();
  await p.evaluate(code(0, row));
  let threw = false;
  try {
    await p.evaluate(code(1, row));
  } catch (e) {
    threw = /did not match/.test(String(e));
  }
  ok(threw, 'check: throws when the box lacks the later lines');
  await p.keyboard.press('Enter');
  const rA = await p.evaluate(code(2, row));
  ok(rA && rA.abort, 'confirm: reports the failed check (' + JSON.stringify(rA) + ')');
  ok((await p.evaluate(() => window.__sent.length)) === 0, 'check: Return after a failed check sent nothing');

  // A reply box pointing at someone else's message: call 1 fails before typing.
  await fresh();
  const rB = await p.evaluate(code(0, Object.assign({}, row, { mid: 'mid.$c2' })));
  ok(
    rB && rB.fail === 'reply box points at a different message',
    'call 1: refuses a bar for another message (' + JSON.stringify(rB) + ')',
  );
  ok(JSON.stringify(await boxParas(p)) === JSON.stringify(['']), 'call 1: typed nothing after a failed check');

  // A message that isn't on the screen: the jump's tip is passed on as the failure.
  await fresh();
  const rC = await p.evaluate(code(0, Object.assign({}, row, { mid: 'mid.$gone' })));
  ok(
    rC && (rC.wait !== undefined || /couldn/.test(rC.fail || '')),
    'call 1: a missing message never types (' + JSON.stringify(rC) + ')',
  );
  await b.close();
})();
