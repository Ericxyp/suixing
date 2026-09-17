/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AMAP_JS_API_KEY?: string;
  readonly VITE_TRIP_AI_MODE?: string;
  readonly VITE_TRIP_GENERATION_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
