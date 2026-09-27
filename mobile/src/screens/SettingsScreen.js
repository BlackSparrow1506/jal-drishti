import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useApp } from '../context/AppContext';
import { LANGUAGES } from '../i18n/strings';
import { API_BASE } from '../config';
import { colors, type } from '../theme';
import { Banner, Button, Chip, Section } from '../components/ui';

export default function SettingsScreen() {
  const { t, prefs, updatePrefs, overview, officerLogin, officerLogout, online, socketUp } = useApp();
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState(null);
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    setBusy(true);
    setPinError(null);
    try {
      await officerLogin(pin);
      setPin('');
    } catch (e) {
      setPinError(e.status === 401 ? t('wrongPin') : t('serverDown'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 20, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
      <Section title={t('language')}>
        <View style={styles.wrap}>
          {LANGUAGES.map((l) => (
            <Chip key={l.id} label={l.label} active={prefs.lang === l.id} onPress={() => updatePrefs({ lang: l.id })} />
          ))}
        </View>
      </Section>

      <Section title={t('location')}>
        <View style={styles.wrap}>
          <Chip label={t('useGps')} active={prefs.locationMode === 'gps'} onPress={() => updatePrefs({ locationMode: 'gps' })} />
          {(overview?.demo_locations || []).map((d) => (
            <Chip
              key={d.id}
              label={`${t('demoLocation')}: ${d.name}`}
              active={prefs.locationMode === 'demo' && prefs.demoId === d.id}
              onPress={() => updatePrefs({ locationMode: 'demo', demoId: d.id })}
            />
          ))}
        </View>
      </Section>

      <Section title={t('mode')}>
        {prefs.role === 'officer' ? (
          <>
            <Text style={[type.body, { marginBottom: 12 }]}>{t('officer')}</Text>
            <Button label={t('signOut')} variant="secondary" onPress={officerLogout} />
          </>
        ) : (
          <>
            <Text style={[type.body, { marginBottom: 12 }]}>{t('citizen')}</Text>
            <TextInput
              style={styles.input}
              value={pin}
              onChangeText={setPin}
              placeholder={t('enterPin')}
              placeholderTextColor={colors.inkSoft}
              keyboardType="number-pad"
              secureTextEntry
            />
            {pinError ? <Banner tone="EXTREME" text={pinError} /> : null}
            <Button label={t('signIn')} onPress={signIn} loading={busy} disabled={!pin} />
          </>
        )}
      </Section>

      <Section title={t('server')}>
        <Text style={type.body}>{API_BASE}</Text>
        <Text style={type.small}>{`API: ${online ? t('connected') : t('notConnected')}. ${t('live')}: ${socketUp ? t('connected') : t('notConnected')}.`}</Text>
      </Section>

      <Text style={[type.small, { marginTop: 32, textAlign: 'center' }]}>{`Jal Drishti v0.1. ${t('sampleData')}`}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  input: {
    height: 50, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card,
    paddingHorizontal: 14, fontSize: 18, color: colors.ink, marginBottom: 12, letterSpacing: 4,
  },
});
