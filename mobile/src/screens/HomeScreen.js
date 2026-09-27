import React, { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useApp } from '../context/AppContext';
import { colors, type } from '../theme';
import { API_BASE } from '../config';
import RiskHero from '../components/RiskHero';
import AlertCard from '../components/AlertCard';
import { Banner, Button, Loading, ScreenHeader, Section } from '../components/ui';

export default function HomeScreen({ navigation }) {
  const { t, risk, coords, alerts, online, error, notice, refresh } = useApp();
  const [pulling, setPulling] = useState(false);

  const onRefresh = async () => {
    setPulling(true);
    await refresh();
    setPulling(false);
  };

  const where = coords
    ? coords.isDemo
      ? `${t('demoLocation')}: ${coords.label}`
      : `${t('yourLocation')}: ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`
    : '';

  if (!risk && error) {
    return (
      <View style={styles.screen}>
        <ScreenHeader title={t('appName')} />
        <View style={{ padding: 20 }}>
          <Banner tone="EXTREME" icon="cloud-offline-outline" text={t('serverDown')} />
          <Text style={[type.small, { marginBottom: 16 }]}>{`${t('server')}: ${API_BASE}`}</Text>
          <Button label={t('retry')} onPress={refresh} icon="refresh" />
        </View>
      </View>
    );
  }
  if (!risk) {
    return (
      <View style={styles.screen}>
        <ScreenHeader title={t('appName')} />
        <Loading label={t('loading')} />
      </View>
    );
  }

  const atRisk = risk.level === 'EXTREME' || risk.level === 'HIGH';
  const latest = alerts?.[0];

  return (
    <View style={styles.screen}>
      <ScreenHeader title={t('appName')} subtitle={where} />
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onRefresh} />}
      >
        {!online ? <Banner tone="MODERATE" icon="cloud-offline-outline" text={t('offline')} /> : null}
        {notice ? <Banner text={t(notice)} /> : null}

        <RiskHero risk={risk} t={t} />

        {risk.scenario_id ? (
          <View style={styles.stats}>
            <Stat label={t('velocity')} value={`${risk.velocity_mps.toFixed(1)} m/s`} />
            <Stat label={t('toRiver')} value={formatMeters(risk.distance_to_river_m)} />
          </View>
        ) : null}

        <View style={{ marginTop: 16 }}>
          {atRisk ? (
            <Button label={t('showRoute')} icon="walk" onPress={() => navigation.navigate('Evacuate')} />
          ) : null}
          <View style={{ height: 10 }} />
          <Button
            label={t('sos')}
            icon="call"
            variant={atRisk ? 'secondary' : 'primary'}
            color={atRisk ? undefined : colors.ink}
            onPress={() => navigation.navigate('Sos')}
          />
        </View>

        <Pressable
          onPress={() => navigation.navigate('Simulation')}
          style={({ pressed }) => [styles.simCard, pressed && { opacity: 0.8 }]}
          accessibilityRole="button"
        >
          <Ionicons name="cube-outline" size={26} color="#FFFFFF" style={{ marginRight: 12 }} />
          <View style={{ flex: 1 }}>
            <Text style={styles.simTitle}>{t('openSim')}</Text>
            <Text style={styles.simSub}>{t('openSimSub')}</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#FFFFFF" />
        </Pressable>

        {latest ? (
          <Section
            title={t('latestAlert')}
            right={
              <Pressable onPress={() => navigation.navigate('Alerts')} hitSlop={8}>
                <Text style={styles.link}>{t('seeAll')}</Text>
              </Pressable>
            }
          >
            <AlertCard alert={latest} t={t} compact />
          </Section>
        ) : null}

        <Text style={[type.small, styles.footer]}>{t('sampleData')}</Text>
      </ScrollView>
    </View>
  );
}

function Stat({ label, value }) {
  return (
    <View style={styles.stat}>
      <Text style={type.small}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function formatMeters(m) {
  if (m == null) return '';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  body: { paddingHorizontal: 20, paddingBottom: 40 },
  stats: { flexDirection: 'row', marginTop: 12 },
  simCard: {
    flexDirection: 'row', alignItems: 'center', marginTop: 16, padding: 16, borderRadius: 14,
    backgroundColor: '#0E2233',
  },
  simTitle: { fontSize: 16, fontWeight: '800', color: '#FFFFFF' },
  simSub: { fontSize: 13, color: 'rgba(255,255,255,0.75)', marginTop: 2 },
  stat: {
    flex: 1, backgroundColor: colors.card, borderRadius: 12, padding: 14, marginRight: 10,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
  },
  statValue: { fontSize: 22, fontWeight: '800', color: colors.ink, marginTop: 4, fontVariant: ['tabular-nums'] },
  link: { color: colors.water, fontWeight: '700', fontSize: 14 },
  footer: { textAlign: 'center', marginTop: 28 },
});
