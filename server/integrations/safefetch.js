'use strict';
/**
 * Fetching web pages for the AI and the bots, safely.
 *
 * Bots read pages that a search turned up or that a model picked, so the address can't be trusted. Every request
 * (and every redirect) is checked where the connection is made: the name is looked up, and if any address it points
 * at is this computer, the home/office network, a link-local or cloud-metadata address or anything reserved, the
 * request is refused. Doing it in the connection's own lookup means a name can't pass the check and then point
 * somewhere else (DNS rebinding). Only http and https, ports 80/443 (others with `web.anyPort`), at most 5 redirects,
 * at most 4 MB, gzip/deflate/brotli unpacked.
 *
 * Settings: `web.localNetwork` true lets pages on the home/office network through (never this computer).
 * Tests set EUCLIDEAN_WEB_ALLOW_LOOPBACK=1 to read a local test server.
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');
const ctx = require('../core/ctx');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const MAX_BYTES = 4 * 1024 * 1024;

const ranges = (list) => { const b = new net.BlockList(); for (const [a, p, f] of list) b.addSubnet(a, p, f); return b; };
const LOOPBACK = ranges([['127.0.0.0', 8, 'ipv4'], ['::1', 128, 'ipv6'], ['0.0.0.0', 8, 'ipv4'], ['::', 128, 'ipv6']]);
const PRIVATE = ranges([['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['fc00::', 7, 'ipv6']]);
const LINK_LOCAL = ranges([['169.254.0.0', 16, 'ipv4'], ['fe80::', 10, 'ipv6']]);
const RESERVED = ranges([['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'], ['198.51.100.0', 24, 'ipv4'], ['203.0.113.0', 24, 'ipv4'], ['224.0.0.0', 3, 'ipv4'], ['ff00::', 8, 'ipv6'], ['2001:db8::', 32, 'ipv6']]);
// Proxies in "fake IP" mode answer every name from here and route it themselves: that's the internet, not the LAN.
const FAKE_IP = ranges([['198.18.0.0', 15, 'ipv4']]);

/** What kind of address this is: 'public' or the reason it's refused. */
function addressClass(addr) {
  let a = String(addr || ''); let fam = net.isIP(a) === 6 ? 'ipv6' : 'ipv4';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a); if (mapped) { a = mapped[1]; fam = 'ipv4'; }
  if (!net.isIP(a)) return 'reserved';
  if (FAKE_IP.check(a, fam)) return 'public';
  if (LOOPBACK.check(a, fam)) return 'this-computer';
  if (a === '169.254.169.254' || a === 'fd00:ec2::254') return 'metadata';
  if (LINK_LOCAL.check(a, fam)) return 'link-local';
  if (PRIVATE.check(a, fam)) return 'local-network';
  if (RESERVED.check(a, fam)) return 'reserved';
  return 'public';
}
const REFUSAL = {
  'this-computer': 'a service on this computer', 'local-network': 'your home or office network', 'link-local': 'a link-local address',
  metadata: 'the cloud metadata service', reserved: 'a reserved address',
};
function allowed(cls) {
  if (cls === 'public') return true;
  if (cls === 'this-computer') return process.env.EUCLIDEAN_WEB_ALLOW_LOOPBACK === '1';
  if (cls === 'local-network') return ctx.setting?.('web.localNetwork', false) === true;
  return false;
}
class Refused extends Error { constructor(host, cls) { super(`Bots can't open ${host}: it points at ${REFUSAL[cls] || 'a blocked address'}.`); this.refused = cls; } }

/** The connection's own name lookup: refuses blocked addresses, so the checked address is the one connected to. */
function guardedLookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(host, { ...opts, all: true }, (err, list) => {
    if (err) return cb(err);
    const arr = Array.isArray(list) ? list : [{ address: list, family: opts.family || 4 }];
    const bad = arr.find((x) => !allowed(addressClass(x.address)));
    if (bad) return cb(new Refused(host, addressClass(bad.address)));
    if (opts.all) return cb(null, arr);
    return cb(null, arr[0].address, arr[0].family);
  });
}

/** Check an address before fetching (also used by the bots' browser). Resolves to { ok, reason }. */
async function check(url) {
  let u; try { u = new URL(url); } catch { return { ok: false, reason: 'That is not a web address.' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: 'Only http and https pages can be opened.' };
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (![80, 443].includes(port) && ctx.setting?.('web.anyPort', false) !== true && !(process.env.EUCLIDEAN_WEB_ALLOW_LOOPBACK === '1')) return { ok: false, reason: `Bots only open normal web ports (80 and 443), not ${port}.` };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(?:[^.]+\.)*localhost\.?$/i.test(host) && !allowed('this-computer')) return { ok: false, reason: `Bots can't open ${host}: it is this computer.` };
  if (net.isIP(host)) { const c = addressClass(host); return allowed(c) ? { ok: true } : { ok: false, reason: new Refused(host, c).message }; }
  try {
    const list = await dns.promises.lookup(host, { all: true });
    const bad = list.find((x) => !allowed(addressClass(x.address)));
    return bad ? { ok: false, reason: new Refused(host, addressClass(bad.address)).message } : { ok: true };
  } catch { return { ok: false, reason: `Couldn't find ${host} on the internet.` }; }
}

function once(url, { method = 'GET', headers = {}, body = null, timeout = 20000, maxBytes = MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) { const c = addressClass(host); if (!allowed(c)) return reject(new Refused(host, c)); }
    const req = lib.request(u, {
      method, lookup: guardedLookup, timeout, agent: false,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5', 'accept-language': 'en-US,en;q=0.9', 'accept-encoding': 'gzip, deflate, br', ...headers },
    }, (res) => {
      const chunks = []; let n = 0;
      let stream = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      stream.on('data', (c) => { n += c.length; if (n > maxBytes) { chunks.push(c.subarray(0, Math.max(0, c.length - (n - maxBytes)))); res.destroy(); stream.destroy?.(); finish(true); return; } chunks.push(c); });
      let done = false;
      const finish = (truncated = false) => { if (done) return; done = true; resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks), truncated }); };
      stream.on('end', () => finish());
      stream.on('error', (e) => { if (!done) { if (chunks.length) finish(true); else reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('The page took too long to answer.')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Fetch a page safely. Returns { url (after redirects), status, type, text, truncated }.
 * Non-text answers (files) come back with text '' and binary: true.
 */
async function get(url, opts = {}) {
  let cur = String(url); let method = opts.method || 'GET'; let body = opts.body || null; let headers = opts.headers || {};
  for (let hop = 0; hop < 6; hop++) {
    const c = await check(cur); if (!c.ok) throw Object.assign(new Error(c.reason), { refused: true });
    const r = await once(cur, { ...opts, method, body, headers });
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      cur = new URL(r.headers.location, cur).toString();
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === 'POST')) { method = 'GET'; body = null; headers = { ...headers }; delete headers['content-type']; }
      continue;
    }
    const type = String(r.headers['content-type'] || '');
    const textual = !type || /text|html|json|xml|javascript|rss|atom/i.test(type);
    const charset = (/charset=([^;]+)/i.exec(type) || [])[1];
    let text = '';
    if (textual) { try { text = new TextDecoder(charset ? charset.trim().toLowerCase() : 'utf-8').decode(r.buffer); } catch { text = r.buffer.toString('utf8'); } }
    return { url: cur, status: r.status, type, text, binary: !textual, bytes: r.buffer.length, buffer: opts.keepBuffer ? r.buffer : undefined, truncated: r.truncated };
  }
  throw new Error('The page redirected too many times.');
}

module.exports = { get, check, addressClass, UA };
