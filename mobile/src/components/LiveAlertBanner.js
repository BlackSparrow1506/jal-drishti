import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { risk as riskColors } from '../theme';
import { useApp } from '../context/AppContext';

// Slides over every screen when a new alert arrives over the WebSocket.
export default function LiveAlertBanner({ onOpen }) {
  const { liveAlert, setLiveAlert, t } = useApp();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!liveAlert) return undefined;
    const id = setTimeout(() => setLiveAlert(null), 12000);
    return () => clearTimeout(id);
  }, [liveAlert, setLiveAlert]);

  if (!liveAlert) return null;
  const c = riskColors[liveAlert.severity] || riskColors.INFO;
  return (
    <Pressable
      onPress={() => {
        setLiveAlert(null);
        onOpen?.();
      }}
      accessibilityRole="alert"
      style={[styles.wrap, { top: insets.top + 6, backgroundColor: c.bg }]}
    >
      <Text style={[styles.kicker, { color: c.fg }]}>{t(`level_${liveAlert.severity}`)}</Text>
      <Text style={[styles.title, { color: c.fg }]} numberOfLines={1}>{liveAlert.title}</Text>
      <Text style={[styles.msg, { color: c.fg }]} numberOfLines={2}>{liveAlert.message}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute', left: 12, right: 12, borderRadius: 14, padding: 14, zIndex: 100,
    elevation: 12, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
  },
  kicker: { fontSize: 12, fontWeight: '800' },
  title: { fontSize: 16, fontWeight: '800', marginTop: 2 },
  msg: { fontSize: 14, marginTop: 2 },
});
