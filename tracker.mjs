const distribution = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3';
const model = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
// SHA-256 published in Google's MediaPipe sample's model download task.
const integrity = 'sha256-ZBhOIpsmMQe8K4BMZiXbE0H/K7cxh0sLzC/mVE4Lyf8=';

export async function createFaceTracker(onResults, signal) {
  const [{ FaceLandmarker, FilesetResolver }, weights] = await Promise.all([
    import(distribution + '/vision_bundle.mjs'),
    fetch(model, { integrity, credentials: 'omit', signal }).then(response => {
      if (!response.ok) throw new Error('Could not download Face Landmarker weights');
      return response.arrayBuffer();
    }),
  ]);
  const files = await FilesetResolver.forVisionTasks(distribution + '/wasm');
  signal.throwIfAborted();
  const tracker = await FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetBuffer: new Uint8Array(weights) },
    runningMode: 'VIDEO',
    numFaces: 1,
  });

  if (signal.aborted) {
    tracker.close();
    signal.throwIfAborted();
  }

  return {
    send({ image }) {
      const results = tracker.detectForVideo(image, performance.now());
      onResults({ multiFaceLandmarks: results.faceLandmarks });
    },
  };
}
