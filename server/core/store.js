'use strict';
/**
 * Embedded document store. Collections live in memory and are persisted to a
 * single JSON file with atomic write-then-rename and a rolling .bak copy, so a
 * crash mid-write can never corrupt the database. No native modules, so the
 * app compiles anywhere Node runs.
 */
const fs = require('fs');
const path = require('path');
const { id: makeId, now } = require('./util');

const COLLECTIONS = ['bots', 'botMessages', 'botRuns', 'seoDocs', 'seoStats', 'seoRuns', 'botTasks', 'halMessages', 'halNotes', 'opsEvents', 'protests', 
  'users', 'clients', 'contacts', 'conversations', 'messages', 'jobs', 'assets', 'clips',
  'approvals', 'posts', 'prospects', 'invoices', 'expenses', 'usage', 'timelogs', 'projects',
  'workers', 'alerts', 'portalComments', 'processed',
  'agentThreads', 'agentMessages', 'agentApprovals', 'creators', 'outreachFeedback', 'outreachChat',
];

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'euclidean.json');
    this.data = {};
    this.meta = { schema: 1, createdAt: now() };
    this.dirty = false;
    this.timer = null;
    this.listeners = new Set();
    this.load();
  }

  load() {
    for (const f of [this.file, this.file + '.bak']) {
      if (!fs.existsSync(f)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        this.data = raw.data || {};
        this.meta = raw.meta || this.meta;
        if (f !== this.file) console.warn('[store] primary database unreadable, recovered from backup copy');
        break;
      } catch (e) { console.error('[store] failed to read', f, e.message); }
    }
    for (const c of COLLECTIONS) if (!Array.isArray(this.data[c])) this.data[c] = [];
    if (!this.data.settings || typeof this.data.settings !== 'object') this.data.settings = {};
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(col, op, doc) { for (const fn of this.listeners) { try { fn(col, op, doc); } catch { /* listener errors never break writes */ } } }

  all(col, pred) { const a = this.data[col] || []; return pred ? a.filter(pred) : a.slice(); }
  find(col, pred) { return (this.data[col] || []).find(pred) || null; }
  get(col, id) { return (this.data[col] || []).find((d) => d.id === id) || null; }

  insert(col, doc) {
    const d = { id: doc.id || makeId(col.slice(0, 2) + '_'), createdAt: now(), updatedAt: now(), ...doc };
    this.data[col].push(d);
    this.touch(); this.emit(col, 'insert', d);
    return d;
  }

  update(col, id, patch) {
    const d = this.get(col, id);
    if (!d) return null;
    const p = typeof patch === 'function' ? patch(d) : patch;
    if (p) Object.assign(d, p);
    d.updatedAt = now();
    this.touch(); this.emit(col, 'update', d);
    return d;
  }

  remove(col, id) {
    const a = this.data[col]; const i = a.findIndex((d) => d.id === id);
    if (i < 0) return false;
    const [d] = a.splice(i, 1);
    this.touch(); this.emit(col, 'remove', d);
    return true;
  }

  removeWhere(col, pred) {
    const a = this.data[col]; const keep = a.filter((d) => !pred(d));
    const n = a.length - keep.length; this.data[col] = keep;
    if (n) { this.touch(); this.emit(col, 'bulk', null); }
    return n;
  }

  get settings() { return this.data.settings; }
  setSettings(patch) { deepMerge(this.data.settings, patch); this.touch(); this.emit('settings', 'update', this.data.settings); return this.data.settings; }

  // Saving writes the whole database, so it's spread out: at most every 2 s, written in the background (the app keeps
  // working while the disk catches up), with the .bak copy refreshed every 5 minutes. It used to stringify, fsync and
  // copy the whole file every 200 ms while anything changed, which froze the app during production runs.
  touch() {
    this.dirty = true;
    if (this.timer) return;
    const wait = Math.max(200, (this.lastFlush || 0) + 2000 - Date.now());
    this.timer = setTimeout(() => { this.timer = null; this.flushAsync(); }, wait);
  }

  /** Write now and wait (used when the engine stops, and for backups). */
  flush() {
    if (!this.dirty) return;
    this.dirty = false; this.lastFlush = Date.now(); this.gen = (this.gen || 0) + 1; // a background save still running won't overwrite this one
    const body = JSON.stringify({ meta: { ...this.meta, savedAt: now() }, data: this.data });
    const tmp = this.file + '.tmp';
    try {
      const fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
      fs.renameSync(tmp, this.file);
      this.lastBak = Date.now();
    } catch (e) { console.error('[store] write failed', e.message); this.dirty = true; }
  }

  /** The everyday save: the same safe write-then-rename, without blocking the app on the disk. */
  flushAsync() {
    if (!this.dirty) return;
    if (this.writing) { this.touch(); return; }
    this.dirty = false; this.lastFlush = Date.now(); this.writing = true; const gen = this.gen = (this.gen || 0) + 1;
    const body = JSON.stringify({ meta: { ...this.meta, savedAt: now() }, data: this.data });
    const tmp = `${this.file}.${gen}.tmp`; const fsp = fs.promises;
    (async () => {
      const fh = await fsp.open(tmp, 'w'); try { await fh.writeFile(body); await fh.sync(); } finally { await fh.close(); }
      if (!this.lastBak || Date.now() - this.lastBak > 5 * 60000) { try { await fsp.copyFile(this.file, this.file + '.bak'); } catch { /* first save */ } this.lastBak = Date.now(); }
      if (gen !== this.gen) { await fsp.unlink(tmp).catch(() => {}); return; } // a newer save already landed
      await fsp.rename(tmp, this.file);
    })().catch((e) => { console.error('[store] write failed', e.message); this.dirty = true; })
      .finally(() => { this.writing = false; if (this.dirty) this.touch(); });
  }

  backup(dir) {
    this.flush();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = path.join(dir, `euclidean-${stamp}.json`);
    fs.copyFileSync(this.file, out);
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('euclidean-') && f.endsWith('.json')).sort();
    while (files.length > 30) fs.unlinkSync(path.join(dir, files.shift()));
    return out;
  }

  restore(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw.data) throw new Error('Not a Euclidean backup file');
    this.data = raw.data; this.meta = raw.meta || this.meta;
    for (const c of COLLECTIONS) if (!Array.isArray(this.data[c])) this.data[c] = [];
    this.dirty = true; this.flush(); this.emit('*', 'restore', null);
  }
}

function deepMerge(t, s) {
  for (const k of Object.keys(s || {})) {
    const v = s[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) { if (!t[k] || typeof t[k] !== 'object') t[k] = {}; deepMerge(t[k], v); }
    else t[k] = v;
  }
  return t;
}

module.exports = { Store, deepMerge };
