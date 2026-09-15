// Real local-model smoke test, deliberately separate from the lightweight CI suite.
import { chromium } from '@playwright/test';
import { serve } from '../src/server/http.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const temporary = await mkdtemp(path.join(os.tmpdir(), 'depth-browser-'));
const app = await serve({ inputDir: path.resolve('test'), outputDir: path.resolve('output'), dataDir: temporary, port: 0, open: false });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.waitForFunction(() => document.querySelector('#engine-detail').textContent.includes('Depth Anything'));
  assert.equal(await page.locator('#mode').inputValue(), 'depth'); assert.equal(await page.locator('#audio').inputValue(), 'mute');
  await page.getByRole('checkbox', { name: '选择 2026-09-15_153332_222.mp4', exact: true }).check();
  await page.getByRole('button', { name: '开始转换' }).click();
  await page.getByRole('button', { name: '播放', exact: true }).waitFor({ timeout: 180000 });
  const state = await page.evaluate(() => fetch('/api/jobs').then(r => r.json()));
  const result = state.jobs[0].result;
  assert.equal(result.mode, 'depth'); assert.equal(result.frames, 107);
  await page.screenshot({ path: 'output/depth-workspace.png', fullPage: true });
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.locator('#player').evaluate(v => v.play());
  await page.waitForFunction(() => document.getElementById('player').currentTime > 1);
  await page.locator('#player').evaluate(v => v.pause());
  await page.screenshot({ path: 'output/depth-playback.png', fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile('output/depth-browser-result.json', JSON.stringify(result, null, 2));
  console.log('PASS: browser defaults depth+mute, real local model conversion, 107 frames and playback');
  console.log(result.output);
} finally { await browser.close(); await app.close(); await rm(temporary, { recursive: true, force: true }); }
