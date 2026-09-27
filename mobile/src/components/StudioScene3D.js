import React, { useEffect, useMemo, useRef } from 'react';
import { PanResponder, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { GLView } from 'expo-gl';
import { Ionicons } from '@expo/vector-icons';
import * as THREE from 'three';

import { colors, sim as simColors } from '../theme';

// Real-terrain 3D scene for a dam-studio run. Scene units are kilometres; heights are
// exaggerated so a flood a few metres deep is visible across a 20 km valley.
const HOME = { theta: -0.6, phi: 0.9, radius: 1.35 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function b64bytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodeScene(scene) {
  const { nx, ny } = scene.grid;
  const zdm = new Uint16Array(b64bytes(scene.z_dm).buffer);
  const z = new Float32Array(nx * ny);
  for (let k = 0; k < z.length; k++) z[k] = zdm[k] / 10;
  return {
    nx, ny, cell: scene.grid.cell_m, x0: scene.grid.x0, y0: scene.grid.y0, z,
    rgb: scene.rgb ? b64bytes(scene.rgb) : null,
    frames: scene.frames.map((f) => ({ b64: f, bytes: null })),
    hmax: b64bytes(scene.hmax),
  };
}

const depthOf = (code) => (code / 40) ** 2;

function makeRenderer(gl) {
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const canvas = {
    width: w, height: h, clientWidth: w, clientHeight: h, style: {},
    addEventListener: () => {}, removeEventListener: () => {}, getContext: () => gl,
  };
  const r = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false });
  r.setPixelRatio(1);
  r.setSize(w, h, false);
  r.setClearColor(simColors.night, 1);
  return r;
}

function build(scene, d) {
  const { nx, ny, cell, x0, y0, z } = d;
  const W = (nx - 1) * cell;
  const H = (ny - 1) * cell;
  let zmax = 0;
  for (let k = 0; k < z.length; k++) zmax = Math.max(zmax, z[k]);
  const exag = clamp((0.12 * Math.max(W, H)) / Math.max(zmax, 1), 1, 10);
  const S = 1 / Math.max(W, H); // normalise the domain to ~1 unit across
  const cx = x0 + W / 2;
  const cy = y0 + H / 2;
  const toX = (x) => (x - cx) * S;
  const toZ = (y) => -(y - cy) * S;
  const toY = (elev) => elev * exag * S;
  const groundAt = (x, y) => {
    const i = clamp(Math.round((x - x0) / cell), 0, nx - 1);
    const j = clamp(Math.round((y - y0) / cell), 0, ny - 1);
    return z[j * nx + i];
  };

  const s3 = new THREE.Scene();
  s3.background = new THREE.Color(simColors.night);
  s3.add(new THREE.HemisphereLight(0xe8f2ff, 0x2a2418, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(-0.6, 1.2, 0.5);
  s3.add(sun);

  const index = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, e = c + 1;
      index.push(a, b, c, b, e, c);
    }
  }
  const pos = new Float32Array(nx * ny * 3);
  const col = new Float32Array(nx * ny * 3);
  const low = new THREE.Color('#4f7a4a');
  const high = new THREE.Color('#cfc3a2');
  const tmp = new THREE.Color();
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      pos[k * 3] = toX(x0 + i * cell);
      pos[k * 3 + 1] = toY(z[k]);
      pos[k * 3 + 2] = toZ(y0 + j * cell);
      if (d.rgb) {
        // Sentinel-2 true colour, brightened a little for the dark background.
        col[k * 3] = Math.min(1, (d.rgb[k * 3] / 255) * 1.35);
        col[k * 3 + 1] = Math.min(1, (d.rgb[k * 3 + 1] / 255) * 1.35);
        col[k * 3 + 2] = Math.min(1, (d.rgb[k * 3 + 2] / 255) * 1.35);
      } else {
        tmp.copy(low).lerp(high, z[k] / Math.max(zmax, 1));
        col.set([tmp.r, tmp.g, tmp.b], k * 3);
      }
    }
  }
  const tGeo = new THREE.BufferGeometry();
  tGeo.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
  tGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  tGeo.setIndex(index);
  tGeo.computeVertexNormals();
  s3.add(new THREE.Mesh(tGeo, new THREE.MeshLambertMaterial({ vertexColors: true })));

  const wGeo = new THREE.BufferGeometry();
  wGeo.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
  wGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nx * ny * 3), 3));
  wGeo.setIndex(index);
  s3.add(new THREE.Mesh(wGeo, new THREE.MeshPhongMaterial({
    vertexColors: true, transparent: true, opacity: 0.82, shininess: 80, specular: 0x9fd6ff, side: THREE.DoubleSide,
  })));

  // Buildings: one merged mesh (walls + flat roof), coloured by use and flood depth.
  const bPos = [];
  const bCol = [];
  const kindColour = {
    shop: new THREE.Color('#8e6cf0'), hospital: new THREE.Color('#ff5fa2'),
    school: new THREE.Color('#ffd23f'), building: new THREE.Color('#e9edf1'),
  };
  const wet1 = new THREE.Color('#ff9f43');
  const wet2 = new THREE.Color('#e53935');
  const hScale = Math.max(exag, 4) * S;
  const buildingMeta = [];
  scene.buildings.forEach((b) => {
    if (b.xy.length < 3) return;
    const base = groundAt(b.xy[0][0], b.xy[0][1]);
    const y0b = toY(base);
    const y1b = y0b + b.h * hScale;
    const c = b.d > 0.1 ? (b.d > 1.5 ? wet2 : wet1) : kindColour[b.kind] || kindColour.building;
    const pts = b.xy.map(([x, y]) => [toX(x), toZ(y)]);
    const start = bPos.length / 3;
    for (let k = 0; k < pts.length; k++) {
      const [ax, az] = pts[k];
      const [bx, bz] = pts[(k + 1) % pts.length];
      bPos.push(ax, y0b, az, bx, y0b, bz, bx, y1b, bz, ax, y0b, az, bx, y1b, bz, ax, y1b, az);
    }
    try {
      const tris = THREE.ShapeUtils.triangulateShape(pts.map(([x, zz]) => new THREE.Vector2(x, zz)), []);
      tris.forEach((t) => t.forEach((v) => bPos.push(pts[v][0], y1b, pts[v][1])));
    } catch {
      // skip roofs that fail to triangulate (self-intersecting footprints)
    }
    for (let k = start; k < bPos.length / 3; k++) bCol.push(c.r, c.g, c.b);
    buildingMeta.push(b);
  });
  if (bPos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(bPos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(bCol, 3));
    g.computeVertexNormals();
    s3.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  }

  // Roads (red where flooded), river path and breach marker.
  const lift = 3 * S * exag;
  scene.roads.forEach((r) => {
    const p = r.xy.map(([x, y]) => new THREE.Vector3(toX(x), toY(groundAt(x, y)) + lift, toZ(y)));
    s3.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(p),
      new THREE.LineBasicMaterial({ color: r.flooded ? 0xff3b30 : 0xf5f5f5 })));
  });
  const river = scene.river_xy.map(([x, y]) => new THREE.Vector3(toX(x), toY(groundAt(x, y)) + lift, toZ(y)));
  s3.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(river), new THREE.LineBasicMaterial({ color: 0x7fd3ff })));
  const marker = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.04, 12), new THREE.MeshLambertMaterial({ color: simColors.dam }));
  const [bx, by] = scene.breach_xy;
  marker.position.set(toX(bx), toY(groundAt(bx, by)) + 0.03, toZ(by));
  marker.rotation.x = Math.PI;
  s3.add(marker);

  return {
    s3, wGeo, pos, exag, S,
    dispose: () => s3.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }),
    counts: { buildings: buildingMeta.length },
  };
}

function applyFrame(ctx, d, frameIdx, showMax) {
  const f = showMax ? { bytes: d.hmax } : d.frames[frameIdx];
  if (!f.bytes) f.bytes = b64bytes(f.b64);
  const p = ctx.wGeo.attributes.position.array;
  const c = ctx.wGeo.attributes.color.array;
  const shallow = new THREE.Color('#8fe3f0');
  const deep = new THREE.Color('#0b3f8a');
  const tmp = new THREE.Color();
  for (let k = 0; k < d.z.length; k++) {
    const h = depthOf(f.bytes[k]);
    const g = ctx.pos[k * 3 + 1];
    if (h > 0.05) {
      p[k * 3 + 1] = g + (h * ctx.exag + 0.5) * ctx.S;
      tmp.copy(shallow).lerp(deep, Math.min(1, h / 6));
    } else {
      p[k * 3 + 1] = g - 2 * ctx.S * ctx.exag;
      tmp.copy(shallow);
    }
    c[k * 3] = tmp.r; c[k * 3 + 1] = tmp.g; c[k * 3 + 2] = tmp.b;
  }
  ctx.wGeo.attributes.position.needsUpdate = true;
  ctx.wGeo.attributes.color.needsUpdate = true;
  ctx.wGeo.computeVertexNormals();
}

export default function StudioScene3D({ scene, decoded, frameIdx, showMax, active = true, onInteract, t, height = 380 }) {
  const live = useRef({});
  live.current = { frameIdx, showMax, active };
  const orbit = useRef({ ...HOME, lastDx: 0, lastDy: 0, pinch: null });
  const raf = useRef(null);
  const cleanup = useRef(null);
  const surface = useRef(null);

  useEffect(() => () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    cleanup.current?.();
  }, []);

  useEffect(() => {
    const el = surface.current;
    if (Platform.OS !== 'web' || !el?.addEventListener) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      orbit.current.radius = clamp(orbit.current.radius * (1 + e.deltaY * 0.001), 0.15, 3);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { Object.assign(orbit.current, { lastDx: 0, lastDy: 0, pinch: null }); onInteract?.(true); },
    onPanResponderMove: (e, g) => {
      const o = orbit.current;
      const touches = e.nativeEvent.touches || [];
      if (touches.length >= 2) {
        const dist = Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);
        if (o.pinch) o.radius = clamp(o.radius * (o.pinch / dist), 0.15, 3);
        o.pinch = dist;
      } else {
        o.pinch = null;
        o.theta -= (g.dx - o.lastDx) * 0.008;
        o.phi = clamp(o.phi - (g.dy - o.lastDy) * 0.006, 0.2, 1.45);
      }
      o.lastDx = g.dx; o.lastDy = g.dy;
    },
    onPanResponderRelease: () => onInteract?.(false),
    onPanResponderTerminate: () => onInteract?.(false),
  }), [onInteract]);

  const onContextCreate = (gl) => {
    const renderer = makeRenderer(gl);
    const camera = new THREE.PerspectiveCamera(45, gl.drawingBufferWidth / gl.drawingBufferHeight, 0.005, 20);
    const ctx = build(scene, decoded);
    cleanup.current = () => { ctx.dispose(); renderer.dispose(); };
    const target = new THREE.Vector3(0, 0.02, 0);
    let applied = null;
    const loop = () => {
      raf.current = requestAnimationFrame(loop);
      const { frameIdx: fi, showMax: sm, active: on } = live.current;
      if (!on) return;
      const key = sm ? 'max' : fi;
      if (key !== applied) { applyFrame(ctx, decoded, fi, sm); applied = key; }
      const o = orbit.current;
      camera.position.set(
        target.x + o.radius * Math.sin(o.phi) * Math.sin(o.theta),
        target.y + o.radius * Math.cos(o.phi),
        target.z + o.radius * Math.sin(o.phi) * Math.cos(o.theta),
      );
      camera.lookAt(target);
      renderer.render(ctx.s3, camera);
      gl.endFrameEXP();
    };
    loop();
  };

  return (
    <View style={[styles.wrap, { height }]}>
      <View ref={surface} style={StyleSheet.absoluteFill} {...pan.panHandlers}>
        <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />
      </View>
      <Text style={styles.hint} pointerEvents="none">
        {`${t(Platform.OS === 'web' ? 'drag3dWeb' : 'drag3d')} ${t('heightsExaggerated')}.`}
      </Text>
      <Pressable style={styles.reset} onPress={() => Object.assign(orbit.current, HOME)} accessibilityLabel={t('resetView')}>
        <Ionicons name="scan-outline" size={18} color="#FFFFFF" />
      </Pressable>
      <View style={styles.legend} pointerEvents="none">
        {[['#2f86c4', t('stWater')], ['#e53935', t('stFloodedBuilding')], ['#8e6cf0', t('stShop')],
          ['#ff5fa2', t('stHospital')], ['#ffd23f', t('stSchool')], ['#ff3b30', t('stRoadCut')],
          [simColors.dam, t('stBreach')]].map(([c, l]) => (
          <View key={l} style={styles.row}>
            <View style={[styles.sw, { backgroundColor: c }]} />
            <Text style={styles.lt}>{l}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 14, overflow: 'hidden', backgroundColor: simColors.night },
  hint: { position: 'absolute', top: 10, left: 12, right: 52, color: 'rgba(255,255,255,0.75)', fontSize: 11, fontWeight: '600' },
  reset: {
    position: 'absolute', top: 8, right: 8, width: 34, height: 34, borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center',
  },
  legend: { position: 'absolute', left: 10, bottom: 10, backgroundColor: 'rgba(14,34,51,0.82)', borderRadius: 8, padding: 6 },
  row: { flexDirection: 'row', alignItems: 'center', marginVertical: 1 },
  sw: { width: 10, height: 10, borderRadius: 2, marginRight: 6 },
  lt: { color: colors.card, fontSize: 10.5, fontWeight: '600' },
});
