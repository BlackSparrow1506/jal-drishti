import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Vibration } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';

import { api } from '../services/api';
import { connectAlerts } from '../services/socket';
import { makeT } from '../i18n/strings';

const AppContext = createContext(null);
const PREFS_KEY = 'jd:prefs';
const RISK_REFRESH_MS = 120000;

const DEFAULT_PREFS = {
  lang: 'en',
  role: 'citizen', // 'citizen' | 'officer'
  officerToken: null,
  locationMode: 'demo', // 'demo' | 'gps'
  demoId: 'd1',
};

export function AppProvider({ children }) {
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [ready, setReady] = useState(false);

  const [overview, setOverview] = useState(null);
  const [coords, setCoords] = useState(null); // { lat, lng, label, isDemo }
  const [risk, setRisk] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [liveAlert, setLiveAlert] = useState(null);

  const [online, setOnline] = useState(true);
  const [socketUp, setSocketUp] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [dataVersion, setDataVersion] = useState(0); // bumps when the officer changes scenario

  const t = useMemo(() => makeT(prefs.lang), [prefs.lang]);

  // Load saved preferences once.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(PREFS_KEY);
        if (raw) setPrefs((p) => ({ ...p, ...JSON.parse(raw) }));
      } catch {}
      setReady(true);
    })();
  }, []);

  const updatePrefs = useCallback((patch) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      AsyncStorage.setItem(PREFS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const resolveLocation = useCallback(
    async (ov) => {
      setNotice(null);
      const demos = ov?.demo_locations || [];
      const demo = demos.find((d) => d.id === prefs.demoId) || demos[0];
      if (prefs.locationMode === 'gps') {
        try {
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status === 'granted') {
            const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
            return { lat: pos.coords.latitude, lng: pos.coords.longitude, label: null, isDemo: false };
          }
        } catch (e) {
          console.warn('[location]', e.message);
        }
        setNotice('gpsDenied');
      }
      return demo ? { lat: demo.lat, lng: demo.lng, label: demo.name, isDemo: true } : null;
    },
    [prefs.locationMode, prefs.demoId]
  );

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const ov = await api.overview();
      setOverview(ov.data);
      let cached = ov.cached;

      const c = await resolveLocation(ov.data);
      setCoords(c);
      if (c) {
        const r = await api.risk(c.lat, c.lng);
        setRisk(r.data);
        cached = cached || r.cached;
      }
      const a = await api.alerts();
      setAlerts(a.data);
      setOnline(!(cached || a.cached));
    } catch (e) {
      setOnline(false);
      setError(e);
    }
  }, [resolveLocation]);

  useEffect(() => {
    if (ready) refresh();
  }, [ready, refresh, dataVersion]);

  // Keep risk fresh in the background.
  useEffect(() => {
    if (!ready) return undefined;
    const id = setInterval(refresh, RISK_REFRESH_MS);
    return () => clearInterval(id);
  }, [ready, refresh]);

  // Live alerts and scenario changes over WebSocket.
  useEffect(() => {
    if (!ready) return undefined;
    const conn = connectAlerts({
      onStatus: setSocketUp,
      onMessage: (msg) => {
        if (msg.type === 'alert') {
          setAlerts((prev) => [msg.alert, ...prev.filter((a) => a.id !== msg.alert.id)]);
          setLiveAlert(msg.alert);
          if (msg.alert.severity === 'EXTREME' || msg.alert.severity === 'HIGH') {
            Vibration.vibrate([0, 400, 200, 400]);
          }
        }
        if (msg.type === 'scenario') setDataVersion((v) => v + 1);
      },
    });
    return () => conn.close();
  }, [ready]);

  const officerLogin = useCallback(
    async (pin) => {
      const r = await api.officerLogin(pin);
      updatePrefs({ role: 'officer', officerToken: r.data.token });
    },
    [updatePrefs]
  );

  const officerLogout = useCallback(() => updatePrefs({ role: 'citizen', officerToken: null }), [updatePrefs]);

  const value = {
    ready, prefs, updatePrefs, t,
    overview, coords, risk, alerts, liveAlert, setLiveAlert,
    online, socketUp, error, notice, dataVersion,
    refresh, bumpData: () => setDataVersion((v) => v + 1),
    officerLogin, officerLogout,
  };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
