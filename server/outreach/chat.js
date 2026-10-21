'use strict';
/**
 * Talk to the scout. Each lane has a conversation; the agent can change the
 * lane's saved searches, daily numbers, continuous mode, exclusions and
 * lessons, or start a scout right away. It cannot switch auto-send on or off:
 * that stays a founder's switch.
 */
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const events = require('../core/events');
const queue = require('../jobs/queue');
const ai = require('../integrations/ai');
const learning = require('./learning');
const { noDashes } = require('./common');
const { now } = require('../core/util');

const SETTABLE = { scoutPerDay: [1, 100], maxLeadsPerDay: [1, 500], scoutEveryMin: [10, 1440], scoutHour: [0, 23], continuous: 'bool', scout: 'bool' };
const lines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

function history(lane, n = 40) { return ctx.store.all('outreachChat', (m) => m.lane === lane).slice(-n); }

function snapshot(lane) {
  const c = ctx.setting(`outreach.${lane}`, {}) || {};
  const st = learning.stats(lane);
  const leads = ctx.store.all('prospects', (p) => (lane === 'political' ? p.type === 'political' : p.type !== 'political'));
  return {
    savedSearches: lines(c.scoutQueries), dailyScout: !!c.scout, continuous: !!c.continuous, scoutEveryMin: c.scoutEveryMin, scoutPerDay: c.scoutPerDay, maxLeadsPerDay: c.maxLeadsPerDay,
    lessons: lines(c.lessons), exclusions: lines(ctx.setting('outreach.exclusions', '')), autoSend: !!c.autoSend,
    leads: { total: leads.length, byStage: leads.reduce((a, p) => ((a[p.stage || 'new'] = (a[p.stage || 'new'] || 0) + 1), a), {}) },
    recentLeads: leads.slice(-12).map((p) => ({ name: p.name, where: p.location || p.handle || '', stage: p.stage || 'new' })), feedback: st,
  };
}

function apply(lane, actions, actor) {
  const done = [];
  const cur = { ...(ctx.setting(`outreach.${lane}`, {}) || {}) };
  let exclusions = lines(ctx.setting('outreach.exclusions', ''));
  let queries = lines(cur.scoutQueries); let lessons = lines(cur.lessons);
  for (const a of (Array.isArray(actions) ? actions : []).slice(0, 12)) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'set_searches' && Array.isArray(a.searches)) { queries = a.searches.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 30); done.push(`Saved searches set (${queries.length})`); }
    else if (a.type === 'add_search' && a.search) { queries.push(String(a.search).trim()); done.push(`Added search: ${a.search}`); }
    else if (a.type === 'remove_search' && a.search) { const before = queries.length; queries = queries.filter((q) => q.toLowerCase() !== String(a.search).toLowerCase()); if (queries.length < before) done.push(`Removed search: ${a.search}`); }
    else if (a.type === 'scout_now' && a.query) {
      queue.enqueue(lane === 'political' ? 'political.scout' : 'creator.scout', { query: String(a.query), count: Math.max(1, Math.min(50, Number(a.count) || 10)), autoPackage: true }, { actor });
      done.push(`Scouting now: ${a.query}`);
    } else if (a.type === 'set' && a.key in SETTABLE) {
      const rule = SETTABLE[a.key];
      cur[a.key] = rule === 'bool' ? !!a.value : Math.max(rule[0], Math.min(rule[1], Number(a.value) || rule[0]));
      done.push(`${a.key} → ${cur[a.key]}`);
    } else if (a.type === 'add_exclusion' && a.value) { exclusions.push(String(a.value).trim()); done.push(`Will never contact: ${a.value}`); }
    else if (a.type === 'remove_exclusion' && a.value) { exclusions = exclusions.filter((x) => x.toLowerCase() !== String(a.value).toLowerCase()); done.push(`Removed from exclusions: ${a.value}`); }
    else if (a.type === 'add_lesson' && a.text) { lessons.push(noDashes(String(a.text).trim())); done.push(`Learned: ${a.text}`); }
    else if (a.type === 'remove_lesson' && a.text) { lessons = lessons.filter((x) => !x.toLowerCase().includes(String(a.text).toLowerCase())); done.push(`Forgot: ${a.text}`); }
  }
  cur.scoutQueries = queries.join('\n'); cur.lessons = lessons.join('\n');
  ctx.store.setSettings({ outreach: { [lane]: cur, exclusions: exclusions.join('\n') } });
  events.publish('settings', {});
  if (done.length) audit.log(actor, 'outreach.chat_changes', { lane, changes: done });
  return done;
}

/** Simple commands when no AI provider is connected. */
function offline(lane, text) {
  const t = text.trim(); let m;
  if ((m = /^(?:find|scout|search(?: for)?)\s+(.+)/i.exec(t))) return { reply: `Scouting for "${m[1]}".`, actions: [{ type: 'scout_now', query: m[1], count: 10 }] };
  if ((m = /^(?:add search|save search)\s*:?\s*(.+)/i.exec(t))) return { reply: 'Saved.', actions: [{ type: 'add_search', search: m[1] }] };
  if ((m = /^(?:never contact|exclude)\s*:?\s*(.+)/i.exec(t))) return { reply: 'Added to the exclusions list.', actions: [{ type: 'add_exclusion', value: m[1] }] };
  if ((m = /^(?:remember|lesson)\s*:?\s*(.+)/i.exec(t))) return { reply: 'Got it, I will follow that.', actions: [{ type: 'add_lesson', text: m[1] }] };
  if (/^(?:keep going|run continuously|continuous on)/i.test(t)) return { reply: 'Continuous scouting is on while the computer is on.', actions: [{ type: 'set', key: 'scout', value: true }, { type: 'set', key: 'continuous', value: true }] };
  if (/^(?:stop scouting|continuous off|pause)/i.test(t)) return { reply: 'Continuous scouting is off.', actions: [{ type: 'set', key: 'continuous', value: false }] };
  return { reply: 'Without an AI provider I understand: "find …", "add search …", "never contact …", "remember …", "keep going", "pause". Connect Claude in Settings → Connections to talk freely.', actions: [] };
}

async function send(lane, text, actor) {
  const msg = String(text || '').trim().slice(0, 4000); if (!msg) throw new Error('Type a message.');
  ctx.store.insert('outreachChat', { lane, role: 'user', text: msg, by: actor, at: now() });
  let out;
  if (!ai.anyConnected()) out = offline(lane, msg);
  else {
    const who = lane === 'political' ? 'political candidates and officials (they receive a package of campaign ads; plan: ' + ctx.setting('political.plan', '12 posts a week for $949') + ')' : 'creators: political/news commentary creators and creators who want to build into YouTube (email only; Shorts package $1,200/mo, full YouTube management $2,200/mo)';
    const convo = history(lane, 20).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
    try {
      const r = await ai.ask({ role: 'research', json: true, maxTokens: 1500, system: `You manage lead scouting for ${ctx.setting('agency.name', 'Euclidean Media')}'s ${lane} lane: ${who}. Talk with the founders in plain, short sentences (no em dashes). Turn what they want into actions. Current state:\n${JSON.stringify(snapshot(lane))}\n\nActions you can take:\n- {"type":"set_searches","searches":["..."]} replace the saved searches (each a specific, plain-English description of who to find)\n- {"type":"add_search","search":"..."} / {"type":"remove_search","search":"..."}\n- {"type":"scout_now","query":"...","count":10}\n- {"type":"set","key":"scoutPerDay|maxLeadsPerDay|scoutEveryMin|scoutHour|continuous|scout","value":...}\n- {"type":"add_exclusion","value":"name, organisation or email domain"} / {"type":"remove_exclusion","value":"..."}\n- {"type":"add_lesson","text":"a rule for writing or scouting"} / {"type":"remove_lesson","text":"..."}\nYou cannot turn auto-send on or off; tell them to use the Auto-send switch. Never invent contact details. Return JSON {"reply":"...","actions":[...]}`, messages: convo });
      out = { reply: r.json?.reply || 'Done.', actions: r.json?.actions || [] };
    } catch (e) { out = { ...offline(lane, msg), reply: `I couldn't reach the AI (${e.message.slice(0, 80)}). ${offline(lane, msg).reply}` }; }
  }
  const done = apply(lane, out.actions, actor);
  const reply = ctx.store.insert('outreachChat', { lane, role: 'assistant', text: noDashes(out.reply), changes: done, at: now() });
  const all = ctx.store.data.outreachChat; if (all.length > 2000) all.splice(0, all.length - 1500);
  events.publish('outreachChat', { lane });
  return { reply, changes: done };
}

module.exports = { send, history, snapshot, apply };
