# Silent-Speech Notes — Prototype

A small single-page static web app that shows a live camera preview with
lip-region landmark tracking, and records short clips locally in the browser.

## What it does

- **Camera capture** — `getUserMedia` requests the camera and shows a live preview.
  Video never leaves the browser; nothing is uploaded.
- **Live lip-region tracking visualisation** — loads MediaPipe Face Mesh from the
  jsDelivr CDN (`@mediapipe/face_mesh`) and draws the lip landmark points and
  the outer/inner lip outlines on a canvas overlay in real time.
- **Graceful fallback** — if the Face Mesh script or model fails to load
  (offline, blocked CDN, or no result within 20 seconds), the app shows a
  dashed face-box guide overlay instead and says so in the status line and
  the model pill in the header.
- **Clip recording** — `MediaRecorder` records short clips from the camera
  stream. Clips are listed with playback, a timestamp, duration and size, and
  can be downloaded or deleted. Clips live only in the browser session; refreshing clears them.
- **Snapshot** — saves a still PNG of the current camera frame, **including
  the lip-tracking overlay** when tracking is live, and confirms with a short
  status message.
- **Status line** — always shows camera on/off, model loaded/failed, and
  recording state.
- **Resilient by design** — if the camera disappears mid-session (unplugged,
  permission revoked, another app takes it) the app stops cleanly and says so
  in plain language instead of freezing. The Face Mesh model gets up to 30
  seconds to return its first result (slow mobile connections), and a single
  model instance is reused across camera restarts. Malformed tracking results
  are skipped, never drawn from.

## What it does NOT do (important)

> **Prototype demo — true lip-reading transcription needs a dedicated trained
> model and is NOT included. No transcripts are generated or claimed.**

- It does **not** read lips or produce transcripts. The "Transcribe" button on
  each clip states clearly that transcription is not available in this prototype.
- It makes **no accuracy claims** — there is no recognition model here, only a
  landmark visualisation.
- It invents **no transcripts** anywhere.

Real silent-speech transcription would require a dedicated trained lip-reading
model (trained on video–text pairs, e.g. a visual speech recognition model),
which is out of scope for this prototype.

## Live demo

Camera access requires a secure context (HTTPS), so the demo needs a hosted
URL — it cannot be tested from a plain `http://` address on a phone.

- **Status (21 Nov 2026): no live URL yet.** Deploying to Vercel is blocked:
  the connected Vercel account's token is not authorised for the
  `sivasai1807s-projects` team scope (403 on every deploy call), and the
  team-access approval step has to be done by Siva. The fallback is GitHub
  Pages: enable it once in this repo (Settings → Pages → Deploy from branch
  `main`, `/` root) and the demo goes live at
  `https://sivasaiboggu.github.io/Slient-speech-notes/` — no code change needed,
  the repo already contains only static files.

Until a hosted URL exists, test the camera on a laptop via `localhost`
below (localhost counts as a secure context).

## How Siva tests the camera on his phone

1. Open the live demo URL above on the phone (Chrome or Safari).
2. Tap **Start camera** and allow camera access when asked.
3. Mouth words silently, facing the camera in good light. You should see blue
   dots and outlines tracking your lips in real time, and the header pill
   should read **"Model: loaded ✓"**.
4. Try **Record clip** (records locally, never uploads), **Snapshot** (saves a
   PNG with the lip overlay), and the **Transcribe** button on a clip — it
   must say transcription is not available, because this prototype does not
   lip-read.
5. If the model pill says "failed", the page falls back to a dashed face-box
   guide and says why in the status line — that usually means the CDN was
   unreachable, not a camera problem.

## Run it locally

No build step. Serve the folder over HTTP (camera access requires a secure
context — `localhost` counts) and open `index.html`:

```bash
cd silent-speech-notes
python3 -m http.server 8000
# open http://localhost:8000/
```

Opening the file directly with `file://` will load the page, but most browsers
block camera access on `file://` URLs — use the local server above.

## Tests

Automated checks run in jsdom with a fake camera and fake Face Mesh model —
no real camera is involved, and they prove nothing about a real device:

```bash
npm install   # jsdom only, dev dependency
npm test      # 61 checks, all green
```

Covered: initial render and honest note, CDN-failure fallback, lip-draw path,
no-face and malformed results, stop-while-loading pill reset, FaceMesh reuse,
late-result race, recording / download / transcribe / delete, snapshot with
overlay, unexpected camera-track end, camera denied, and no camera API at all.
The live-camera check still has to happen on a real device (see above).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure, honest-note banner, camera stage, clip list |
| `style.css` | Dark theme, cards, stage overlay, face-box guide |
| `app.js` | Camera, Face Mesh tracking, recording, clips, fallback handling |
| `tests/run-tests.js` | jsdom test suite (`npm test`, 61 checks) |
| `package.json` | Test script + jsdom dev dependency (no build step for the app itself) |

## Dependencies

CDN only, no build step, no npm packages:

- MediaPipe Face Mesh — `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js`
  (the model weights are fetched from the same CDN package at runtime)

If the CDN is unreachable, the app still loads and runs with the face-box
guide fallback.

## Browser support

Any modern browser with `getUserMedia` and `MediaRecorder` (Chrome, Edge,
Firefox, Safari 14.1+). Camera permission is required.
