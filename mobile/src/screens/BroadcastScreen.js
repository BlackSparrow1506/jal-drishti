import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useApp } from '../context/AppContext';
import { api } from '../services/api';
import { colors, type } from '../theme';
import { Banner, Button, Chip, ScreenHeader, Section } from '../components/ui';
import { confirm, notify } from '../utils/dialog';

const TEMPLATES = [
  {
    label: 'Evacuate now', severity: 'EXTREME', title: 'Evacuate now',
    message: 'Dam-break flood expected. Residents in riverside areas must move to the nearest relief camp immediately. Follow the route in the Jal Drishti app.',
  },
  {
    label: 'Prepare to evacuate', severity: 'HIGH', title: 'Prepare to evacuate',
    message: 'Flood risk is rising. Pack essentials, charge your phone and be ready to leave when instructed.',
  },
  {
    label: 'Stay alert', severity: 'MODERATE', title: 'Stay alert',
    message: 'Heavy inflow into the reservoir. Avoid the riverbank and low-lying roads.',
  },
  {
    label: 'All clear', severity: 'INFO', title: 'All clear',
    message: 'The flood threat has passed. Follow local authorities before returning home.',
  },
];
const SEVERITIES = ['EXTREME', 'HIGH', 'MODERATE', 'INFO'];

export default function BroadcastScreen() {
  const { t, prefs } = useApp();
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [severity, setSeverity] = useState('HIGH');
  const [area, setArea] = useState('Mutha river downstream of Khadakwasla');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null);

  const valid = title.trim().length >= 3 && message.trim().length >= 3;

  const send = () => {
    confirm({
      title: t('sendAlert'),
      message: t('confirmSend'),
      okText: t('send'),
      cancelText: t('cancel'),
      destructive: true,
      onConfirm: async () => {
        setBusy(true);
        try {
          const r = await api.sendAlert(prefs.officerToken, { title, message, severity, area });
          setSent(r.data.title);
          setTitle('');
          setMessage('');
        } catch (e) {
          notify(t('serverDown'), e.message);
        } finally {
          setBusy(false);
        }
      },
    });
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title={t('tabBroadcast')} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {sent ? <Banner tone="SAFE" icon="checkmark-circle-outline" text={`${t('alertSent')}: ${sent}`} /> : null}

        <Section title={t('templates')}>
          <View style={styles.wrap}>
            {TEMPLATES.map((tp) => (
              <Chip key={tp.label} label={tp.label} onPress={() => {
                setTitle(tp.title); setMessage(tp.message); setSeverity(tp.severity); setSent(null);
              }} />
            ))}
          </View>
        </Section>

        <Section title={t('severity')}>
          <View style={styles.wrap}>
            {SEVERITIES.map((s) => (
              <Chip key={s} label={t(`level_${s}`)} tone={s} active={severity === s} onPress={() => setSeverity(s)} />
            ))}
          </View>
        </Section>

        <Text style={[type.small, styles.label]}>{t('alertTitle')}</Text>
        <TextInput style={styles.input} value={title} onChangeText={setTitle} maxLength={120} />
        <Text style={[type.small, styles.label]}>{t('alertMessage')}</Text>
        <TextInput style={[styles.input, { height: 120, textAlignVertical: 'top', paddingTop: 12 }]} value={message} onChangeText={setMessage} multiline maxLength={1000} />
        <Text style={[type.small, styles.label]}>{t('area')}</Text>
        <TextInput style={styles.input} value={area} onChangeText={setArea} />

        <View style={{ height: 12 }} />
        <Button label={t('sendAlert')} icon="megaphone" onPress={send} disabled={!valid} loading={busy} color="#A61B1B" />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  body: { paddingHorizontal: 20, paddingBottom: 48 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  label: { marginTop: 14, marginBottom: 6, fontWeight: '700' },
  input: {
    minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card,
    paddingHorizontal: 14, fontSize: 16, color: colors.ink,
  },
});
