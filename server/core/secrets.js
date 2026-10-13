'use strict';
/**
 * Encrypted credential vault (AES-256-GCM). The master key is generated per
 * machine. Inside Electron it is additionally sealed with the OS keychain
 * (DPAPI on Windows, Keychain on macOS) via safeStorage; headless engines keep
 * it in a permission-restricted key file. Secrets never leave the engine: the
 * API only reports whether a value is set, never the value itself.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');

let masterKey = null;
let vault = {};
let sealer = null; // { encrypt(buf)->buf, decrypt(buf)->buf } from Electron safeStorage

function setSealer(s) { sealer = s; }

function keyFile() { return path.join(paths.keys(), sealer ? 'master.sealed' : 'master.key'); }
function vaultFile() { return path.join(paths.keys(), 'vault.enc'); }

function loadKey() {
  if (masterKey) return masterKey;
  const sealed = path.join(paths.keys(), 'master.sealed');
  const plain = path.join(paths.keys(), 'master.key');
  if (sealer && fs.existsSync(sealed)) masterKey = sealer.decrypt(fs.readFileSync(sealed));
  else if (fs.existsSync(plain)) {
    masterKey = Buffer.from(fs.readFileSync(plain, 'utf8').trim(), 'hex');
    if (sealer) { fs.writeFileSync(sealed, sealer.encrypt(masterKey)); fs.unlinkSync(plain); } // upgrade to OS-sealed key
  } else {
    masterKey = crypto.randomBytes(32);
    if (sealer) fs.writeFileSync(sealed, sealer.encrypt(masterKey));
    else fs.writeFileSync(plain, masterKey.toString('hex'), { mode: 0o600 });
  }
  return masterKey;
}

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from('EUV1'), iv, c.getAuthTag(), enc]);
}
function decrypt(buf) {
  if (buf.slice(0, 4).toString() !== 'EUV1') throw new Error('Unknown vault format');
  const iv = buf.slice(4, 16), tag = buf.slice(16, 32), enc = buf.slice(32);
  const d = crypto.createDecipheriv('aes-256-gcm', loadKey(), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8'));
}

function load() {
  loadKey();
  if (fs.existsSync(vaultFile())) {
    try { vault = decrypt(fs.readFileSync(vaultFile())); }
    catch (e) { console.error('[secrets] vault could not be decrypted:', e.message); vault = {}; }
  }
}
function save() {
  const tmp = vaultFile() + '.tmp';
  fs.writeFileSync(tmp, encrypt(vault), { mode: 0o600 });
  fs.renameSync(tmp, vaultFile());
}

/** Keys are namespaced: "global.anthropic.apiKey" or "client.<id>.youtube.token". */
function get(key) { return vault[key]; }
function set(key, value) { if (value === '' || value == null) delete vault[key]; else vault[key] = value; save(); }
function has(key) { return vault[key] != null && vault[key] !== ''; }
function removePrefix(prefix) { for (const k of Object.keys(vault)) if (k.startsWith(prefix)) delete vault[k]; save(); }
function status(keys) { const o = {}; for (const k of keys) o[k] = has(k); return o; }

module.exports = { setSealer, load, get, set, has, removePrefix, status, keyFile };
