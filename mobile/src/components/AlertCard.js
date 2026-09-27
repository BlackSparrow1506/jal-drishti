import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, risk as riskColors, type } from '../theme';
import { timeAgo } from '../utils/format';
import { LevelBadge } from './ui';

export default function AlertCard({ alert, t, compact }) {
  const c = riskColors[alert.severity] || riskColors.INFO;
  return (
    <View style={[styles.card, { borderLeftColor: c.bg }]}>
      <View style={styles.row}>
        <LevelBadge level={alert.severity} label={t(`level_${alert.severity}`)} />
        <Text style={type.small}>{timeAgo(alert.created_at)}</Text>
      </View>
      <Text style={[type.section, { marginTop: 8 }]}>{alert.title}</Text>
      <Text style={[type.body, { marginTop: 4 }]} numberOfLines={compact ? 3 : undefined}>
        {alert.message}
      </Text>
      {!compact ? (
        <Text style={[type.small, { marginTop: 8 }]}>{`${alert.area}. ${alert.source}`}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card, borderRadius: 12, padding: 16, borderLeftWidth: 6,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, marginBottom: 12,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
