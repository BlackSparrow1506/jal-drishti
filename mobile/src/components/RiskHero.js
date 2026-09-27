import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { risk as riskColors, type } from '../theme';
import { formatClock, formatDuration, minutesUntil } from '../utils/format';
import { useNow } from '../utils/useNow';

const GAUGE_MAX_M = 4;
const PERSON_M = 1.7;

// The signature element: the whole block takes the colour of your risk level,
// with a water gauge that shows flood depth against an adult's height.
export default function RiskHero({ risk, t }) {
  const now = useNow(30000);
  const level = risk?.level || 'SAFE';
  const c = riskColors[level];
  const noThreat = !risk?.scenario_id;
  const minsLeft = minutesUntil(risk?.flood_arrives_at, now);
  const depth = risk?.depth_m || 0;
  const fillPct = Math.min(1, depth / GAUGE_MAX_M);

  return (
    <View style={[styles.wrap, { backgroundColor: c.bg }]} accessible accessibilityLabel={`${t(`level_${level}`)}. ${noThreat ? t('noThreat') : t(`advice_${level}`)}`}>
      <View style={{ flex: 1, paddingRight: 16 }}>
        <Text style={[type.hero, { color: c.fg }]}>{t(`level_${level}`)}</Text>
        <Text style={[styles.advice, { color: c.fg }]}>
          {noThreat ? t('noThreat') : t(`advice_${level}`)}
        </Text>

        {minsLeft != null ? (
          <View style={{ marginTop: 20 }}>
            {minsLeft > 0 ? (
              <>
                <Text style={[styles.label, { color: c.fg }]}>{t('waterArrivesIn')}</Text>
                <Text style={[type.countdown, { color: c.fg }]} adjustsFontSizeToFit numberOfLines={1}>
                  {formatDuration(minsLeft, t)}
                </Text>
                <Text style={[styles.label, { color: c.fg }]}>
                  {t('waterBy', { time: formatClock(risk.flood_arrives_at) })}
                </Text>
              </>
            ) : (
              <Text style={[type.hero, { color: c.fg, fontSize: 24 }]}>{t('floodingNow')}</Text>
            )}
          </View>
        ) : null}
      </View>

      <View style={styles.gaugeCol}>
        <View style={[styles.gauge, { borderColor: c.fg }]}>
          <View style={[styles.fill, { height: `${fillPct * 100}%` }]} />
          <View style={[styles.person, { bottom: `${(PERSON_M / GAUGE_MAX_M) * 100}%`, borderColor: c.fg }]} />
        </View>
        <Text style={[styles.gaugeNum, { color: c.fg }]}>{depth.toFixed(1)} m</Text>
        <Text style={[styles.gaugeCap, { color: c.fg }]}>{t('depth')}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', padding: 20, paddingTop: 22, borderRadius: 18 },
  advice: { fontSize: 17, lineHeight: 24, marginTop: 6, fontWeight: '500' },
  label: { fontSize: 14, fontWeight: '600', opacity: 0.92 },
  gaugeCol: { alignItems: 'center', width: 56 },
  gauge: {
    width: 30, height: 150, borderWidth: 2, borderRadius: 8, overflow: 'hidden',
    justifyContent: 'flex-end', backgroundColor: 'rgba(255,255,255,0.18)',
  },
  fill: { width: '100%', backgroundColor: 'rgba(27,108,168,0.95)' },
  person: { position: 'absolute', left: -2, right: -2, borderTopWidth: 2, borderStyle: 'dashed' },
  gaugeNum: { marginTop: 6, fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] },
  gaugeCap: { fontSize: 11, fontWeight: '600', opacity: 0.9 },
});
