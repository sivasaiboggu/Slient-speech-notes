// Silent-Speech Notes — automated checks (jsdom, no real camera needed).
//
// Run:  npm install && npm test
// What it covers:
//   - initial render + honest note visible, correct button states
//   - CDN-failure fallback (face-box guide) and no-camera states
//   - lip-tracking draw path with fake landmarks, incl. malformed results
//   - stop-while-loading pill reset + FaceMesh instance reuse on restart
//   - late-result race (results arriving after Stop are ignored)
//   - recording flow: clip added, download link, transcribe note, delete,
//     monotonic clip numbering after a delete, 12-clip cap
//   - snapshot includes the lip overlay and confirms with a status message
//   - unexpected camera-track end stops cleanly with a plain message
//   - camera denied / no camera / camera API missing -> plain-language
//     status, no raw error names, no crash
//   - camera switch offered only with 2+ devices, and it switches
//   - live track stats (fps + lip aperture) update from real results,
//     and the fps number counts every result, not the ~4 Hz repaint rate
//   - a lip point missing on the first frame does not poison smoothing
//     (EMA NaN snap), and [hidden] really hides the face-box guide and
//     the HUD chips (computed display, real stylesheet inlined)
//   - switch clears the old camera's lip points (fresh seed after switch),
//     and Switch works after Stop (starts the next camera)
//   - hero copy says 40 lip landmarks, the number actually drawn
//   - unknown camera errors get a neutral message (never "permission was
//     denied"), NotFoundError gets no "allow camera access" advice, and a
//     failed switch keeps the specific reason
//   - the 12-clip cap notice survives Stop camera
//   - dark/light theme toggle (stored choice wins, OS preference otherwise)
//
// Nothing here touches a real camera or claims anything about one. The live
// camera check has to happen on a real device (see README).

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LANDMARKS = () => Array.from({ length: 468 }, (_, i) => ({ x: 0.3 + (i % 10) * 0.01, y: 0.5 }));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra !== undefined ? ` — ${extra}` : ''}`);
  }
}

// Build a fresh page. opts:
//   faceMesh: 'fake' | 'missing'   (default 'fake')
//   sendNever: true                 (FaceMesh.send never resolves -> model stays loading)
//   gum: 'ok' | 'denied' | 'missing' (default 'ok')
async function makePage(opts = {}) {
  const faceMeshMode = opts.faceMesh || 'fake';
  const htmlRaw = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const themeJs = fs.readFileSync(path.join(ROOT, 'theme.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')
    .replace("import('./tracker.mjs')", 'window.__loadTracker()');
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  // Inline the app script and the real stylesheet, and strip external
  // resources, so the test needs no server — and so computed-style checks
  // (e.g. [hidden] actually hiding an element) test the real CSS.
  const html = htmlRaw
    .replace('<script src="theme.js"></script>', () => `<script>${themeJs}</script>`)
    .replace(/<link[^>]*>/g, '<!-- link stripped for tests -->')
    .replace(/<script src="app\.js"><\/script>/, () => `<script>${appJs}</script>`)
    .replace('</head>', () => `<style>${css}</style></head>`);

  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + String(e.detail || e.message).split('\n')[0]));

  const contexts = []; // every 2d context created, in creation order
  const dom = new JSDOM(html, {
    url: 'http://localhost:8137/',
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.HTMLCanvasElement.prototype.getContext = function () {
        const calls = [];
        const ctx = new Proxy({}, {
          get(t, p) {
            if (typeof p === 'symbol') return undefined;
            return (...a) => { calls.push({ method: String(p), args: a }); };
          },
          set(t, p, v) { calls.push({ method: 'set:' + String(p), args: [v] }); return true; },
        });
        contexts.push({ canvas: this, ctx, calls });
        return ctx;
      };
      window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      try {
        Object.defineProperty(window.HTMLVideoElement.prototype, 'readyState', { configurable: true, get() { return 4; } });
        Object.defineProperty(window.HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get() { return 1280; } });
        Object.defineProperty(window.HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get() { return 720; } });
      } catch (e) { /* jsdom may not allow the override; draw tests still work via the callback */ }
      window.URL.createObjectURL = () => 'blob:fake-clip';
      window.URL.revokeObjectURL = () => {};
      // jsdom has no real canvas bitmap: stub toDataURL, and record anchor
      // clicks instead of letting jsdom "navigate" on a download click.
      window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,fake';
      window.__anchorClicks = [];
      window.HTMLAnchorElement.prototype.click = function () {
        window.__anchorClicks.push({ href: this.href, download: this.getAttribute('download') });
      };
      window.__faceMeshCount = 0;
      window.__sendCalls = 0;
      window.__recorders = [];
      window.__gumCalls = [];
      window.__sendNever = !!opts.sendNever;
      window.__gumErrorOnCall = opts.gumErrorOnCall || null;
      // The <head> theme script reads matchMedia + localStorage before any
      // other script runs; seed both so theme tests are deterministic.
      window.matchMedia = (q) => ({
        matches: !!opts.matchMediaLight && String(q).includes('light'),
        media: q,
        addEventListener() {},
        removeEventListener() {},
      });
      if (opts.storedTheme) {
        try { window.localStorage.setItem('ssn-theme', opts.storedTheme); } catch (e) { /* ignore */ }
      }

      // Fake camera stream + track.
      const makeTrack = () => ({
        stopCalls: 0,
        handlers: {},
        kind: 'video',
        stop() { this.stopCalls += 1; },
        addEventListener(type, fn) { this.handlers[type] = fn; },
        removeEventListener() {},
        // Which camera the browser actually opened (opts.defaultDeviceId,
        // default cam1) — drives the switch-camera index, as on a real device.
        getSettings() { return { deviceId: opts.defaultDeviceId || 'cam1' }; },
      });
      if (opts.gum !== 'missing') {
        window.navigator.mediaDevices = {
          getUserMedia: async (constraints) => {
            window.__gumCalls.push(constraints);
            const failName = window.__gumErrorOnCall && window.__gumErrorOnCall[window.__gumCalls.length];
            if (failName) {
              const fail = new Error('simulated ' + failName);
              fail.name = failName;
              throw fail;
            }
            if (opts.gum === 'denied') {
              const err = new Error('Permission denied');
              err.name = 'NotAllowedError';
              throw err;
            }
            if (opts.gum === 'notfound') {
              const err = new Error('Requested device not found');
              err.name = 'NotFoundError';
              throw err;
            }
            if (opts.gum === 'unknown') {
              const err = new Error('Something broke');
              err.name = 'WeirdError';
              throw err;
            }
            const track = makeTrack();
            const stream = { getTracks: () => [track], getVideoTracks: () => [track], _track: track };
            window.__stream = stream;
            return stream;
          },
        };
        if (opts.devices) {
          window.navigator.mediaDevices.enumerateDevices = async () => opts.devices;
        }
      }

      // Fake MediaRecorder.
      window.MediaRecorder = class FakeMediaRecorder {
        static isTypeSupported() { return true; }
        constructor(stream) { this.stream = stream; this.state = 'inactive'; this.mimeType = 'video/webm'; window.__recorders.push(this); }
        start() { this.state = 'recording'; }
        stop() {
          this.state = 'inactive';
          if (this.ondataavailable) this.ondataavailable({ data: new window.Blob(['clip-bytes'], { type: 'video/webm' }) });
          if (this.onstop) this.onstop();
        }
      };

      window.__loadTracker = async () => {
        if (faceMeshMode === 'missing') throw new Error('Simulated tracker load failure');
        return {
          async createFaceTracker(onResults) {
            window.__faceMeshCount += 1;
            window.__faceMeshCb = onResults;
            return {
              async send() {
                window.__sendCalls += 1;
                if (window.__sendNever) await new Promise(() => {});
                else await sleep(5);
              },
            };
          },
        };
      };
    },
  });

  const { window } = dom;
  const { document } = window;
  await new Promise((res) => {
    if (document.readyState === 'complete') res();
    else window.addEventListener('load', res);
    setTimeout(res, 8000);
  });
  await sleep(200);
  const q = (s) => document.querySelector(s);
  return { window, document, q, errors, contexts };
}

function overlayCalls(page) {
  return page.contexts.length ? page.contexts[0].calls : [];
}
function pointDrawCount(page) {
  return overlayCalls(page).filter((c) => c.method === 'arc').length;
}

async function testInitialRender() {
  console.log('initial render');
  const page = await makePage();
  const { q, errors } = page;
  check('first screen and guide explain the scope of the prototype',
    q('.scope-note').textContent.includes('Transcription is unavailable') &&
    q('.honest-note').textContent.includes('cannot turn speech into text'));
  check('pill starts at "Model: not loaded"', q('#modelPill').textContent === 'Model: not loaded');
  check('Start enabled, Stop/Record/Snapshot disabled',
    !q('#startBtn').disabled && q('#stopBtn').disabled && q('#recordBtn').disabled && q('#snapshotBtn').disabled);
  check('clip count is "0 clips"', q('#clipCount').textContent === '0 clips');
  check('empty-clips message shown', !!q('#clipEmpty'));
  check('record button aria-pressed is false', q('#recordBtn').getAttribute('aria-pressed') === 'false');
  check('no JS errors on load', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testCdnFailure() {
  console.log('CDN failure fallback');
  const page = await makePage({ faceMesh: 'missing' });
  const { q, errors } = page;
  check('model stays unloaded until camera starts', q('#modelPill').textContent === 'Model: not loaded');
  check('face-box guide hidden until camera starts', q('#faceGuide').hidden === true);
  q('#startBtn').click();
  await sleep(300);
  check('pill reports model failed', q('#modelPill').textContent.includes('failed'));
  check('status explains the CDN failure', q('#statusLine').textContent.includes('did not load from the CDN'));
  check('face-box guide appears once camera is on', q('#faceGuide').hidden === false);
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testTrackingDraw() {
  console.log('tracking draw path');
  const page = await makePage();
  const { window, q, errors } = page;
  q('#startBtn').click();
  await sleep(400);
  check('pill shows loading while model starts', q('#modelPill').textContent.includes('loading'), q('#modelPill').textContent);
  window.__faceMeshCb({ multiFaceLandmarks: [LANDMARKS()] });
  await sleep(300);
  check('pill flips to loaded after results', q('#modelPill').textContent.includes('loaded'));
  check('status says lip tracking active', q('#statusLine').textContent.includes('Lip tracking active'));
  check('lip points and outlines drawn', pointDrawCount(page) === 40 &&
    overlayCalls(page).filter(call => call.method === 'closePath').length === 4);
  check('face guide stays hidden when loaded', q('#faceGuide').hidden === true);
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testNoFaceAndMalformed() {
  console.log('no-face + malformed results');
  const page = await makePage();
  const { window, q, errors } = page;
  q('#startBtn').click();
  await sleep(300);
  window.__faceMeshCb({ multiFaceLandmarks: [] });
  await sleep(150);
  check('empty face list explains how to return to frame',
    q('#trackStats').textContent.includes('no face in frame. Move into view.'));
  // Malformed results must never throw inside the tracking loop.
  window.__faceMeshCb(null);
  window.__faceMeshCb(undefined);
  window.__faceMeshCb({ multiFaceLandmarks: [{ x: 0.5, y: 0.5 }] }); // 1 landmark, not 468
  window.__faceMeshCb({ multiFaceLandmarks: [null] });
  window.__faceMeshCb({});
  await sleep(200);
  check('malformed results do not throw', errors.length === 0, JSON.stringify(errors));
  check('pill still loaded after malformed frames', q('#modelPill').textContent.includes('loaded'));
  page.window.close();
}

async function testStopWhileLoading() {
  console.log('stop while loading + FaceMesh reuse');
  const page = await makePage({ sendNever: true });
  const { window, q, errors } = page;
  q('#startBtn').click();
  await sleep(300);
  check('pill is loading', q('#modelPill').textContent.includes('loading'));
  q('#stopBtn').click();
  await sleep(150);
  check('pill resets to not loaded after stop', q('#modelPill').textContent === 'Model: not loaded', q('#modelPill').textContent);
  check('Start re-enabled after stop', !q('#startBtn').disabled);
  q('#startBtn').click();
  await sleep(300);
  check('FaceMesh instance reused on restart (no leak)', window.__faceMeshCount === 1, `instances: ${window.__faceMeshCount}`);
  check('pill is loading again on retry', q('#modelPill').textContent.includes('loading'));
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testLateResultIgnored() {
  console.log('late-result race');
  const page = await makePage();
  const { window, q, errors } = page;
  q('#startBtn').click();
  await sleep(300);
  window.__faceMeshCb({ multiFaceLandmarks: [LANDMARKS()] });
  await sleep(200);
  const drawsBeforeStop = pointDrawCount(page);
  check('loaded before stop', q('#modelPill').textContent.includes('loaded'));
  q('#stopBtn').click();
  await sleep(150);
  window.__faceMeshCb({ multiFaceLandmarks: [LANDMARKS()] }); // late result
  await sleep(200);
  check('late result draws nothing after stop', pointDrawCount(page) === drawsBeforeStop,
    `before ${drawsBeforeStop}, after ${pointDrawCount(page)}`);
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();

  // Variant: stop while still loading, then a late result must not flip the pill.
  const page2 = await makePage({ sendNever: true });
  page2.q('#startBtn').click();
  await sleep(300);
  page2.q('#stopBtn').click();
  await sleep(150);
  page2.window.__faceMeshCb({ multiFaceLandmarks: [LANDMARKS()] });
  await sleep(200);
  check('late result does not revive pill after stop-while-loading',
    page2.q('#modelPill').textContent === 'Model: not loaded', page2.q('#modelPill').textContent);
  check('no JS errors (variant)', page2.errors.length === 0, JSON.stringify(page2.errors));
  page2.window.close();
}

async function testRecordingFlow() {
  console.log('recording flow');
  const page = await makePage();
  const { window, q, errors } = page;
  q('#startBtn').click();
  await sleep(300);
  q('#recordBtn').click();
  await sleep(150);
  check('record button shows stop state + aria-pressed true',
    q('#recordBtn').textContent.includes('Stop recording') && q('#recordBtn').getAttribute('aria-pressed') === 'true');
  q('#recordBtn').click();
  await sleep(300);
  check('clip added, count is "1 clip"', q('#clipCount').textContent === '1 clip', q('#clipCount').textContent);
  check('clip has a Download link with download attribute',
    !!q('.clip .download-btn') && q('.clip .download-btn').getAttribute('download') === 'silent-speech-clip-1.webm');
  check('clip video src is the blob URL', q('.clip video').getAttribute('src') === 'blob:fake-clip');
  q('.clip .transcribe-btn').click();
  await sleep(100);
  check('Transcribe says plainly it is not available',
    q('.clip .clip-note').textContent.includes('not available in this prototype'));
  check('Transcribe button disables after one click', q('.clip .transcribe-btn').disabled === true);
  q('.clip .delete-btn').click();
  await sleep(100);
  check('delete removes clip, count back to 0', q('#clipCount').textContent === '0 clips');
  check('empty-clips message returns', !!q('#clipEmpty'));
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testSnapshot() {
  console.log('snapshot');
  const page = await makePage();
  const { window, q, errors, contexts } = page;
  q('#startBtn').click();
  await sleep(300);
  window.__faceMeshCb({ multiFaceLandmarks: [LANDMARKS()] });
  await sleep(200);
  const ctxCountBefore = contexts.length;
  q('#snapshotBtn').click();
  await sleep(200);
  check('snapshot creates a new canvas', contexts.length === ctxCountBefore + 1, `${ctxCountBefore} -> ${contexts.length}`);
  const snapCalls = contexts[contexts.length - 1].calls.filter((c) => c.method === 'drawImage');
  check('snapshot draws video frame + lip overlay (2 drawImage calls)', snapCalls.length === 2, `drawImage calls: ${snapCalls.length}`);
  const snapClick = window.__anchorClicks.find((a) => (a.download || '').startsWith('silent-speech-'));
  check('snapshot triggers a download named silent-speech-*.png',
    !!snapClick && snapClick.download.endsWith('.png'), JSON.stringify(snapClick || null));
  check('status confirms the snapshot saved', q('#statusLine').textContent.includes('snapshot saved'));
  await sleep(3200);
  check('status line restores after a few seconds', q('#statusLine').textContent.includes('Lip tracking') || q('#statusLine').textContent.includes('Loading lip tracking'));
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testTrackEnded() {
  console.log('unexpected camera-track end');
  const page = await makePage();
  const { window, q, errors } = page;
  q('#startBtn').click();
  await sleep(300);
  check('camera on before track ends', q('#cameraStatusText').textContent === 'Camera on');
  window.__stream._track.handlers.ended();
  await sleep(200);
  check('camera shows off after track ends', q('#cameraStatusText').textContent === 'Camera off');
  check('Start re-enabled after unexpected stop', !q('#startBtn').disabled);
  check('status explains the camera stopped unexpectedly',
    q('#statusLine').textContent.includes('stopped unexpectedly'));
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testCameraDenied() {
  console.log('camera denied');
  const page = await makePage({ gum: 'denied' });
  const { q, errors } = page;
  q('#startBtn').click();
  await sleep(300);
  check('status says plainly that permission was denied (no raw error name)',
    q('#statusLine').textContent.includes('permission was denied') &&
    !q('#statusLine').textContent.includes('NotAllowedError'));
  check('Start re-enabled so the user can retry', !q('#startBtn').disabled);
  check('Stop stays disabled', q('#stopBtn').disabled === true);
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testCameraNotFound() {
  console.log('no camera on device');
  const page = await makePage({ gum: 'notfound' });
  const { q, errors } = page;
  q('#startBtn').click();
  await sleep(300);
  check('status says plainly that no camera was found',
    q('#statusLine').textContent.includes('no camera was found') &&
    !q('#statusLine').textContent.includes('NotFoundError'));
  check('missing-camera advice is not "allow camera access"',
    !q('#statusLine').textContent.includes('Allow camera access'));
  check('Start re-enabled', !q('#startBtn').disabled);
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testUnknownCameraError() {
  console.log('unknown camera error name');
  const page = await makePage({ gum: 'unknown' });
  const { q, errors } = page;
  q('#startBtn').click();
  await sleep(300);
  check('unknown error gets a neutral message, not a permission blame',
    q('#statusLine').textContent.includes('could not be started') &&
    !q('#statusLine').textContent.includes('permission was denied'),
    q('#statusLine').textContent);
  check('no raw error name leaks to the user',
    !q('#statusLine').textContent.includes('WeirdError'));
  check('Start re-enabled', !q('#startBtn').disabled);
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testSwitchClearsStaleLipPoints() {
  console.log('switch clears stale lip points');
  const devices = [
    { kind: 'videoinput', deviceId: 'cam1', label: 'Front camera' },
    { kind: 'videoinput', deviceId: 'cam2', label: 'Back camera' },
  ];
  const page = await makePage({ devices, defaultDeviceId: 'cam2' });
  const { window, q, errors } = page;
  q('#startBtn').click();
  await sleep(400);
  window.__faceMeshCb({ multiFaceLandmarks: [LANDMARKS()] });
  await sleep(200);
  const clearRects = () => overlayCalls(page).filter((c) => c.method === 'clearRect').length;
  const clearsBefore = clearRects();
  const drawsBefore = pointDrawCount(page);
  q('#switchBtn').click();
  await sleep(400);
  check('switch wipes the overlay canvas before the new camera draws',
    clearRects() > clearsBefore, `clearRect ${clearsBefore} -> ${clearRects()}`);
  // Feed a frame with one lip point missing. A fresh seed draws 39 lip
  // points (78 draw calls); stale smoothed points carried over from the old
  // camera would keep the missing point alive and draw all 40 (80 calls).
  const sparse = LANDMARKS();
  sparse[61] = null;
  window.__faceMeshCb({ multiFaceLandmarks: [sparse] });
  await sleep(200);
  const frameDraws = pointDrawCount(page) - drawsBefore;
  check('first frame after switch seeds fresh lip points (39, not 40)',
    frameDraws === 39, `draws: ${frameDraws}`);
  check('camera still on after switch', q('#cameraStatusText').textContent === 'Camera on');
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testSwitchAfterStop() {
  console.log('switch camera after stop');
  const devices = [
    { kind: 'videoinput', deviceId: 'cam1', label: 'Front camera' },
    { kind: 'videoinput', deviceId: 'cam2', label: 'Back camera' },
  ];
  const page = await makePage({ devices, defaultDeviceId: 'cam2' });
  const { window, q, errors } = page;
  q('#startBtn').click();
  await sleep(400);
  q('#stopBtn').click();
  await sleep(200);
  check('camera off after stop', q('#cameraStatusText').textContent === 'Camera off');
  check('switch button stays visible after stop', q('#switchBtn').hidden === false);
  q('#switchBtn').click();
  await sleep(400);
  const secondCall = window.__gumCalls[1];
  check('switch after stop starts the other camera',
    !!secondCall && secondCall.video && secondCall.video.deviceId && secondCall.video.deviceId.exact === 'cam1',
    JSON.stringify(secondCall || null));
  check('camera on again after switch-after-stop', q('#cameraStatusText').textContent === 'Camera on');
  check('Start disabled while the switched camera runs', q('#startBtn').disabled === true);
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testSwitchFailureKeepsReason() {
  console.log('failed switch keeps the specific reason');
  const devices = [
    { kind: 'videoinput', deviceId: 'cam1', label: 'Front camera' },
    { kind: 'videoinput', deviceId: 'cam2', label: 'Back camera' },
  ];
  // The second camera is gone by the time Switch asks for it.
  const page = await makePage({ devices, defaultDeviceId: 'cam2', gumErrorOnCall: { 2: 'NotFoundError' } });
  const { q, errors } = page;
  q('#startBtn').click();
  await sleep(400);
  q('#switchBtn').click();
  await sleep(400);
  check('failed switch says it could not switch',
    q('#statusLine').textContent.includes('could not switch camera'));
  check('failed switch keeps the real reason (no camera was found)',
    q('#statusLine').textContent.includes('no camera was found'), q('#statusLine').textContent);
  check('old "previous camera is off" wording is gone',
    !q('#statusLine').textContent.includes('previous camera is off'));
  check('camera off after failed switch', q('#cameraStatusText').textContent === 'Camera off');
  check('Start re-enabled after failed switch', !q('#startBtn').disabled);
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testFortyLandmarksCopy() {
  console.log('40 lip landmarks, not 468');
  const page = await makePage();
  const { q, errors } = page;
  check('hero says 40 lip landmarks and never 468',
    q('.intro-copy').textContent.includes('40 lip landmarks') &&
    !q('.intro-copy').textContent.includes('468'), q('.intro-copy').textContent);
  check('viewfinder labels the reference contour', q('.stage-index').textContent.includes('40 points'));
  check('reference contains two 20-point contours',
    [...page.document.querySelectorAll('.contour-line')].map(polygon => polygon.getAttribute('points').split(' ').length).join(',') === '20,20');
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testCapNoticeSurvivesStop() {
  console.log('clip-cap notice survives Stop camera');
  const page = await makePage();
  const { q, errors } = page;
  q('#startBtn').click();
  await sleep(300);
  for (let i = 0; i < 13; i += 1) await recordOne(page);
  check('cap notice shows after the 13th clip',
    q('#statusLine').textContent.toLowerCase().includes('oldest clip removed'), q('#statusLine').textContent);
  q('#stopBtn').click();
  await sleep(200);
  check('cap notice still there after Stop camera',
    /oldest clip removed/i.test(q('#statusLine').textContent), q('#statusLine').textContent);
  check('camera really is off', q('#cameraStatusText').textContent === 'Camera off');
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testThemeToggle() {
  console.log('dark/light theme toggle');
  const page = await makePage();
  const { window, q, errors } = page;
  check('default theme is dark (no stored choice, OS prefers dark)',
    window.document.documentElement.getAttribute('data-theme') === 'dark');
  check('toggle button offers Light mode', q('#themeBtn').textContent === 'Light mode');
  q('#themeBtn').click();
  await sleep(100);
  check('toggle switches to light', window.document.documentElement.getAttribute('data-theme') === 'light');
  check('choice is stored', window.localStorage.getItem('ssn-theme') === 'light');
  check('toggle button now offers Dark mode', q('#themeBtn').textContent === 'Dark mode');
  q('#themeBtn').click();
  await sleep(100);
  check('toggle switches back to dark', window.document.documentElement.getAttribute('data-theme') === 'dark');
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();

  // OS prefers light: the page starts light without any stored choice.
  const osLight = await makePage({ matchMediaLight: true });
  check('OS light preference starts the page light',
    osLight.window.document.documentElement.getAttribute('data-theme') === 'light');
  osLight.window.close();

  // A stored choice beats the OS preference.
  const stored = await makePage({ storedTheme: 'light', matchMediaLight: false });
  check('stored light choice beats an OS dark preference',
    stored.window.document.documentElement.getAttribute('data-theme') === 'light');
  stored.window.close();
}

async function testSwitchCamera() {
  console.log('switch camera');
  const devices = [
    { kind: 'videoinput', deviceId: 'cam1', label: 'Front camera' },
    { kind: 'videoinput', deviceId: 'cam2', label: 'Back camera' },
  ];
  // The browser opens the second enumerated camera by default — Switch must
  // move to a genuinely different camera, not re-select the one in use.
  const page = await makePage({ devices, defaultDeviceId: 'cam2' });
  const { window, q, errors } = page;
  check('switch button hidden before camera starts', q('#switchBtn').hidden === true);
  q('#startBtn').click();
  await sleep(400);
  check('switch button appears with 2 cameras', q('#switchBtn').hidden === false);
  check('res chip names the real camera in use',
    q('#resChip').textContent.includes('Back camera'), q('#resChip').textContent);
  q('#switchBtn').click();
  await sleep(400);
  const secondCall = window.__gumCalls[1];
  check('switch requests the other camera by deviceId',
    !!secondCall && secondCall.video && secondCall.video.deviceId && secondCall.video.deviceId.exact === 'cam1',
    JSON.stringify(secondCall || null));
  check('camera still on after switch', q('#cameraStatusText').textContent === 'Camera on');
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();

  // One camera only: no switch button, ever.
  const single = await makePage({ devices: [{ kind: 'videoinput', deviceId: 'cam1', label: 'Only' }] });
  single.q('#startBtn').click();
  await sleep(400);
  check('switch button stays hidden with 1 camera', single.q('#switchBtn').hidden === true);
  check('no JS errors (single camera)', single.errors.length === 0, JSON.stringify(single.errors));
  single.window.close();
}

async function recordOne(page) {
  const { q } = page;
  q('#recordBtn').click();
  await sleep(80);
  q('#recordBtn').click();
  await sleep(200);
}

async function testClipNumbering() {
  console.log('clip numbering after delete');
  const page = await makePage();
  const { q, errors, document } = page;
  q('#startBtn').click();
  await sleep(300);
  await recordOne(page);
  await recordOne(page);
  check('two clips recorded', q('#clipCount').textContent === '2 clips', q('#clipCount').textContent);
  // Newest clip is first in the list; delete it.
  document.querySelectorAll('.clip')[0].querySelector('.delete-btn').click();
  await sleep(100);
  check('count back to 1 after delete', q('#clipCount').textContent === '1 clip');
  await recordOne(page);
  check('next clip keeps a fresh number (no reuse after delete)',
    !!document.querySelector('.download-btn[download="silent-speech-clip-3.webm"]'));
  check('count is 2 again', q('#clipCount').textContent === '2 clips');
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testClipCap() {
  console.log('12-clip cap');
  const page = await makePage();
  const { q, errors, document } = page;
  q('#startBtn').click();
  await sleep(300);
  for (let i = 0; i < 13; i += 1) await recordOne(page);
  check('list caps at 12 clips', q('#clipCount').textContent === '12 clips', q('#clipCount').textContent);
  check('oldest clip (Clip 1) was dropped',
    !document.querySelector('.download-btn[download="silent-speech-clip-1.webm"]'));
  check('newest clip (Clip 13) is kept',
    !!document.querySelector('.download-btn[download="silent-speech-clip-13.webm"]'));
  check('cap notice survives in the status line (not overwritten by the refresh)',
    q('#statusLine').textContent.toLowerCase().includes('oldest clip removed'), q('#statusLine').textContent);
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testTrackStats() {
  console.log('live track stats');
  const page = await makePage();
  const { window, q, errors } = page;
  check('stats line starts empty', q('#trackStats').textContent === '');
  q('#startBtn').click();
  await sleep(300);
  window.__faceMeshCb({ multiFaceLandmarks: [LANDMARKS()] });
  await sleep(400);
  check('stats show fps from real results', q('#trackStats').textContent.includes('fps'), q('#trackStats').textContent);
  check('stats show lip aperture', q('#trackStats').textContent.includes('Lip aperture'), q('#trackStats').textContent);
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testFpsRealRate() {
  console.log('fps reflects the real frame rate');
  const page = await makePage();
  const { window, q, errors } = page;
  q('#startBtn').click();
  await sleep(300);
  // Seven results in ~350 ms: the stats line repaints at ~4 Hz, but the fps
  // number must count every result. (Sampling inside the throttled repaint
  // used to cap the readout at ~4 fps however fast tracking ran.)
  for (let i = 0; i < 6; i += 1) window.__faceMeshCb({ multiFaceLandmarks: [LANDMARKS()] });
  await sleep(300);
  window.__faceMeshCb({ multiFaceLandmarks: [LANDMARKS()] });
  await sleep(300);
  const m = q('#trackStats').textContent.match(/(\d+) fps/);
  const fps = m ? parseInt(m[1], 10) : 0;
  check('fps counts every result, not the repaint rate (>= 5)', fps >= 5, q('#trackStats').textContent);
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testSmoothingNanRecovery() {
  console.log('EMA recovers from a null point on the first frame');
  const page = await makePage();
  const { window, q, errors } = page;
  q('#startBtn').click();
  await sleep(300);
  const before = pointDrawCount(page);
  const sparse = LANDMARKS();
  sparse[61] = null; // outer lip corner missing on the first frame
  window.__faceMeshCb({ multiFaceLandmarks: [sparse] });
  await sleep(150);
  // One frame: 39 lip-point arcs + 19 outer + 20 inner polyline calls = 78.
  const firstFrameDraws = pointDrawCount(page) - before;
  window.__faceMeshCb({ multiFaceLandmarks: [LANDMARKS()] });
  await sleep(150);
  // Full frame: 40 arcs + 20 + 20 = 80. Without the NaN snap the missing
  // point would stay NaN forever and this frame would draw 78 again.
  const secondFrameDraws = pointDrawCount(page) - before - firstFrameDraws;
  check('first frame draws 39 lip points (one missing)', firstFrameDraws === 39, `draws: ${firstFrameDraws}`);
  check('second frame draws all 40 lip points again (no NaN poisoning)', secondFrameDraws === 40, `draws: ${secondFrameDraws}`);
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

async function testHiddenAttributeHonoured() {
  console.log('[hidden] actually hides elements');
  const page = await makePage();
  const { window, q, errors } = page;
  const display = (sel) => window.getComputedStyle(q(sel)).display;
  check('face-box guide is display:none on load', display('#faceGuide') === 'none', display('#faceGuide'));
  check('res chip is display:none on load', display('#resChip') === 'none', display('#resChip'));
  check('REC chip is display:none on load', display('#recHud') === 'none', display('#recHud'));
  check('switch button is display:none on load', display('#switchBtn') === 'none', display('#switchBtn'));
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();

  // And the reverse: with the camera on and the model failed, the guide and
  // the res chip must actually show.
  const failed = await makePage({ faceMesh: 'missing' });
  failed.q('#startBtn').click();
  await sleep(300);
  const fdisplay = (sel) => failed.window.getComputedStyle(failed.q(sel)).display;
  check('face-box guide shows once camera is on and model failed', fdisplay('#faceGuide') !== 'none', fdisplay('#faceGuide'));
  check('res chip shows once camera is on', fdisplay('#resChip') !== 'none', fdisplay('#resChip'));
  check('REC chip stays hidden while not recording', fdisplay('#recHud') === 'none', fdisplay('#recHud'));
  check('no JS errors (fallback)', failed.errors.length === 0, JSON.stringify(failed.errors));
  failed.window.close();
}

async function testNoCameraApi() {
  console.log('no camera API at all');
  const page = await makePage({ gum: 'missing' });
  const { q, errors } = page;
  q('#startBtn').click();
  await sleep(300);
  check('status says the browser does not expose camera access (no raw TypeError)',
    q('#statusLine').textContent.includes('does not expose camera access') &&
    !q('#statusLine').textContent.includes('TypeError'));
  check('Start re-enabled', !q('#startBtn').disabled);
  check('no JS errors', errors.length === 0, JSON.stringify(errors));
  page.window.close();
}

function testStaticCss() {
  console.log('static CSS sanity');
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const opens = (css.match(/\{/g) || []).length;
  const closes = (css.match(/\}/g) || []).length;
  check('style.css braces balance', opens === closes && opens > 0, `{ ${opens} } ${closes}`);
  check('no TODO/FIXME left in CSS', !/TODO|FIXME/.test(css));
}

async function main() {
  await testInitialRender();
  await testCdnFailure();
  await testTrackingDraw();
  await testNoFaceAndMalformed();
  await testStopWhileLoading();
  await testLateResultIgnored();
  await testRecordingFlow();
  await testSnapshot();
  await testTrackEnded();
  await testCameraDenied();
  await testCameraNotFound();
  await testUnknownCameraError();
  await testSwitchCamera();
  await testSwitchClearsStaleLipPoints();
  await testSwitchAfterStop();
  await testSwitchFailureKeepsReason();
  await testFortyLandmarksCopy();
  await testClipNumbering();
  await testClipCap();
  await testCapNoticeSurvivesStop();
  await testTrackStats();
  await testFpsRealRate();
  await testSmoothingNanRecovery();
  await testHiddenAttributeHonoured();
  await testNoCameraApi();
  await testThemeToggle();
  testStaticCss();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('DRIVER ERROR:', e); process.exit(1); });
