# Silent-Speech Notes

A single-page camera workspace for watching 40 lip landmarks move in real time. Record clips, play them back, or download a still with the tracking outline. The camera requests video only. Video, landmarks and clips stay in the browser. Transcription is unavailable in this prototype.

[Live demo](https://sivasaiboggu.github.io/Slient-speech-notes/) · [Design and launch checklist](docs/redesign.md) · [Browser screenshot recipe](scripts/README.md)

## Run locally

Use Node **24.22.3**, npm **11.19.1**, and Python 3. The frontend needs no environment variables or credentials.

```sh
npm ci
npm run start
# Open http://localhost:8000/
```

Camera access requires HTTPS or a loopback address such as localhost. The tracking runtime and model load when you start the camera. If the model is unavailable, the framing guide, recording and snapshots still work.

```sh
npm test
npm run design:contrast
npm run build
```

The build checks the token files and JavaScript, then copies the static site into `dist/`. The checked-in root still works for the existing GitHub Pages setup. Build previews can be served at `/Slient-speech-notes/` to exercise the same path as production.

## Use the camera

1. Choose **Start camera** and approve the browser prompt.
2. Move into view until the two lip contours follow your mouth. The readout shows tracking FPS and lip aperture, the inner gap as a percentage of lip width.
3. Choose **Record clip** or **Snapshot**. Snapshots include the drawn contours when tracking is active. A recording stores the camera video and can be played, downloaded or deleted in **Session clips**.
4. Download clips you want to keep before refreshing or closing the tab. The session holds the latest 12 clips. **Transcribe** explains the prototype’s limits.

When multiple cameras are available, **Switch camera** cycles through them. **Stop camera** releases the active stream.

## Source

| File | Role |
| --- | --- |
| `index.html`, `privacy.html`, `404.html` | Workspace, privacy, and the GitHub Pages recovery screen |
| `style.css`, `theme.js` | Responsive layout, local font, theme and interaction states |
| `tokens.json`, `tokens.css`, `tailwind-theme.css` | Token source and generated CSS and Tailwind v4 representations |
| `app.js`, `tracker.mjs` | Camera, Face Landmarker, recordings, snapshot and clip interactions |
| `tests/run-tests.js`, `scripts/capture.mjs` | DOM assertions and real-browser capture and flow checks |

Instrument Sans is served from a local Latin variable WOFF2, with its [SIL Open Font License](assets/instrument-sans-OFL.txt). The MediaPipe Tasks runtime is pinned to `1.2.3`. The versioned Face Landmarker model is checked against Google’s published SHA-256. The browser suite uses a prerecorded fixture with a real face and Chrome’s fake camera interface. Physical-device verification is part of the launch checklist.
