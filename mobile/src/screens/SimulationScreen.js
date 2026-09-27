import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import Slider from '@react-native-community/slider';
import MapView, { Marker, Polygon, Polyline } from 'react-native-maps';
import { Ionicons } from '@expo/vector-icons';

import { useApp } from '../context/AppContext';
import { api } from '../services/api';
import { INITIAL_REGION } from '../config';
import { colors, sim as simColors, type } from '../theme';
import Flood3D from '../components/Flood3D';
import Hydrograph from '../components/Hydrograph';
import { Banner, Button, Chip, Loading, ScreenHeader, Section } from '../components/ui';
import { extentGeoJSON, extentKML, extentRings, formatClock } from '../utils/simGeometry';

const PLAY_MS = 90;
const PARAMS = [
  { key: 'volume_mm3', label: 'volume', unit: 'Mm³', min: 1, max: 120, step: 1 },
  { key: 'height_m', label: 'damHeight', unit: 'm', min: 5, max: 100, step: 1 },
  { key: 'formation_min', label: 'formationTime', unit: 'min', min: 5, max: 120, step: 1 },
];
const PIPELINE = [1, 2, 3, 4, 5, 6];

export default function SimulationScreen({ route, navigation }) {
  const { t, overview } = useApp();
  const focused = useIsFocused();
  const inStack = route?.name === 'Simulation'; // opened from Home: the stack header is shown instead

  const scenarios = overview?.scenarios || [];
  const [scenarioId, setScenarioId] = useState(overview?.active_scenario?.id || scenarios[0]?.id || 'S1');
  const scenario = scenarios.find((s) => s.id === scenarioId);
  // Breach inputs. null means "use the scenario defaults from the server".
  const [params, setParams] = useState(scenario?.breach || null);
  const [draft, setDraft] = useState(null); // slider values while dragging

  const [terrain, setTerrain] = useState(null);
  const [sim, setSim] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [offline, setOffline] = useState(false);

  const [view, setView] = useState('3d');
  const [layers, setLayers] = useState({ sph: true, delft: true });
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scrollLock, setScrollLock] = useState(false);
  const [openStep, setOpenStep] = useState(6);

  useEffect(() => {
    api.terrain().then((r) => setTerrain(r.data)).catch(setError);
  }, []);

  // Re-run whenever the scenario or breach inputs change.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.simulation(scenarioId, params || {})
      .then((r) => {
        if (!alive) return;
        setSim(r.data);
        setOffline(r.cached);
        setError(null);
        setFrame((f) => Math.min(f, r.data.frames.length - 1));
      })
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [scenarioId, params]);

  // Timeline playback. Stops at the end, and when the screen loses focus.
  useEffect(() => {
    if (!playing || !sim || !focused) return undefined;
    const id = setInterval(() => {
      setFrame((f) => {
        if (f >= sim.frames.length - 1) { setPlaying(false); return f; }
        return f + 1;
      });
    }, PLAY_MS);
    return () => clearInterval(id);
  }, [playing, sim, focused]);

  const selectScenario = (sc) => {
    setScenarioId(sc.id);
    setParams(sc.breach || null);
    setDraft(null);
    setFrame(0);
    setPlaying(false);
  };
  const updateParam = (patch) => {
    setDraft(null);
    setParams((p) => ({ ...(p || sim.params), ...patch }));
  };

  const togglePlay = () => {
    if (!sim) return;
    if (!playing && frame >= sim.frames.length - 1) setFrame(0);
    setPlaying((p) => !p);
  };

  const onInteract = useCallback((busy) => setScrollLock(busy), []);

  const exportExtent = async (fmt) => {
    const f = sim.frames[frame];
    const body = fmt === 'kml' ? extentKML(sim, f) : JSON.stringify(extentGeoJSON(sim, f));
    const name = `inundation_${sim.scenario.id}_T${Math.round(f.t_min)}.${fmt}`;
    if (Platform.OS === 'web') {
      const url = URL.createObjectURL(new Blob([body], { type: fmt === 'kml' ? 'application/vnd.google-earth.kml+xml' : 'application/geo+json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    try {
      await Share.share({ title: name, message: body });
    } catch (e) {
      console.warn('[export]', e.message);
    }
  };

  if (!sim || !terrain) {
    return (
      <View style={styles.screen}>
        {inStack ? null : <ScreenHeader title={t('tabSimulate')} subtitle={t('simSubtitle')} />}
        {error ? (
          <View style={styles.body}>
            <Banner tone="EXTREME" icon="cloud-offline-outline" text={t('serverDown')} />
          </View>
        ) : (
          <Loading label={t('loading')} />
        )}
      </View>
    );
  }

  const cur = sim.frames[frame];
  const inputs = params || sim.params;
  const shown = { ...inputs, ...draft };
  const peakFrame = sim.frames.reduce((a, b) => (b.q_sph > a.q_sph ? b : a));

  return (
    <View style={styles.screen}>
      {inStack ? null : <ScreenHeader title={t('tabSimulate')} subtitle={`${sim.scenario.id}: ${sim.scenario.name}`} />}
      <ScrollView contentContainerStyle={styles.body} scrollEnabled={!scrollLock} keyboardShouldPersistTaps="handled">
        {offline ? <Banner tone="MODERATE" icon="cloud-offline-outline" text={t('offline')} /> : null}
        <Pressable onPress={() => navigation.navigate('DamStudio')} style={styles.studioLink} accessibilityRole="button">
          <Ionicons name="cube-outline" size={20} color={colors.water} style={{ marginRight: 8 }} />
          <Text style={[type.body, { flex: 1, fontWeight: '700', color: colors.water }]}>{t('stOpen')}</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.water} />
        </Pressable>

        <View style={styles.row}>
          <Chip label={t('view3d')} active={view === '3d'} onPress={() => setView('3d')} />
          <Chip label={t('view2d')} active={view === 'map'} onPress={() => setView('map')} />
          <View style={{ flex: 1 }} />
          <LayerToggle color={simColors.sph} label="SPH" on={layers.sph} onPress={() => setLayers((l) => ({ ...l, sph: !l.sph }))} />
          <LayerToggle color={simColors.delft} label="Delft3D" on={layers.delft} onPress={() => setLayers((l) => ({ ...l, delft: !l.delft }))} />
        </View>

        {view === '3d' ? (
          <Flood3D terrain={terrain} sim={sim} frameIdx={frame} layers={layers} active={focused} onInteract={onInteract} t={t} />
        ) : (
          <SimMap sim={sim} frame={cur} layers={layers} dam={overview?.dam} t={t} />
        )}

        <View style={styles.timeline}>
          <Pressable
            onPress={togglePlay}
            style={styles.playBtn}
            accessibilityRole="button"
            accessibilityLabel={playing ? t('pause') : t('play')}
          >
            <Ionicons name={playing ? 'pause' : 'play'} size={20} color="#FFFFFF" />
          </Pressable>
          <Slider
            style={{ flex: 1, marginHorizontal: 8 }}
            minimumValue={0}
            maximumValue={sim.frames.length - 1}
            step={1}
            value={frame}
            onSlidingStart={() => setPlaying(false)}
            onValueChange={(v) => setFrame(Math.round(v))}
            minimumTrackTintColor={colors.water}
            maximumTrackTintColor={colors.line}
            thumbTintColor={colors.water}
            accessibilityLabel="Timeline"
          />
          <Text style={styles.clock}>{formatClock(cur.t_min)}</Text>
        </View>
        {loading ? <Text style={[type.small, { textAlign: 'right' }]}>{t('loading')}…</Text> : null}

        <View style={styles.metrics}>
          <Metric label={t('sphQ')} value={`${cur.q_sph.toLocaleString('en-IN')} m³/s`} sub={t('peakValue', { v: `${sim.peak_q_m3s.toLocaleString('en-IN')}` })} color={simColors.sph} />
          <Metric label={t('delftQ')} value={`${cur.q_delft.toLocaleString('en-IN')} m³/s`} sub={t('peakValue', { v: `${sim.peak_q_delft_m3s.toLocaleString('en-IN')}` })} color={simColors.delft} />
          <Metric label={t('waveFront')} value={`${cur.front_km.toFixed(1)} km`} sub={t('ofReach', { km: sim.reach_km })} />
          <Metric label={t('inundatedArea')} value={`${cur.area_km2.toFixed(1)} km²`} sub={`max ${cur.max_depth_m.toFixed(1)} m`} color="#A61B1B" />
        </View>

        <Section title={t('hydrograph')}>
          <View style={styles.card}>
            <Hydrograph frames={sim.frames} frameIdx={frame} t={t} />
            <Text style={[type.small, { marginTop: 6 }]}>
              {`SPH peak ${formatClock(peakFrame.t_min)}. Far-field gauge ${sim.reach_km} km downstream.`}
            </Text>
          </View>
        </Section>

        <Section title={t('scenario')}>
          <Text style={[type.small, { marginBottom: 8 }]}>{t('whatIf')}</Text>
          {scenarios.map((sc) => (
            <Pressable
              key={sc.id}
              onPress={() => selectScenario(sc)}
              style={[styles.scCard, sc.id === scenarioId && styles.scActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: sc.id === scenarioId }}
            >
              <Text style={[type.body, { fontWeight: '700' }]}>{`${sc.id}: ${sc.name}`}</Text>
              <Text style={type.small}>{`${sc.trigger}. Breach ${sc.breach_width_m} m. ${overview?.dam?.name || ''}`}</Text>
            </Pressable>
          ))}
        </Section>

        <Section title={t('failureMode')}>
          <View style={styles.row}>
            {['overtopping', 'piping'].map((m) => (
              <Chip key={m} label={t(m)} active={inputs.failure_mode === m} onPress={() => updateParam({ failure_mode: m })} />
            ))}
          </View>
        </Section>

        <Section title={t('breachParams')}>
          {PARAMS.map((p) => (
            <View key={p.key} style={styles.param}>
              <View style={styles.paramHead}>
                <Text style={type.small}>{t(p.label)}</Text>
                <Text style={styles.paramVal}>{`${Math.round(shown[p.key])} ${p.unit}`}</Text>
              </View>
              <Slider
                minimumValue={p.min}
                maximumValue={p.max}
                step={p.step}
                value={inputs[p.key]}
                onValueChange={(v) => setDraft((d) => ({ ...d, [p.key]: v }))}
                onSlidingComplete={(v) => updateParam({ [p.key]: v })}
                minimumTrackTintColor={colors.water}
                maximumTrackTintColor={colors.line}
                thumbTintColor={colors.water}
                accessibilityLabel={t(p.label)}
              />
            </View>
          ))}
          <Button label={t('resetParams')} variant="secondary" icon="refresh" onPress={() => scenario && selectScenario(scenario)} />
        </Section>

        {sim.arrivals.length ? (
          <Section title={t('arrivalByArea')}>
            {sim.arrivals.map((a) => {
              const reached = cur.t_min >= a.arrival_min;
              return (
                <View key={a.name} style={styles.arrRow}>
                  <Ionicons name={reached ? 'water' : 'time-outline'} size={18} color={reached ? '#A61B1B' : colors.inkSoft} style={{ marginRight: 10 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={type.body}>{a.name}</Text>
                    <Text style={type.small}>{`${a.chainage_km} km. ${a.population.toLocaleString('en-IN')} people`}</Text>
                  </View>
                  <Text style={[styles.arrTime, reached && { color: '#A61B1B' }]}>{formatClock(a.arrival_min)}</Text>
                </View>
              );
            })}
          </Section>
        ) : null}

        <Section title={t('exportExtent')}>
          <View style={styles.row}>
            <View style={{ flex: 1, marginRight: 8 }}>
              <Button label=".geojson" variant="secondary" icon="share-outline" onPress={() => exportExtent('geojson')} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label=".kml" variant="secondary" icon="share-outline" onPress={() => exportExtent('kml')} />
            </View>
          </View>
        </Section>

        <Section title={t('pipeline')}>
          {PIPELINE.map((n) => (
            <Pressable key={n} onPress={() => setOpenStep(openStep === n ? null : n)} style={[styles.step, openStep === n && styles.stepOpen]} accessibilityRole="button">
              <View style={styles.stepHead}>
                <Text style={styles.stepNum}>{`STEP ${n}`}</Text>
                <Text style={[type.body, { fontWeight: '700', flex: 1 }]}>{t(`pipe${n}`)}</Text>
                <Ionicons name={openStep === n ? 'chevron-up' : 'chevron-down'} size={16} color={colors.inkSoft} />
              </View>
              {openStep === n ? <Text style={[type.small, { marginTop: 4 }]}>{t(`pipe${n}d`)}</Text> : null}
            </Pressable>
          ))}
        </Section>

        <Text style={[type.small, styles.disclaimer]}>{t('simDisclaimer')}</Text>
      </ScrollView>
    </View>
  );
}

function SimMap({ sim, frame, layers, dam, t }) {
  const toLL = ([lat, lng]) => ({ latitude: lat, longitude: lng });
  const river = useMemo(() => sim.stations.map((s) => toLL([s.lat, s.lng])), [sim.stations]);
  const delft = layers.delft ? extentRings(sim.stations, frame.width_delft_m) : [];
  const sph = layers.sph ? extentRings(sim.stations, frame.width_sph_m) : [];
  const front = sim.stations.reduce((best, s) => (Math.abs(s.chainage_km - frame.front_km) < Math.abs(best.chainage_km - frame.front_km) ? s : best));

  return (
    <View style={styles.mapWrap}>
      <MapView style={StyleSheet.absoluteFill} initialRegion={INITIAL_REGION}>
        <Polyline coordinates={river} strokeColor={colors.water} strokeWidth={2} lineDashPattern={[4, 6]} />
        {delft.map((ring, i) => (
          <Polygon key={`d${i}`} coordinates={ring.map(toLL)} fillColor={simColors.delftFill} strokeColor={simColors.delft} strokeWidth={1} />
        ))}
        {sph.map((ring, i) => (
          <Polygon key={`s${i}`} coordinates={ring.map(toLL)} fillColor={simColors.sphFill} strokeColor={simColors.sph} strokeWidth={1} />
        ))}
        {frame.front_km > 0 ? (
          <Marker coordinate={toLL([front.lat, front.lng])} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} title={t('waveFront')}>
            <View style={styles.frontDot} />
          </Marker>
        ) : null}
        {dam ? (
          <Marker coordinate={toLL([dam.lat, dam.lng])} title={dam.name} description={t('dam')} pinColor="orange" tracksViewChanges={false} />
        ) : null}
      </MapView>
      <View style={styles.mapCaption} pointerEvents="none">
        <Text style={styles.mapCaptionText}>{`${sim.scenario.id}: ${sim.stations.length} cross-sections over ${sim.reach_km} km (sample)`}</Text>
      </View>
    </View>
  );
}

function LayerToggle({ color, label, on, onPress }) {
  return (
    <Pressable onPress={onPress} style={[styles.layer, on && { borderColor: color }]} accessibilityRole="checkbox" accessibilityState={{ checked: on }} hitSlop={6}>
      <View style={[styles.layerDot, { backgroundColor: on ? color : colors.line }]} />
      <Text style={[styles.layerText, { color: on ? colors.ink : colors.inkSoft }]}>{label}</Text>
    </Pressable>
  );
}

function Metric({ label, value, sub, color }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, color && { color }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      {sub ? <Text style={type.small}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  studioLink: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 12, backgroundColor: colors.waterSoft, marginBottom: 10 },
  body: { paddingHorizontal: 16, paddingBottom: 48, paddingTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  layer: {
    flexDirection: 'row', alignItems: 'center', borderWidth: 1.5, borderColor: colors.line, borderRadius: 16,
    paddingHorizontal: 9, paddingVertical: 5, marginLeft: 6, marginBottom: 8, backgroundColor: colors.card,
  },
  layerDot: { width: 9, height: 9, borderRadius: 5, marginRight: 5 },
  layerText: { fontSize: 12, fontWeight: '700' },
  mapWrap: { height: 340, borderRadius: 14, overflow: 'hidden', backgroundColor: colors.waterSoft },
  mapCaption: {
    position: 'absolute', left: 10, bottom: 10, right: 10, backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: 8, padding: 8,
  },
  mapCaptionText: { fontSize: 11, color: colors.ink, fontWeight: '600' },
  frontDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: '#A61B1B', borderWidth: 2, borderColor: '#FFFFFF' },
  timeline: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  playBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.water, alignItems: 'center', justifyContent: 'center' },
  clock: { ...type.num, width: 74, textAlign: 'right', fontSize: 15, fontWeight: '800', color: colors.ink },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 12 },
  metric: {
    width: '48.5%', backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
  },
  metricLabel: { fontSize: 11, fontWeight: '700', color: colors.inkSoft, textTransform: 'uppercase', letterSpacing: 0.4 },
  metricValue: { fontSize: 19, fontWeight: '800', color: colors.ink, marginTop: 2, ...type.num },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  scCard: { backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.line },
  scActive: { borderColor: colors.water, borderWidth: 2, backgroundColor: colors.waterSoft },
  param: { marginBottom: 12 },
  paramHead: { flexDirection: 'row', justifyContent: 'space-between' },
  paramVal: { fontSize: 14, fontWeight: '800', color: colors.ink, ...type.num },
  arrRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  arrTime: { fontSize: 14, fontWeight: '800', color: colors.inkSoft, ...type.num },
  step: { backgroundColor: colors.card, borderRadius: 10, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: colors.line },
  stepOpen: { borderColor: colors.water },
  stepHead: { flexDirection: 'row', alignItems: 'center' },
  stepNum: { fontSize: 11, fontWeight: '800', color: simColors.dam, marginRight: 10, ...type.num },
  disclaimer: { marginTop: 20, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.line, borderRadius: 10, padding: 10 },
});
