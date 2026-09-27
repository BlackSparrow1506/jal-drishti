import React, { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

import { useApp } from '../context/AppContext';
import { api } from '../services/api';
import { colors, risk as riskColors, type } from '../theme';
import { formatDuration } from '../utils/format';
import { confirm, notify } from '../utils/dialog';
import { Banner, LevelBadge, ScreenHeader, Section } from '../components/ui';

export default function OfficerDashboardScreen({ navigation }) {
  const { t, prefs, overview, bumpData, dataVersion, officerLogout } = useApp();
  const [status, setStatus] = useState(null);
  const [summary, setSummary] = useState(null);
  const [err, setErr] = useState(null);
  const [pulling, setPulling] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [a, s] = await Promise.all([api.akashwani(), api.officerSummary(prefs.officerToken)]);
      setStatus(a.data);
      setSummary(s.data);
    } catch (e) {
      if (e.status === 401) officerLogout();
      setErr(e);
    }
  }, [prefs.officerToken, officerLogout]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load, dataVersion])
  );

  const activeId = overview?.active_scenario?.id || null;

  const choose = (sc) => {
    const name = sc ? sc.name : t('standDown');
    confirm({
      title: t('activeScenario'),
      message: t('confirmScenario', { name }),
      okText: t('activate'),
      cancelText: t('cancel'),
      destructive: !!sc,
      onConfirm: async () => {
        try {
          await api.setScenario(prefs.officerToken, sc ? sc.id : null);
          bumpData();
          load();
        } catch (e) {
          notify(t('serverDown'), e.message);
        }
      },
    });
  };

  const pop = summary?.population_by_level || {};
  const maxPop = Math.max(1, ...['EXTREME', 'HIGH', 'MODERATE'].map((l) => pop[l] || 0));

  return (
    <View style={styles.screen}>
      <ScreenHeader title={t('tabDashboard')} subtitle={overview?.dam?.name} />
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={async () => { setPulling(true); await load(); setPulling(false); }} />}
      >
        {err ? <Banner tone="EXTREME" icon="cloud-offline-outline" text={t('serverDown')} /> : null}

        <Pressable onPress={() => navigation.navigate('DamStudio')} style={styles.studio} accessibilityRole="button">
          <Ionicons name="cube-outline" size={26} color="#FFFFFF" style={{ marginRight: 12 }} />
          <View style={{ flex: 1 }}>
            <Text style={styles.studioTitle}>{t('stOpen')}</Text>
            <Text style={styles.studioSub}>{t('stOpenSub')}</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#FFFFFF" />
        </Pressable>

        {status ? (
          <Section title={t('akashwani')}>
            <View style={styles.pipeline}>
              {status.pipeline.map((stage, i) => {
                const reached = status.pipeline.indexOf(status.stage) >= i;
                return (
                  <View key={stage} style={styles.stageWrap}>
                    <View style={[styles.stage, reached && styles.stageOn]}>
                      <Text style={[styles.stageText, reached && { color: '#FFFFFF' }]} numberOfLines={1}>
                        {t(`stage_${stage}`)}
                      </Text>
                    </View>
                    {i < status.pipeline.length - 1 ? (
                      <Ionicons name="chevron-forward" size={14} color={colors.inkSoft} />
                    ) : null}
                  </View>
                );
              })}
            </View>
            {Object.entries(status.metrics).map(([key, m]) => (
              <View key={key} style={styles.metric}>
                <View style={{ flex: 1 }}>
                  <Text style={type.small}>{m.label}</Text>
                  <Text style={styles.metricValue}>{`${m.latest} ${m.unit}`}</Text>
                  <Text style={[type.small, { color: m.anomaly ? '#A61B1B' : '#2F7A55', fontWeight: '700' }]}>
                    {m.anomaly ? `${t('anomaly')} (z = ${m.z_score})` : t('normal')}
                  </Text>
                </View>
                <Spark values={m.recent} alert={m.anomaly} />
              </View>
            ))}
            <Text style={type.small}>{status.note}</Text>
          </Section>
        ) : null}

        <Section title={t('activeScenario')}>
          {(overview?.scenarios || []).map((sc) => (
            <ScenarioRow key={sc.id} sc={sc} active={activeId === sc.id} onPress={() => choose(sc)} />
          ))}
          <ScenarioRow sc={null} label={t('standDown')} active={activeId === null} onPress={() => choose(null)} />
        </Section>

        {summary?.scenario_id ? (
          <>
            <Section title={t('peopleAtRisk')}>
              {['EXTREME', 'HIGH', 'MODERATE'].map((lvl) => (
                <View key={lvl} style={{ marginBottom: 10 }}>
                  <View style={styles.barHead}>
                    <Text style={type.body}>{t(`level_${lvl}`)}</Text>
                    <Text style={[type.body, { fontWeight: '800' }]}>{(pop[lvl] || 0).toLocaleString('en-IN')}</Text>
                  </View>
                  <View style={styles.barTrack}>
                    <View style={[styles.bar, { width: `${((pop[lvl] || 0) / maxPop) * 100}%`, backgroundColor: riskColors[lvl].bg }]} />
                  </View>
                </View>
              ))}
            </Section>

            <Section title={t('areasAtRisk')}>
              {summary.localities.length ? summary.localities.map((l) => (
                <Row key={l.id} level={l.level} title={l.name} t={t}
                  sub={`${l.population.toLocaleString('en-IN')}. ${t('arrivesIn', { d: formatDuration(l.arrival_in_min, t) })}`} />
              )) : <Text style={type.body}>{t('noneAtRisk')}</Text>}
            </Section>

            <Section title={t('facilitiesAtRisk')}>
              {summary.facilities.length ? summary.facilities.map((f) => (
                <Row key={f.id} level={f.level} title={f.name} t={t}
                  sub={t('arrivesIn', { d: formatDuration(f.arrival_in_min, t) })} />
              )) : <Text style={type.body}>{t('noneAtRisk')}</Text>}
            </Section>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ScenarioRow({ sc, label, active, onPress }) {
  return (
    <Pressable onPress={onPress} style={[styles.scRow, active && styles.scActive]} accessibilityState={{ selected: active }}>
      <View style={{ flex: 1 }}>
        <Text style={[type.body, { fontWeight: '700' }]}>{sc ? `${sc.id}: ${sc.name}` : label}</Text>
        {sc ? (
          <Text style={type.small}>{`${sc.trigger}. Breach ${sc.breach_width_m} m. Reservoir ${sc.reservoir_level_pct}%`}</Text>
        ) : null}
      </View>
      <Ionicons name={active ? 'radio-button-on' : 'radio-button-off'} size={22} color={active ? colors.water : colors.inkSoft} />
    </Pressable>
  );
}

function Row({ level, title, sub, t }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={type.body}>{title}</Text>
        <Text style={type.small}>{sub}</Text>
      </View>
      <LevelBadge level={level} label={t(`level_${level}`)} />
    </View>
  );
}

function Spark({ values = [], alert }) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  return (
    <View style={styles.spark}>
      {values.map((v, i) => (
        <View key={i} style={{
          width: 5, marginLeft: 2, borderRadius: 1,
          height: 4 + ((v - min) / (max - min || 1)) * 36,
          backgroundColor: alert && i === values.length - 1 ? '#A61B1B' : colors.water,
        }} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  studio: { flexDirection: 'row', alignItems: 'center', marginTop: 8, padding: 16, borderRadius: 14, backgroundColor: '#0E2233' },
  studioTitle: { fontSize: 16, fontWeight: '800', color: '#FFFFFF' },
  studioSub: { fontSize: 13, color: 'rgba(255,255,255,0.75)', marginTop: 2 },
  body: { paddingHorizontal: 20, paddingBottom: 48 },
  pipeline: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 },
  stageWrap: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  stage: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  stageOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  stageText: { fontSize: 12, fontWeight: '700', color: colors.ink },
  metric: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: 12, padding: 14,
    marginBottom: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
  },
  metricValue: { fontSize: 20, fontWeight: '800', color: colors.ink, fontVariant: ['tabular-nums'] },
  spark: { flexDirection: 'row', alignItems: 'flex-end', height: 42 },
  scRow: {
    flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: 12, backgroundColor: colors.card,
    marginBottom: 8, borderWidth: 1, borderColor: colors.line,
  },
  scActive: { borderColor: colors.water, borderWidth: 2 },
  barHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  barTrack: { height: 10, backgroundColor: colors.line, borderRadius: 5, overflow: 'hidden' },
  bar: { height: 10, borderRadius: 5 },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
  },
});
