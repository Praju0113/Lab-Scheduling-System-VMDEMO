import axios from 'axios';
import { useAuthStore } from '../store/useAuthStore';
import { resolveApiBaseUrl, resolveApiBaseUrlCandidates } from './resolveApiUrl';

const apiBaseCandidates = resolveApiBaseUrlCandidates();

export const apiClient = axios.create({
  baseURL: resolveApiBaseUrl(),
  headers: {
    'Content-Type': 'application/json',
  },
});

apiClient.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  const anyConfig = config as any;
  if (typeof anyConfig.__apiBaseCandidateIndex !== 'number') {
    anyConfig.__apiBaseCandidateIndex = Math.max(0, apiBaseCandidates.indexOf(String(config.baseURL || apiBaseCandidates[0])));
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => {
    // Utility to transform ISO strings to Date objects globally
    const transformDates = (data: any): any => {
      if (data === null || data === undefined) return data;
      if (typeof data === 'string') {
        // basic ISO string regex matcher
        const isISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d*)?(?:[-+]\d{2}:\d{2}|Z)?$/.test(data);
        if (isISO) return new Date(data);
        return data;
      }
      if (Array.isArray(data)) {
        return data.map(transformDates);
      }
      if (typeof data === 'object') {
        const transformed: any = {};
        for (const [key, value] of Object.entries(data)) {
          transformed[key] = transformDates(value);
        }
        return transformed;
      }
      return data;
    };

    response.data = transformDates(response.data);
    return response;
  },
  (error) => {
    const config = error.config as any;
    const isNetworkFailure = !error.response || error.code === 'ERR_NETWORK' || error.code === 'ECONNABORTED';
    const currentIndex = typeof config?.__apiBaseCandidateIndex === 'number' ? config.__apiBaseCandidateIndex : 0;

    if (config && isNetworkFailure && currentIndex < apiBaseCandidates.length - 1) {
      const nextIndex = currentIndex + 1;
      config.__apiBaseCandidateIndex = nextIndex;
      config.baseURL = apiBaseCandidates[nextIndex];
      return apiClient.request(config);
    }

    if (error.response?.status === 401) {
      // Only logout if the user was actually logged in.
      // Pre-login 401s (bootstrap/delta before auth) should not trigger signOut.
      const { token, logout } = useAuthStore.getState();
      if (token) {
        logout();
      }
    }
    return Promise.reject(error);
  }
);
