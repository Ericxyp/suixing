export interface ServerConfig {
  port: number;
  /** Server-internal only; never serialize this object into responses. */
  amapWebServiceKey?: string;
  /** Server-internal only; never serialize this object into responses. */
  amapSecurityJsCode?: string;
  hasAmapWebServiceKey: boolean;
  hasAmapSecurityJsCode: boolean;
  /** Server-internal only; never serialize this object into responses. */
  qwenApiKey?: string;
  /** Server-internal only; never serialize this object into responses. */
  qwenBaseUrl?: string;
  /** Server-internal only; never serialize this object into responses. */
  qwenModel?: string;
  /** Server-internal only; never serialize this object into responses. */
  qwenRequestTimeoutMs?: number;
  hasQwenAiProvider: boolean;
}

const QWEN_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const QWEN_PATH_PATTERN = /^(\/[A-Za-z0-9._-]+)*$/;

function isTrustedQwenHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'dashscope.aliyuncs.com'
    || /^[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(host)
  );
}

function parseQwenBaseUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    trimmed.includes('..')
    || trimmed.includes('\\')
    || trimmed.includes('@')
    || trimmed.includes('?')
    || trimmed.includes('#')
  ) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || (parsed.port !== '' && parsed.port !== '443')
    || !isTrustedQwenHost(parsed.hostname)
  ) {
    return undefined;
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (!QWEN_PATH_PATTERN.test(pathname)) {
    return undefined;
  }

  return `${parsed.origin}${pathname}`;
}

function parseQwenModel(raw: string | undefined): string | undefined {
  const model = raw?.trim();
  if (!model || !QWEN_MODEL_PATTERN.test(model)) {
    return undefined;
  }
  return model;
}

const DEFAULT_QWEN_TIMEOUT_MS = 60_000;
const MIN_QWEN_TIMEOUT_MS = 5_000;
const MAX_QWEN_TIMEOUT_MS = 120_000;

function parseQwenRequestTimeoutMs(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return DEFAULT_QWEN_TIMEOUT_MS;
  }
  const value = Number(trimmed);
  if (
    !Number.isInteger(value)
    || value < MIN_QWEN_TIMEOUT_MS
    || value > MAX_QWEN_TIMEOUT_MS
  ) {
    return DEFAULT_QWEN_TIMEOUT_MS;
  }
  return value;
}

export function getServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT);
  const amapWebServiceKey = env.AMAP_WEB_SERVICE_KEY?.trim() || undefined;
  const amapSecurityJsCode = env.AMAP_SECURITY_JS_CODE?.trim() || undefined;
  const provider = env.AI_PROVIDER?.trim();
  const qwenApiKey = env.DASHSCOPE_API_KEY?.trim() || undefined;
  const qwenBaseUrl = parseQwenBaseUrl(env.QWEN_BASE_URL);
  const qwenModel = parseQwenModel(env.QWEN_MODEL);
  const hasQwenAiProvider = provider === 'qwen'
    && Boolean(qwenApiKey)
    && Boolean(qwenBaseUrl)
    && Boolean(qwenModel);

  return {
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3000,
    amapWebServiceKey,
    amapSecurityJsCode,
    hasAmapWebServiceKey: Boolean(amapWebServiceKey),
    hasAmapSecurityJsCode: Boolean(amapSecurityJsCode),
    qwenApiKey: hasQwenAiProvider ? qwenApiKey : undefined,
    qwenBaseUrl: hasQwenAiProvider ? qwenBaseUrl : undefined,
    qwenModel: hasQwenAiProvider ? qwenModel : undefined,
    qwenRequestTimeoutMs: parseQwenRequestTimeoutMs(env.QWEN_REQUEST_TIMEOUT_MS),
    hasQwenAiProvider,
  };
}
