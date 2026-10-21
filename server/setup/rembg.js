'use strict';
/** One-click install of the free photo cut-out tool (rembg), with Python if needed. */
const tools = require('../agents/tools');

async function install(h) {
  if (require('../video/cutout').rembgPath()) return { ok: true, already: true };
  let py = tools.findExecutable(tools.WIN ? ['python', 'py'] : ['python3', 'python']);
  if (!py && tools.WIN) {
    const winget = tools.findExecutable(['winget']);
    if (!winget) throw new Error('Install Python from python.org (tick "Add to PATH"), then click Install again.');
    h.progress(0.1, 'Installing Python (one time)');
    await tools.exec(winget, ['install', '-e', '--id', 'Python.Python.3.12', '--accept-package-agreements', '--accept-source-agreements', '--silent'], { timeoutMs: 30 * 60000 });
    py = tools.findExecutable(['python', 'py']);
  }
  if (!py) throw new Error(tools.WIN ? 'Python was installed. Restart Euclidean once, then click Install again.' : 'Install Python 3, then click Install again.');
  h.progress(0.4, 'Downloading the cut-out tool (a few hundred MB)');
  await tools.exec(py, ['-m', 'pip', 'install', '--user', '--upgrade', 'rembg[cli]'], { timeoutMs: 30 * 60000 });
  if (!require('../video/cutout').rembgPath()) throw new Error('The cut-out tool was installed. Restart Euclidean once so it can be found.');
  return { ok: true };
}

module.exports = { install };
