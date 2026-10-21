'use strict';
/**
 * One-click free speech-to-text on this computer (whisper.cpp). Used for clip
 * captions and the "their own speeches" ads instead of paying OpenAI.
 * Windows: the official prebuilt zip from GitHub. Mac: Homebrew. Model: base.en (~150 MB).
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const tools = require('../agents/tools');

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

function findBin(dir) {
  const names = tools.WIN ? ['whisper-cli.exe', 'main.exe'] : ['whisper-cli', 'whisper-cpp', 'main'];
  const walk = (d, depth) => {
    let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const n of names) if (list.some((x) => x.isFile() && x.name === n)) return path.join(d, n);
    if (depth > 3) return null;
    for (const x of list) if (x.isDirectory()) { const r = walk(path.join(d, x.name), depth + 1); if (r) return r; }
    return null;
  };
  return walk(dir, 0);
}

function status() {
  const bin = ctx.setting('ai.transcription.localWhisperPath', ''); const model = ctx.setting('ai.transcription.localWhisperModel', '');
  return { ready: !!(bin && model && fs.existsSync(bin) && fs.existsSync(model)), bin, model };
}

async function install(h) {
  if (status().ready) return { ok: true, already: true };
  const dir = tools.toolsDir('whisper');
  let bin = findBin(dir) || (tools.WIN ? null : tools.findExecutable(['whisper-cli', 'whisper-cpp'], { extraDirs: ['/opt/homebrew/bin', '/usr/local/bin'] }));
  if (!bin) {
    if (tools.WIN) {
      h.progress(0.1, 'Downloading the speech-to-text tool');
      const rel = await (await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest', { headers: { 'user-agent': 'Euclidean' }, signal: AbortSignal.timeout(30000) })).json().catch(() => ({}));
      const asset = (rel.assets || []).find((a) => /^whisper-bin-x64\.zip$/i.test(a.name)) || (rel.assets || []).find((a) => /bin-x64.*\.zip$/i.test(a.name) && !/cublas|blas|cuda/i.test(a.name));
      if (!asset) throw new Error("Couldn't find the Windows download of whisper.cpp on GitHub. Try again later.");
      const zip = path.join(tools.toolsDir('downloads'), asset.name);
      await tools.download(asset.browser_download_url, zip);
      h.progress(0.35, 'Unpacking');
      await tools.unzip(zip, dir);
      bin = findBin(dir);
    } else if (process.platform === 'darwin') {
      const brew = tools.findExecutable(['brew'], { extraDirs: ['/opt/homebrew/bin', '/usr/local/bin'] });
      if (!brew) throw new Error('Install Homebrew from brew.sh, then click Install again.');
      h.progress(0.1, 'Installing the speech-to-text tool with Homebrew');
      await tools.exec(brew, ['install', 'whisper-cpp'], { timeoutMs: 30 * 60000 });
      bin = tools.findExecutable(['whisper-cli', 'whisper-cpp'], { extraDirs: ['/opt/homebrew/bin', '/usr/local/bin'] });
    } else throw new Error('On Linux, build whisper.cpp (github.com/ggml-org/whisper.cpp) and set its path in Settings → AI.');
  }
  if (!bin) throw new Error('The speech-to-text tool downloaded but its program was not found. Try Install again.');
  const model = path.join(dir, 'ggml-base.en.bin');
  if (!fs.existsSync(model) || fs.statSync(model).size < 100e6) {
    h.progress(0.5, 'Downloading the English speech model (about 150 MB)');
    await tools.download(MODEL_URL, model);
  }
  ctx.store.setSettings({ ai: { transcription: { localWhisperPath: bin, localWhisperModel: model } } });
  h.progress(1, 'Ready');
  return { ok: true, bin, model };
}

module.exports = { install, status };
