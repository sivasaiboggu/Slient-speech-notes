/* Silent-Speech Notes — prototype
 *
 * Camera preview + MediaPipe Face Mesh lip-landmark visualisation.
 * NO lip-reading / transcription is performed here — there is no
 * recognition model in this prototype. The "Transcribe" button on each
 * clip says so explicitly.
 */

'use strict';

// ---------- DOM ----------
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');
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
let recordingChunks = [];
let recording = false;
let recordStartedAt = 0;
let clipTotal = 0;

// Lip landmark index sets (MediaPipe Face Mesh, 468 landmarks).
// Outer lip contour and inner lip contour, drawn as closed polylines.
const LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const LIPS_INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];

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

// ---------- Camera ----------
async function startCamera() {
  startBtn.disabled = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
  } catch (err) {
    startBtn.disabled = false;
    updateStatusLine();
    statusLine.textContent = `Status: camera could not start — ${err.name || 'permission denied'}. ` +
      'Allow camera access in the browser and try again.';
    return;
  }

  video.srcObject = stream;
  await video.play().catch(() => {});
  stageEmpty.style.display = 'none';
  cameraDot.classList.add('on');
  cameraStatusText.textContent = 'Camera on';
  stopBtn.disabled = false;
  recordBtn.disabled = false;
  snapshotBtn.disabled = false;
  resizeOverlay();

  initFaceMesh();
  updateStatusLine();
}

function stopCamera() {
  trackingActive = false;
  if (recording) stopRecording();
  if (modelWatchdog) { clearTimeout(modelWatchdog); modelWatchdog = null; }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  stageEmpty.style.display = 'flex';
  faceGuide.hidden = true;
  cameraDot.classList.remove('on', 'rec');
  cameraStatusText.textContent = 'Camera off';
  startBtn.disabled = false;
  stopBtn.disabled = true;
  recordBtn.disabled = true;
  snapshotBtn.disabled = true;
  setModelState(modelState === 'loaded' ? 'loaded' : modelState, ''); // keep model state, hide guide
  if (modelState !== 'failed') setModelState(modelState);
  updateStatusLine();
}

function resizeOverlay() {
  const rect = video.getBoundingClientRect();
  overlay.width = Math.max(1, Math.round(rect.width * window.devicePixelRatio));
  overlay.height = Math.max(1, Math.round(rect.height * window.devicePixelRatio));
}

// ---------- Face Mesh lip tracking ----------
function initFaceMesh() {
  if (modelState === 'loaded' || modelState === 'loading') return;
  if (typeof FaceMesh === 'undefined') {
    setModelState('failed', 'Face Mesh script did not load from the CDN (offline or blocked).');
    return;
  }
  setModelState('loading');
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
    trackingActive = true;
    lastResultsAt = 0;
    // Watchdog: if the model never produces a result, say so instead of spinning forever.
    modelWatchdog = setTimeout(() => {
      if (modelState === 'loading' && !lastResultsAt) {
        trackingActive = false;
        setModelState('failed', 'Model did not return results in time (CDN/model load failed).');
      }
    }, 20000);
    requestAnimationFrame(trackLoop);
  } catch (err) {
    trackingActive = false;
    setModelState('failed', `Face Mesh could not start: ${err.message || err}`);
  }
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
  lastResultsAt = Date.now();
  if (modelState !== 'loaded') setModelState('loaded');
  resizeOverlayIfNeeded();
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const faces = results.multiFaceLandmarks;
  if (!faces || faces.length === 0) {
    ctx.fillStyle = 'rgba(232, 236, 241, 0.85)';
    ctx.font = `${Math.round(overlay.height * 0.035)}px system-ui, sans-serif`;
    ctx.fillText('No face detected — move into frame', 16, 32);
    return;
  }
  drawLips(faces[0]);
}

let lastOverlaySize = '';
function resizeOverlayIfNeeded() {
  const key = `${video.videoWidth}x${video.videoHeight}`;
  if (key !== lastOverlaySize) {
    lastOverlaySize = key;
    overlay.width = video.videoWidth || overlay.width;
    overlay.height = video.videoHeight || overlay.height;
  }
}

function drawLips(landmarks) {
  const w = overlay.width;
  const h = overlay.height;
  const pts = (indices) => indices.map((i) => [landmarks[i].x * w, landmarks[i].y * h]);

  // Lip landmark points.
  ctx.fillStyle = '#4f8cff';
  for (const idx of [...LIPS_OUTER, ...LIPS_INNER]) {
    const x = landmarks[idx].x * w;
    const y = landmarks[idx].y * h;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, w * 0.004), 0, Math.PI * 2);
    ctx.fill();
  }

  // Lip outlines.
  const drawPolyline = (indices, color, width) => {
    const p = pts(indices);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    p.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.stroke();
  };
  drawPolyline(LIPS_OUTER, '#4f8cff', Math.max(2, w * 0.004));
  drawPolyline(LIPS_INNER, '#7fd0ff', Math.max(1.5, w * 0.003));
}

// ---------- Recording ----------
function pickMimeType() {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return candidates.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

function startRecording() {
  if (!stream || recording) return;
  if (!window.MediaRecorder) {
    statusLine.textContent = 'Status: MediaRecorder is not supported in this browser — recording unavailable.';
    return;
  }
  recordingChunks = [];
  try {
    mediaRecorder = new MediaRecorder(stream, { mimeType: pickMimeType() || undefined });
  } catch (err) {
    statusLine.textContent = `Status: could not start recording — ${err.message || err}`;
    return;
  }
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordingChunks.push(e.data); };
  mediaRecorder.onstop = onRecordingStopped;
  mediaRecorder.start(250);
  recording = true;
  recordStartedAt = Date.now();
  recordBtn.textContent = '■ Stop recording';
  recordBtn.classList.add('recording');
  cameraDot.classList.add('rec');
  updateStatusLine();
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  recording = false;
  recordBtn.textContent = '● Record clip';
  recordBtn.classList.remove('recording');
  cameraDot.classList.remove('rec');
  updateStatusLine();
}

function onRecordingStopped() {
  const durationSec = Math.max(0, Math.round((Date.now() - recordStartedAt) / 1000));
  const blob = new Blob(recordingChunks, { type: mediaRecorder.mimeType || 'video/webm' });
  if (!blob.size) {
    statusLine.textContent = 'Status: recording produced no data — clip discarded.';
    return;
  }
  addClip(URL.createObjectURL(blob), durationSec, blob.size);
  updateStatusLine();
}

function addClip(url, durationSec, sizeBytes) {
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
      <span>Clip ${clipTotal} · ${escapeHtml(stamp)}</span>
      <span>${durationSec}s · ${sizeKb} KB</span>
    </div>
    <div class="clip-actions">
      <button class="btn transcribe-btn" type="button">Transcribe</button>
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
}

// ---------- Snapshot ----------
function takeSnapshot() {
  if (!stream || video.readyState < 2) return;
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = `silent-speech-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  a.click();
}

// ---------- Wiring ----------
startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);
recordBtn.addEventListener('click', () => (recording ? stopRecording() : startRecording()));
snapshotBtn.addEventListener('click', takeSnapshot);
window.addEventListener('resize', resizeOverlay);
video.addEventListener('loadedmetadata', resizeOverlay);

// If the CDN script itself failed to load, say so as soon as the page is ready.
window.addEventListener('load', () => {
  if (typeof FaceMesh === 'undefined') {
    setModelState('failed', 'Face Mesh script did not load from the CDN (offline or blocked).');
  }
  updateStatusLine();
});
updateStatusLine();
