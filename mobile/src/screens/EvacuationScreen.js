import React, { useCallback, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

import { useApp } from '../context/AppContext';
import { api } from '../services/api';
import { colors, routeColor, type } from '../theme';
import { formatDuration } from '../utils/format';
import FloodMap from '../components/FloodMap';
import { Banner, Button, Chip, Loading, ScreenHeader, Section } from '../components/ui';

const STATUS_ICON = { SAFE: 'shield-checkmark', CAUTION: 'warning', UNSAFE: 'close-circle' };

export default function EvacuationScreen() {
  const { t, coords, overview, dataVersion } = useApp();
  const [mode, setMode] = useState('walk');
  const [plan, setPlan] = useState(null);
  const [zones, setZones] = useState(null);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!coords) return;
    setLoading(true);
    setFailed(false);
    try {
      const [r, z] = await Promise.all([api.route(coords.lat, coords.lng, mode), api.zones()]);
      setPlan(r.data);
      setZones(z.data);
      setOffline(r.cached);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [coords, mode]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load, dataVersion])
  );

  const best = plan?.best;
  const originSafe = plan?.origin?.level === 'SAFE' || plan?.origin?.level === 'MODERATE';

  const openInMaps = () => {
    if (!best) return;
    const { lat, lng } = best.shelter;
    const travelmode = mode === 'walk' ? 'walking' : 'driving';
    Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=${travelmode}`);
  };

  return (
    <View style={styles.screen}>
      <ScreenHeader title={t('tabEvacuate')} subtitle={overview?.active_scenario?.name} />
      <View style={styles.modeRow}>
        <Chip label={t('walk')} active={mode === 'walk'} onPress={() => setMode('walk')} />
        <Chip label={t('drive')} active={mode === 'drive'} onPress={() => setMode('drive')} />
      </View>

      <FloodMap
        style={styles.map}
        zones={zones}
        user={coords}
        route={best}
        places={best ? { shelters: [best.shelter], facilities: [] } : null}
        layers={{ facilities: false }}
        t={t}
        fitRoute
      />

      <ScrollView contentContainerStyle={styles.sheet}>
        {loading && !best ? <Loading label={t('findingRoute')} /> : null}
        {failed && !best ? (
          <>
            <Banner tone="EXTREME" icon="cloud-offline-outline" text={t('serverDown')} />
            <Button label={t('retry')} onPress={load} icon="refresh" />
          </>
        ) : null}

        {best ? (
          <>
            {offline ? <Banner tone="MODERATE" icon="cloud-offline-outline" text={t('offline')} /> : null}
            {originSafe ? <Banner tone="SAFE" icon="checkmark-circle-outline" text={t('outsideZone')} /> : null}

            <View style={[styles.statusRow, { backgroundColor: routeColor[best.status] }]}>
              <Ionicons name={STATUS_ICON[best.status]} size={22} color="#FFFFFF" />
              <Text style={styles.statusText}>{t(`route_${best.status}`)}</Text>
            </View>

            <Text style={[type.small, { marginTop: 14 }]}>{t('routeTo')}</Text>
            <Text style={type.title}>{best.shelter.name}</Text>

            <View style={styles.metrics}>
              <Metric label={t('travelTime')} value={formatDuration(best.travel_min, t)} />
              <Metric label={t('distance')} value={`${best.distance_km} km`} />
              {best.safety_window_min != null ? (
                <Metric
                  label={t('safetyWindow')}
                  value={formatDuration(Math.max(0, best.safety_window_min), t)}
                  danger={best.safety_window_min < 10}
                />
              ) : null}
            </View>

            {best.status === 'UNSAFE' || (best.safety_window_min != null && best.safety_window_min < 10) ? (
              <Banner tone="EXTREME" icon="alert-circle-outline" text={t('unsafeAdvice')} />
            ) : null}
            {best.route_source !== 'osrm' ? <Banner text={t('estimateRoute')} /> : null}

            <Button label={t('openMaps')} icon="navigate" onPress={openInMaps} />
            <Text style={[type.small, { marginTop: 8 }]}>{t('mapsWarning')}</Text>

            {plan.alternatives?.length ? (
              <Section title={t('otherCamps')}>
                {plan.alternatives.map((a) => (
                  <View key={a.shelter.id} style={styles.alt}>
                    <View style={[styles.dot, { backgroundColor: routeColor[a.status] }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={type.body}>{a.shelter.name}</Text>
                      <Text style={type.small}>
                        {`${formatDuration(a.travel_min, t)}, ${a.distance_km} km. ${t(`route_${a.status}`)}`}
                      </Text>
                    </View>
                  </View>
                ))}
              </Section>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Metric({ label, value, danger }) {
  return (
    <View style={styles.metric}>
      <Text style={type.small}>{label}</Text>
      <Text style={[styles.metricValue, danger && { color: '#A61B1B' }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  modeRow: { flexDirection: 'row', paddingHorizontal: 16 },
  map: { flex: 0, height: 280 },
  sheet: { padding: 20, paddingBottom: 40 },
  statusRow: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 10 },
  statusText: { color: '#FFFFFF', fontWeight: '800', fontSize: 15, marginLeft: 8, flex: 1 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', marginVertical: 14 },
  metric: { marginRight: 22, marginBottom: 8 },
  metricValue: { fontSize: 20, fontWeight: '800', color: colors.ink, fontVariant: ['tabular-nums'] },
  alt: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  dot: { width: 12, height: 12, borderRadius: 6, marginTop: 6, marginRight: 12 },
});
