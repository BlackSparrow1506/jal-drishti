import Constants from 'expo-constants';

// Where the FastAPI backend lives.
// 1. If EXPO_PUBLIC_API_URL is set in mobile/.env, that wins.
// 2. Otherwise we reuse the laptop IP that Expo is already serving from, on port 8000.
//    This works automatically when the phone and laptop are on the same Wi-Fi.
function resolveApiBase() {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const hostUri = Constants.expoConfig?.hostUri || Constants.expoGoConfig?.debuggerHost;
  if (hostUri) {
    const host = hostUri.split(':')[0];
    return `http://${host}:8000`;
  }
  return 'http://localhost:8000';
}

export const API_BASE = resolveApiBase();
export const WS_BASE = API_BASE.replace(/^http/, 'ws');

// Map starts centred on the demo river (Mutha, downstream of Khadakwasla, Pune).
export const INITIAL_REGION = {
  latitude: 18.495,
  longitude: 73.832,
  latitudeDelta: 0.13,
  longitudeDelta: 0.13,
};
