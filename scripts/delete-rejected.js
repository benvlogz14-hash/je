'use strict';
// Frees disk space: deletes the rendered video files (.mp4) of clips you rejected. Footage, approved / waiting /
// posted clips and the clip records themselves are left alone. Run by "Delete Rejected Videos.bat".
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const candidates = [process.env.EUCLIDEAN_DATA, process.env.APPDATA && path.join(process.env.APPDATA, 'Euclidean', 'data'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Euclidean', 'data'), path.join(os.homedir(), '.config', 'Euclidean', 'data'),
  path.join(os.homedir(), '.euclidean')].filter(Boolean);
const root = candidates.find((d) => fs.existsSync(path.join(d, 'db', 'euclidean.json')));
if (!root) { console.log('Could not find Euclidean\'s data folder. Nothing was deleted.'); process.exit(1); }

let db;
try { db = JSON.parse(fs.readFileSync(path.join(root, 'db', 'euclidean.json'), 'utf8')); } catch (e) { console.log('Could not read Euclidean\'s database: ' + e.message + '. Nothing was deleted.'); process.exit(1); }
const all = (db.data || db).clips; const clips = Array.isArray(all) ? all : Object.values(all || {});
const filesOf = (c) => (c.versions || []).flatMap((v) => [v.path, v.wide]).filter((p) => typeof p === 'string' && /\.mp4$/i.test(p));

// Never touch a file that any clip that isn't rejected still uses.
const keep = new Set(clips.filter((c) => c.status !== 'rejected').flatMap(filesOf).map((p) => path.resolve(p).toLowerCase()));
const gone = [...new Set(clips.filter((c) => c.status === 'rejected').flatMap(filesOf))]
  .filter((p) => !keep.has(path.resolve(p).toLowerCase()) && fs.existsSync(p));
const size = gone.reduce((n, p) => { try { return n + fs.statSync(p).size; } catch { return n; } }, 0);
const gb = (b) => (b / 1024 ** 3).toFixed(2) + ' GB';

console.log(`Data folder: ${root}`);
console.log(`Rejected clips: ${clips.filter((c) => c.status === 'rejected').length}`);
if (!gone.length) { console.log('No rejected video files left on disk. Nothing to delete.'); process.exit(0); }
console.log(`Video files to delete: ${gone.length} (${gb(size)})`);

const go = () => {
  let n = 0, freed = 0;
  for (const p of gone) { try { const s = fs.statSync(p).size; fs.unlinkSync(p); n++; freed += s; } catch (e) { console.log(`  Skipped ${path.basename(p)}: ${e.code === 'EBUSY' ? 'in use' : e.message}`); } }
  console.log(`Done: deleted ${n} videos, freed ${gb(freed)}.`);
};
if (process.argv.includes('--yes')) go();
else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Delete them? Type Y and press Enter: ', (a) => { rl.close(); if (/^y/i.test(a.trim())) go(); else console.log('Nothing was deleted.'); });
}
