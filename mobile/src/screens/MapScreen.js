import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { useApp } from '../context/AppContext';
import { api } from '../services/api';
import { colors } from '../theme';
import FloodMap from '../components/FloodMap';
import { Banner, Chip, ScreenHeader } from '../components/ui';

export default function MapScreen() {
  const { t, coords, overview, prefs, dataVersion } = useApp();
  const [zones, setZones] = useState(null);
  const [places, setPlaces] = useState(null);
  const [localities, setLocalities] = useState([]);
  const [offline, setOffline] = useState(false);
  const [layers, setLayers] = useState({ zones: true, camps: true, facilities: false, areas: true });
  const isOfficer = prefs.role === 'officer';

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        try {
          const [z, p] = await Promise.all([api.zones(), api.places()]);
          if (!alive) return;
          setZones(z.data);
          setPlaces(p.data);
          setOffline(z.cached || p.cached);
          if (isOfficer && prefs.officerToken) {
            const s = await api.officerSummary(prefs.officerToken);
            if (alive) setLocalities(s.data.localities || []);
          }
        } catch {
          if (alive) setOffline(true);
        }
      })();
      return () => {
        alive = false;
      };
    }, [dataVersion, isOfficer, prefs.officerToken])
  );

  const toggle = (k) => setLayers((l) => ({ ...l, [k]: !l[k] }));
  const layerKeys = isOfficer ? ['zones', 'areas', 'camps', 'facilities'] : ['zones', 'camps', 'facilities'];
  const labels = { zones: 'layerZones', camps: 'layerCamps', facilities: 'layerFacilities', areas: 'layerAreas' };

  return (
    <View style={styles.screen}>
      <ScreenHeader title={t('tabMap')} subtitle={overview?.active_scenario?.name || t('noThreat')} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow} contentContainerStyle={styles.chips}>
        {layerKeys.map((k) => (
          <Chip key={k} small label={t(labels[k])} active={layers[k]} onPress={() => toggle(k)} />
        ))}
      </ScrollView>
      {offline ? (
        <View style={{ paddingHorizontal: 16 }}>
          <Banner tone="MODERATE" icon="cloud-offline-outline" text={t('offline')} />
        </View>
      ) : null}
      <FloodMap
        zones={zones}
        places={places}
        dam={overview?.dam}
        user={coords}
        localities={isOfficer ? localities : []}
        layers={layers}
        t={t}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  // flexGrow 0 stops the horizontal row from stretching to fill the screen height.
  chipRow: { flexGrow: 0, flexShrink: 0 },
  chips: { paddingHorizontal: 16, paddingBottom: 4, alignItems: 'center' },
});
