import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import MapView, { Circle, Marker, Polygon, Polyline } from 'react-native-maps';

import { INITIAL_REGION } from '../config';
import { colors, risk as riskColors, routeColor, zoneFill } from '../theme';

const toLatLng = ([lng, lat]) => ({ latitude: lat, longitude: lng });
const PIN = { hospital: 'blue', school: 'violet', bridge: 'orange' };

export default function FloodMap({
  zones, places, dam, user, route, localities, layers = {}, t, style, fitRoute,
}) {
  const mapRef = useRef(null);
  const show = { zones: true, camps: true, facilities: true, areas: true, ...layers };

  const zoneFeatures = zones?.features?.filter((f) => f.properties.kind === 'zone') || [];
  const river = zones?.features?.find((f) => f.properties.kind === 'river');

  useEffect(() => {
    if (!fitRoute || !route?.coords?.length || !mapRef.current) return;
    const pts = route.coords.map(([lat, lng]) => ({ latitude: lat, longitude: lng }));
    const id = setTimeout(() => {
      mapRef.current?.fitToCoordinates(pts, {
        edgePadding: { top: 60, right: 40, bottom: 60, left: 40 }, animated: true,
      });
    }, 300);
    return () => clearTimeout(id);
  }, [route, fitRoute]);

  return (
    <View style={[styles.wrap, style]}>
      <MapView ref={mapRef} style={StyleSheet.absoluteFill} initialRegion={INITIAL_REGION} showsCompass>
        {show.zones &&
          zoneFeatures.map((f) => (
            <Polygon
              key={`zone-${f.properties.level}`}
              coordinates={f.geometry.coordinates[0].map(toLatLng)}
              fillColor={zoneFill[f.properties.level]}
              strokeColor="transparent"
              strokeWidth={0}
            />
          ))}

        {river ? (
          <Polyline coordinates={river.geometry.coordinates.map(toLatLng)} strokeColor={colors.water} strokeWidth={4} />
        ) : null}

        {show.areas &&
          (localities || []).map((l) => (
            <Circle
              key={`loc-${l.id}`}
              center={{ latitude: l.lat, longitude: l.lng }}
              radius={Math.max(150, Math.sqrt(l.population) * 2.2)}
              fillColor={`${riskColors[l.level]?.bg || colors.ink}55`}
              strokeColor={riskColors[l.level]?.bg || colors.ink}
              strokeWidth={1.5}
            />
          ))}

        {route?.coords?.length ? (
          <Polyline
            coordinates={route.coords.map(([lat, lng]) => ({ latitude: lat, longitude: lng }))}
            strokeColor={routeColor[route.status] || colors.ink}
            strokeWidth={6}
            lineDashPattern={route.route_source === 'osrm' ? undefined : [10, 8]}
          />
        ) : null}

        {dam ? (
          <Marker coordinate={{ latitude: dam.lat, longitude: dam.lng }} title={dam.name} description={t('dam')} pinColor="navy" tracksViewChanges={false} />
        ) : null}

        {show.camps &&
          (places?.shelters || []).map((s) => (
            <Marker key={s.id} coordinate={{ latitude: s.lat, longitude: s.lng }} title={s.name}
              description={`${t('layerCamps')}: ${s.capacity}`} pinColor="green" tracksViewChanges={false} />
          ))}

        {show.facilities &&
          (places?.facilities || []).filter((f) => f.type !== 'bridge').map((f) => (
            <Marker key={f.id} coordinate={{ latitude: f.lat, longitude: f.lng }} title={f.name}
              pinColor={PIN[f.type] || 'blue'} tracksViewChanges={false} />
          ))}

        {user ? (
          <Marker coordinate={{ latitude: user.lat, longitude: user.lng }} title={t('you')} tracksViewChanges={false}>
            <View style={styles.userDot} />
          </Marker>
        ) : null}
      </MapView>

      {show.zones && zoneFeatures.length ? (
        <View style={styles.legend} pointerEvents="none">
          {['EXTREME', 'HIGH', 'MODERATE'].map((lvl) => (
            <View key={lvl} style={styles.legendRow}>
              <View style={[styles.swatch, { backgroundColor: riskColors[lvl].bg }]} />
              <Text style={styles.legendText}>{t(`level_${lvl}`)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, overflow: 'hidden', backgroundColor: colors.waterSoft },
  userDot: {
    width: 20, height: 20, borderRadius: 10, backgroundColor: colors.water,
    borderWidth: 3, borderColor: '#FFFFFF',
  },
  legend: {
    position: 'absolute', left: 10, bottom: 10, backgroundColor: 'rgba(255,255,255,0.94)',
    borderRadius: 10, padding: 10,
  },
  legendRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 2 },
  swatch: { width: 14, height: 14, borderRadius: 3, marginRight: 8 },
  legendText: { fontSize: 12, fontWeight: '600', color: colors.ink },
});
