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
  can be deleted. Clips live only in the browser session; refreshing clears them.
- **Snapshot** — saves a still PNG of the current camera frame.
- **Status line** — always shows camera on/off, model loaded/failed, and
  recording state.

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

## Run it

No build step. Serve the folder over HTTP (camera access requires a secure
context — `localhost` counts) and open `index.html`:

```bash
cd silent-speech-notes
python3 -m http.server 8000
# open http://localhost:8000/
```

Opening the file directly with `file://` will load the page, but most browsers
block camera access on `file://` URLs — use the local server above.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure, honest-note banner, camera stage, clip list |
| `style.css` | Dark theme, cards, stage overlay, face-box guide |
| `app.js` | Camera, Face Mesh tracking, recording, clips, fallback handling |

## Dependencies

CDN only, no build step, no npm packages:

- MediaPipe Face Mesh — `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js`
  (the model weights are fetched from the same CDN package at runtime)

If the CDN is unreachable, the app still loads and runs with the face-box
guide fallback.

## Browser support

Any modern browser with `getUserMedia` and `MediaRecorder` (Chrome, Edge,
Firefox, Safari 14.1+). Camera permission is required.
