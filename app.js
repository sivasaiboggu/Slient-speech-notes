/* Camera lifecycle, live lip landmarks, silent recording and snapshots. */

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
const recordLabel = document.getElementById('recordLabel');
const snapshotBtn = document.getElementById('snapshotBtn');
const switchBtn = document.getElementById('switchBtn');
const trackStats = document.getElementById('trackStats');
const resChip = document.getElementById('resChip');
const recHud = document.getElementById('recHud');
const recTimer = document.getElementById('recTimer');
const recordMeter = document.getElementById('recordMeter');
const meterFill = recordMeter.firstElementChild;
const notebook = window.createNotebook(() => (recordBtn.disabled ? startBtn : recordBtn));
const styles = getComputedStyle(document.documentElement);
const signal = styles.getPropertyValue('--signal').trim() || '#ff837e';
const signalKeyline = styles.getPropertyValue('--signal-keyline').trim() || '#211719';

// ---------- State ----------
let stream = null;
let faceMesh = null;
let trackerLoad = null;
let trackingSession = 0;
let sendingSession = null;
let cameraRequestPending = false;
let modelState = 'not-loaded'; // not-loaded | loading | loaded | failed
let modelFailedReason = '';
let trackingActive = false;
let lastResultsAt = 0;
let modelWatchdog = null;
let activeCapture = null;
let recordTimerId = null;
let currentDeviceId = null;
let currentDeviceIndex = 0;
let videoDevices = [];
let smoothedLips = null; // EMA-smoothed lip points, normalised coords
let resultTimes = [];    // timestamps of recent results, for the fps readout
let lastStatsAt = 0;
let lastCameraError = ''; // plain-language reason from the last failed camera start
let clipCapNotice = '';   // cap sentence that must survive later status refreshes

const RECORD_LIMIT_MS = 60_000;
const SMOOTH_ALPHA = 0.5; // EMA factor for lip points (0.5 = steady, still responsive)

// Lip landmark indices in the MediaPipe face topology.
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
    'loaded': 'Model: loaded',
    'failed': 'Model: failed',
  };
  modelPill.textContent = labels[state] || state;
  modelPill.className = 'model-state' + (state === 'loaded' ? ' ok' : state === 'failed' ? ' bad' : state === 'loading' ? ' warn' : '');
  faceGuide.hidden = !stream || (state !== 'failed' && state !== 'loading');
  updateStatusLine();
}

function updateStatusLine(message) {
  const messages = {
    'not-loaded': 'Start the camera when you’re ready.',
    'loading': 'Loading lip tracking. You can record while you wait.',
    'loaded': 'Lip tracking active. Move your mouth to see the outline follow.',
    'failed': 'Lip tracking is unavailable.',
  };
  const current = message || (activeCapture ? 'Recording video only. Clips stop at one minute.' : stream ? messages[modelState] : 'Camera off. Start when you’re ready.');
  statusLine.textContent = [current, modelState === 'failed' && modelFailedReason, clipCapNotice].filter(Boolean).join(' ');
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
  }[name] || 'the camera could not be started'; // never blame permission for an unknown error
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
  if (cameraRequestPending || stream) return false;
  cameraRequestPending = true;
  const moveFocus = document.activeElement === startBtn;
  startBtn.disabled = true;
  switchBtn.disabled = true;
  updateStatusLine('Waiting for camera access…');
  const constraints = deviceId
    ? { video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }
    : defaultConstraints();
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    cameraRequestPending = false;
    startBtn.disabled = false;
    switchBtn.disabled = false;
    if (moveFocus) startBtn.focus();
    lastCameraError = describeCameraError(err);
    // The advice must match the cause: telling the user to allow camera
    // access when no camera exists (or the requested camera is gone) sends
    // them to fix the wrong thing.
    const advice = (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError'))
      ? 'Allow camera access in the browser and try again.'
      : (err && err.name === 'NotFoundError')
        ? 'Check that a camera is connected and try again.'
        : 'Try again.';
    statusLine.textContent = `Status: camera could not start — ${lastCameraError}. ${advice}`;
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
    cameraRequestPending = false;
    startBtn.disabled = false;
    switchBtn.disabled = false;
    if (moveFocus) startBtn.focus();
    lastCameraError = 'the preview could not play';
    statusLine.textContent = 'Status: camera started but the preview could not play — try again.';
    return false;
  }
  lastCameraError = ''; // a clean start clears the last failure's reason
  // If the camera disappears mid-session (unplugged, permission revoked,
  // another app takes it), the track fires 'ended' — stop cleanly and say so.
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    currentDeviceId = (videoTrack.getSettings && videoTrack.getSettings().deviceId) || deviceId || null;
    if (videoTrack.addEventListener) videoTrack.addEventListener('ended', onCameraTrackEnded);
  }
  syncCurrentDeviceIndex(deviceId);
  stageEmpty.hidden = true;
  stage.classList.add('live');
  cameraDot.classList.add('on');
  cameraStatusText.textContent = 'Camera on';
  stopBtn.disabled = false;
  recordBtn.disabled = false;
  snapshotBtn.disabled = false;
  updateResChip();
  syncOverlaySize();

  cameraRequestPending = false;
  switchBtn.disabled = false;
  if (moveFocus) stopBtn.focus();
  initFaceMesh();
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
  trackingSession += 1;
  trackingActive = false;
  const moveFocus = document.activeElement === stopBtn;
  if (activeCapture) stopRecording();
  if (modelWatchdog) { clearTimeout(modelWatchdog); modelWatchdog = null; }
  stopTracksOnly();
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  stageEmpty.hidden = false;
  stage.classList.remove('live');
  faceGuide.hidden = true;
  cameraDot.classList.remove('on', 'rec');
  cameraStatusText.textContent = 'Camera off';
  startBtn.disabled = false;
  stopBtn.disabled = true;
  if (moveFocus) startBtn.focus();
  recordBtn.disabled = true;
  snapshotBtn.disabled = true;
  updateResChip();
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
  // The device list only exists after permission, so the index picked at
  // Start time was a guess against an empty list. Re-sync now that the real
  // devices (and the real current deviceId from the track) are known — or
  // Switch can re-select the camera already in use.
  syncCurrentDeviceIndex();
  updateResChip();
}

async function switchCamera() {
  if (cameraRequestPending || videoDevices.length < 2) return;
  const next = videoDevices[(currentDeviceIndex + 1) % videoDevices.length];
  if (activeCapture) stopRecording();
  if (stream) stopTracksOnly();
  trackingSession += 1;
  trackingActive = false;
  stopBtn.disabled = true;
  recordBtn.disabled = true;
  snapshotBtn.disabled = true;
  // The old camera's lip points must not linger on the new camera's first
  // frames: drop the smoothed points and wipe the overlay now, before the
  // new camera's first result arrives.
  smoothedLips = null;
  resultTimes = [];
  lastStatsAt = 0;
  trackStats.textContent = '';
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const ok = await startCamera(next.deviceId);
  if (!ok) {
    // startCamera already wrote the specific reason to the status line; keep
    // it. A generic "could not switch" would hide whether the camera is
    // missing, denied, or in use — and Switch works after Stop too, so the
    // "previous camera is off" wording no longer fits every failure.
    const reason = lastCameraError || 'the camera could not be started';
    stopCamera();
    statusLine.textContent = `Status: could not switch camera — ${reason}. ` +
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

// Resolution + camera label chip. The label comes from enumerateDevices,
// which only carries real labels after permission — until then it is
// resolution only, never a guessed name.
function currentDeviceLabel() {
  if (!currentDeviceId) return '';
  const d = videoDevices.find((dev) => dev.deviceId === currentDeviceId);
  return d && d.label ? d.label : '';
}
function updateResChip() {
  if (!resChip) return;
  if (!stream) { resChip.hidden = true; return; }
  const res = `${video.videoWidth || '?'}×${video.videoHeight || '?'}`;
  const label = currentDeviceLabel();
  resChip.textContent = label ? `${res} · ${label}` : res;
  resChip.hidden = false;
}

// ---------- Face Landmarker lip tracking ----------
function loadFaceMesh() {
  if (trackerLoad) return trackerLoad;
  const controller = new AbortController();
  let timeout;
  const wait = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('Tracking model download timed out'));
    }, 30_000);
  });

  trackerLoad = Promise.race([
    import('./tracker.mjs').then(module => module.createFaceTracker(onFaceResults, controller.signal)),
    wait,
  ]).catch(error => {
    trackerLoad = null;
    throw error;
  }).finally(() => clearTimeout(timeout));
  return trackerLoad;
}

async function initFaceMesh() {
  const session = ++trackingSession;
  setModelState('loading');
  lastResultsAt = 0;
  lastStatsAt = 0;
  try {
    faceMesh = await loadFaceMesh();
    if (session !== trackingSession || !stream) return;
  } catch (error) {
    if (session === trackingSession && stream) {
      console.warn('[silent-speech] model load error:', error);
      setModelState('failed', 'The tracking model did not load from the CDN. Check your connection and restart the camera to retry.');
    }
    return;
  }
  trackingActive = true;
  armModelWatchdog();
  requestAnimationFrame(() => trackLoop(session));
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

async function trackLoop(session) {
  if (!trackingActive || !stream || session !== trackingSession) return;
  // MediaPipe processes one frame at a time, even across a camera restart.
  if (video.readyState >= 2 && sendingSession === null) {
    sendingSession = session;
    try {
      await faceMesh.send({ image: video });
    } catch (error) {
      if (session === trackingSession) {
        trackingActive = false;
        console.warn('[silent-speech] tracking error:', error);
        setModelState('failed', 'Restart the camera to retry tracking.');
      }
    } finally {
      sendingSession = null;
    }
  }
  if (trackingActive && session === trackingSession) requestAnimationFrame(() => trackLoop(session));
}

function onFaceResults(results) {
  // A result can arrive after Stop (an in-flight send resolving late) —
  // never draw it or flip the model state back to "loaded" then.
  if (!trackingActive || !stream || (sendingSession !== null && sendingSession !== trackingSession)) return;
  lastResultsAt = Date.now();
  // Sample every result for the fps readout, before any throttling: the
  // stats line only repaints at ~4 Hz, but the samples are per-frame, so the
  // fps number is the real frame rate. (Sampling inside the throttled stats
  // update capped the readout at ~4 fps no matter how fast tracking ran.)
  resultTimes.push(lastResultsAt);
  resultTimes = resultTimes.filter((t) => lastResultsAt - t < 1000);
  if (modelState !== 'loaded') setModelState('loaded');
  syncOverlaySize();
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  // Guard against a null/partial result: a malformed callback must never
  // throw inside the tracking loop.
  const faces = results && results.multiFaceLandmarks;
  if (!faces || faces.length === 0) {
    smoothedLips = null; // a new face must not drag points from the old one
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
    // A point missing on the first frame seeds NaN, and EMA around NaN stays
    // NaN forever — that lip point would never draw again. Snap a non-finite
    // stored point straight to the new one instead.
    if (!Number.isFinite(smoothedLips[k][0]) || !Number.isFinite(smoothedLips[k][1])) {
      smoothedLips[k][0] = pt.x;
      smoothedLips[k][1] = pt.y;
      return;
    }
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

  // A dark keyline keeps the signal readable over light camera footage.
  const outline = toPx(smooth.slice(0, 20));
  const opening = toPx(smooth.slice(20));
  const stroke = Math.max(1, w * 0.0015);
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
  for (const points of [outline, opening]) {
    drawPolyline(points, signalKeyline, stroke + 2);
    drawPolyline(points, signal, stroke);
  }

  ctx.fillStyle = signal;
  ctx.strokeStyle = signalKeyline;
  ctx.lineWidth = 1;
  for (const [x, y] of [...outline, ...opening]) {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1.5, w * 0.0022), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

// Live tracking readout: frames per second plus lip aperture — the vertical
// gap between the inner lips as a percentage of lip width. Both are computed
// from real tracking data, never invented; the line stays empty when the
// camera is off so it can never show a stale number.
function updateTrackStats(landmarks) {
  if (!trackStats) return;
  const now = Date.now();
  if (!landmarks) {
    // A face leaving the frame is a state change, not a repaint — show it at
    // once instead of waiting out the throttle below.
    lastStatsAt = now;
    trackStats.textContent = 'Tracking · no face in frame. Move into view.';
    return;
  }
  if (now - lastStatsAt < 250) return; // throttle DOM writes to ~4 Hz
  lastStatsAt = now;
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
    'video/webm;codecs=vp9',
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

function startRecordTimer(capture) {
  stopRecordTimer();
  const tick = () => {
    const elapsed = Math.min(performance.now() - capture.started, RECORD_LIMIT_MS);
    recTimer.textContent = formatElapsed(elapsed);
    meterFill.style.transform = `scaleX(${elapsed / RECORD_LIMIT_MS})`;
    if (elapsed >= RECORD_LIMIT_MS) stopRecording(true);
  };
  tick();
  recordTimerId = setInterval(tick, 200);
}

function stopRecordTimer() {
  if (recordTimerId) clearInterval(recordTimerId);
  recordTimerId = null;
}

function startRecording() {
  if (!stream || activeCapture) return;
  clipCapNotice = '';
  if (!window.MediaRecorder) {
    updateStatusLine('Recording is unavailable in this browser. You can still take a snapshot.');
    return;
  }

  // Each recorder owns its final chunks even if the next take starts first.
  const chunks = [];
  let capture;
  try {
    const recorder = new MediaRecorder(stream, {
      mimeType: pickMimeType() || undefined,
      videoBitsPerSecond: 2_500_000,
    });
    capture = { recorder, capturedAt: Date.now(), started: performance.now() };
    recorder.ondataavailable = ({ data }) => {
      if (data?.size) chunks.push(data);
      if (activeCapture === capture && performance.now() - capture.started >= RECORD_LIMIT_MS) stopRecording(true);
    };
    recorder.onerror = () => {
      capture.failed = true;
      if (activeCapture === capture) resetRecording();
      if (!activeCapture) updateStatusLine('Recording stopped before the clip could be saved. Try again.');
    };
    recorder.onstop = () => finishRecording(capture, chunks);
    recorder.start(250);
  } catch (err) {
    console.warn('[silent-speech] recording error:', err);
    updateStatusLine('Could not start recording. Try again.');
    return;
  }

  activeCapture = capture;
  recordLabel.textContent = 'Stop recording';
  recordBtn.classList.add('recording');
  recordBtn.setAttribute('aria-pressed', 'true');
  cameraDot.classList.add('rec');
  recHud.hidden = false;
  recordMeter.hidden = false;
  startRecordTimer(capture);
  updateStatusLine();
}

function finishRecording(capture, chunks) {
  if (activeCapture === capture) resetRecording();
  if (capture.failed) return;
  const blob = new Blob(chunks, { type: capture.recorder.mimeType || chunks[0]?.type || 'video/webm' });
  if (!blob.size) {
    if (!activeCapture) updateStatusLine('The recording was empty. Try recording a few seconds longer.');
    return;
  }

  const durationMs = capture.durationMs ?? performance.now() - capture.started;
  const wasPruned = notebook.addRecording({ blob, capturedAt: capture.capturedAt, durationMs });
  clipCapNotice = wasPruned ? `Oldest clip removed to keep the latest ${notebook.limit} unsaved clips.` : '';
  if (!activeCapture) updateStatusLine(capture.reachedLimit
    ? 'One-minute limit reached. Clip saved in this tab.'
    : 'Clip saved in this tab.');
}

function resetRecording() {
  activeCapture = null;
  recordLabel.textContent = 'Record clip';
  recordBtn.classList.remove('recording');
  recordBtn.setAttribute('aria-pressed', 'false');
  cameraDot.classList.remove('rec');
  recHud.hidden = true;
  recordMeter.hidden = true;
  stopRecordTimer();
}

function stopRecording(reachedLimit = false) {
  const capture = activeCapture;
  if (!capture) return;
  capture.durationMs = performance.now() - capture.started;
  capture.reachedLimit = reachedLimit;
  resetRecording();
  updateStatusLine('Finishing the clip…');
  if (capture.recorder.state !== 'inactive') capture.recorder.stop();
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
  updateStatusLine('Your snapshot saved to Downloads.');
  const confirmation = statusLine.textContent;
  setTimeout(() => {
    if (statusLine.textContent === confirmation) updateStatusLine();
  }, 3000);
}

// ---------- Wiring ----------
startBtn.addEventListener('click', () => startCamera());
stopBtn.addEventListener('click', stopCamera);
recordBtn.addEventListener('click', () => (activeCapture ? stopRecording() : startRecording()));
snapshotBtn.addEventListener('click', takeSnapshot);
if (switchBtn) switchBtn.addEventListener('click', switchCamera);
video.addEventListener('loadedmetadata', () => { syncOverlaySize(); updateResChip(); });
// The model watchdog must not fire while the tab is hidden (rAF is paused
// there, so "no results yet" says nothing about the model); re-arm it when
// the tab comes back.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && modelState === 'loading' && !lastResultsAt) armModelWatchdog();
});
