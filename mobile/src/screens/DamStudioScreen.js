import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import Slider from '@react-native-community/slider';
import MapView, { Marker, Overlay, Polyline } from 'react-native-maps';
import { Ionicons } from '@expo/vector-icons';

import { useApp } from '../context/AppContext';
import { api, apiUrl } from '../services/api';
import { colors, sim as simColors, type } from '../theme';
import StudioScene3D, { decodeScene } from '../components/StudioScene3D';
import { Banner, Button, Chip, Section } from '../components/ui';
import { formatClock } from '../utils/simGeometry';

// Editable inputs: [key, label, unit]
const DAM_FIELDS = [
  ['height_m', 'Dam height', 'm'], ['length_m', 'Crest length', 'm'],
  ['gross_storage_mm3', 'Water capacity (gross storage)', 'Mm³'], ['reservoir_area_km2', 'Reservoir area at full level', 'km²'],
  ['storage_pct', 'Current storage', '% of capacity'], ['spillway_m3s', 'Spillway capacity', 'm³/s'],
  ['catchment_km2', 'Catchment area', 'km²'],
];
const RAIN_FIELDS = [['rain_mm', 'Rainfall', 'mm'], ['rain_hours', 'Over', 'hours'], ['runoff_coeff', 'Runoff coefficient', '0-1']];
const BREACH_FIELDS = [
  ['breach_width_m', 'Breach width (bottom)', 'm'], ['breach_depth_m', 'Breach depth (from crest)', 'm'],
  ['formation_h', 'Breach formation time', 'h'], ['side_slope', 'Breach side slope', 'H:V'],
];
const RUN_FIELDS = [['reach_km', 'Downstream reach', 'km'], ['flood_hours', 'Simulate flood for', 'hours']];

export default function DamStudioScreen({ route }) {
  const { t } = useApp();
  const focused = useIsFocused();
  const [q, setQ] = useState(route?.params?.query || '');
  const [country, setCountry] = useState(null);
  const [results, setResults] = useState([]);
  const [stats, setStats] = useState(null);
  const [dam, setDam] = useState(null);
  const [prep, setPrep] = useState(null);
  const [inputs, setInputs] = useState(null);
  const [preview, setPreview] = useState(null);
  const [run, setRun] = useState(null);
  const [scene, setScene] = useState(null);
  const [decoded, setDecoded] = useState(null);
  const [sat, setSat] = useState(null);
  const [cmp, setCmp] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState('3d');
  const [frame, setFrame] = useState(0);
  const [showMax, setShowMax] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [lock, setLock] = useState(false);
  const scrollRef = useRef(null);

  // Search the catalogue as the user types.
  useEffect(() => {
    const id = setTimeout(() => {
      api.damSearch(q, country).then((r) => { setResults(r.data.results); setStats(r.data.stats); }).catch(() => {});
    }, 250);
    return () => clearTimeout(id);
  }, [q, country]);

  const pick = async (d) => {
    setDam(d); setPrep(null); setPreview(null); setRun(null); setScene(null); setSat(null); setCmp(null); setError(null);
    setBusy('prepare');
    try {
      const r = await api.damPrepare(d.id, 25);
      const p = r.data;
      setPrep(p);
      const sb = p.suggested_breach || {};
      setInputs({
        dam_id: d.id, lat: d.lat, lng: d.lng, location_is: d.location_is || null, type: d.type || '',
        height_m: d.height_m ?? '', length_m: d.length_m ?? '', gross_storage_mm3: d.gross_storage_mm3 ?? '',
        reservoir_area_km2: d.reservoir_area_km2 ?? '', storage_pct: 90, spillway_m3s: d.spillway_m3s ?? 0,
        catchment_km2: d.catchment_km2 ?? p.site.catchment_km2,
        rain_mm: p.rainfall?.next_72h_mm ?? 0, rain_hours: 72, runoff_coeff: 0.5, rain_source: 'manual', rain_window: 'next',
        breach_width_m: sb.breach_width_m ?? 50, breach_depth_m: sb.breach_depth_m ?? d.height_m ?? 10,
        formation_h: sb.formation_h ?? 1, side_slope: 1, failure_mode: 'overtopping', breach_trigger: 'now',
        reach_km: 25, flood_hours: 6,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const numeric = () => {
    const out = { ...inputs };
    [...DAM_FIELDS, ...RAIN_FIELDS, ...BREACH_FIELDS, ...RUN_FIELDS].forEach(([k]) => {
      const v = parseFloat(out[k]);
      out[k] = Number.isFinite(v) ? v : null;
    });
    out.rain_hours = Math.max(1, Math.round(out.rain_hours || 24));
    return out;
  };

  const missing = inputs && ['height_m', 'gross_storage_mm3'].filter((k) => !(parseFloat(inputs[k]) > 0));

  const checkReservoir = async () => {
    setBusy('preview'); setError(null);
    try { setPreview((await api.reservoirPreview(numeric())).data); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  const startRun = async (override) => {
    setBusy('run'); setError(null); setScene(null); setDecoded(null); setFrame(0); setPlaying(false);
    try {
      const body = { ...numeric(), ...override };
      let s = (await api.startRun(body)).data;
      setRun(s);
      while (s.status === 'running') {
        await new Promise((r) => setTimeout(r, 1500));
        s = (await api.runStatus(s.run_id)).data;
        setRun(s);
      }
      if (s.status === 'error') throw new Error(s.error);
      const sc = (await api.runScene(s.run_id)).data;
      setScene(sc);
      setDecoded(decodeScene(sc));
      return s;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(null);
    }
  };

  // Buildings and shops load after the flood itself; keep polling until they arrive.
  useEffect(() => {
    if (!run || run.status !== 'done' || run.summary?.impacts_status !== 'pending') return undefined;
    const id = setInterval(async () => {
      try {
        const s = (await api.runStatus(run.run_id)).data;
        if (s.summary?.impacts_status !== 'pending') {
          setRun(s);
          const sc = (await api.runScene(run.run_id)).data;
          setScene(sc);
        } else setRun((r) => ({ ...r, impacts_progress: s.impacts_progress }));
      } catch {
        // keep trying
      }
    }, 3000);
    return () => clearInterval(id);
  }, [run]);

  useEffect(() => {
    if (!playing || !scene || !focused) return undefined;
    const id = setInterval(() => setFrame((f) => {
      if (f >= scene.frames.length - 1) { setPlaying(false); return f; }
      return f + 1;
    }), 250);
    return () => clearInterval(id);
  }, [playing, scene, focused]);

  const checkSatellite = async () => {
    setBusy('sat'); setError(null); setCmp(null);
    try { setSat((await api.satellite(numeric(), run?.status === 'done' ? run.run_id : null)).data); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  const rerunWithSatellite = async () => {
    const baseId = run?.run_id;
    const pct = sat.reservoir.implied_storage_pct;
    const s = await startRun({ storage_pct: pct });
    if (s && baseId && baseId !== s.run_id) {
      try {
        const r = await fetch(apiUrl(`/api/studio/compare?a=${baseId}&b=${s.run_id}`));
        setCmp(await r.json());
      } catch (e) {
        setError(e.message);
      }
    }
  };

  const onInteract = useCallback((b) => setLock(b), []);
  const set = (k) => (v) => setInputs((p) => ({ ...p, [k]: v }));
  const summary = run?.status === 'done' ? run.summary : null;

  return (
    <ScrollView ref={scrollRef} style={styles.screen} contentContainerStyle={styles.body} scrollEnabled={!lock} keyboardShouldPersistTaps="handled">
      <Text style={type.small}>{t('stIntro')}</Text>
      {error ? <Banner tone="EXTREME" icon="alert-circle-outline" text={error} /> : null}

      {/* 1. Choose a dam */}
      <Section title={t('stChooseDam')}>
        <View style={styles.search}>
          <Ionicons name="search" size={18} color={colors.inkSoft} />
          <TextInput value={q} onChangeText={setQ} placeholder={t('stSearchPh')} placeholderTextColor={colors.inkSoft} style={styles.searchInput} />
        </View>
        <View style={styles.rowWrap}>
          {[null, 'India', 'Nepal'].map((c) => (
            <Chip key={c || 'all'} label={c || t('stAll')} active={country === c} onPress={() => setCountry(c)} />
          ))}
        </View>
        {stats ? <Text style={type.small}>{`${stats.total.toLocaleString('en-IN')} dams: ${stats.sources.join('; ')}`}</Text> : null}
        {!dam || q ? results.slice(0, 8).map((d) => (
          <Pressable key={d.id} onPress={() => { setQ(''); pick(d); }} style={styles.result}>
            <View style={{ flex: 1 }}>
              <Text style={[type.body, { fontWeight: '700' }]}>{d.name}</Text>
              <Text style={type.small}>{[d.country, d.state, d.river, d.height_m ? `${d.height_m} m` : null, d.gross_storage_mm3 ? `${d.gross_storage_mm3} Mm³` : null].filter(Boolean).join(' · ')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.inkSoft} />
          </Pressable>
        )) : null}
      </Section>

      {busy === 'prepare' ? <Busy label={t('stPreparing')} /> : null}

      {dam && prep && inputs ? (
        <>
          <View style={styles.card}>
            <Text style={type.section}>{dam.name}</Text>
            <Text style={type.small}>{[dam.country, dam.state, dam.river, dam.type, dam.year].filter(Boolean).join(' · ')}</Text>
            <Text style={[type.small, { marginTop: 4 }]}>{`${t('stSource')}: ${dam.source}`}</Text>
            <Text style={type.small}>{`${t('stTerrain')}: ${prep.site.dem.name}. ${t('stCatchment')} ${prep.site.catchment_km2} km²${prep.site.catchment_window_limited ? ' (≥, extends beyond analysis area)' : ''}. ${t('stPath')} ${prep.site.reach_km} km.`}</Text>
            {(dam.checks || []).map((c) => <Banner key={c} tone="MODERATE" icon="warning-outline" text={c} />)}
          </View>

          {prep.rainfall && !prep.rainfall.error ? (
            <View style={styles.card}>
              <Text style={type.section}>{t('stLiveRain')}</Text>
              <View style={styles.rowWrap}>
                <Stat label={t('stPast72')} value={`${prep.rainfall.past_72h_mm} mm`} />
                <Stat label={t('stNext72')} value={`${prep.rainfall.next_72h_mm} mm`} />
              </View>
              <View style={styles.rowWrap}>
                <Chip label={t('stUsePast')} onPress={() => setInputs((p) => ({ ...p, rain_mm: prep.rainfall.past_72h_mm, rain_hours: 72, rain_source: 'live', rain_window: 'past' }))} active={inputs.rain_source === 'live' && inputs.rain_window === 'past'} />
                <Chip label={t('stUseNext')} onPress={() => setInputs((p) => ({ ...p, rain_mm: prep.rainfall.next_72h_mm, rain_hours: 72, rain_source: 'live', rain_window: 'next' }))} active={inputs.rain_source === 'live' && inputs.rain_window === 'next'} />
                <Chip label={t('stManual')} onPress={() => setInputs((p) => ({ ...p, rain_source: 'manual' }))} active={inputs.rain_source === 'manual'} />
              </View>
              <Text style={type.small}>{prep.rainfall.source}</Text>
            </View>
          ) : null}

          {/* 2. Inputs */}
          <Section title={t('stDamWater')}>
            {DAM_FIELDS.map(([k, l, u]) => <NumField key={k} label={l} unit={u} value={inputs[k]} onChange={set(k)} />)}
          </Section>
          <Section title={t('stRain')}>
            {RAIN_FIELDS.map(([k, l, u]) => <NumField key={k} label={l} unit={u} value={inputs[k]} onChange={(v) => setInputs((p) => ({ ...p, [k]: v, rain_source: 'manual' }))} />)}
          </Section>
          <Section title={t('stBreach')}>
            <View style={styles.rowWrap}>
              {['overtopping', 'piping'].map((m) => <Chip key={m} label={t(m)} active={inputs.failure_mode === m} onPress={() => set('failure_mode')(m)} />)}
            </View>
            <View style={styles.rowWrap}>
              {[['auto', t('stTrigAuto')], ['now', t('stTrigNow')], ['none', t('stTrigNone')]].map(([k, l]) => (
                <Chip key={k} label={l} active={inputs.breach_trigger === k} onPress={() => set('breach_trigger')(k)} />
              ))}
            </View>
            {BREACH_FIELDS.map(([k, l, u]) => <NumField key={k} label={l} unit={u} value={inputs[k]} onChange={set(k)} />)}
            {prep.suggested_breach ? (
              <Text style={type.small}>{`${t('stFroehlich')}: ${prep.suggested_breach.breach_width_m} m wide, ${prep.suggested_breach.breach_depth_m} m deep, ${prep.suggested_breach.formation_h} h, peak ≈ ${prep.suggested_breach.froehlich.peak_q_m3s.toLocaleString('en-IN')} m³/s`}</Text>
            ) : null}
          </Section>
          <Section title={t('stModel')}>
            {RUN_FIELDS.map(([k, l, u]) => <NumField key={k} label={l} unit={u} value={inputs[k]} onChange={set(k)} />)}
          </Section>

          {missing.length ? <Banner tone="MODERATE" text={t('stMissing')} /> : null}
          <Button label={t('stCheckReservoir')} icon="water-outline" variant="secondary" onPress={checkReservoir} loading={busy === 'preview'} disabled={!!missing.length} />
          {preview ? <ReservoirCard r={preview} t={t} /> : null}
          <View style={{ height: 10 }} />
          <Button label={t('stRun')} icon="play" onPress={() => startRun()} loading={busy === 'run'} disabled={!!missing.length || !!busy} />
          {run && run.status === 'running' ? <Progress value={run.progress} label={run.stage} /> : null}

          {/* 3. Results */}
          {summary && scene && decoded ? (
            <Section title={t('stResults')}>
              <View style={styles.rowWrap}>
                <Chip label={t('view3d')} active={view === '3d'} onPress={() => setView('3d')} />
                <Chip label={t('view2d')} active={view === 'map'} onPress={() => setView('map')} />
                <Chip label={t('stMaxExtent')} active={showMax} onPress={() => setShowMax((v) => !v)} />
              </View>
              {view === '3d' ? (
                <StudioScene3D key={summary.run_id + (scene.buildings.length)} scene={scene} decoded={decoded} frameIdx={frame} showMax={showMax} active={focused} onInteract={onInteract} t={t} />
              ) : (
                <StudioMap summary={summary} frame={frame} showMax={showMax} sat={sat} />
              )}
              <View style={styles.timeline}>
                <Pressable onPress={() => { setShowMax(false); if (frame >= scene.frames.length - 1) setFrame(0); setPlaying((p) => !p); }} style={styles.play} accessibilityLabel={playing ? t('pause') : t('play')}>
                  <Ionicons name={playing ? 'pause' : 'play'} size={20} color="#FFFFFF" />
                </Pressable>
                <Slider style={{ flex: 1, marginHorizontal: 8 }} minimumValue={0} maximumValue={scene.frames.length - 1} step={1} value={frame}
                  onSlidingStart={() => { setPlaying(false); setShowMax(false); }} onValueChange={(v) => setFrame(Math.round(v))}
                  minimumTrackTintColor={colors.water} maximumTrackTintColor={colors.line} thumbTintColor={colors.water} />
                <Text style={styles.clock}>{formatClock(scene.times_min[frame] || 0)}</Text>
              </View>
              <Text style={type.small}>{t('stClockNote', { h: summary.flood.start_offset_h })}</Text>

              {summary.flood.inundated_km2 === 0 ? <Banner tone="SAFE" icon="checkmark-circle-outline" text={t('stNoFlood')} /> : null}
              <View style={styles.metrics}>
                <Metric label={t('inundatedArea')} value={`${summary.flood.inundated_km2} km²`} color="#A61B1B" />
                <Metric label={t('stMaxDepth')} value={`${summary.flood.max_depth_m} m`} />
                <Metric label={t('stPeakOut')} value={`${summary.routing.peak_outflow_m3s.toLocaleString('en-IN')} m³/s`} color={simColors.delft} />
                <Metric label={t('stReachEnd')} value={summary.flood.reach_end_arrival_min != null ? formatClock(summary.flood.reach_end_arrival_min) : '—'} />
              </View>
              <HazardBar hz={summary.flood.hazard_km2} t={t} />

              <Text style={[type.section, { marginTop: 16 }]}>{t('stImpacts')}</Text>
              {summary.impacts_status === 'pending' ? (
                <Progress value={run.impacts_progress || 0} label={t('stLoadingImpacts')} />
              ) : (
                <View style={styles.metrics}>
                  {[['buildings', t('stBuildings')], ['shops', t('stShops')], ['hospitals', t('stHospitals')], ['schools', t('stSchools')], ['roads_cut', t('stRoads')], ['places', t('stPlaces')]].map(([k, l]) => (
                    <Metric key={k} label={l} value={(summary.impacts[k] ?? 0).toLocaleString('en-IN')} small />
                  ))}
                </View>
              )}
              {summary.sources.osm_note ? <Banner tone="MODERATE" text={summary.sources.osm_note} /> : null}
              {summary.towns.slice(0, 12).map((tw) => (
                <View key={tw.name} style={styles.town}>
                  <Ionicons name="location-outline" size={16} color="#A61B1B" style={{ marginRight: 8 }} />
                  <Text style={[type.body, { flex: 1 }]}>{tw.name}</Text>
                  <Text style={type.small}>{`${tw.max_depth_m} m · ${tw.arrival_min != null ? formatClock(tw.arrival_min) : ''}`}</Text>
                </View>
              ))}
              <Sources s={summary} t={t} />
            </Section>
          ) : null}

          {/* 4. Satellite */}
          <Section title={t('stSatTitle')}>
            <Text style={type.small}>{t('stSatIntro')}</Text>
            <View style={{ height: 8 }} />
            <Button label={t('stSatRun')} icon="planet-outline" variant="secondary" onPress={checkSatellite} loading={busy === 'sat'} disabled={!!missing.length || !!busy} />
            {sat ? <SatelliteCard sat={sat} t={t} onRerun={rerunWithSatellite} busy={busy} canRerun={!!summary} /> : null}
            {cmp ? <CompareCard cmp={cmp} t={t} /> : null}
          </Section>
        </>
      ) : null}
    </ScrollView>
  );
}

function StudioMap({ summary, frame, showMax, sat }) {
  const [s, w, n, e] = summary.grid.bounds;
  const img = apiUrl(`/api/studio/runs/${summary.run_id}/overlay/${showMax ? 'max' : 'frame'}.png?k=${frame}`);
  const path = summary.site.river_path.map((p) => ({ latitude: p[0], longitude: p[1] }));
  return (
    <View style={styles.map}>
      <MapView style={StyleSheet.absoluteFill} initialRegion={{ latitude: (s + n) / 2, longitude: (w + e) / 2, latitudeDelta: (n - s) * 1.05, longitudeDelta: (e - w) * 1.05 }}>
        {sat?.layers_key ? (
          <Overlay image={{ uri: apiUrl(`/api/studio/satellite/${sat.layers_key}/change.png`) }}
            bounds={[[sat.grid.bounds[0], sat.grid.bounds[1]], [sat.grid.bounds[2], sat.grid.bounds[3]]]} opacity={0.8} />
        ) : null}
        <Overlay image={{ uri: img }} bounds={[[s, w], [n, e]]} opacity={0.9} />
        <Polyline coordinates={path} strokeColor={colors.water} strokeWidth={2} lineDashPattern={[4, 6]} />
        <Marker coordinate={{ latitude: summary.site.breach.lat, longitude: summary.site.breach.lng }} pinColor="orange" title="Breach" tracksViewChanges={false} />
      </MapView>
    </View>
  );
}

function ReservoirCard({ r, t }) {
  const tone = { breach: 'EXTREME', overtopping: 'HIGH', spilling: 'MODERATE', safe: 'SAFE' }[r.status];
  return (
    <View style={styles.card}>
      <Banner tone={tone} icon="water-outline" text={t(`stStatus_${r.status}`)} />
      <View style={styles.metrics}>
        <Metric small label={t('stLevel')} value={`${r.initial_level_m} → ${r.peak_level_m} m`} />
        <Metric small label={t('stFreeboard')} value={`${r.freeboard_left_m} m`} color={r.freeboard_left_m < 0 ? '#A61B1B' : undefined} />
        <Metric small label={t('stInflow')} value={`${r.inflow_volume_mm3} Mm³`} />
        <Metric small label={t('stPeakIn')} value={`${r.peak_inflow_m3s.toLocaleString('en-IN')} m³/s`} />
        <Metric small label={t('stOvertop')} value={r.overtop_at_h != null ? `${r.overtop_at_h} h` : '—'} />
        <Metric small label={t('stBreachAt')} value={r.breach_at_h != null ? `${r.breach_at_h} h` : '—'} />
        <Metric small label={t('stPeakOut')} value={`${r.peak_outflow_m3s.toLocaleString('en-IN')} m³/s`} />
        <Metric small label={t('stReleased')} value={`${r.released_mm3} Mm³`} />
      </View>
      <Text style={type.small}>{`${t('stFroehlichCheck')}: ${r.froehlich_check.peak_q_m3s.toLocaleString('en-IN')} m³/s. ${t('stFroehlichNote')}`}</Text>
      {r.stage_storage_note ? <Text style={[type.small, { color: '#A61B1B' }]}>{r.stage_storage_note}</Text> : null}
    </View>
  );
}

function SatelliteCard({ sat, t, onRerun, busy, canRerun }) {
  const res = sat.reservoir || {};
  const pc = sat.prediction_check;
  return (
    <View style={styles.card}>
      <Text style={type.small}>{[sat.sentinel1 && `Sentinel-1 radar ${sat.sentinel1.date}`, sat.sentinel2 && `Sentinel-2 ${sat.sentinel2.date} (${sat.sentinel2.cloud_pct}% cloud)`].filter(Boolean).join(' · ')}</Text>
      <View style={styles.metrics}>
        <Metric small label={t('stSatNow')} value={res.now_km2 != null ? `${res.now_km2} km²` : '—'} />
        <Metric small label={t('stSatUsual')} value={`${res.baseline_km2} km²`} />
        <Metric small label={t('stSatVsUsual')} value={res.vs_usual_pct != null ? `${res.vs_usual_pct}%` : '—'} />
        <Metric small label={t('stSatStorage')} value={res.implied_storage_pct != null ? `${res.implied_storage_pct}%` : '—'} color={simColors.delft} />
        {sat.downstream ? <Metric small label={t('stSatNewWater')} value={`${sat.downstream.new_water_km2} km²`} color="#A61B1B" /> : null}
        {sat.model_check ? <Metric small label={t('stSatOverlap')} value={`${sat.model_check.overlap_km2} km²`} /> : null}
      </View>
      {res.method ? <Text style={type.small}>{res.method}</Text> : null}
      {(sat.notes || []).map((n) => <Banner key={n} tone="MODERATE" text={n} />)}
      <View style={styles.rowWrap}>
        {[['#1b6ca8', t('stLgNormal')], ['#d73027', t('stLgNew')], ['#78bee6', t('stLgSeasonal')], ['#f0b428', t('stLgDry')]].map(([c, l]) => (
          <View key={l} style={styles.lg}><View style={[styles.sw, { backgroundColor: c }]} /><Text style={type.small}>{l}</Text></View>
        ))}
      </View>
      <Image source={{ uri: apiUrl(`/api/studio/satellite/${sat.layers_key}/change.png`) }} style={styles.satImg} resizeMode="contain" />
      {pc ? (
        <View style={{ marginTop: 10 }}>
          <Text style={type.section}>{t('stPredCheck')}</Text>
          <Banner tone={pc.changed ? 'HIGH' : 'SAFE'} text={pc.changed ? t('stPredChanged') : t('stPredSame')} />
          <Table rows={[
            ['', t('stYourInput'), t('stSatellite')],
            [t('stStorage'), `${pc.user.storage_pct}%`, `${pc.satellite.storage_pct}%`],
            [t('stStatus'), t(`stStatus_${pc.user.status}`), t(`stStatus_${pc.satellite.status}`)],
            [t('stPeakLevel'), `${pc.user.peak_level_m} m`, `${pc.satellite.peak_level_m} m`],
            [t('stOvertop'), pc.user.overtop_at_h ?? '—', pc.satellite.overtop_at_h ?? '—'],
            [t('stPeakOut'), pc.user.peak_outflow_m3s.toLocaleString('en-IN'), pc.satellite.peak_outflow_m3s.toLocaleString('en-IN')],
          ]} />
          {canRerun ? <Button label={t('stRerunSat')} icon="refresh" variant="secondary" onPress={onRerun} loading={busy === 'run'} /> : <Text style={type.small}>{t('stRunFirst')}</Text>}
        </View>
      ) : null}
    </View>
  );
}

function CompareCard({ cmp, t }) {
  const rows = [['', t('stYourInput'), t('stSatellite'), 'Δ']];
  [['storage_pct', t('stStorage')], ['status', t('stStatus')], ['peak_outflow_m3s', t('stPeakOut')], ['inundated_km2', t('inundatedArea')],
    ['max_depth_m', t('stMaxDepth')], ['buildings', t('stBuildings')], ['shops', t('stShops')], ['places', t('stPlaces')]].forEach(([k, l]) => {
    rows.push([l, String(cmp.a[k] ?? '—'), String(cmp.b[k] ?? '—'), cmp.delta[k] != null ? (cmp.delta[k] > 0 ? `+${cmp.delta[k]}` : String(cmp.delta[k])) : '']);
  });
  return (
    <View style={styles.card}>
      <Text style={type.section}>{t('stCompareTitle')}</Text>
      <Table rows={rows} />
      {cmp.extent_agreement_csi != null ? <Text style={type.small}>{t('stCsi', { v: Math.round(cmp.extent_agreement_csi * 100) })}</Text> : null}
    </View>
  );
}

function Sources({ s, t }) {
  const src = s.sources;
  const lines = [
    `DEM: ${src.dem.name}`, `Land cover (friction): ${src.landcover}`,
    src.imagery ? `Imagery: Sentinel-2 ${src.imagery.dates.join(', ')}` : null,
    src.osm ? `Buildings & places: ${src.osm}` : null, `Rainfall: ${src.rainfall}`,
    `Solver: ${s.flood.solver.scheme}, ${s.flood.solver.cells.toLocaleString('en-IN')} cells of ${s.flood.solver.cell_m} m, ${s.flood.solver.wall_s} s`,
    `Water balance: in ${s.flood.volume.volume_in_mm3} Mm³, left domain ${s.flood.volume.volume_out_mm3}, on ground ${s.flood.volume.volume_left_mm3}`,
  ].filter(Boolean);
  return (
    <View style={[styles.card, { marginTop: 12 }]}>
      <Text style={[type.small, { fontWeight: '800' }]}>{t('stSources')}</Text>
      {lines.map((l) => <Text key={l} style={type.small}>{l}</Text>)}
      <Text style={[type.small, { marginTop: 6 }]}>{t('stDisclaimer')}</Text>
    </View>
  );
}

function HazardBar({ hz, t }) {
  const items = [['low', '#E3B53B'], ['moderate', '#E6822A'], ['significant', '#C8461E'], ['extreme', '#961414']];
  const total = items.reduce((a, [k]) => a + (hz[k] || 0), 0) || 1;
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={type.small}>{t('stHazard')}</Text>
      <View style={styles.hbar}>{items.map(([k, c]) => <View key={k} style={{ flex: (hz[k] || 0) / total, backgroundColor: c }} />)}</View>
      <Text style={type.small}>{items.map(([k]) => `${t(`stHz_${k}`)} ${hz[k]} km²`).join(' · ')}</Text>
    </View>
  );
}

function Table({ rows }) {
  return (
    <View style={styles.table}>
      {rows.map((r, i) => (
        <View key={i} style={[styles.tr, i === 0 && { borderBottomWidth: 1, borderColor: colors.line }]}>
          {r.map((c, j) => <Text key={j} style={[styles.td, j === 0 && { flex: 1.4, fontWeight: '700' }, i === 0 && { fontWeight: '800' }]}>{String(c)}</Text>)}
        </View>
      ))}
    </View>
  );
}

function NumField({ label, unit, value, onChange }) {
  return (
    <View style={styles.field}>
      <Text style={[type.small, { flex: 1 }]}>{label}</Text>
      <TextInput style={styles.num} value={value === null || value === undefined ? '' : String(value)} onChangeText={onChange} keyboardType="decimal-pad" accessibilityLabel={label} />
      <Text style={styles.unit}>{unit}</Text>
    </View>
  );
}

function Metric({ label, value, color, small }) {
  return (
    <View style={[styles.metric, small && { paddingVertical: 8 }]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, small && { fontSize: 15 }, color && { color }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    </View>
  );
}

function Stat({ label, value }) {
  return <View style={{ marginRight: 18, marginVertical: 4 }}><Text style={type.small}>{label}</Text><Text style={styles.metricValue}>{value}</Text></View>;
}

function Progress({ value, label }) {
  return (
    <View style={{ marginTop: 10 }}>
      <View style={styles.pTrack}><View style={[styles.pBar, { width: `${Math.round((value || 0) * 100)}%` }]} /></View>
      <Text style={type.small}>{`${label} · ${Math.round((value || 0) * 100)}%`}</Text>
    </View>
  );
}

function Busy({ label }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12 }}><ActivityIndicator color={colors.water} /><Text style={[type.small, { marginLeft: 8 }]}>{label}</Text></View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  body: { padding: 16, paddingBottom: 60 },
  search: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.line, marginBottom: 8 },
  searchInput: { flex: 1, minHeight: 46, marginLeft: 8, fontSize: 16, color: colors.ink },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 4 },
  result: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: 10, padding: 12, marginTop: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 12, marginTop: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  field: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  num: { width: 96, minHeight: 38, borderRadius: 8, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 8, textAlign: 'right', color: colors.ink, fontSize: 15, fontWeight: '700' },
  unit: { width: 78, marginLeft: 8, fontSize: 12, color: colors.inkSoft },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 10 },
  metric: { width: '48.5%', backgroundColor: colors.paper, borderRadius: 10, padding: 10, marginBottom: 8 },
  metricLabel: { fontSize: 11, fontWeight: '700', color: colors.inkSoft, textTransform: 'uppercase' },
  metricValue: { fontSize: 18, fontWeight: '800', color: colors.ink, ...type.num },
  timeline: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  play: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.water, alignItems: 'center', justifyContent: 'center' },
  clock: { width: 70, textAlign: 'right', fontWeight: '800', color: colors.ink, ...type.num },
  map: { height: 380, borderRadius: 14, overflow: 'hidden', backgroundColor: colors.waterSoft },
  town: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  hbar: { flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden', backgroundColor: colors.line, marginVertical: 4 },
  table: { marginVertical: 8 },
  tr: { flexDirection: 'row', paddingVertical: 6 },
  td: { flex: 1, fontSize: 13, color: colors.ink },
  satImg: { width: '100%', height: 240, marginTop: 8, backgroundColor: colors.paper, borderRadius: 8 },
  lg: { flexDirection: 'row', alignItems: 'center', marginRight: 12, marginTop: 4 },
  sw: { width: 10, height: 10, borderRadius: 2, marginRight: 5 },
  pTrack: { height: 8, borderRadius: 4, backgroundColor: colors.line, overflow: 'hidden', marginBottom: 4 },
  pBar: { height: 8, backgroundColor: colors.water },
});
