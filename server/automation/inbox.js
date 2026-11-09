'use strict';
/**
 * The footage inbox (Nov 9, Ryan: "add footage to a drive and beam it directly to the video production machine, choose
 * which clip styles and give notes, from my phone while my PC is on"). A folder on this PC that Google Drive for
 * desktop (or Dropbox / OneDrive / iCloud) keeps in sync with the cloud. On the phone you drop a video into a client's
 * folder in the Drive app; Drive brings it down to the PC, and Euclidean imports it.
 *
 *   <inbox>/<Client name>/video.mp4        → that client's Production footage (it waits for Make clips, like an upload)
 *   <inbox>/<Client name>/video.txt        → optional notes for that video, any words (styles too: "documentary 3, story 2")
 *   <inbox>/Politics/<Candidate name>/x.mp4 → that candidate's footage on the Ad machine (a new lead if the name is new)
 *   imported files move to an "Imported" folder next to them, so the phone shows what's done.
 *
 * A file is only taken once it has stopped changing for a minute (Drive writes big files in pieces). Folders are made for
 * every active client (and Politics) when the inbox is set, so they show up in the Drive app straight away.
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const audit = require('../core/audit');
const events = require('../core/events');

const VIDEO = /\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts|wmv|mpg|mpeg|3gp)$/i;
const S = (k, d) => ctx.setting(`inbox.${k}`, d);
const safeName = (s) => String(s || '').replace(/[<>:"/\\|?*]+/g, '').trim().slice(0, 80);
const folderKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function folder() { const f = String(S('folder', '') || '').trim(); return f && fs.existsSync(f) ? f : null; }

/** Make a folder per active client and a Politics folder, so they appear in the Drive app. */
function ensureFolders() {
  const root = folder(); if (!root) return [];
  const made = [];
  for (const c of ctx.store.all('clients', (x) => x.status === 'active' || x.status === 'lead')) {
    const d = path.join(root, safeName(c.name)); if (!fs.existsSync(d)) { try { fs.mkdirSync(d, { recursive: true }); made.push(d); } catch { /* read-only */ } }
  }
  const pol = path.join(root, 'Politics'); if (!fs.existsSync(pol)) { try { fs.mkdirSync(pol, { recursive: true }); made.push(pol); } catch { /* fine */ } }
  return made;
}

/** Notes beside a video (same name, .txt): the words are the notes; "documentary 3, story 2" sets the styles too. */
function sidecar(file) {
  const t = file.replace(/\.[^.]+$/, '.txt'); if (!fs.existsSync(t)) return null;
  let text = ''; try { text = fs.readFileSync(t, 'utf8').slice(0, 2000).trim(); } catch { return null; }
  const styles = require('../video/styles').PRESETS; const mix = {};
  for (const id of [...Object.keys(styles), 'custom']) {
    const label = (styles[id]?.label || id).toLowerCase();
    const m = new RegExp(`\\b(?:${id}|${label.replace(/[^a-z ]/g, '')})\\b\\s*(?:x\\s*)?(\\d{1,2})|(\\d{1,2})\\s*(?:x\\s*)?(?:${id}|${label.replace(/[^a-z ]/g, '')})\\b`, 'i').exec(text);
    if (m) mix[id] = Math.min(10, Number(m[1] || m[2]));
  }
  return { notes: text, styleMix: Object.keys(mix).length ? mix : null, file: t };
}

const seen = () => ctx.store.settings._inboxSeen || {};
function markSeen(key) { const s = seen(); s[key] = Date.now(); const keys = Object.keys(s); if (keys.length > 3000) for (const k of keys.sort((a, b) => s[a] - s[b]).slice(0, keys.length - 3000)) delete s[k]; ctx.store.settings._inboxSeen = s; ctx.store.touch(); }

const sizes = new Map(); // file → size at the last look (taken only when it stopped growing)
let busy = false;

/** Look through the inbox once. Returns what was imported. */
async function scan({ force = false } = {}) {
  const root = folder(); if (!root || busy) return { imported: [], on: !!root };
  if (!force && S('on', true) === false) return { imported: [], on: false };
  busy = true; const imported = [];
  try {
    ensureFolders();
    const clients = ctx.store.all('clients', (c) => c.status !== 'archived');
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || /^(imported|\.)/i.test(d.name)) continue;
      const dir = path.join(root, d.name);
      if (/^politics$/i.test(d.name)) { for (const c of fs.readdirSync(dir, { withFileTypes: true })) if (c.isDirectory() && !/^imported$/i.test(c.name)) imported.push(...await take(path.join(dir, c.name), { candidate: c.name })); continue; }
      const client = clients.find((c) => folderKey(c.name) === folderKey(d.name));
      if (client) imported.push(...await take(dir, { client }));
    }
    ctx.store.settings._inboxLast = { at: new Date().toISOString(), imported: imported.length }; ctx.store.touch();
    if (imported.length) {
      const by = {}; for (const x of imported) by[x.who] = (by[x.who] || 0) + 1;
      const line = Object.entries(by).map(([w, n]) => `${n} for ${w}`).join(', ');
      events.publish('notify', { title: `From your Drive inbox: ${imported.length} video${imported.length === 1 ? '' : 's'}`, body: `${line}. Pick styles and notes, then press Make clips.`, route: '/production' });
      const m = ctx.store.insert('halMessages', { who: 'hal', text: `New footage from your Drive inbox: ${line}.\n${imported.map((x) => `- ${x.name} → ${x.who}${x.notes ? ' (with your notes)' : ''}`).join('\n')}\nOpen Production (or Politics for candidates) to pick the styles and press Make clips.`, by: 'inbox' });
      events.publish('hal', { id: m.id });
    }
    return { imported, on: true };
  } finally { busy = false; }
}

async function take(dir, { client = null, candidate = null }) {
  const out = [];
  let files; try { files = fs.readdirSync(dir).filter((f) => VIDEO.test(f) && !/^[.~]/.test(f)); } catch { return out; }
  for (const name of files) {
    const f = path.join(dir, name);
    let st; try { st = fs.statSync(f); } catch { continue; }
    const key = `${f}|${st.size}|${Math.round(st.mtimeMs)}`;
    if (seen()[key]) continue;
    // Still arriving: wait until the size stays the same between two looks and nothing changed for a minute.
    const prev = sizes.get(f); sizes.set(f, st.size);
    if (prev !== st.size || Date.now() - st.mtimeMs < 60000 || st.size < 20000) continue;
    try {
      const side = sidecar(f);
      if (client) {
        const dest = path.join(paths.clientDir(client.id, 'footage'), uniqueName(paths.clientDir(client.id, 'footage'), name));
        await fs.promises.copyFile(f, dest);
        const a = require('./pipeline').addAsset({ clientId: client.id, filePath: dest, source: 'drive inbox', actor: 'inbox', name });
        if (side) ctx.store.update('assets', a.id, { notes: side.notes, ...(side.styleMix ? { styleMix: side.styleMix } : {}) });
        out.push({ name, who: client.name, assetId: a.id, notes: !!side });
      } else {
        let p = ctx.store.find('prospects', (x) => x.type === 'political' && folderKey(x.name) === folderKey(candidate));
        if (!p) p = ctx.store.insert('prospects', { name: candidate.trim(), type: 'political', stage: 'new', source: 'drive inbox', platforms: [], handle: '', publicContact: '', location: '' });
        const updir = path.join(paths.root, 'political', p.id, 'uploads'); fs.mkdirSync(updir, { recursive: true });
        const dest = path.join(updir, uniqueName(updir, `${Date.now()}-${name}`));
        await fs.promises.copyFile(f, dest);
        const info = await require('../video/ffmpeg').probe(dest).catch(() => ({}));
        const up = { id: `fu_${Math.random().toString(36).slice(2, 10)}`, name, file: dest, size: st.size, duration: info.duration || 0, hasAudio: !!info.hasAudio, at: new Date().toISOString(), from: 'drive inbox' };
        ctx.store.update('prospects', p.id, (cur) => ({ footageUploads: [...(cur.footageUploads || []), up], ...(side?.notes ? { story: { mode: 'brief', brief: side.notes, at: new Date().toISOString(), by: 'inbox' } } : {}) }));
        events.publish('prospects', { id: p.id });
        out.push({ name, who: p.name, prospectId: p.id, notes: !!side });
      }
      markSeen(key);
      audit.log('inbox', 'footage.inbox', { file: name, to: client ? client.name : p_name(candidate) });
      // Moved to "Imported" beside it, so the phone shows it's done (Drive syncs the move).
      if (S('moveDone', true)) {
        const done = path.join(dir, 'Imported'); try { fs.mkdirSync(done, { recursive: true }); fs.renameSync(f, path.join(done, uniqueName(done, name))); if (side) fs.renameSync(side.file, path.join(done, uniqueName(done, path.basename(side.file)))); } catch { /* left where it is; seen() keeps it from coming in twice */ }
      }
    } catch (e) { audit.log('inbox', 'footage.inbox_failed', { file: name, error: e.message }, 'warn'); markSeen(key); }
  }
  return out;
}
const p_name = (s) => String(s || '').trim();
function uniqueName(dir, name) { let n = name; let i = 2; const ext = path.extname(name); const base = path.basename(name, ext); while (fs.existsSync(path.join(dir, n))) n = `${base} (${i++})${ext}`; return n; }

function status() {
  const root = String(S('folder', '') || '');
  return { folder: root || null, exists: !!(root && fs.existsSync(root)), on: S('on', true) !== false, moveDone: S('moveDone', true) !== false, last: ctx.store.settings._inboxLast || null,
    folders: folder() ? fs.readdirSync(folder(), { withFileTypes: true }).filter((d) => d.isDirectory() && !/^imported$/i.test(d.name)).map((d) => d.name) : [],
    suggestions: suggest() };
}
/** Likely Google Drive / Dropbox / OneDrive folders on this PC, for the Choose folder step. */
function suggest() {
  const home = require('os').homedir(); const out = [];
  const tries = [path.join(home, 'Google Drive'), path.join(home, 'My Drive'), 'G:\\My Drive', 'H:\\My Drive', path.join(home, 'Dropbox'), path.join(home, 'OneDrive'), path.join(home, 'iCloudDrive')];
  for (const t of tries) if (fs.existsSync(t)) out.push(path.join(t, 'Euclidean Inbox'));
  return out;
}

let last = 0;
function tick() { if (Date.now() - last < 45000) return; last = Date.now(); scan().catch((e) => audit.log('system', 'footage.inbox_error', { error: e.message }, 'warn')); }

module.exports = { scan, tick, status, ensureFolders, sidecar, folder };
