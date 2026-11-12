/* Test runner: serves tests/ (the simulated Messenger) on a free local port, runs sim.js and composer.sim.js against it, exits non-zero if either fails.
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
const server = http.createServer((req, res) => {
  const p = path.normalize(path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!p.startsWith(ROOT + path.sep)) {
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
  /* sim.js (the helper on the simulated thread), then composer.sim.js (the outbox's posting steps) */
  const run = (files, worst) => {
    if (!files.length) {
      server.close();
      return process.exit(worst);
    }
    const child = spawn(process.execPath, [path.join(ROOT, files[0])], { stdio: 'inherit', env });
    child.on('exit', code => run(files.slice(1), worst || (code == null ? 1 : code)));
  };
  run(['sim.js', 'composer.sim.js'], 0);
});
