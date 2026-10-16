// Glass lab — renders the real fragment shader from index.html over synthetic
// backdrops and screenshots the result.
//
// The live overlay sets contentProtection, which makes it invisible to every
// capture API (that is what stops the glass capturing itself), so it cannot be
// screenshotted for review. This is the way to actually look at the material.
//
//   npm run glasslab              → tools/glasslab/out.png
//   npm run glasslab -- diff      → per-scene pixel diff, working tree vs HEAD
//
// The shader is pulled out of index.html at run time, so there is no second
// copy to drift out of sync.
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const REPO = path.join(HERE, '..', '..');
const INDEX = path.join(REPO, 'index.html');
const MODE = process.argv.includes('diff') ? 'diff' : 'render';

function extract(html) {
  const marker = 'const fsSource = `';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('fsSource not found in index.html');
  const from = start + marker.length;
  return html.slice(from, html.indexOf('`;', from));
}

app.whenReady().then(async () => {
  const current = extract(fs.readFileSync(INDEX, 'utf8'));
  const win = new BrowserWindow({ width: 700, height: 840, show: false });
  await win.loadFile(path.join(HERE, 'harness.html'));

  if (MODE === 'diff') {
    // GLASSLAB_BASE=<rev> compares against another revision instead of HEAD.
    const base = process.env.GLASSLAB_BASE || 'HEAD';
    const head = extract(execFileSync('git', ['show', `${base}:index.html`], { cwd: REPO, encoding: 'utf8' }));
    const report = await win.webContents.executeJavaScript(
      `compareShaders(${JSON.stringify(head)}, ${JSON.stringify(current)})`);
    const text = report
      .map((r) => `${r.scene.padEnd(22)} maxDelta=${String(r.maxDelta).padStart(3)}  meanDelta=${r.meanDelta}`)
      .join('\n');
    console.log(`working tree vs ${base}, per scene:\n` + text);
    fs.writeFileSync(path.join(HERE, 'diff.txt'), text + '\n');
  } else {
    await win.webContents.executeJavaScript(`renderAll(${JSON.stringify(current)})`);
    await new Promise((r) => setTimeout(r, 400));
    const out = path.join(HERE, 'out.png');
    fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
    console.log('wrote ' + out);
  }
  app.quit();
});
