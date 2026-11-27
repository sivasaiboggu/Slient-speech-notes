import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import AxeBuilder from '@axe-core/playwright';

const [url, destination, revision = 'after'] = process.argv.slice(2);
const { CHROMIUM_PATH, CAMERA_FIXTURE, TASKS_VISION_DIR, LANDMARKER_MODEL } = process.env;
const modelURL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

if (!url || !destination || !CAMERA_FIXTURE || !TASKS_VISION_DIR || !LANDMARKER_MODEL) {
  throw new Error('Provide URL, OUTPUT_DIR, CAMERA_FIXTURE, TASKS_VISION_DIR and LANDMARKER_MODEL.');
}

await mkdir(destination, { recursive: true });
const browser = await chromium.launch({
  ...(CHROMIUM_PATH && { executablePath: CHROMIUM_PATH }),
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--use-file-for-fake-video-capture=' + resolve(CAMERA_FIXTURE),
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
  ],
});

async function createView({ width, height, theme, mobile = false, fallback = false }) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    reducedMotion: 'reduce',
    timezoneId: 'UTC',
    locale: 'en-GB',
    isMobile: mobile,
    hasTouch: mobile,
    acceptDownloads: true,
  });
  async function serveModelAsset(route, path, contentType) {
    if (fallback) return route.abort();
    await route.fulfill({ path, contentType, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  await context.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@mediapipe\/tasks-vision@1\.2\.3\//, route => {
    const file = new URL(route.request().url()).pathname.split('/@mediapipe/tasks-vision@1.2.3/')[1];
    return serveModelAsset(route, join(TASKS_VISION_DIR, file), file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  });
  await context.route(modelURL, route => serveModelAsset(route, LANDMARKER_MODEL, 'application/octet-stream'));
  await context.addInitScript(fixturePath => {
    const devices = navigator.mediaDevices;
    if (!devices) return;
    const enumerate = devices.enumerateDevices.bind(devices);
    devices.enumerateDevices = async () => (await enumerate()).map(device => (
      device.label === fixturePath
        ? { deviceId: device.deviceId, kind: device.kind, label: 'Test camera' }
        : device
    ));
  }, resolve(CAMERA_FIXTURE));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.text().includes('Content Security Policy')) errors.push(message.text());
  });
  page.on('close', () => {
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    }
  });
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

async function checkOverflow(page, name) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error('Horizontal overflow in ' + name);
}

async function snapshot(page, name, selector) {
  await checkOverflow(page, name);
  const path = join(destination, revision + '-' + name + '.png');
  if (selector) await page.locator(selector).screenshot({ path, timeout: 20_000 });
  else await page.screenshot({ path, fullPage: true });
}

async function audit(page, name) {
  if (revision === 'before') return;
  const results = await new AxeBuilder({ page }).analyze();
  if (results.violations.length) {
    throw new Error(name + ': ' + JSON.stringify(results.violations.map(({ id, nodes }) => ({
      id, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    }))));
  }
  console.log(name + ': zero axe violations');
}

try {
  for (const theme of ['light', 'dark']) {
    const { context, page } = await createView({ width: 1440, height: 1000, theme });
    await snapshot(page, 'desktop-' + theme);
    await audit(page, 'desktop ' + theme);

    if (theme === 'light') {
      if (revision === 'after') {
        await page.keyboard.press('Tab');
        if (await page.locator(':focus').getAttribute('href') !== '#cameraCard') throw new Error('Skip link is missing');
        await page.keyboard.press('Enter');
        if (await page.locator(':focus').getAttribute('id') !== 'cameraCard') throw new Error('Skip link did not move focus');
      }
      await page.locator('#startBtn').click();
      await page.waitForFunction(() => /\d+ fps/.test(document.querySelector('#trackStats').textContent), null, { timeout: 35_000 });
      if (revision === 'after') await audit(page, 'live camera');
      await page.locator('#recordBtn').click();
      await page.waitForFunction(() => {
        const [minutes, seconds] = document.querySelector('#recTimer').textContent.split(':').map(Number);
        return minutes * 60 + seconds >= 6;
      }, null, { timeout: 12_000 });
      await snapshot(page, 'recording', '#cameraCard');
      if (revision === 'after') await audit(page, 'recording');
      await page.locator('#recordBtn').click();
      await page.locator('.clip video').waitFor();
      await page.locator('.clip video').evaluate(video => {
        if (video.readyState >= 2) return;
        return new Promise(resolve => video.addEventListener('loadeddata', resolve, { once: true }));
      });
      if (revision === 'before') {
        await page.locator('.clip .transcribe-btn').click();
        await snapshot(page, 'clips', '#clips');
      } else {
        await page.locator('#reviewClip').click();
        if (await page.locator(':focus').getAttribute('class') !== 'clip-title') throw new Error('Review link did not focus the captured clip');

        const clip = page.locator('.clip');
        const video = clip.locator('video');
        await clip.getByRole('button', { name: 'Play', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.clip video').currentTime > 0.1);
        await clip.getByRole('button', { name: 'Pause', exact: true }).click();
        const seek = clip.getByRole('slider');
        await seek.focus();
        await page.keyboard.press('End');
        await page.keyboard.press('ArrowLeft');
        await page.waitForFunction(() => document.querySelector('.clip video').currentTime > 3);
        if (!(await video.evaluate(element => element.paused))) throw new Error('Seeking unexpectedly resumed the clip');

        await clip.getByRole('button', { name: 'Add note' }).click();
        const title = clip.getByRole('textbox', { name: 'Title' });
        const body = clip.getByRole('textbox', { name: 'Note', exact: true });
        const save = clip.getByRole('button', { name: 'Save note' });
        await title.fill('   ');
        await save.click();
        await clip.getByText(/Enter a title of/).waitFor();
        await title.fill('Practice take');
        await body.fill('Watch the second phrase at the end of the take.');
        await snapshot(page, 'editor', '#clips');
        await audit(page, 'note editor');
        for (const width of [320, 390, 768, 1440]) {
          await page.setViewportSize({ width, height: 1000 });
          await checkOverflow(page, 'note editor at ' + width + 'px');
        }
        await page.setViewportSize({ width: 1440, height: 1000 });

        await page.evaluate(() => {
          const store = window.noteStore;
          const original = store.save;
          store.save = () => {
            store.save = original;
            return Promise.reject(new DOMException('Test quota failure', 'QuotaExceededError'));
          };
        });
        await save.click();
        await clip.getByText(/Your edits are still here/).waitFor();
        if (await body.inputValue() !== 'Watch the second phrase at the end of the take.') throw new Error('A failed save lost the draft');
        await save.click();
        await clip.getByRole('heading', { name: 'Practice take' }).waitFor();
        await snapshot(page, 'clips', '#clips');
        await audit(page, 'saved note and playback');
      }

      for (const [selector, extension] of [['.clip .download-btn', /\.(webm|mp4)$/], ['#snapshotBtn', /\.png$/]]) {
        const download = page.waitForEvent('download');
        await page.locator(selector).click();
        if (!extension.test((await download).suggestedFilename())) throw new Error('Unexpected download filename');
      }

      if (revision === 'before') {
        await page.locator('.clip .delete-btn').click();
      } else {
        await page.reload();
        const saved = page.locator('.clip');
        await saved.getByRole('heading', { name: 'Practice take' }).waitFor();
        await saved.getByText('Watch the second phrase at the end of the take.').waitFor();
        await saved.locator('summary').click();
        await saved.getByRole('button', { name: 'Play', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.clip video').currentTime > 0.1);

        const stalePage = await context.newPage();
        await stalePage.goto(url);
        await stalePage.getByRole('heading', { name: 'Practice take' }).waitFor();
        await stalePage.getByRole('button', { name: 'Edit note' }).click();
        await stalePage.getByRole('textbox', { name: 'Title' }).fill('Stale edit');
        await saved.getByRole('button', { name: 'Edit note' }).click();
        await saved.getByRole('textbox', { name: 'Title' }).fill('Edited practice take');
        await saved.getByRole('button', { name: 'Save note' }).click();
        await saved.getByRole('heading', { name: 'Edited practice take' }).waitFor();
        await stalePage.getByRole('button', { name: 'Save note' }).click();
        await stalePage.getByText(/changed in another tab/).waitFor();
        if (await stalePage.getByRole('textbox', { name: 'Title' }).inputValue() !== 'Stale edit') {
          throw new Error('A conflicting edit lost the draft');
        }
        await stalePage.close();

        await saved.getByRole('button', { name: 'Delete', exact: true }).click();
        await saved.getByRole('button', { name: 'Cancel' }).click();
        await saved.getByRole('heading', { name: 'Edited practice take' }).waitFor();
        await saved.getByRole('button', { name: 'Delete', exact: true }).click();
        await saved.getByRole('button', { name: 'Delete note' }).click();
        await page.getByText('Note deleted.').waitFor();
        await page.reload();
        const remaining = await page.evaluate(() => window.noteStore.list());
        if (remaining.length !== 0) throw new Error('Deleted note returned after reload');
        if (!(await page.locator('#stopBtn').isDisabled())) throw new Error('Reload restarted the camera');
        await page.locator('#startBtn').click();
        await page.waitForFunction(() => /\d+ fps/.test(document.querySelector('#trackStats').textContent));
        console.log('Review, play and seek, validated notes, quota retry, persistence, edit conflict and deletion passed');
      }
      await page.locator('#clipEmpty').waitFor();
      await page.locator('#stopBtn').click();
      await page.locator('#startBtn').click();
      if (revision === 'after') {
        await page.waitForFunction(() => /\d+ fps/.test(document.querySelector('#trackStats').textContent));
      }
      console.log('Live landmarks, recording, playback, downloads and deletion passed');
    }
    await context.close();
  }

  for (const theme of ['light', 'dark']) {
    const { context, page } = await createView({ width: 390, height: 844, mobile: true, theme });
    await snapshot(page, 'mobile-' + theme);
    await audit(page, 'mobile ' + theme);
    if (revision === 'after') {
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await checkOverflow(page, width + 'px ' + theme);
        console.log('No horizontal overflow at ' + width + 'px ' + theme);
      }
    }
    await page.locator('#themeBtn').click();
    await page.reload();
    const expectedTheme = theme === 'light' ? 'dark' : 'light';
    if (await page.locator('html').getAttribute('data-theme') !== expectedTheme) throw new Error('Theme was not saved');
    await context.close();
  }

  const { context, page } = await createView({ width: 1440, height: 1000, theme: 'dark', fallback: true });
  await page.locator('#startBtn').click();
  await page.waitForFunction(() => document.querySelector('#modelPill').textContent === 'Model: failed');
  await page.locator('#faceGuide').waitFor();
  await snapshot(page, 'fallback', '#cameraCard');
  await audit(page, 'face guide fallback');
  await context.close();

  if (revision === 'after') {
    const { context: pages, page: support } = await createView({ width: 1100, height: 820, theme: 'light' });
    for (const [path, name, title] of [
      ['privacy.html', 'privacy', 'Camera and privacy'],
      ['404.html', '404', 'Page unavailable'],
    ]) {
      await support.goto(new URL(path, url).href);
      await support.getByRole('heading', { name: title, exact: true }).waitFor();
      await support.evaluate(() => document.fonts.ready);
      await snapshot(support, name);
      await audit(support, name);
      if (name === '404') {
        await support.getByRole('link', { name: 'Open the workspace' }).click();
        await support.locator('#cameraCard').waitFor();
      }
    }
    await pages.close();
  }
} finally {
  await browser.close();
}
