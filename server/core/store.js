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

const COLLECTIONS = [
  'users', 'clients', 'contacts', 'conversations', 'messages', 'jobs', 'assets', 'clips',
  'approvals', 'posts', 'prospects', 'invoices', 'expenses', 'usage', 'timelogs', 'projects',
  'workers', 'alerts', 'portalComments', 'processed',
  'agentThreads', 'agentMessages', 'agentApprovals',
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

  touch() {
    this.dirty = true;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 200);
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const body = JSON.stringify({ meta: { ...this.meta, savedAt: now() }, data: this.data });
    const tmp = this.file + '.tmp';
    try {
      const fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('[store] write failed', e.message); this.dirty = true; }
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
