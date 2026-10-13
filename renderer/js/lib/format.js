// Formatting helpers.
export const money = (v, digits = 0) => (v == null ? '—' : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);
export const num = (v) => (v == null ? '—' : Number(v).toLocaleString());
export function ago(iso) {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 45) return 'now';
  if (d < 3600) return `${Math.round(d / 60)}m`;
  if (d < 86400) return `${Math.round(d / 3600)}h`;
  if (d < 86400 * 6) return new Date(iso).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export const time = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');
export const dateTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
export const day = (iso) => {
  const d = new Date(iso); const t = new Date(); const y = new Date(Date.now() - 864e5);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
};
export function dur(sec) { sec = Math.max(0, Math.round(sec || 0)); const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, '0')}`; }
export function tc(sec, fps = 30) { sec = Math.max(0, sec || 0); const f = Math.floor((sec % 1) * fps); const s = Math.floor(sec) % 60; const m = Math.floor(sec / 60) % 60; const h = Math.floor(sec / 3600); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`; }
export const PLATFORM_LABEL = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', facebook: 'Facebook', twitter: 'X', threads: 'Threads', linkedin: 'LinkedIn' };
export const actorName = (a) => ({ ryan: 'Ryan', ben: 'Ben', system: 'Euclidean' }[a] || (String(a || '').startsWith('agent:') ? String(a).slice(6).split(':')[0].replace('anthropic', 'Claude').replace('openai', 'GPT').replace('xai', 'Grok') : String(a || '').startsWith('portal:') ? 'Client portal' : a));
export const providerLabel = (agent) => { const p = String(agent || '').split(':')[0]; return { anthropic: 'Claude', openai: 'GPT', xai: 'Grok', autopilot: 'Autopilot' }[p] || p; };
