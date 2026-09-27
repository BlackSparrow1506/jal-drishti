import React, { useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { useApp } from '../context/AppContext';
import { colors, type } from '../theme';
import AlertCard from '../components/AlertCard';
import { ScreenHeader } from '../components/ui';

export default function AlertsScreen() {
  const { t, alerts, refresh, socketUp } = useApp();
  const [pulling, setPulling] = useState(false);

  return (
    <View style={styles.screen}>
      <ScreenHeader title={t('tabAlerts')} subtitle={socketUp ? `${t('live')}: ${t('connected')}` : t('notConnected')} />
      <FlatList
        data={alerts}
        keyExtractor={(a) => String(a.id)}
        renderItem={({ item }) => <AlertCard alert={item} t={t} />}
        contentContainerStyle={styles.list}
        refreshing={pulling}
        onRefresh={async () => {
          setPulling(true);
          await refresh();
          setPulling(false);
        }}
        ListEmptyComponent={<Text style={[type.body, { textAlign: 'center', marginTop: 40 }]}>{t('noAlerts')}</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  list: { paddingHorizontal: 20, paddingBottom: 40 },
});
