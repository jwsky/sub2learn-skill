// Local regressions: timing boundaries, nested overlaps, Unicode, safe output and installation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'skills/sub2learn/scripts/s2l.mjs');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 's2l-local-test-'));
const time = ms => `00:00:${String(Math.floor(ms / 1000)).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
const srt = rows => rows.map(([s, e, t], i) => `${i + 1}\n${time(s)} --> ${time(e)}\n${t}\n`).join('\n');
let passed = 0;
try {
  for (const [label, top, bottom, expected] of [
    ['nested overlaps exclude expired short cues', [[10000, 11000, 'Top']], [[0, 20000, 'Long'], [1000, 2000, 'Expired'], [10500, 12000, 'Current']], [[10000, 11000, 'Top\nLong\nCurrent']]],
    ['touching endpoints do not overlap', [[3000, 4000, 'Top']], [[1000, 3000, 'Before'], [4000, 5000, 'After']], [[3000, 4000, 'Top']]],
    ['offset cues keep the top timeline', [[1000, 3000, 'Hello']], [[1200, 3200, '你好']], [[1000, 3000, 'Hello\n你好']]],
    ['overlapping duplicate text appears once', [[1000, 4000, 'Top']], [[1000, 2000, 'Same'], [1500, 3000, 'Same']], [[1000, 4000, 'Top\nSame']]],
    ['multiline Unicode survives merging', [[1000, 4000, 'Première ligne\nSecond line']], [[1200, 3000, '第一行\n第二行']], [[1000, 4000, 'Première ligne\nSecond line\n第一行\n第二行']]],
  ]) {
    const folder = path.join(temp, String(passed));
    await fs.mkdir(folder);
    const a = path.join(folder, 'top.srt'), b = path.join(folder, 'bottom.srt');
    await fs.writeFile(a, srt(top)); await fs.writeFile(b, srt(bottom));
    const result = JSON.parse(execFileSync(process.execPath, [cli, 'merge-srt', a, b], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }));
    assert.equal(result.ok, true);
    assert.equal(await fs.readFile(result.outputs[0].path, 'utf8'), srt(expected), label);
    assert.equal(await fs.readFile(a, 'utf8'), srt(top));
    assert.equal(await fs.readFile(b, 'utf8'), srt(bottom));
    console.log('PASS', label); passed++;
  }
  const a = path.join(temp, 'a.srt'), b = path.join(temp, 'b.srt'), out = path.join(temp, 'existing.srt');
  await fs.writeFile(a, srt([[1000, 3000, 'First']])); await fs.writeFile(b, srt([[1200, 3200, 'Second']]));
  await fs.writeFile(out, 'keep me');
  const result = JSON.parse(execFileSync(process.execPath, [cli, 'merge-srt', a, b, '--out', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(await fs.readFile(out, 'utf8'), 'keep me');
  assert.equal(result.outputs[0].path, path.join(temp, 'existing (1).srt'));
  console.log('PASS existing output is preserved'); passed++;

  const checkout = path.join(temp, 'checkout'), source = path.join(checkout, 'skills/sub2learn');
  await fs.mkdir(source, { recursive: true });
  await fs.copyFile(path.join(root, 'install.sh'), path.join(checkout, 'install.sh'));
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: sub2learn\ndescription: test\n---\n');
  await fs.writeFile(path.join(source, 'marker'), 'source must survive');
  for (const base of [path.join(checkout, 'skills'), path.join(temp, 'symlinks')]) {
    if (base.endsWith('symlinks')) { await fs.mkdir(base); await fs.symlink(source, path.join(base, 'sub2learn')); }
    execFileSync('bash', [path.join(checkout, 'install.sh'), '--dest', base, '--no-setup'], { stdio: 'pipe' });
    assert.equal(await fs.readFile(path.join(source, 'marker'), 'utf8'), 'source must survive');
    console.log('PASS installer preserves its source' + (base.endsWith('symlinks') ? ' through a symlink' : ' for in-place installation')); passed++;
  }
  console.log(JSON.stringify({ passed, networkRequests: 0 }));
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
