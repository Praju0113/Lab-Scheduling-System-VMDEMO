const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const normalizeToApiBase = (value: string) => {
  const normalizedUrl = trimTrailingSlash(value.trim());
  return /\/api$/i.test(normalizedUrl) ? normalizedUrl : `${normalizedUrl}/api`;
};

const parseConfiguredApiUrls = () => {
  // @ts-ignore
  const configuredApiUrl = import.meta.env.VITE_API_URL;
  // @ts-ignore
  const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL;
  const rawUrl = configuredApiUrl || configuredApiBaseUrl;

  if (!rawUrl) {
    return [] as string[];
  }

  return String(rawUrl)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map(normalizeToApiBase);
};

const unique = (values: string[]) => Array.from(new Set(values));

export function resolveApiBaseUrlCandidates() {
  const configuredCandidates = parseConfiguredApiUrls();

  if (configuredCandidates.length > 0) {
    return unique(configuredCandidates);
  }

  const inferredOrigin = typeof window !== 'undefined' && window.location?.origin ? [window.location.origin] : [];
  const fallbackOrigins = [
    ...inferredOrigin,
    'http://localhost:5173',
    'http://localhost:3001',
    'http://localhost:7071',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:7071',
  ];

  return unique(fallbackOrigins.map(normalizeToApiBase));
}

export function resolveApiBaseUrl() {
  const candidates = resolveApiBaseUrlCandidates();
  if (candidates.length > 0) {
    return candidates[0];
  }

  throw new Error('Unable to resolve API base URL candidates');
}

export function resolveApiOrigin() {
  const apiBaseUrl = resolveApiBaseUrl();
  return apiBaseUrl.replace(/\/api$/i, '');
}
