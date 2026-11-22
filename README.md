# Silent-Speech Notes — Prototype

A small single-page static web app that shows a live camera preview with
lip-region landmark tracking, and records short clips locally in the browser.

## What it does

- **Camera capture** — `getUserMedia` requests the camera and shows a live preview.
  Video never leaves the browser; nothing is uploaded.
- **Live lip-region tracking visualisation** — loads MediaPipe Face Mesh from the
  jsDelivr CDN (`@mediapipe/face_mesh`) and draws the lip landmark points and
  the outer/inner lip outlines on a canvas overlay in real time. The model
  returns 468 face points; this prototype draws the **40 lip points** (20
  outer + 20 inner contour) — the hero says 40, the number actually drawn.
  The points
  are temporally smoothed (exponential moving average) so the overlay reads
  as tracked, not jittery, and a live readout shows tracking fps plus lip
  aperture (inner-lip gap as a percentage of lip width), both computed from
  real tracking data.
- **Graceful fallback** — if the Face Mesh script or model fails to load
  (offline, blocked CDN, or no result within 30 seconds), the app shows a
  dashed face-box guide overlay instead and says so in the status line and
  the model pill in the header. The 30-second watchdog never fires while the
  tab is hidden (animation frames pause there, so "no results yet" says
  nothing about the model).
- **Camera switching** — when the device has more than one camera, a Switch
  camera button appears and cycles front/back without dropping the session.
  Switching wipes the old camera's lip points from the overlay first, so no
  stale points linger on the new camera's first frames, and Switch works
  after Stop too (it starts the next camera). If the camera it asks for is
  gone, the status line keeps the specific reason ("no camera was found")
  instead of a generic switch error.
  Camera errors are reported in plain language (permission denied, no camera
  found, camera in use by another app) instead of raw error names — and an
  error the app does not recognise says "the camera could not be started",
  never a guessed blame. A missing camera is never told to "allow camera
  access"; that advice appears only for permission errors.
- **Clip recording** — `MediaRecorder` records short clips from the camera
  stream. Clips are listed with playback, a timestamp, duration and size, and
  can be downloaded or deleted. Clips live only in the browser session; refreshing clears them.
  Each recording owns its chunks in a closure, so stopping one clip and
  starting the next immediately cannot mix them up, and the list caps at the
  latest 12 clips (oldest drops off) to bound session memory — and the status
  line says so when it happens, instead of the notice being overwritten by the
  status refresh, and the notice survives Stop camera too. Clip numbers
  never repeat after a delete. A REC timer and the camera resolution (plus the camera's name, once known) show on
  the stage while recording/live. The fps readout counts every tracking result,
  so it is the real frame rate, not the ~4 Hz repaint rate; a face leaving the
  frame updates the readout at once instead of waiting out the throttle.
- **Snapshot** — saves a still PNG of the current camera frame, **including
  the lip-tracking overlay** when tracking is live, and confirms with a short
  status message.
- **Status line** — always shows camera on/off, model loaded/failed, and
  recording state.
- **Design system** — one signature idea, "the lip line": a single thin
  lip-contour line in the one accent, repeated in the logo, the favicon, the
  hero eyebrow dot and the live-stage border. The accent is signal blue
  `#4f8cff` — the same blue as the lip points on the canvas — used for under
  10% of any screen; everything else is a neutral ramp plus semantic colours
  (green ok, amber warn, red danger). Tokens are OKLCH with hex fallbacks in
  `style.css`, mirrored in `tokens.json`. Dark and light themes are equal
  citizens: a toggle in the topbar switches them (stored choice wins, else the
  OS preference, applied before first paint); the video stage stays black in
  both. Type is Space Grotesk (display), Inter (text), JetBrains Mono (stats
  and HUD). No gradients, no glass, no glows, no staggered entrances — motion
  only for state changes (REC pulse, idle wave, a new clip appearing, a
  pressed button).

### Contrast (WCAG AA, text on page background)

| Token | Dark (`#07080c`) | Light (`#f6f7f9`) |
| --- | --- | --- |
| Text | 18.18:1 | 16.60:1 |
| Muted | 7.87:1 | 5.58:1 |
| Muted-2 | 5.38:1 | 5.00:1 |
| Accent | 6.22:1 | 5.04:1 |
| Danger | 6.17:1 | 5.05:1 |
| Ok | 10.41:1 | 5.01:1 |
| Warn | 11.37:1 | 5.17:1 |
| Honest-note text | 14.60:1 | 6.86:1 |
| White on accent fill (`#2b63d9`, buttons) | 5.40:1 | 5.40:1 |
- **Resilient by design** — if the camera disappears mid-session (unplugged,
  permission revoked, another app takes it) the app stops cleanly and says so
  in plain language instead of freezing. The Face Mesh model gets up to 30
  seconds to return its first result (slow mobile connections), and a single
  model instance is reused across camera restarts. Malformed tracking results
  are skipped, never drawn from. A lip point missing on the first frame cannot
  poison smoothing (a non-finite smoothed point snaps to the new reading).
  Hidden HUD elements stay hidden — the `[hidden]` attribute beats the CSS
  display rules, so the face-box guide, resolution chip and REC chip never
  show while they should not. Camera switching re-syncs against the real
  device list, so Switch always moves to a different camera.

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

- **Live since 21 Nov 2026 ~16:07 IST:** https://sivasaiboggu.github.io/Slient-speech-notes/
  (GitHub Pages, Deploy from branch `main`, `/` root — pushing to `main`
  updates the live site). Vercel remains blocked (the connected account's
  token is not authorised for the `sivasai1807s-projects` team scope, 403 on
  every deploy call) and is not needed while Pages serves the site.

Until a hosted URL exists, test the camera on a laptop via `localhost`
below (localhost counts as a secure context).

## How Siva tests the camera on his phone

1. Open the live demo URL above on the phone (Chrome or Safari).
2. Tap **Start camera** and allow camera access when asked.
3. Mouth words silently, facing the camera in good light. You should see blue
   dots and outlines tracking your lips in real time, and the header pill
   should read **"Model: loaded ✓"**. The line under the preview shows live
   tracking fps and lip aperture.
4. Try **Record clip** (records locally, never uploads), **Snapshot** (saves a
   PNG with the lip overlay), and the **Transcribe** button on a clip — it
   must say transcription is not available, because this prototype does not
   lip-read. On a phone with two cameras, **⇄ Switch camera** cycles front/back.
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
npm test      # 138 checks, all green
```

Covered: initial render and honest note, CDN-failure fallback, lip-draw path
with smoothing, no-face and malformed results, stop-while-loading pill reset,
FaceMesh reuse, late-result race, recording / download / transcribe / delete,
monotonic clip numbering after a delete, 12-clip cap (and the cap notice
surviving in the status line, and surviving Stop camera),
live track stats
(fps + lip aperture — fps counts every result, not the repaint rate),
EMA recovery when a lip point is missing on the first frame,
`[hidden]` really hiding the face-box guide and HUD chips (computed display
against the real stylesheet), camera switch (2 cameras offered, 1 camera hidden;
switch moves to a genuinely different camera when the default is not the first
enumerated device; res chip names the camera in use; switch clears the old
camera's stale lip points; switch works after Stop; a failed switch keeps the
specific reason),
hero copy says 40 lip landmarks, unknown camera errors get a neutral message
and NotFoundError gets no "allow camera access" advice,
snapshot with overlay, unexpected camera-track end, camera denied / no
camera / no camera API (all plain-language), and no camera API at all.
Dark/light theme toggle (stored choice wins, OS preference otherwise).
The live-camera check still has to happen on a real device (see above).

Round 7 also verified the UI in a real headless Chrome (stock build, served
over localhost, MediaPipe files served locally because the VM's egress proxy
is unreachable from Chrome): with Chrome's fake camera the model loads
("Model: loaded ✓", "Lip tracking active"), the loop runs ("Tracking · no
face in frame" — the fake feed has no face), and a 6-second recording
produces a clip. A 2.5-second recording produced no data in headless — the
encoder's first chunk takes a few seconds to arrive there, not an app bug;
the app reports it honestly ("recording produced no data — clip discarded").
A real face on a real camera is still untested — that check is Siva's.

Round 10 (22 Nov 2026) applied the 5 fixes a read-only review had found
(switch clears stale lip points and works after Stop; 40 not 468; unknown
camera errors no longer blame permission; cap notice survives Stop), added a
single-accent OKLCH design system with a light theme and a dark/light toggle,
and re-rendered desktop 1280px + mobile 390px in both themes
(`screenshots/round10/`, zero horizontal overflow on both widths, verified
via CDP because this build's `--screenshot` flag writes nothing — see
`scripts/README.md`). Tests 100 → 138 checks, all green.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure, honest-note banner, camera stage, clip list |
| `style.css` | Dark + light theme, OKLCH tokens, cards, stage overlay, face-box guide |
| `tokens.json` | Design tokens (OKLCH + hex, both themes) |
| `app.js` | Camera, Face Mesh tracking, recording, clips, fallback handling |
| `tests/run-tests.js` | jsdom test suite (`npm test`, 138 checks) |
| `scripts/cdp-screenshot.py` | Headless-Chrome screenshot recipe (CDP; the `--screenshot` flag writes nothing in this build) |
| `scripts/webgl-policy.txt` | WebGL domain policy file Chrome needs to start here |
| `screenshots/round10/` | Round-10 renders: desktop 1280px + mobile 390px, dark + light |
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
