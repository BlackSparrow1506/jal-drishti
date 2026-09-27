import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

import { colors, sim as simColors } from '../theme';

const PAD = { l: 44, r: 10, t: 10, b: 22 };

function formatQ(q) {
  return q >= 1000 ? `${(q / 1000).toFixed(q >= 10000 ? 0 : 1)}k` : String(Math.round(q));
}

// SPH (breach) and Delft3D (downstream gauge) discharge over time, with a cursor at the current frame.
export default function Hydrograph({ frames, frameIdx, t, height = 190 }) {
  const [width, setWidth] = useState(0);
  const w = width - PAD.l - PAD.r;
  const h = height - PAD.t - PAD.b;
  const tMax = frames[frames.length - 1].t_min || 1;
  const qMax = Math.max(1, ...frames.map((f) => Math.max(f.q_sph, f.q_delft))) * 1.1;
  const x = (tm) => PAD.l + (tm / tMax) * w;
  const y = (q) => PAD.t + h - (q / qMax) * h;

  const line = (key) => frames.map((f, i) => `${i ? 'L' : 'M'}${x(f.t_min).toFixed(1)},${y(f[key]).toFixed(1)}`).join('');
  const area = (key) => `${line(key)}L${x(tMax)},${y(0)}L${x(0)},${y(0)}Z`;
  const cur = frames[frameIdx];

  return (
    <View>
      <View style={{ height }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 ? (
          <Svg width={width} height={height}>
            {[0, 0.5, 1].map((f) => (
              <React.Fragment key={f}>
                <Line x1={PAD.l} x2={PAD.l + w} y1={y(qMax * f / 1.1)} y2={y(qMax * f / 1.1)} stroke={colors.line} strokeWidth={1} />
                <SvgText x={PAD.l - 6} y={y(qMax * f / 1.1) + 4} fontSize={10} fill={colors.inkSoft} textAnchor="end">
                  {formatQ((qMax * f) / 1.1)}
                </SvgText>
              </React.Fragment>
            ))}
            {[0, 60, 120, 180, 240].filter((m) => m <= tMax).map((m) => (
              <SvgText key={m} x={x(m)} y={height - 6} fontSize={10} fill={colors.inkSoft} textAnchor="middle">
                {`${m / 60}h`}
              </SvgText>
            ))}
            <Path d={area('q_delft')} fill={simColors.delftFill} opacity={0.5} />
            <Path d={area('q_sph')} fill={simColors.sphFill} opacity={0.5} />
            <Path d={line('q_delft')} stroke={simColors.delft} strokeWidth={2} fill="none" />
            <Path d={line('q_sph')} stroke={simColors.sph} strokeWidth={2} fill="none" />
            {cur ? (
              <>
                <Line x1={x(cur.t_min)} x2={x(cur.t_min)} y1={PAD.t} y2={PAD.t + h} stroke={colors.ink} strokeWidth={1} strokeDasharray="3,3" />
                <Circle cx={x(cur.t_min)} cy={y(cur.q_sph)} r={4} fill={simColors.sph} />
                <Circle cx={x(cur.t_min)} cy={y(cur.q_delft)} r={4} fill={simColors.delft} />
              </>
            ) : null}
          </Svg>
        ) : null}
      </View>
      <View style={styles.legend}>
        <Key color={simColors.sph} label={`${t('layerSph')} (m³/s)`} />
        <Key color={simColors.delft} label={`${t('layerDelft')} (m³/s)`} />
      </View>
    </View>
  );
}

function Key({ color, label }) {
  return (
    <View style={styles.key}>
      <View style={[styles.swatch, { backgroundColor: color }]} />
      <Text style={styles.keyText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  legend: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 },
  key: { flexDirection: 'row', alignItems: 'center', marginRight: 14, marginTop: 2 },
  swatch: { width: 12, height: 3, borderRadius: 2, marginRight: 6 },
  keyText: { fontSize: 12, color: colors.inkSoft, fontWeight: '600' },
});
