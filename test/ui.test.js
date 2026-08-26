const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const publicHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const replayHtml = fs.readFileSync(path.join(root, 'replay', 'index.html'), 'utf8');
const replaySource = fs.readFileSync(path.join(root, 'replay', 'replay.js'), 'utf8');

function style(html) {
  return html.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\r\n/g, '\n');
}

function scripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(source => source.trim());
}

function ids(html) {
  return [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
}

function markup(html) {
  return html.slice(html.indexOf('<body>'), html.lastIndexOf('<script>'))
    .replace('<script src="replay.js"></script>', '')
    .replace(/\r\n/g, '\n')
    .trim();
}

test('Dashboard sources compile and stay aligned', () => {
  assert.equal(style(publicHtml), style(replayHtml));
  assert.equal(markup(publicHtml), markup(replayHtml));
  assert.match(publicHtml, /<aside id="rail"/);
  assert.match(publicHtml, /class="duo duo-main"/);
  assert.match(publicHtml, /<form id="taskForm"/);
  assert.match(publicHtml, /<link rel="icon" type="image\/png"/);
  assert.match(publicHtml, /<span class="bw">/);

  const publicScripts = scripts(publicHtml);
  const replayScripts = scripts(replayHtml);
  assert.equal(publicScripts.length, replayScripts.length);
  publicScripts.forEach((source, index) => {
    const replaySource = replayScripts[index].replace(' * (window.__replayRate ?? 1)', '');
    assert.equal(source.replace(/\r\n/g, '\n'), replaySource.replace(/\r\n/g, '\n'));
  });

  for (const [name, html] of [['public', publicHtml], ['replay', replayHtml]]) {
    const pageIds = ids(html);
    assert.equal(new Set(pageIds).size, pageIds.length, name + ' has duplicate ids');
    scripts(html).forEach((source, index) => new vm.Script(source, {filename: name + '-inline-' + index}));
  }

  new vm.Script(replaySource, {filename: 'replay.js'});
});
