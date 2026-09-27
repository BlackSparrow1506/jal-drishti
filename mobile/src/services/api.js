import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from '../config';

const TIMEOUT_MS = 60000; // satellite checks and scene downloads can take a while
const CACHE_PREFIX = 'jd:cache:';

// Every call returns { data, cached }. If the network fails and we have a saved copy,
// we return that copy with cached: true so the app keeps working offline.
async function request(path, { method = 'GET', body, token, cacheKey } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Officer-Token': token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(data?.detail || `Request failed (${res.status})`);
      err.status = res.status;
      err.isHttp = true;
      throw err;
    }
    if (cacheKey) {
      AsyncStorage.setItem(CACHE_PREFIX + cacheKey, JSON.stringify(data)).catch(() => {});
    }
    return { data, cached: false };
  } catch (e) {
    if (!e.isHttp && cacheKey) {
      const raw = await AsyncStorage.getItem(CACHE_PREFIX + cacheKey).catch(() => null);
      if (raw) return { data: JSON.parse(raw), cached: true };
    }
    console.warn(`[api] ${method} ${path} failed:`, e.message);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const apiUrl = (path) => `${API_BASE}${path}`;

export const api = {
  overview: () => request('/api/overview', { cacheKey: 'overview' }),
  risk: (lat, lng) => request(`/api/risk?lat=${lat}&lng=${lng}`, { cacheKey: 'risk' }),
  zones: () => request('/api/zones', { cacheKey: 'zones' }),
  places: () => request('/api/places', { cacheKey: 'places' }),
  route: (lat, lng, mode) =>
    request('/api/route', { method: 'POST', body: { lat, lng, mode }, cacheKey: `route:${mode}` }),
  alerts: () => request('/api/alerts', { cacheKey: 'alerts' }),
  medibot: (message, lang) => request('/api/medibot', { method: 'POST', body: { message, lang } }),
  akashwani: () => request('/api/akashwani/status', { cacheKey: 'akashwani' }),
  simulation: (scenarioId, params = {}) => {
    const q = new URLSearchParams({ scenario_id: scenarioId });
    Object.entries(params).forEach(([k, v]) => v != null && q.append(k, String(v)));
    return request(`/api/simulation?${q}`, { cacheKey: `sim:${scenarioId}` });
  },
  terrain: () => request('/api/simulation/terrain', { cacheKey: 'terrain' }),
  damSearch: (q, country) =>
    request(`/api/dams/search?q=${encodeURIComponent(q)}${country ? `&country=${country}` : ''}`),
  damPrepare: (id, reachKm) => request(`/api/dams/${encodeURIComponent(id)}/prepare?reach_km=${reachKm}`),
  damWris: (id) => request(`/api/dams/${encodeURIComponent(id)}/wris`),
  reservoirPreview: (inputs) => request('/api/studio/reservoir', { method: 'POST', body: inputs }),
  startRun: (inputs) => request('/api/studio/runs', { method: 'POST', body: inputs }),
  runStatus: (id) => request(`/api/studio/runs/${id}`),
  runScene: (id) => request(`/api/studio/runs/${id}/scene`),
  satellite: (inputs, runId) =>
    request('/api/studio/satellite', { method: 'POST', body: { inputs, run_id: runId } }),

  officerLogin: (pin) => request('/api/officer/login', { method: 'POST', body: { pin } }),
  officerSummary: (token) => request('/api/officer/summary', { token, cacheKey: 'summary' }),
  setScenario: (token, scenarioId) =>
    request('/api/officer/scenario', { method: 'POST', token, body: { scenario_id: scenarioId } }),
  sendAlert: (token, alert) => request('/api/officer/alerts', { method: 'POST', token, body: alert }),
};
