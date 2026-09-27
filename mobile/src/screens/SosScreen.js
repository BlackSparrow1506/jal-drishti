import React from 'react';
import { Linking, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useApp } from '../context/AppContext';
import { colors, type } from '../theme';
import { Button } from '../components/ui';

const NUMBERS = [
  { num: '112', key: 'call112', icon: 'alert-circle', color: '#A61B1B' },
  { num: '108', key: 'call108', icon: 'medkit', color: '#C8561A' },
  { num: '101', key: 'call101', icon: 'flame', color: '#12324A' },
  { num: '100', key: 'call100', icon: 'shield', color: '#12324A' },
];

export default function SosScreen() {
  const { t, coords } = useApp();

  const share = () => {
    if (!coords) return;
    const url = `https://maps.google.com/?q=${coords.lat},${coords.lng}`;
    Share.share({ message: t('shareMsg', { url }) });
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
      {NUMBERS.map((n) => (
        <Pressable
          key={n.num}
          onPress={() => Linking.openURL(`tel:${n.num}`)}
          style={({ pressed }) => [styles.call, { backgroundColor: n.color }, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
          accessibilityLabel={`${t(n.key)} ${n.num}`}
        >
          <Ionicons name={n.icon} size={28} color="#FFFFFF" />
          <View style={{ marginLeft: 14, flex: 1 }}>
            <Text style={styles.num}>{n.num}</Text>
            <Text style={styles.callLabel}>{t(n.key)}</Text>
          </View>
          <Ionicons name="call" size={22} color="#FFFFFF" />
        </Pressable>
      ))}
      <View style={{ height: 8 }} />
      <Button label={t('shareLocation')} icon="share-social" variant="secondary" onPress={share} />
      {coords ? (
        <Text style={[type.small, { marginTop: 10, textAlign: 'center' }]}>
          {`${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  call: { flexDirection: 'row', alignItems: 'center', padding: 18, borderRadius: 14, marginBottom: 12 },
  num: { color: '#FFFFFF', fontSize: 28, fontWeight: '800', fontVariant: ['tabular-nums'] },
  callLabel: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
});
