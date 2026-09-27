import React from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createNavigationContainerRef, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';

import { AppProvider, useApp } from './src/context/AppContext';
import { colors } from './src/theme';
import LiveAlertBanner from './src/components/LiveAlertBanner';
import { Loading } from './src/components/ui';

import HomeScreen from './src/screens/HomeScreen';
import MapScreen from './src/screens/MapScreen';
import EvacuationScreen from './src/screens/EvacuationScreen';
import AlertsScreen from './src/screens/AlertsScreen';
import MediBotScreen from './src/screens/MediBotScreen';
import SosScreen from './src/screens/SosScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import OfficerDashboardScreen from './src/screens/OfficerDashboardScreen';
import BroadcastScreen from './src/screens/BroadcastScreen';
import SimulationScreen from './src/screens/SimulationScreen';
import DamStudioScreen from './src/screens/DamStudioScreen';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();
const navRef = createNavigationContainerRef();

const ICONS = {
  Home: 'home', Map: 'map', Evacuate: 'walk', Alerts: 'notifications', MediBot: 'medkit',
  Dashboard: 'speedometer', Broadcast: 'megaphone', Simulate: 'cube',
};

const navTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: colors.paper, primary: colors.water, text: colors.ink },
};

function Tabs() {
  const { t, prefs } = useApp();
  const officer = prefs.role === 'officer';
  const screenOptions = ({ route }) => ({
    headerShown: false,
    tabBarActiveTintColor: colors.ink,
    tabBarInactiveTintColor: colors.inkSoft,
    tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
    tabBarIcon: ({ color, focused, size }) => (
      <Ionicons name={focused ? ICONS[route.name] : `${ICONS[route.name]}-outline`} size={size} color={color} />
    ),
  });

  // key forces the tab navigator to reset when switching role.
  if (officer) {
    return (
      <Tab.Navigator key="officer" screenOptions={screenOptions}>
        <Tab.Screen name="Dashboard" component={OfficerDashboardScreen} options={{ title: t('tabDashboard') }} />
        <Tab.Screen name="Simulate" component={SimulationScreen} options={{ title: t('tabSimulate') }} />
        <Tab.Screen name="Map" component={MapScreen} options={{ title: t('tabMap') }} />
        <Tab.Screen name="Broadcast" component={BroadcastScreen} options={{ title: t('tabBroadcast') }} />
        <Tab.Screen name="Alerts" component={AlertsScreen} options={{ title: t('tabAlerts') }} />
      </Tab.Navigator>
    );
  }
  return (
    <Tab.Navigator key="citizen" screenOptions={screenOptions}>
      <Tab.Screen name="Home" component={HomeScreen} options={{ title: t('tabHome') }} />
      <Tab.Screen name="Map" component={MapScreen} options={{ title: t('tabMap') }} />
      <Tab.Screen name="Evacuate" component={EvacuationScreen} options={{ title: t('tabEvacuate') }} />
      <Tab.Screen name="Alerts" component={AlertsScreen} options={{ title: t('tabAlerts') }} />
      <Tab.Screen name="MediBot" component={MediBotScreen} options={{ title: t('tabMedibot') }} />
    </Tab.Navigator>
  );
}

function Root() {
  const { ready, t } = useApp();
  if (!ready) return <Loading />;
  return (
    <View style={{ flex: 1 }}>
      <NavigationContainer ref={navRef} theme={navTheme}>
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: colors.paper },
            headerTintColor: colors.ink,
            headerShadowVisible: false,
          }}
        >
          <Stack.Screen name="Main" component={Tabs} options={{ headerShown: false }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: t('settings') }} />
          <Stack.Screen name="Sos" component={SosScreen} options={{ title: t('sosTitle') }} />
          <Stack.Screen name="Simulation" component={SimulationScreen} options={{ title: t('simTitle') }} />
          <Stack.Screen name="DamStudio" component={DamStudioScreen} options={{ title: t('stTitle') }} />
        </Stack.Navigator>
      </NavigationContainer>
      <LiveAlertBanner onOpen={() => navRef.isReady() && navRef.navigate('Main', { screen: 'Alerts' })} />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="dark" />
        <Root />
      </AppProvider>
    </SafeAreaProvider>
  );
}
