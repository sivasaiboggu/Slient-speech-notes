# Browser captures

The Playwright runner captures real Chromium pages. Chrome reads a prerecorded Y4M file through its fake camera interface. MediaPipe runs on the same input in both revisions. The fallback view blocks the model deliberately. No camera hardware or account is needed.

From the repository root, prepare the fixture with Python, curl and FFmpeg. The source portrait is NASA’s Eileen Collins image, distributed with scikit-image.

```sh
mkdir -p /tmp/ssn-qa
curl -fsSL https://raw.githubusercontent.com/scikit-image/scikit-image/v0.24.0/skimage/data/astronaut.png -o /tmp/ssn-qa/astronaut.png
ffmpeg -loop 1 -i /tmp/ssn-qa/astronaut.png -vf 'crop=440:320:15:0,scale=640:480,setsar=1' \
  -t 2 -r 15 -pix_fmt yuv420p /tmp/ssn-qa/camera.y4m
npm install --prefix /tmp/ssn-qa --save-exact @mediapipe/tasks-vision@1.2.3
curl -fsSL https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task -o /tmp/ssn-qa/face_landmarker.task
npm ci
npx playwright-core install chromium
npm run build
mkdir -p /tmp/ssn-qa/preview
ln -s "$PWD/dist" /tmp/ssn-qa/preview/Slient-speech-notes
python3 -m http.server 8012 --bind 127.0.0.1 --directory /tmp/ssn-qa/preview
```

From another terminal, run the captures and checks against the built preview.

```sh
CAMERA_FIXTURE=/tmp/ssn-qa/camera.y4m \
TASKS_VISION_DIR=/tmp/ssn-qa/node_modules/@mediapipe/tasks-vision \
LANDMARKER_MODEL=/tmp/ssn-qa/face_landmarker.task \
npm run test:browser -- http://127.0.0.1:8012/Slient-speech-notes/ /tmp/ssn-qa/captures after
```

Set `CHROMIUM_PATH` to use an installed browser instead of Playwright’s Chromium. The browser suite above uses paths relative to the GitHub Pages project. To recapture the comparison, serve the parent revision at a second loopback port and pass its URL and `before` to the runner. Install `@mediapipe/face_mesh@0.4.1633559619` under `/tmp/ssn-qa` and set `FACE_MESH_DIR=/tmp/ssn-qa/node_modules/@mediapipe/face_mesh`. When Google Fonts is unreachable, install `@fontsource-variable/inter@5.3.0`, `@fontsource-variable/space-grotesk@5.3.0`, and `@fontsource-variable/jetbrains-mono@5.3.0` under `/tmp/ssn-qa`, then set `LEGACY_FONTS_DIR=/tmp/ssn-qa/node_modules/@fontsource-variable`.

If storage.googleapis.com is unreachable, any local copy matching the [Google-published SHA-256](https://github.com/google-ai-edge/mediapipe-samples/blob/main/examples/face_landmarker/android/app/download_tasks.gradle.kts) can be passed to the runner.

For Lighthouse, run `npx lighthouse@13.6.0 http://127.0.0.1:8012/Slient-speech-notes/ --chrome-flags=--headless` and repeat with `--preset=desktop`.
