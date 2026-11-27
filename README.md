# Silent-Speech Notes

Silent-Speech Notes records video without a microphone and shows 40 lip landmarks in the live viewfinder. Play a clip, add a title and an optional note, and save them together in this browser. Transcription is unavailable.

[Live demo](https://sivasaiboggu.github.io/Slient-speech-notes/) · [Browser verification and screenshots](scripts/README.md) · [V1 design record](docs/redesign.md)

## Run locally

Use Node **24.22.3**, npm **11.19.1**, and Python 3. The frontend needs no environment variables or credentials.

```sh
npm ci
npm run start
# Open http://localhost:8000/
```

Camera access requires HTTPS or a loopback address such as localhost. The tracking runtime and model load when you start the camera. Recording and snapshots work with the framing guide if the model is unavailable.

```sh
npm test
npm run design:contrast
npm run build
```

The build checks the generated tokens and JavaScript, then copies the static site into `dist/`. The checked-in root also serves the existing GitHub Pages site. Use the `/Slient-speech-notes/` prefix for built previews to exercise the same paths as production.

## Record and keep a note

1. Choose **Start camera** and grant access. Move into view until the red contours follow your mouth. The readout shows tracking FPS and lip aperture, the inner gap as a percentage of lip width.
2. Choose **Record clip**. Stop when you're done, or let the one-minute limit finish the clip. **Snapshot** downloads a still with the tracking outline when available.
3. Choose **Review clip** to jump to your recording. Use **Play** and the seek slider to review it.
4. Choose **Add note**, enter a title and optional text, and choose **Save note**. The note and its video appear when you reopen the app in the same browser and profile.

The notebook keeps up to 12 unsaved clips in the current tab. Saved notes are held in IndexedDB until you delete them or the browser clears site data. Download any video you want to keep as a separate file. **Switch camera** cycles available cameras and **Stop camera** releases the active stream.

## Source

| File | Role |
| --- | --- |
| `index.html`, `privacy.html`, `404.html` | Workspace, privacy, and GitHub Pages recovery |
| `style.css`, `theme.js` | Responsive layout, typography, theme and motion |
| `tokens.json`, `tokens.css`, `tailwind-theme.css` | Token source and generated CSS and Tailwind v4 adapter |
| `app.js`, `tracker.mjs` | Camera, Face Landmarker, recordings and snapshots |
| `notebook.js`, `note-store.js` | Notes, playback and local transactions |
| `tests/run-tests.js`, `scripts/capture.mjs` | DOM regression tests and real-browser flow, accessibility and screenshot checks |

Alegreya Sans is self-hosted as Latin WOFF2 in weights 400 and 700 under the [SIL Open Font License](assets/alegreya-sans-OFL.txt). The pinned MediaPipe Tasks runtime is **1.2.3**. The versioned Face Landmarker model is checked against Google's published SHA-256.
