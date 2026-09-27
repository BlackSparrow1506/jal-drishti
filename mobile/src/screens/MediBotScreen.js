import React, { useEffect, useRef, useState } from 'react';
import {
  FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Speech from 'expo-speech';

import { useApp } from '../context/AppContext';
import { api } from '../services/api';
import { colors, type } from '../theme';
import { Banner, ScreenHeader } from '../components/ui';

export default function MediBotScreen() {
  const { t, prefs } = useApp();
  const [messages, setMessages] = useState([]);
  const [quick, setQuick] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const listRef = useRef(null);

  const ask = async (text) => {
    const clean = text.trim();
    if (clean) setMessages((m) => [...m, { id: `u${Date.now()}`, from: 'me', text: clean }]);
    setInput('');
    setBusy(true);
    setFailed(false);
    try {
      const r = await api.medibot(clean, prefs.lang);
      setMessages((m) => [...m, { id: `b${Date.now()}`, from: 'bot', data: r.data }]);
      setQuick(r.data.quick_replies || []);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    ask('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
  }, [messages]);

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title="MediBot" subtitle={t('medibotIntro')} />
      {prefs.lang !== 'en' ? (
        <View style={{ paddingHorizontal: 16 }}>
          <Banner text={t('medibotLangNote')} />
        </View>
      ) : null}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (item.from === 'me' ? <MyBubble text={item.text} /> : <BotBubble data={item.data} />)}
        ListFooterComponent={failed ? <Banner tone="EXTREME" text={t('serverDown')} /> : null}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.quickRow} contentContainerStyle={styles.quick} keyboardShouldPersistTaps="handled">
        {quick.map((q) => (
          <TopicButton key={q} label={q} onPress={() => ask(q)} disabled={busy} />
        ))}
      </ScrollView>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={t('typeMessage')}
          placeholderTextColor={colors.inkSoft}
          onSubmitEditing={() => input.trim() && ask(input)}
          returnKeyType="send"
        />
        <Pressable
          onPress={() => input.trim() && ask(input)}
          disabled={busy || !input.trim()}
          style={[styles.send, (busy || !input.trim()) && { opacity: 0.5 }]}
          accessibilityLabel={t('send')}
        >
          <Ionicons name="send" size={20} color="#FFFFFF" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

// Picture + colour for each quick-reply label the backend sends (see ALIASES in services/medibot.py).
const RED = '#A61B1B';
const ORANGE = '#C8561A';
const GREEN = '#2F7A55';
const BLUE = '#1F6FA8';
const PURPLE = '#6B4AA6';
const TOPIC_ART = {
  'drowning / cpr': { icon: 'lifebuoy', color: RED },
  'not breathing / cpr': { icon: 'heart-pulse', color: RED },
  'child not breathing': { icon: 'heart-pulse', color: RED },
  'recovery position': { icon: 'human-male-board', color: ORANGE },
  'bleeding': { icon: 'water-plus', color: RED },
  'cuts and bleeding': { icon: 'bandage', color: RED },
  'snake bite': { icon: 'snake', color: RED },
  'preventing snake bites': { icon: 'snake', color: GREEN },
  'electric shock': { icon: 'flash', color: RED },
  'fever after flood': { icon: 'thermometer', color: ORANGE },
  'diarrhoea / ors': { icon: 'cup-water', color: BLUE },
  'safe drinking water': { icon: 'water-check', color: BLUE },
  'food safety': { icon: 'food-apple', color: GREEN },
  'emergency kit': { icon: 'medical-bag', color: RED },
  'stress and panic': { icon: 'head-heart', color: PURPLE },
  'cold after rescue': { icon: 'snowflake-thermometer', color: BLUE },
  'wound infection signs': { icon: 'virus', color: ORANGE },
  'skin, feet and wound infections': { icon: 'shoe-print', color: ORANGE },
  'tetanus injection': { icon: 'needle', color: BLUE },
  'broken bone': { icon: 'bone', color: ORANGE },
  'carrying an injured person': { icon: 'account-injury', color: ORANGE },
  'burns': { icon: 'fire', color: RED },
  'returning home safely': { icon: 'home-flood', color: GREEN },
  'dengue and malaria': { icon: 'bug', color: ORANGE },
  'child with fever': { icon: 'baby-face-outline', color: ORANGE },
  'sick children': { icon: 'baby-face-outline', color: ORANGE },
  'medicines during evacuation': { icon: 'pill', color: BLUE },
  'pregnancy and newborns': { icon: 'human-pregnant', color: PURPLE },
  'evacuating safely': { icon: 'run-fast', color: GREEN },
  'dog or animal bite': { icon: 'dog-side', color: RED },
};
const DEFAULT_ART = { icon: 'hospital-box', color: BLUE };

function TopicButton({ label, onPress, disabled }) {
  const art = TOPIC_ART[label.toLowerCase()] || DEFAULT_ART;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.topic, { borderColor: art.color }, (pressed || disabled) && { opacity: 0.6 }]}
    >
      <View style={[styles.topicArt, { backgroundColor: art.color }]}>
        <MaterialCommunityIcons name={art.icon} size={20} color="#FFFFFF" />
      </View>
      <Text style={styles.topicText} numberOfLines={2}>{label}</Text>
    </Pressable>
  );
}

function MyBubble({ text }) {
  return (
    <View style={[styles.bubble, styles.mine]}>
      <Text style={[type.body, { color: '#FFFFFF' }]}>{text}</Text>
    </View>
  );
}

const URGENCY = {
  emergency: { bg: '#A61B1B', icon: 'alert-circle' },
  urgent: { bg: '#C8561A', icon: 'medkit' },
  care: { bg: '#2F7A55', icon: 'heart' },
};

function BotBubble({ data }) {
  const [speaking, setSpeaking] = useState(false);
  const u = URGENCY[data.urgency];
  const speak = () => {
    if (speaking) { Speech.stop(); setSpeaking(false); return; }
    const parts = [data.title, data.text, ...(data.steps || []).map((s, i) => `Step ${i + 1}. ${s}`),
      ...(data.dont?.length ? ['Do not:', ...data.dont] : []), ...(data.get_help?.length ? ['Get help if:', ...data.get_help] : [])];
    setSpeaking(true);
    Speech.speak(parts.join(' '), { language: 'en-IN', rate: 0.95, onDone: () => setSpeaking(false), onStopped: () => setSpeaking(false) });
  };
  return (
    <View style={[styles.bubble, styles.bot]}>
      {u ? (
        <View style={[styles.urg, { backgroundColor: u.bg }]}>
          <Ionicons name={u.icon} size={16} color="#FFFFFF" />
          <Text style={styles.urgText}>{data.urgency_label}</Text>
        </View>
      ) : null}
      <Text style={type.section}>{data.title}</Text>
      {data.text ? <Text style={[type.body, { marginTop: 4 }]}>{data.text}</Text> : null}
      {data.call?.length && data.urgency !== 'care' ? (
        <View style={styles.calls}>
          {data.call.map((n) => (
            <Pressable key={n} onPress={() => Linking.openURL(`tel:${n}`)} style={styles.call} accessibilityRole="button" accessibilityLabel={`Call ${n}`}>
              <Ionicons name="call" size={16} color="#FFFFFF" />
              <Text style={styles.callText}>{`Call ${n}`}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {data.steps?.length ? <Text style={styles.h}>What to do</Text> : null}
      {data.steps?.map((s, i) => (
        <View key={i} style={styles.step}>
          <Text style={styles.stepNum}>{i + 1}</Text>
          <Text style={[type.body, { flex: 1 }]}>{s}</Text>
        </View>
      ))}
      {data.dont?.length ? (
        <View style={[styles.box, { backgroundColor: '#F6DEDC' }]}>
          <Text style={[styles.h, { marginTop: 0, color: '#A61B1B' }]}>Don't</Text>
          {data.dont.map((s, i) => (
            <View key={i} style={styles.bullet}><Ionicons name="close-circle" size={16} color="#A61B1B" style={{ marginTop: 3, marginRight: 6 }} /><Text style={[type.body, { flex: 1 }]}>{s}</Text></View>
          ))}
        </View>
      ) : null}
      {data.get_help?.length ? (
        <View style={[styles.box, { backgroundColor: '#FBF0CF' }]}>
          <Text style={[styles.h, { marginTop: 0 }]}>Get medical help if</Text>
          {data.get_help.map((s, i) => (
            <View key={i} style={styles.bullet}><Ionicons name="warning" size={16} color="#8a6400" style={{ marginTop: 3, marginRight: 6 }} /><Text style={[type.body, { flex: 1 }]}>{s}</Text></View>
          ))}
        </View>
      ) : null}
      {data.steps?.length ? (
        <Pressable onPress={speak} style={styles.speak} accessibilityRole="button">
          <Ionicons name={speaking ? 'stop-circle-outline' : 'volume-high-outline'} size={18} color={colors.water} />
          <Text style={styles.speakText}>{speaking ? 'Stop reading' : 'Read aloud'}</Text>
        </Pressable>
      ) : null}
      <Text style={[type.small, { marginTop: 10 }]}>{data.disclaimer}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  list: { padding: 16, paddingBottom: 8 },
  bubble: { borderRadius: 16, padding: 14, marginBottom: 10, maxWidth: '94%' },
  urg: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, marginBottom: 8 },
  urgText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12, marginLeft: 6 },
  calls: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 },
  call: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#A61B1B', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8, marginBottom: 6 },
  callText: { color: '#FFFFFF', fontWeight: '800', marginLeft: 6 },
  h: { fontSize: 14, fontWeight: '800', color: colors.ink, marginTop: 12, textTransform: 'uppercase', letterSpacing: 0.4 },
  box: { borderRadius: 10, padding: 10, marginTop: 12 },
  bullet: { flexDirection: 'row', marginTop: 6 },
  speak: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  speakText: { color: colors.water, fontWeight: '700', marginLeft: 6 },
  mine: { alignSelf: 'flex-end', backgroundColor: colors.water, borderBottomRightRadius: 4 },
  bot: {
    alignSelf: 'flex-start', backgroundColor: colors.card, borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
  },
  step: { flexDirection: 'row', marginTop: 8 },
  stepNum: { width: 24, fontWeight: '800', color: colors.water, fontSize: 16 },
  // flexGrow 0 stops the horizontal row from stretching to fill the screen height.
  quickRow: { flexGrow: 0, flexShrink: 0 },
  quick: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8, alignItems: 'stretch' },
  topic: {
    width: 72, alignItems: 'center', borderRadius: 12, borderWidth: 1, backgroundColor: colors.card,
    paddingVertical: 6, paddingHorizontal: 3, marginRight: 6,
  },
  topicArt: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  topicText: { fontSize: 11, fontWeight: '700', color: colors.ink, textAlign: 'center', marginTop: 4, lineHeight: 13 },
  inputRow: {
    flexDirection: 'row', padding: 12, paddingBottom: 16, borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line, backgroundColor: colors.card,
  },
  input: {
    flex: 1, minHeight: 46, borderRadius: 23, paddingHorizontal: 16, backgroundColor: colors.paper,
    color: colors.ink, fontSize: 16,
  },
  send: {
    width: 46, height: 46, borderRadius: 23, backgroundColor: colors.ink, marginLeft: 8,
    alignItems: 'center', justifyContent: 'center',
  },
});
