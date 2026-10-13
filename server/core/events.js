'use strict';
/** Server-sent events bus: every state change is pushed to open windows live. */
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(100);
const clients = new Set();

function attach(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const c = { res, user: req.user };
  clients.add(c);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); clients.delete(c); });
}

let batch = new Map();
let flushTimer = null;
/** Coalesce high-frequency events (job progress) into one frame per 150ms. */
function publish(type, payload, { coalesceKey } = {}) {
  bus.emit(type, payload);
  bus.emit('*', type, payload);
  const key = coalesceKey || `${type}:${Math.random()}`;
  batch.set(key, { type, payload });
  if (!flushTimer) flushTimer = setTimeout(flush, 150);
}
function flush() {
  flushTimer = null;
  const items = [...batch.values()]; batch = new Map();
  if (!clients.size) return;
  const frame = `data: ${JSON.stringify(items)}\n\n`;
  for (const c of clients) { try { c.res.write(frame); } catch { clients.delete(c); } }
}

module.exports = { bus, attach, publish, get connected() { return clients.size; } };
