import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { colors, risk as riskColors, type } from '../theme';
import { useApp } from '../context/AppContext';

export function ScreenHeader({ title, subtitle }) {
  const nav = useNavigation();
  const insets = useSafeAreaInsets();
  const { t } = useApp();
  return (
    <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
      <View style={{ flex: 1 }}>
        <Text style={type.title} accessibilityRole="header">{title}</Text>
        {subtitle ? <Text style={type.small} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      <Pressable
        onPress={() => nav.navigate('Settings')}
        hitSlop={12}
        accessibilityLabel={t('settings')}
        style={styles.iconBtn}
      >
        <Ionicons name="settings-outline" size={22} color={colors.ink} />
      </Pressable>
    </View>
  );
}

export function Button({ label, onPress, variant = 'primary', icon, disabled, loading, color }) {
  const bg = variant === 'primary' ? color || colors.ink : 'transparent';
  const fg = variant === 'primary' ? '#FFFFFF' : color || colors.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: bg, borderColor: variant === 'primary' ? bg : colors.line },
        (pressed || disabled) && { opacity: 0.7 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={20} color={fg} style={{ marginRight: 8 }} /> : null}
          <Text style={[styles.btnText, { color: fg }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

export function Chip({ label, active, onPress, tone, small }) {
  const c = tone ? riskColors[tone] : null;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      style={[
        styles.chip,
        small && styles.chipSmall,
        active && { backgroundColor: c ? c.bg : colors.ink, borderColor: c ? c.bg : colors.ink },
      ]}
    >
      <Text style={[styles.chipText, small && styles.chipTextSmall, active && { color: c ? c.fg : '#FFFFFF' }]}>{label}</Text>
    </Pressable>
  );
}

export function Section({ title, right, children }) {
  return (
    <View style={styles.section}>
      {title ? (
        <View style={styles.sectionHead}>
          <Text style={type.section}>{title}</Text>
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function Banner({ text, tone = 'INFO', icon = 'information-circle-outline' }) {
  const c = riskColors[tone] || riskColors.INFO;
  return (
    <View style={[styles.banner, { backgroundColor: c.soft }]}>
      <Ionicons name={icon} size={18} color={colors.ink} style={{ marginRight: 8, marginTop: 1 }} />
      <Text style={[type.small, { color: colors.ink, flex: 1 }]}>{text}</Text>
    </View>
  );
}

export function LevelBadge({ level, label }) {
  const c = riskColors[level] || riskColors.INFO;
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <Text style={[styles.badgeText, { color: c.fg }]}>{label}</Text>
    </View>
  );
}

export function Loading({ label }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={colors.water} />
      {label ? <Text style={[type.small, { marginTop: 12 }]}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 12,
    backgroundColor: colors.paper,
  },
  iconBtn: { padding: 6 },
  btn: {
    minHeight: 52, borderRadius: 12, borderWidth: 1.5, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18,
  },
  btnText: { fontSize: 16, fontWeight: '700' },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1,
    borderColor: colors.line, backgroundColor: colors.card, marginRight: 8, marginBottom: 8,
  },
  chipText: { fontSize: 14, fontWeight: '600', color: colors.ink },
  chipSmall: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, marginRight: 6, marginBottom: 6 },
  chipTextSmall: { fontSize: 12 },
  section: { marginTop: 24 },
  sectionHead: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10,
  },
  banner: { flexDirection: 'row', padding: 12, borderRadius: 10, marginBottom: 12 },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  badgeText: { fontSize: 12, fontWeight: '800' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
});
