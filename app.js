/* Silent-Speech Notes — prototype
 *
 * Camera preview + MediaPipe Face Mesh lip-landmark visualisation.
 * NO lip-reading / transcription is performed here — there is no
 * recognition model in this prototype. The "Transcribe" button on each
 * clip says so explicitly.
 *
 * Design notes (senior pass, 21 Nov 2026):
 * - One overlay-sizing path: the canvas backing always matches the video
 *   frame, so landmarks map 1:1. No CSS-size/DPR sizing anywhere.
 * - Lip points are temporally smoothed (EMA) — raw per-frame landmarks
 *   jitter visibly; smoothing is what makes the overlay look tracked.
 * - Recording is session-scoped: each recording owns its chunks, mime
 *   type and start time in a closure, so stopping one clip and starting
 *   the next immediately cannot mix the two up.
 * - Camera errors are translated to plain language; the technical name
 *   goes to the console, never to the user.
 * - The model watchdog never fires while the tab is hidden (rAF is
 *   paused there, so "no results yet" says nothing about the model).
 */

'use strict';

// ---------- DOM ----------
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');
const stage = document.getElementById('stage');
const stageEmpty = document.getElementById('stageEmpty');
const faceGuide = document.getElementById('faceGuide');
const statusLine = document.getElementById('statusLine');
const cameraDot = document.getElementById('cameraDot');
const cameraStatusText = document.getElementById('cameraStatusText');
const modelPill = document.getElementById('modelPill');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const recordBtn = document.getElementById('recordBtn');
const snapshotBtn = document.getElementById('snapshotBtn');
const switchBtn = document.getElementById('switchBtn');
const trackStats = document.getElementById('trackStats');
const resChip = document.getElementById('resChip');
const recHud = document.getElementById('recHud');
const recTimer = document.getElementById('recTimer');
const clipList = document.getElementById('clipList');
const clipEmpty = document.getElementById('clipEmpty');
const clipCount = document.getElementById('clipCount');

// ---------- State ----------
let stream = null;
let faceMesh = null;
let modelState = 'not-loaded'; // not-loaded | loading | loaded | failed
let modelFailedReason = '';
let trackingActive = false;
let lastResultsAt = 0;
let modelWatchdog = null;
let mediaRecorder = null;
let recording = false;
let recordStartedAt = 0;
let recordTimerId = null;
let clipTotal = 0; // clips currently listed
let clipSeq = 0;   // monotonic clip number (never reused, survives deletes)
let currentDeviceId = null;
let currentDeviceIndex = 0;
let videoDevices = [];
let smoothedLips = null; // EMA-smoothed lip points, normalised coords
let resultTimes = [];    // timestamps of recent results, for the fps readout
let lastStatsAt = 0;

const MAX_CLIPS = 12;    // bound session memory: oldest clip drops off past this
const SMOOTH_ALPHA = 0.5; // EMA factor for lip points (0.5 = steady, still responsive)

// Lip landmark index sets (MediaPipe Face Mesh, 468 landmarks).
// Outer lip contour and inner lip contour, drawn as closed polylines.
const LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const LIPS_INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
const LIP_INDICES = [...LIPS_OUTER, ...LIPS_INNER];

// ---------- Status helpers ----------
function setModelState(state, reason) {
  modelState = state;
  if (reason) modelFailedReason = reason;
  const labels = {
    'not-loaded': 'Model: not loaded',
    'loading': 'Model: loading…',
    'loaded': 'Model: loaded ✓',
    'failed': 'Model: failed — face-box guide only',
  };
  modelPill.textContent = labels[state] || state;
  modelPill.className = 'pill' + (state === 'loaded' ? ' ok' : state === 'failed' ? ' bad' : state === 'loading' ? ' warn' : '');
  faceGuide.hidden = state !== 'failed' || !stream;
  updateStatusLine();
}

function updateStatusLine() {
  const cam = stream ? 'Camera on' : 'Camera off';
  const model = {
    'not-loaded': 'Model not loaded',
    'loading': 'Model loading…',
    'loaded': 'Lip tracking active',
    'failed': 'Model failed — showing face-box guide instead',
  }[modelState];
  const rec = recording ? ' · ● Recording' : '';
  statusLine.innerHTML = `Status: ${cam} · ${model}${rec}.` +
    (modelState === 'failed' && modelFailedReason
      ? ` <span class="warn-text">(${escapeHtml(modelFailedReason)})</span>` : '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Plain-language camera errors. The technical name goes to the console for
// debugging; the user sees a sentence they can act on.
function describeCameraError(err) {
  const name = (err && err.name) || '';
  const plain = {
    NotAllowedError: 'permission was denied',
    SecurityError: 'camera access needs a secure page (HTTPS)',
    NotFoundError: 'no camera was found on this device',
    NotReadableError: 'the camera is already in use by another app',
    OverconstrainedError: 'no camera matches the requested settings',
    AbortError: 'the camera request was interrupted',
    TypeError: 'this browser does not expose camera access',
  }[name] || 'permission was denied';
  if (err) console.warn('[silent-speech] camera error:', err);
  return plain;
}

// ---------- Camera ----------
function defaultConstraints() {
  return {
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: false,
  };
}

async function startCamera(deviceId) {
  startBtn.disabled = true;
  const constraints = deviceId
    ? { video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }
    : defaultConstraints();
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    startBtn.disabled = false;
    statusLine.textContent = `Status: camera could not start — ${describeCameraError(err)}. ` +
      'Allow camera access in the browser and try again.';
    return false;
  }

  video.srcObject = stream;
  try {
    await video.play();
  } catch (err) {
    // Camera granted but the preview could not play — do not leave the UI
    // claiming the camera is on. Release the tracks and report plainly.
    console.warn('[silent-speech] preview play failed:', err);
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    startBtn.disabled = false;
    statusLine.textContent = 'Status: camera started but the preview could not play — try again.';
    return false;
  }
  // If the camera disappears mid-session (unplugged, permission revoked,
  // another app takes it), the track fires 'ended' — stop cleanly and say so.
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    currentDeviceId = (videoTrack.getSettings && videoTrack.getSettings().deviceId) || deviceId || null;
    if (videoTrack.addEventListener) videoTrack.addEventListener('ended', onCameraTrackEnded);
  }
  syncCurrentDeviceIndex(deviceId);
  stageEmpty.style.display = 'none';
  stage.classList.add('live');
  cameraDot.classList.add('on');
  cameraStatusText.textContent = 'Camera on';
  stopBtn.disabled = false;
  recordBtn.disabled = false;
  snapshotBtn.disabled = false;
  if (resChip) {
    resChip.hidden = false;
    resChip.textContent = `${video.videoWidth || '?'}×${video.videoHeight || '?'}`;
  }
  syncOverlaySize();

  initFaceMesh();
  updateStatusLine();
  refreshCameraList(); // fire-and-forget: shows Switch camera when >1 device
  return true;
}

function stopTracksOnly() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
}

function stopCamera() {
  trackingActive = false;
  if (recording) stopRecording();
  if (modelWatchdog) { clearTimeout(modelWatchdog); modelWatchdog = null; }
  stopTracksOnly();
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  stageEmpty.style.display = 'flex';
  stage.classList.remove('live');
  faceGuide.hidden = true;
  cameraDot.classList.remove('on', 'rec');
  cameraStatusText.textContent = 'Camera off';
  startBtn.disabled = false;
  stopBtn.disabled = true;
  recordBtn.disabled = true;
  snapshotBtn.disabled = true;
  if (resChip) resChip.hidden = true;
  if (recHud) recHud.hidden = true;
  if (trackStats) trackStats.textContent = '';
  smoothedLips = null;
  resultTimes = [];
  // If the model was still loading, it never will now — don't leave the pill
  // stuck on "loading…". A later Start retries the load from scratch.
  // (A loaded model stays loaded across camera restarts, so only 'loading'
  // resets here; the FaceMesh instance is intentionally kept.)
  if (modelState === 'loading') setModelState('not-loaded');
  else updateStatusLine();
}

function onCameraTrackEnded() {
  // Guard: stopCamera() also stops the tracks, which fires 'ended' — but by
  // the time that event is delivered, stream is already null, so a clean stop
  // never reaches here. Only an unexpected disappearance does.
  if (!stream) return;
  stopCamera();
  statusLine.textContent = 'Status: camera stopped unexpectedly — it may have been ' +
    'unplugged or taken by another app. Press Start camera to try again.';
}

// Discover video inputs (after permission, so labels exist) and offer a
// Switch camera button only when there is actually something to switch to.
async function refreshCameraList() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoDevices = devices.filter((d) => d.kind === 'videoinput');
  } catch (err) {
    console.warn('[silent-speech] could not list cameras:', err);
    return;
  }
  if (switchBtn) switchBtn.hidden = videoDevices.length < 2;
}

async function switchCamera() {
  if (videoDevices.length < 2 || !stream) return;
  const next = videoDevices[(currentDeviceIndex + 1) % videoDevices.length];
  if (recording) stopRecording();
  stopTracksOnly();
  const ok = await startCamera(next.deviceId);
  if (!ok) {
    // startCamera already restored the Start button; tidy the rest of the UI.
    stopCamera();
    statusLine.textContent = 'Status: could not switch camera — the previous camera is off. ' +
      'Press Start camera to try again.';
  }
}

// Which entry of videoDevices is currently open. The track's getSettings()
// reports the real deviceId when the browser provides it; otherwise the
// explicitly requested deviceId wins; otherwise the default camera is
// conventionally the first enumerated device.
function syncCurrentDeviceIndex(deviceId) {
  let idx = -1;
  if (deviceId) idx = videoDevices.findIndex((d) => d.deviceId === deviceId);
  if (idx < 0 && currentDeviceId) idx = videoDevices.findIndex((d) => d.deviceId === currentDeviceId);
  currentDeviceIndex = idx >= 0 ? idx : 0;
}

// ---------- Overlay sizing (single source of truth) ----------
// The canvas backing always matches the video frame, so landmarks map 1:1.
// The old code sized the canvas to the CSS box × DPR in one place and to
// the video frame in another — both are proportional, but two sources of
// truth drift. This is the only place overlay.width/height are set.
let lastOverlayKey = '';
function syncOverlaySize() {
  const vw = video.videoWidth || 0;
  const vh = video.videoHeight || 0;
  let w;
  let h;
  if (vw > 0 && vh > 0) {
    w = vw;
    h = vh;
  } else {
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    w = Math.max(1, Math.round(rect.width * dpr));
    h = Math.max(1, Math.round(rect.height * dpr));
  }
  const key = `${w}x${h}`;
  if (key === lastOverlayKey) return;
  lastOverlayKey = key;
  overlay.width = w;
  overlay.height = h;
}

// ---------- Face Mesh lip tracking ----------
function initFaceMesh() {
  if (modelState === 'loaded' || modelState === 'loading') return;
  if (typeof FaceMesh === 'undefined') {
    setModelState('failed', 'Face Mesh script did not load from the CDN (offline or blocked).');
    return;
  }
  setModelState('loading');
  lastResultsAt = 0;
  // Reuse the existing FaceMesh instance across camera restarts and retries:
  // constructing a new one on every Start leaked an instance per cycle.
  if (!faceMesh) {
    try {
      faceMesh = new FaceMesh({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
      });
      faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      faceMesh.onResults(onFaceResults);
    } catch (err) {
      trackingActive = false;
      setModelState('failed', `Face Mesh could not start: ${err.message || err}`);
      return;
    }
  }
  trackingActive = true;
  // Watchdog: if the model never produces a result, say so instead of spinning
  // forever. 30s, not 20s — model weights over a slow mobile connection can
  // legitimately take longer than 20s, and a retry on the next Start is cheap.
  armModelWatchdog();
  requestAnimationFrame(trackLoop);
}

function armModelWatchdog() {
  if (modelWatchdog) clearTimeout(modelWatchdog);
  modelWatchdog = setTimeout(() => {
    if (modelState !== 'loading' || lastResultsAt) return;
    // rAF is paused while the tab is hidden, so no results arrive there —
    // that says nothing about the model. Wait for the tab to come back
    // instead of failing the model for being slow.
    if (document.visibilityState === 'hidden') {
      armModelWatchdog();
      return;
    }
    trackingActive = false;
    setModelState('failed', 'Model did not return results in time (CDN/model load failed).');
  }, 30000);
}

async function trackLoop() {
  if (!trackingActive || !stream) return;
  if (video.readyState >= 2 && faceMesh) {
    try {
      await faceMesh.send({ image: video });
    } catch (err) {
      trackingActive = false;
      setModelState('failed', `Tracking error: ${err.message || err}`);
      return;
    }
  }
  if (trackingActive) requestAnimationFrame(trackLoop);
}

function onFaceResults(results) {
  // A result can arrive after Stop (an in-flight send resolving late) —
  // never draw it or flip the model state back to "loaded" then.
  if (!trackingActive || !stream) return;
  lastResultsAt = Date.now();
  if (modelState !== 'loaded') setModelState('loaded');
  syncOverlaySize();
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  // Guard against a null/partial result: a malformed callback must never
  // throw inside the tracking loop.
  const faces = results && results.multiFaceLandmarks;
  if (!faces || faces.length === 0) {
    smoothedLips = null; // a new face must not drag points from the old one
    ctx.fillStyle = 'rgba(232, 236, 241, 0.85)';
    ctx.font = `${Math.round(overlay.height * 0.035)}px system-ui, sans-serif`;
    ctx.fillText('No face detected — move into frame', 16, 32);
    updateTrackStats(null);
    return;
  }
  const landmarks = faces[0];
  // A landmark set must be a full 468-point array; anything else (a single
  // point object, a short array, nulls) is skipped, never drawn from.
  if (!Array.isArray(landmarks) || landmarks.length < 468) return;
  drawLips(landmarks);
  updateTrackStats(landmarks);
}

// Temporal smoothing: raw per-frame landmarks jitter a few pixels, which
// reads as a shaky overlay. An exponential moving average on the 40 lip
// points steadies the drawing without perceptible lag (alpha 0.5).
function smoothLipPoints(landmarks) {
  if (!smoothedLips) {
    smoothedLips = LIP_INDICES.map((i) => {
      const pt = landmarks[i];
      return pt ? [pt.x, pt.y] : [NaN, NaN];
    });
    return smoothedLips;
  }
  LIP_INDICES.forEach((li, k) => {
    const pt = landmarks[li];
    if (!pt) return;
    smoothedLips[k][0] += SMOOTH_ALPHA * (pt.x - smoothedLips[k][0]);
    smoothedLips[k][1] += SMOOTH_ALPHA * (pt.y - smoothedLips[k][1]);
  });
  return smoothedLips;
}

function drawLips(landmarks) {
  const w = overlay.width;
  const h = overlay.height;
  const smooth = smoothLipPoints(landmarks);
  // smoothed layout: outer contour first (20), then inner (20).
  const toPx = (arr) => arr
    .map(([x, y]) => [x * w, y * h])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));

  // Lip landmark points (skip any index the model did not supply).
  ctx.fillStyle = '#4f8cff';
  for (const [x, y] of toPx(smooth)) {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, w * 0.004), 0, Math.PI * 2);
    ctx.fill();
  }

  // Lip outlines.
  const drawPolyline = (points, color, width) => {
    if (points.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.stroke();
  };
  drawPolyline(toPx(smooth.slice(0, 20)), '#4f8cff', Math.max(2, w * 0.004));
  drawPolyline(toPx(smooth.slice(20)), '#7fd0ff', Math.max(1.5, w * 0.003));
}

// Live tracking readout: frames per second plus lip aperture — the vertical
// gap between the inner lips as a percentage of lip width. Both are computed
// from real tracking data, never invented; the line stays empty when the
// camera is off so it can never show a stale number.
function updateTrackStats(landmarks) {
  if (!trackStats) return;
  const now = Date.now();
  if (now - lastStatsAt < 250) return; // throttle DOM writes to ~4 Hz
  lastStatsAt = now;
  if (!landmarks) {
    trackStats.textContent = 'Tracking · no face in frame';
    return;
  }
  resultTimes.push(now);
  resultTimes = resultTimes.filter((t) => now - t < 1000);
  const fps = resultTimes.length;
  // Smoothed points: outer 0–19, inner 20–39. Inner upper lip is index 13
  // (inner slot 5), inner lower lip is index 14 (inner slot 15); outer
  // corners are 61 (slot 0) and 291 (slot 10).
  const upper = smoothedLips && smoothedLips[25];
  const lower = smoothedLips && smoothedLips[35];
  const left = smoothedLips && smoothedLips[0];
  const right = smoothedLips && smoothedLips[10];
  let aperture = '—';
  if (upper && lower && left && right) {
    const width = Math.abs(right[0] - left[0]);
    if (width > 0.01) aperture = `${Math.round((Math.abs(lower[1] - upper[1]) / width) * 100)}%`;
  }
  trackStats.textContent = `Tracking · ${fps} fps · Lip aperture ${aperture}`;
}

// ---------- Recording ----------
function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  return candidates.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function startRecordTimer() {
  stopRecordTimer();
  const tick = () => { if (recTimer) recTimer.textContent = formatElapsed(Date.now() - recordStartedAt); };
  tick();
  recordTimerId = setInterval(tick, 500);
}

function stopRecordTimer() {
  if (recordTimerId) { clearInterval(recordTimerId); recordTimerId = null; }
}

function startRecording() {
  if (!stream || recording) return;
  if (!window.MediaRecorder) {
    statusLine.textContent = 'Status: MediaRecorder is not supported in this browser — recording unavailable.';
    return;
  }
  // Session-scoped state, captured in this closure: stopping this clip and
  // starting the next one immediately cannot mix the two recordings up.
  const chunks = [];
  const startedAt = Date.now();
  let recorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: pickMimeType() || undefined });
  } catch (err) {
    statusLine.textContent = `Status: could not start recording — ${err.message || err}`;
    return;
  }
  const mimeType = recorder.mimeType;
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => onRecordingStopped(chunks, mimeType, startedAt);
  recorder.start(250);
  mediaRecorder = recorder;
  recording = true;
  recordStartedAt = startedAt;
  recordBtn.textContent = '■ Stop recording';
  recordBtn.classList.add('recording');
  recordBtn.setAttribute('aria-pressed', 'true');
  cameraDot.classList.add('rec');
  if (recHud) recHud.hidden = false;
  startRecordTimer();
  updateStatusLine();
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  recording = false;
  recordBtn.textContent = '● Record clip';
  recordBtn.classList.remove('recording');
  recordBtn.setAttribute('aria-pressed', 'false');
  cameraDot.classList.remove('rec');
  if (recHud) recHud.hidden = true;
  stopRecordTimer();
  updateStatusLine();
}

function onRecordingStopped(chunks, mimeType, startedAt) {
  const durationSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
  if (!blob.size) {
    statusLine.textContent = 'Status: recording produced no data — clip discarded.';
    return;
  }
  addClip(URL.createObjectURL(blob), durationSec, blob.size);
  updateStatusLine();
}

function addClip(url, durationSec, sizeBytes) {
  clipSeq += 1;
  const n = clipSeq;
  clipTotal += 1;
  if (clipEmpty) clipEmpty.remove();
  clipCount.textContent = `${clipTotal} clip${clipTotal === 1 ? '' : 's'}`;

  const li = document.createElement('li');
  li.className = 'clip';
  const stamp = new Date().toLocaleTimeString();
  const sizeKb = Math.max(1, Math.round(sizeBytes / 1024));

  li.innerHTML = `
    <video controls playsinline src="${escapeHtml(url)}"></video>
    <div class="clip-meta">
      <span>Clip ${n} · ${escapeHtml(stamp)}</span>
      <span>${durationSec}s · ${sizeKb} KB</span>
    </div>
    <div class="clip-actions">
      <button class="btn transcribe-btn" type="button">Transcribe</button>
      <a class="btn download-btn" href="${escapeHtml(url)}" download="silent-speech-clip-${n}.webm">Download</a>
      <button class="btn delete-btn" type="button">Delete</button>
    </div>
    <p class="clip-note"></p>`;

  li.querySelector('.transcribe-btn').addEventListener('click', (e) => {
    const note = li.querySelector('.clip-note');
    note.textContent = 'Transcription is not available in this prototype — true lip-reading ' +
      'needs a dedicated trained model, which is not included. No transcript was generated.';
    e.currentTarget.disabled = true;
  });
  li.querySelector('.delete-btn').addEventListener('click', () => {
    URL.revokeObjectURL(url);
    li.remove();
    clipTotal -= 1;
    clipCount.textContent = `${clipTotal} clip${clipTotal === 1 ? '' : 's'}`;
    if (clipTotal === 0) clipList.appendChild(clipEmpty);
  });

  clipList.prepend(li);
  pruneClips();
}

// Clips live in memory as object URLs, so the list is capped — past the cap
// the oldest clip is dropped (and its URL revoked) instead of growing the
// session without bound.
function pruneClips() {
  const clips = clipList.querySelectorAll('.clip');
  if (clips.length <= MAX_CLIPS) return;
  for (let i = clips.length - 1; i >= MAX_CLIPS; i -= 1) {
    const old = clips[i];
    const v = old.querySelector('video');
    if (v && v.src) URL.revokeObjectURL(v.src);
    old.remove();
    clipTotal -= 1;
  }
  clipCount.textContent = `${clipTotal} clip${clipTotal === 1 ? '' : 's'}`;
  statusLine.textContent = `Status: oldest clip removed — keeping the latest ${MAX_CLIPS} clips in this session.`;
}

// ---------- Snapshot ----------
function takeSnapshot() {
  if (!stream || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  const sctx = c.getContext('2d');
  sctx.drawImage(video, 0, 0);
  // Include the lip-tracking overlay when tracking is live, so the snapshot
  // shows what the user actually saw (landmarks included).
  if (modelState === 'loaded') sctx.drawImage(overlay, 0, 0, c.width, c.height);
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = `silent-speech-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  a.click();
  // Confirm briefly, then restore the normal status line.
  statusLine.textContent = 'Status: snapshot saved — check your downloads folder.';
  setTimeout(updateStatusLine, 3000);
}

// ---------- Wiring ----------
startBtn.addEventListener('click', () => startCamera());
stopBtn.addEventListener('click', stopCamera);
recordBtn.addEventListener('click', () => (recording ? stopRecording() : startRecording()));
snapshotBtn.addEventListener('click', takeSnapshot);
if (switchBtn) switchBtn.addEventListener('click', switchCamera);
video.addEventListener('loadedmetadata', syncOverlaySize);
// The model watchdog must not fire while the tab is hidden (rAF is paused
// there, so "no results yet" says nothing about the model); re-arm it when
// the tab comes back.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && modelState === 'loading' && !lastResultsAt) armModelWatchdog();
});

// If the CDN script itself failed to load, say so as soon as the page is ready.
window.addEventListener('load', () => {
  if (typeof FaceMesh === 'undefined') {
    setModelState('failed', 'Face Mesh script did not load from the CDN (offline or blocked).');
  }
  updateStatusLine();
});
updateStatusLine();
