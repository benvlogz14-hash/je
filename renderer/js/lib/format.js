// Formatting helpers.
// Formatters are made once and reused: toLocaleString with options builds a new one on every call, which made the
// money and date formatting one of the busiest things on the Finance and clip pages.
const F = new Map();
const fmt = (kind, opts) => { const k = kind + JSON.stringify(opts); let f = F.get(k); if (!f) { f = kind === 'n' ? new Intl.NumberFormat(undefined, opts) : new Intl.DateTimeFormat(undefined, opts); F.set(k, f); } return f; };
export const money = (v, digits = 0) => (v == null ? '—' : `$${fmt('n', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(v))}`);
export const num = (v) => (v == null ? '—' : fmt('n', {}).format(Number(v)));
export function ago(iso) {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 45) return 'now';
  if (d < 3600) return `${Math.round(d / 60)}m`;
  if (d < 86400) return `${Math.round(d / 3600)}h`;
  if (d < 86400 * 6) return fmt('d', { weekday: 'short' }).format(new Date(iso));
  return fmt('d', { month: 'short', day: 'numeric' }).format(new Date(iso));
}
export const time = (iso) => (iso ? fmt('d', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '');
export const dateTime = (iso) => (iso ? fmt('d', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '');
export const day = (iso) => {
  const d = new Date(iso); const t = new Date(); const y = new Date(Date.now() - 864e5);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return fmt('d', { weekday: 'long', month: 'short', day: 'numeric' }).format(d);
};
export function dur(sec) { sec = Math.max(0, Math.round(sec || 0)); const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, '0')}`; }
export function tc(sec, fps = 30) { sec = Math.max(0, sec || 0); const f = Math.floor((sec % 1) * fps); const s = Math.floor(sec) % 60; const m = Math.floor(sec / 60) % 60; const h = Math.floor(sec / 3600); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`; }
export const PLATFORM_LABEL = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', facebook: 'Facebook', twitter: 'X', threads: 'Threads', linkedin: 'LinkedIn' };
export const actorName = (a) => ({ ryan: 'Ryan', ben: 'Ben', system: 'Euclidean' }[a] || (String(a || '').startsWith('agent:') ? String(a).slice(6).split(':')[0].replace('anthropic', 'Claude').replace('openai', 'GPT').replace('xai', 'Grok') : String(a || '').startsWith('portal:') ? 'Client portal' : a));
export const providerLabel = (agent) => { const p = String(agent || '').split(':')[0]; return { anthropic: 'Claude', openai: 'GPT', xai: 'Grok', autopilot: 'Autopilot' }[p] || p; };
