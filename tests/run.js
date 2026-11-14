/* Test runner: serves tests/ (the simulated Messenger) on a free local port, runs sim.js and composer.sim.js against it
   in parallel (and the Python suites with --py, as npm test does), exits non-zero if any fails.
   Run from the repo root: npm install && npm run setup (once), then npm test. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.json': 'application/json',
};
/* The mock's composer imports Lexical core from the repo's node_modules (a devDependency): /node_modules/lexical/dist/ only. */
const LEXICAL = path.join(ROOT, '..', 'node_modules', 'lexical', 'dist');
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const lex = u.startsWith('/node_modules/lexical/dist/');
  const p = lex
    ? path.normalize(path.join(LEXICAL, u.slice('/node_modules/lexical/dist/'.length)))
    : path.normalize(path.join(ROOT, u));
  if (!p.startsWith((lex ? LEXICAL : ROOT) + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(p, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  });
});
server.listen(0, '127.0.0.1', () => {
  const base = 'http://127.0.0.1:' + server.address().port + '/mock/';
  const env = Object.assign({}, process.env, {
    MOCK_URL: base + 'messenger.html',
    COMPOSER_URL: base + 'composer.html',
  });
  /* sim.js (the helper on the simulated thread) and composer.sim.js (the outbox's posting steps) at the same time, and
     with --py (npm test) the Python suites too: sim.js prints as it goes, the others' output is held and printed after
     it. Any of them failing fails the run. */
  const run = (label, cmd, args, hold) =>
    new Promise(done => {
      const child = spawn(cmd, args, { stdio: hold ? ['ignore', 'pipe', 'pipe'] : 'inherit', env });
      let out = '';
      if (hold) child.stdout.on('data', d => (out += d)) && child.stderr.on('data', d => (out += d));
      child.on('error', e => (out += String(e) + '\n'));
      child.on('close', (code, sig) => done({ label, out, code: code == null ? 1 : code, sig }));
    });
  const node = file => run(file, process.execPath, [path.join(ROOT, file)], file !== 'sim.js');
  const jobs = [node('sim.js'), node('composer.sim.js')];
  if (process.argv.includes('--py')) jobs.push(run('npm run test:py', 'npm', ['run', '--silent', 'test:py'], true));
  Promise.all(jobs).then(rs => {
    for (const r of rs) {
      if (r.out) process.stdout.write('--- ' + r.label + '\n' + r.out.replace(/([^\n])$/, '$1\n'));
      if (r.code) console.log('FAIL ' + r.label + ' exited with ' + (r.sig || 'code ' + r.code));
    }
    server.close();
    process.exitCode = rs.some(r => r.code) ? 1 : 0; /* not process.exit(): let the held output flush first */
  });
});
