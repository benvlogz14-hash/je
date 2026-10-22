// "Why isn't anything happening?" A banner listing what blocks the automatic work, each with a one-click fix.
import { html, useApi, Button, act } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';

export function HealthBanner({ clientId = '' }) {
  const { data, reload } = useApi(`/api/production/health${clientId ? `?clientId=${clientId}` : ''}`, ['job', 'queue', 'settings', 'assets']);
  const issues = data?.issues || [];
  if (!issues.length) return null;
  const fix = (f) => {
    const go = {
      resume: () => api.post('/api/queue/resume', {}),
      full: () => api.post('/api/mode', { mode: 'full' }),
      local: () => api.patch('/api/settings', { resources: { runHeavyJobsLocally: true } }),
      'retry-asset': () => api.post(`/api/assets/${f.assetId}/process`, {}),
      'retry-job': () => api.post(`/api/jobs/${f.jobId}/retry`, {}),
    }[f.action] || (() => api.post(`/api/setup/${f.action}`, {}));
    return act(go, { ok: 'On it' }).then(reload);
  };
  return html`<div class="col" style="gap:6px;margin-bottom:14px">${issues.map((i) => html`<div class=${'notice ' + (i.level === 'error' ? 'coral' : 'gold')} style="display:flex;align-items:center;gap:10px">
    <${Icon} name=${i.level === 'error' ? 'alert' : 'info'} size=${16} /><span class="grow">${i.text}</span>${i.fix ? html`<${Button} size="sm" kind="primary" onClick=${() => fix(i.fix)}>${i.fix.label}</${Button}>` : null}</div>`)}</div>`;
}
