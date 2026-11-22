# Viewfinder redesign

Silent-Speech Notes is a browser camera prototype for people testing how lip movement looks on screen. The first useful result is an outline that follows your mouth after one camera permission prompt. The workspace can also save a clip or snapshot when tracking is unavailable.

## Design decisions

The lip contour ties the page together. The wordmark uses its two outlines. The idle viewfinder plots 20 outer points and 20 inner points with axes and corner marks. The live view replaces the reference with the points measured from the video. A dark keyline keeps the signal clear over light footage.

| Accent option | Why |
| --- | --- |
| **Chartreuse, selected** | Bright enough for thin lines on the dark viewfinder. Its olive counterpart holds up as small text on warm paper. |
| Copper | A good fit for the paper palette. A thin copper outline is harder to separate from warm skin tones. |
| Cobalt | Clean over warm footage. The cool color would make the camera feel closer to the previous interface and leave less distinction between action and measurement. |

The 12-step olive-neutral ramp runs from warm paper to charcoal. Chartreuse is reserved for the contour, the brand mark, focus and the camera’s primary action. Color occupies a small part of the page. The recording state uses a separate semantic red with a written label. Status colors also have text labels.

Instrument Sans is the single self-hosted variable face. Display and body use the same Latin subset, at different weights and tracking. System mono is reserved for measurement labels, timestamps and counts. Body copy runs at 16–18 px with 1.6 line height and a 68-character measure. The 4 px spacing unit handles control insets and small gaps. Page rhythm uses multiples of 8 px. Corners are 4 px on controls and 8 px on camera surfaces. Elevation has three levels, from flat rules to the primary control’s inner edge and the viewfinder’s two-part shadow. The texture is confined to the idle viewfinder.

Controls move one pixel on press over 180 ms with an eased settle. Reduced motion switches the press effect off. The preview, timer, and status text reflect camera state immediately. Camera permission is the onboarding step. The first action stays adjacent to the preview.

## Tokens and contrast

[`tokens.json`](../tokens.json) defines the ramp, theme roles, type, spacing, radii, depth and motion. [`tokens.css`](../tokens.css) emits hex before OKLCH, so older browsers resolve the same palette. [`tailwind-theme.css`](../tailwind-theme.css) exposes the roles and sizing scale through Tailwind v4 for downstream use. The workspace consumes the CSS variables directly. Edit the JSON and run `npm run design:tokens` to update both representations.

Ratios use the WCAG relative luminance calculation on the sRGB equivalents of the authored OKLCH values. `npm run design:contrast` checks the thresholds. Camera badges have opaque backgrounds, so their ratios hold over arbitrary footage.

| Pair | Light | Dark | Minimum |
| --- | ---: | ---: | ---: |
| Primary text on paper | 15.13:1 | 16.25:1 | 4.5:1 |
| Primary text on controls | 16.25:1 | 14.08:1 | 4.5:1 |
| Primary text on hover controls | 13.84:1 | 11.67:1 | 4.5:1 |
| Secondary text on paper | 7.60:1 | 11.56:1 | 4.5:1 |
| Tracking labels on paper | 5.47:1 | 8.55:1 | 4.5:1 |
| Link and focus color on paper | 6.97:1 | 12.58:1 | 4.5:1 |
| Focus against control fill | 7.49:1 | 10.90:1 | 3:1 |
| Control outline against paper | 4.02:1 | 3.77:1 | 3:1 |
| Primary control text | 10.97:1 | 10.97:1 | 4.5:1 |
| Primary control hover text | 9.61:1 | 9.61:1 | 4.5:1 |
| Primary control pressed text | 8.72:1 | 8.72:1 | 4.5:1 |
| Model ready label on paper | 6.65:1 | 10.61:1 | 4.5:1 |
| Model warning label on paper | 6.22:1 | 10.53:1 | 4.5:1 |
| Recording control on surface | 7.75:1 | 8.46:1 | 4.5:1 |
| Recording control on hover surface | 6.60:1 | 7.02:1 | 4.5:1 |
| Viewfinder label on fixed stage | 8.65:1 | 8.65:1 | 4.5:1 |
| Live labels on opaque badge | 14.57:1 | 14.57:1 | 4.5:1 |
| Recording timer on opaque badge | 9.77:1 | 9.77:1 | 4.5:1 |
| Contour against dark keyline | 12.58:1 | 12.58:1 | 3:1 |

## Screens and flows

| Surface | Applied design | User flow and state |
| --- | --- | --- |
| Workspace, idle | The headline and short explanation sit on the same asymmetric grid as the viewfinder and clip rail. Mobile stacks them in reading order. The technical plate marks the preview area before the camera starts. | Start camera → browser permission → live preview. A visible waiting message covers the permission prompt. |
| Workspace, live and recording | Camera and capture controls are grouped beneath the preview. Native camera footage stays visible at its aspect ratio, with landmarks drawn in place. A resolution label, a recording timer, and a separate lower readout use mono. | Track a face, switch camera, record or take a snapshot. When the camera stops or a face leaves the frame, stale measurements disappear. |
| Workspace, fallback | The same frame carries a dashed face guide. Its message is readable over the video. | Model failure → centre your face using the guide → keep recording or saving stills. Permission and device errors appear below the controls with a recovery action. |
| Session clips | The right rail includes empty and populated states. Each take shows playback, timestamp, duration, size and three actions. The rail follows the camera on narrow screens. | Record → stop → play or download → optionally delete. Transcribe states the scope. Refreshing clears the session, and the list holds the latest 12. |
| First-session guide | A wide ruled section beneath the workspace pairs a short heading with three steps and a plain statement about transcription. | **Guide** jumps directly to the steps. Return to the camera from the page navigation. |
| Camera and privacy | A single column uses the same type and tone. Copy names the model download, permissions, clip lifetime, downloads and theme storage. | **Camera and privacy** in the footer opens the page. **Back to camera** returns to the viewfinder. |
| Missing page | The Pages 404 template shows a short explanation and an action back to the workspace. | On GitHub Pages, an unknown address takes the reader to the recovery screen. The hosting service handles server errors. |

## Architecture and review

Keep the root static entry point for GitHub Pages. The app’s interactive surface needs native browser controls and device APIs, so it uses semantic HTML, CSS and JavaScript with one lazy browser model. The UI has no account or data-entry forms. The page is language-tagged, uses locale-formatted clip times, and displays a responsive layout without relying on fixed text widths. The manifest gives the prototype a home-screen name and icon. A service worker is deferred because offline camera tracking requires a separate model-caching and storage decision.

The session model stays in memory. Camera state holds the stream, selected input, model status and a rolling FPS window. A clip owns a monotonic number, object URL, MIME type, duration, size and local timestamp. Each recording has its own chunk buffer. Removing a clip revokes its URL. Only the theme preference is saved in local storage. The camera loads MediaPipe Tasks 1.2.3 and Google’s versioned Face Landmarker weights after permission. The 40 lip indices and local recording flow are preserved. The weight fetch verifies the SHA-256 from Google’s sample. JavaScript and font assets are otherwise local. [Google model checksum](https://github.com/google-ai-edge/mediapipe-samples/blob/main/examples/face_landmarker/android/app/download_tasks.gradle.kts) The build checks the generated token files, verifies the runtime files, and produces a static preview package under `dist/`.

| Review | Decision applied |
| --- | --- |
| Tokens and type | Replaced the bright-blue UI treatment with olive paper, one display and body face, and a chartreuse signal thin enough to read as measurement. |
| Primitives | Kept a single dashed empty rail. Controls use firm outlines, tuned press and focus states, and readable labels. |
| Page composition | Removed the opening feature-card row. The viewfinder and clips are reached directly from the masthead and follow the same desktop grid as the introduction. |
| Live states | The model loads on demand. A new tracking session rejects late frames from the previous camera and restarts measurement after Stop. Download filenames follow the recorder’s MIME type. |
| Packaging | Build and contrast checks can run in pull requests. The package is a preview artifact. Production continues to use the repository’s existing Pages path. |

## Local audit

- `npm test` passed **139 checks**. This includes denied and unavailable cameras, switching, fallback, draw and smoothing, clip lifetime, snapshot composition and theme persistence.
- `npm run build` produced **16 static files**. `npm run design:contrast` passed all **19 contrast pairs** in both themes. `npm audit` reported **0 known vulnerabilities** in npm dependencies.
- Lighthouse **13.6.0** in headless Chromium 156 on the local built preview scored **100** for Performance, Accessibility, Best Practices and SEO on desktop and emulated mobile. The measured LCP was **0.5 s desktop** and **1.4 s mobile**, with zero CLS. These measurements cover the initial view before camera permission.
- The Chromium capture suite exercises keyboard entry, 320–1440 px, both themes, model failure, live landmarks, recording, playback, snapshot and clip downloads, deletion, camera restart, privacy and recovery. It runs axe in both themes and on the populated, fallback, and support views using WCAG 2.0 and 2.1 A and AA tags.

## Launch checklist and risks

- [x] Build the static package, run the project suite, and check token contrast.
- [x] Review desktop and mobile screenshots, both themes, fallback and live states.
- [x] Run the local Lighthouse and axe audits, exercise skip-link focus and check overflow.
- [x] Verify camera-release and restart behavior in Chromium with a prerecorded video input.
- [ ] Review launch screenshots and confirm the hosted URL still serves its 404 and social preview after release.
- [ ] Verify a physical camera on Chrome for Android and Safari for iOS. Check permission, camera switching, MP4 download and native playback.
- [ ] Measure initial load and first tracking result on real devices and slower cellular connections. The page uses a versioned WebAssembly runtime with an integrity-checked model. Its CSP limits script origins, permits WebAssembly compilation and restricts connections to the pinned distribution and model paths. The offline framing fallback remains available.

## Ten v2 ideas

1. Add a WebM/MP4 device compatibility matrix based on real hardware checks.
2. Let users choose a named camera from a short list.
3. Show camera changes and dropped-device recovery in a dedicated test mode.
4. Add an opt-in tighter face crop for the live preview.
5. Offer the original still and the outlined still as separate snapshot options.
6. Allow optional, explicit on-device clip retention beyond the tab.
7. Export the landmark time series for a chosen clip.
8. Benchmark moving frame inference off the main thread on mobile devices.
9. Add a user-initiated offline model download with a visible storage limit.
10. Translate the workflow and recovery copy with device testers.
