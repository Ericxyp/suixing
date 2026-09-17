export type AmapJsApi = typeof AMap;

export type AmapJsApiLoadErrorCode =
  | 'AMAP_JS_API_KEY_MISSING'
  | 'AMAP_JS_API_LOAD_FAILED'
  | 'AMAP_JS_API_GLOBAL_MISSING';

export class AmapJsApiLoadError extends Error {
  constructor(
    readonly code: AmapJsApiLoadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AmapJsApiLoadError';
  }
}

export interface AmapLoaderScript {
  id: string;
  async: boolean;
  src: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  remove(): void;
}

export interface AmapJsLoaderAdapter {
  getApiKey(): string | undefined | Promise<string | undefined>;
  getAmap(): AmapJsApi | undefined;
  setSecurityConfig(config: { serviceHost: string }): void;
  createScript(): AmapLoaderScript;
  appendScript(script: AmapLoaderScript): void;
}

const SCRIPT_ID = 'amap-js-api-v2';
const SERVICE_HOST = '/_AMapService';
const MISSING_KEY_MESSAGE = '高德地图 JS API Key 尚未配置。';
const LOAD_FAILED_MESSAGE = '高德地图加载失败，请稍后重试。';
const GLOBAL_MISSING_MESSAGE = '高德地图加载结果无效，请稍后重试。';

export function createAmapJsApiLoader(
  adapter: AmapJsLoaderAdapter,
): () => Promise<AmapJsApi> {
  let loadingPromise: Promise<AmapJsApi> | undefined;

  return function load(): Promise<AmapJsApi> {
    if (loadingPromise) {
      return loadingPromise;
    }

    const existing = adapter.getAmap();
    if (existing) {
      return Promise.resolve(existing);
    }

    const attempt = Promise.resolve(adapter.getApiKey()).then((rawKey) => {
      const apiKey = rawKey?.trim();
      if (!apiKey) {
        throw new AmapJsApiLoadError(
          'AMAP_JS_API_KEY_MISSING',
          MISSING_KEY_MESSAGE,
        );
      }

      adapter.setSecurityConfig({ serviceHost: SERVICE_HOST });
      const script = adapter.createScript();
      script.id = SCRIPT_ID;
      script.async = true;
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(apiKey)}`;

      return new Promise<AmapJsApi>((resolve, reject) => {
        script.onload = () => {
          script.onload = null;
          script.onerror = null;
          const amap = adapter.getAmap();
          if (!amap) {
            script.remove();
            reject(new AmapJsApiLoadError(
              'AMAP_JS_API_GLOBAL_MISSING',
              GLOBAL_MISSING_MESSAGE,
            ));
            return;
          }
          resolve(amap);
        };
        script.onerror = () => {
          script.onload = null;
          script.onerror = null;
          script.remove();
          reject(new AmapJsApiLoadError(
            'AMAP_JS_API_LOAD_FAILED',
            LOAD_FAILED_MESSAGE,
          ));
        };
        adapter.appendScript(script);
      });
    });

    loadingPromise = attempt.catch((error: unknown) => {
      loadingPromise = undefined;
      if (error instanceof AmapJsApiLoadError) {
        throw error;
      }
      throw new AmapJsApiLoadError(
        'AMAP_JS_API_LOAD_FAILED',
        LOAD_FAILED_MESSAGE,
      );
    });
    return loadingPromise;
  };
}

const browserAdapter: AmapJsLoaderAdapter = {
  async getApiKey() {
    const environment = await import('./amap-js-env.js');
    return environment.amapJsApiKey;
  },
  getAmap() {
    return window.AMap;
  },
  setSecurityConfig(config) {
    window._AMapSecurityConfig = config;
  },
  createScript() {
    return document.createElement('script') as unknown as AmapLoaderScript;
  },
  appendScript(script) {
    document.head.appendChild(script as HTMLScriptElement);
  },
};

const loadWithBrowser = createAmapJsApiLoader(browserAdapter);

export function loadAmapJsApi(): Promise<AmapJsApi> {
  return loadWithBrowser();
}
