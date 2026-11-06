'use strict';
/**
 * Remotion's heavy work (building the ad designer, drawing stills and videos) in its own low-priority process, so the
 * app's engine never stalls while an ad renders. adengine.js forks this file for each task and sends one message:
 *   { op: 'browser' }                                   → { result: executablePath }
 *   { op: 'bundle', entryPoint, outDir }                → { result: outDir }
 *   { op: 'still', serveUrl, browserExecutable, inputProps, output, frame, scale }
 *   { op: 'render', serveUrl, browserExecutable, inputProps, outputLocation, crf, concurrency }  (sends { progress })
 * and gets back { result } or { error }.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed here */ }

async function run(m) {
  const R = () => require('@remotion/renderer');
  if (m.op === 'browser') {
    // Remotion looks for (and downloads) its headless Chrome from the working folder: stand in the app folder.
    process.chdir(ROOT);
    let said = false;
    await R().ensureBrowser({ logLevel: 'error', onBrowserDownload: () => { if (!said) { said = true; process.send({ progress: 0, text: 'Downloading the video renderer (one time, about 100 MB)' }); } return { version: null, onProgress: () => {} }; } });
    const info = require('@remotion/renderer/dist/browser/BrowserFetcher').getRevisionInfo();
    return info.local && fs.existsSync(info.executablePath) ? info.executablePath : null;
  }
  if (m.op === 'bundle') {
    const { bundle } = require('@remotion/bundler');
    await bundle({ entryPoint: m.entryPoint, outDir: m.outDir, enableCaching: false });
    return m.outDir;
  }
  const opts = { serveUrl: m.serveUrl, id: 'PoliticalAd', inputProps: m.inputProps, logLevel: 'error', browserExecutable: m.browserExecutable };
  const composition = await R().selectComposition(opts);
  if (m.op === 'still') {
    await R().renderStill({ composition, serveUrl: m.serveUrl, browserExecutable: m.browserExecutable, output: m.output, frame: m.frame, inputProps: m.inputProps, logLevel: 'error', scale: m.scale || 1 });
    return m.output;
  }
  if (m.op === 'render') {
    await R().renderMedia({
      composition, serveUrl: m.serveUrl, browserExecutable: m.browserExecutable, codec: 'h264', outputLocation: m.outputLocation, inputProps: m.inputProps,
      crf: m.crf || 18, pixelFormat: 'yuv420p', audioCodec: 'aac', audioBitrate: '192k', concurrency: m.concurrency || 2, logLevel: 'error', timeoutInMilliseconds: 120000,
      onProgress: ({ progress }) => process.send({ progress }),
    });
    return m.outputLocation;
  }
  throw new Error(`Unknown task ${m.op}`);
}

process.once('message', (m) => {
  run(m).then((result) => process.send({ result }, () => process.exit(0)))
    .catch((e) => process.send({ error: String(e && e.stack || e).slice(0, 4000) }, () => process.exit(1)));
});
