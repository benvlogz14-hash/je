'use strict';
/**
 * One-click local AI: install Ollama (if needed), start it in the background,
 * and download the model, all from a button. No command line.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ctx = require('../core/ctx');
const tools = require('../agents/tools');

const base = () => String(ctx.setting('ai.ollama.url', 'http://127.0.0.1:11434') || '').replace(/\/$/, '');
const model = () => ctx.setting('ai.ollama.model', 'llama3.2');

function find() {
  const la = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return tools.findExecutable(['ollama'], { extraDirs: [path.join(la, 'Programs', 'Ollama'), '/usr/local/bin', '/opt/homebrew/bin', '/Applications/Ollama.app/Contents/Resources'] });
}

async function running() { try { const r = await fetch(`${base()}/api/tags`, { signal: AbortSignal.timeout(2500) }); const j = await r.json(); return { ok: true, models: (j.models || []).map((m) => m.name) }; } catch { return { ok: false, models: [] }; } }
const hasModel = (models, m = model()) => models.some((x) => x === m || x.split(':')[0] === m.split(':')[0]);

async function status() {
  const r = await running();
  return { installed: !!find() || r.ok, running: r.ok, model: model(), modelReady: r.ok && hasModel(r.models), models: r.models };
}

async function install(onStep) {
  if (find()) return;
  onStep('Downloading and installing Ollama (about 1 GB, a few minutes)');
  if (tools.WIN) {
    const winget = tools.findExecutable(['winget']);
    if (winget) { try { await tools.exec(winget, ['install', '-e', '--id', 'Ollama.Ollama', '--accept-package-agreements', '--accept-source-agreements', '--silent'], { timeoutMs: 30 * 60000 }); } catch { /* fall back to the installer */ } }
    if (!find()) {
      const exe = path.join(tools.toolsDir('downloads'), 'OllamaSetup.exe');
      await tools.download('https://ollama.com/download/OllamaSetup.exe', exe);
      await tools.exec(exe, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'], { timeoutMs: 30 * 60000 });
    }
  } else if (process.platform === 'darwin') {
    const brew = tools.findExecutable(['brew']);
    if (!brew) throw new Error('Download Ollama for Mac from ollama.com, open it once, then click "Turn on Ollama" again.');
    await tools.exec(brew, ['install', 'ollama'], { timeoutMs: 30 * 60000 });
  } else {
    throw new Error('On Linux, install Ollama with: curl -fsSL https://ollama.com/install.sh | sh  (it needs your password), then click "Turn on Ollama" again.');
  }
  if (!find()) throw new Error('Ollama was installed. Restart Euclidean once so it can be found, then click "Turn on Ollama" again.');
}

async function start(onStep) {
  if ((await running()).ok) return;
  const bin = find(); if (!bin) throw new Error('Ollama is not installed yet.');
  onStep('Starting Llama in the background');
  const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) { await new Promise((ok) => setTimeout(ok, 750)); if ((await running()).ok) return; }
  throw new Error("Ollama didn't start. Open the Ollama app once from the Start menu, then try again.");
}

/** Download the model through Ollama's API, reporting progress 0..1. */
async function pull(onStep, onProgress, name = model(), size = 'about 2 GB') {
  const r = await running(); if (hasModel(r.models, name)) return;
  onStep(`Downloading the ${name} model (${size}, one time only)`);
  const res = await fetch(`${base()}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, stream: true }) });
  if (!res.ok || !res.body) throw new Error(`Couldn't download the model (${res.status}).`);
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true }); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.error) throw new Error(`Model download failed: ${j.error}`);
      if (j.total && j.completed) onProgress(j.completed / j.total, `${j.status || 'Downloading'} ${(j.completed / 1e9).toFixed(2)} of ${(j.total / 1e9).toFixed(2)} GB`);
    }
  }
  if (!hasModel((await running()).models, name)) throw new Error('The model download did not finish. Click "Turn on Ollama" to resume.');
}

/** The whole thing, for the "Turn on Ollama" button. */
async function setup(h) {
  await install((t) => h.progress(0.05, t));
  await start((t) => h.progress(0.3, t));
  await pull((t) => h.progress(0.35, t), (f, t) => h.progress(0.35 + f * 0.6, t));
  ctx.store.setSettings({ ai: { ollama: { enabled: true, autostart: true } } });
  await require('../integrations/ai').pingOllama(true);
  h.progress(1, 'Llama is ready');
  return status();
}

/** Free "eyes": the Llama vision model, so the app can look through video without a paid AI. */
async function setupVision(h) {
  await install((t) => h.progress(0.05, t));
  await start((t) => h.progress(0.2, t));
  const name = ctx.setting('ai.ollama.visionModel', 'llama3.2-vision');
  await pull((t) => h.progress(0.25, t), (f, t) => h.progress(0.25 + f * 0.7, t), name, 'about 8 GB');
  ctx.store.setSettings({ ai: { ollama: { enabled: true, autostart: true } } });
  await require('../integrations/ai').pingOllama(true);
  h.progress(1, 'Euclidean can now look at video for free');
  return { ok: true, model: name };
}
async function visionReady() { const r = await running(); return r.ok && hasModel(r.models, ctx.setting('ai.ollama.visionModel', 'llama3.2-vision')); }

/** On engine start: if the user turned Llama on before and it's installed, start it quietly. */
async function autostart() {
  if (!ctx.setting('ai.ollama.autostart', false) || ctx.setting('ai.ollama.enabled', true) === false || !find()) return;
  try { await start(() => {}); await require('../integrations/ai').pingOllama(true); } catch { /* user can press the button */ }
}

module.exports = { status, setup, setupVision, visionReady, autostart, find };
