# Browser verification

The Playwright runner uses real Chromium, a prerecorded Y4M file as its camera, and the actual MediaPipe tracking runtime and model. Both revisions use the same camera fixture. The fallback case deliberately blocks the tracking assets.

## Setup

Use Node 24.22.3, npm 11.19.1, Python 3, curl and FFmpeg. The fixture is NASA's Eileen Collins portrait as distributed with scikit-image.

```sh
npm ci
npx playwright-core install chromium
mkdir -p /tmp/ssn-qa
curl -fsSL https://raw.githubusercontent.com/scikit-image/scikit-image/v0.24.0/skimage/data/astronaut.png -o /tmp/ssn-qa/astronaut.png
ffmpeg -loop 1 -i /tmp/ssn-qa/astronaut.png -vf 'crop=440:320:15:0,scale=640:480,setsar=1' \
  -t 2 -r 15 -pix_fmt yuv420p /tmp/ssn-qa/camera.y4m
npm install --prefix /tmp/ssn-qa --save-exact @mediapipe/tasks-vision@1.2.3 lighthouse@13.6.0
curl -fsSL https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task -o /tmp/ssn-qa/face_landmarker.task
echo '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff  /tmp/ssn-qa/face_landmarker.task' | sha256sum -c
```

If Google Cloud Storage is unreachable, use a mirrored model file and check it against the same [Google-published SHA-256](https://github.com/google-ai-edge/mediapipe-samples/blob/main/examples/face_landmarker/android/app/download_tasks.gradle.kts).

## Current build

From the repository root, build the app and serve it at the GitHub Pages project path.

```sh
npm run build
mkdir -p /tmp/ssn-qa/preview
ln -s "$PWD/dist" /tmp/ssn-qa/preview/Slient-speech-notes
python3 -m http.server 8012 --bind 127.0.0.1 --directory /tmp/ssn-qa/preview
```

In a separate terminal, run the browser suite. Set `CHROMIUM_PATH` if you are using a system Chromium.

```sh
export CAMERA_FIXTURE=/tmp/ssn-qa/camera.y4m
export TASKS_VISION_DIR=/tmp/ssn-qa/node_modules/@mediapipe/tasks-vision
export LANDMARKER_MODEL=/tmp/ssn-qa/face_landmarker.task
npm run test:browser -- http://127.0.0.1:8012/Slient-speech-notes/ /tmp/ssn-qa/captures after
```

The suite covers overflow, axe, theme persistence, keyboard focus, live tracking, fallback, recording, playback, note validation, quota retry, local persistence, conflicting edits, deletion, and downloads.

## Before screenshots

Serve the merged v1 main commit on port 8011 and run the same capture runner in `before` mode.

```sh
mkdir -p /tmp/ssn-qa/baseline/Slient-speech-notes
git archive 90088cb50007f320953b10bc6c1f63c6c0dd11f7 | tar -x -C /tmp/ssn-qa/baseline/Slient-speech-notes
python3 -m http.server 8011 --bind 127.0.0.1 --directory /tmp/ssn-qa/baseline
```

```sh
npm run test:browser -- http://127.0.0.1:8011/Slient-speech-notes/ /tmp/ssn-qa/captures before
```

## Lighthouse

Run the default mobile configuration against the built preview. Set `CHROME_PATH` to a Chrome or Chromium executable if discovery fails. Add `--preset=desktop` for the desktop run.

```sh
/tmp/ssn-qa/node_modules/.bin/lighthouse http://127.0.0.1:8012/Slient-speech-notes/ \
  --chrome-flags=--headless --output=json --output-path=/tmp/ssn-qa/lighthouse-mobile.json
```
