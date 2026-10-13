'use strict';
/**
 * Computer-use handoff (Astra → Adobe Premiere Pro, or any desktop agent).
 * Euclidean prepares a self-contained work order: the FCP XML sequence, SRT
 * captions, the edit brief and an output path. A computer-use agent polls
 *   GET  /api/agent/next?capability=premiere
 * performs the edit in Premiere, then calls
 *   POST /api/agent/jobs/:id/complete   { outputPath }
 * Euclidean takes over again: QC → approval → scheduling.
 * Agents authenticate with their own token (Settings → Agents).
 */
const ctx = require('../core/ctx');

const seen = new Map(); // agentName -> { lastSeen, capability }

function touch(name, capability) { seen.set(name, { lastSeen: Date.now(), capability }); }

function status() {
  const agents = [...seen.entries()].map(([name, v]) => ({ name, capability: v.capability, lastSeen: new Date(v.lastSeen).toISOString(), online: Date.now() - v.lastSeen < 120000 }));
  const waiting = ctx.store ? ctx.store.all('jobs', (j) => j.status === 'waiting_agent').length : 0;
  return { agents, online: agents.some((a) => a.online), waiting };
}

module.exports = { touch, status };
