'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

let root = process.env.EUCLIDEAN_DATA || path.join(os.homedir(), '.euclidean');

function setRoot(dir) { root = dir; ensure(); }
function ensure() {
  for (const d of ['db', 'clients', 'logs', 'backups', 'keys', 'tmp', 'exports', 'workers']) fs.mkdirSync(path.join(root, d), { recursive: true });
}

/** Every client gets an isolated folder; nothing is shared between clients. */
function clientDir(clientId, ...sub) {
  if (!/^[A-Za-z0-9_-]+$/.test(clientId || '')) throw new Error('Invalid client id');
  const p = path.join(root, 'clients', clientId, ...sub);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** Guard against path traversal: a resolved path must stay inside base. */
function inside(base, p) {
  const rel = path.relative(path.resolve(base), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = {
  get root() { return root; },
  setRoot, ensure, clientDir, inside,
  db: () => path.join(root, 'db'),
  logs: () => path.join(root, 'logs'),
  backups: () => path.join(root, 'backups'),
  keys: () => path.join(root, 'keys'),
  tmp: (...s) => { const p = path.join(root, 'tmp', ...s); fs.mkdirSync(p, { recursive: true }); return p; },
  exports: (...s) => { const p = path.join(root, 'exports', ...s); fs.mkdirSync(p, { recursive: true }); return p; },
};
