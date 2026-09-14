import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

export default defineNuxtPlugin(() => {
  // Bundle the worker and its shared module together before any map is mounted.
  setWorkerUrl(workerUrl);
});
