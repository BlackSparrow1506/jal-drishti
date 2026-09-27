import React, { useEffect, useMemo, useRef } from 'react';
import { PanResponder, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { GLView } from 'expo-gl';
import { Ionicons } from '@expo/vector-icons';
import * as THREE from 'three';

import { colors, sim as simColors } from '../theme';
import { sampleAt } from '../utils/simGeometry';

// Scene units are kilometres. Relief is small next to a 19 km valley, so heights are exaggerated.
const TERRAIN_EXAG = 12;
const WATER_EXAG = 40;
const N_PARTICLES = 700;
const HOME = { theta: -0.55, phi: 0.95, radius: 17 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Three.js needs a canvas-like object; expo-gl only gives us the GL context.
function makeRenderer(gl) {
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const canvas = {
    width: w, height: h, clientWidth: w, clientHeight: h, style: {},
    addEventListener: () => {}, removeEventListener: () => {}, getContext: () => gl,
  };
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false });
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  renderer.setClearColor(simColors.night, 1);
  return renderer;
}

function buildScene(terrain) {
  const { nx, ny, cell_m: cell, origin_m: [ox, oy], z_m: z } = terrain;
  const zMin = Math.min(...z);
  const zMax = Math.max(...z);
  const cx = (ox + (nx - 1) * cell / 2) / 1000;
  const cy = (oy + (ny - 1) * cell / 2) / 1000;

  // Local metres (x east, y north, elevation) -> scene (X east, Y up, Z south).
  const toScene = (x, y, elev) => new THREE.Vector3(x / 1000 - cx, ((elev - zMin) * TERRAIN_EXAG) / 1000, -(y / 1000 - cy));
  const groundY = new Float32Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) groundY[k] = ((z[k] - zMin) * TERRAIN_EXAG) / 1000;

  // Shared grid topology for terrain and water.
  const index = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      index.push(a, b, c, b, d, c);
    }
  }
  const basePositions = new Float32Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      basePositions[k * 3] = (ox + i * cell) / 1000 - cx;
      basePositions[k * 3 + 1] = groundY[k];
      basePositions[k * 3 + 2] = -((oy + j * cell) / 1000 - cy);
    }
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(simColors.night);
  scene.fog = new THREE.Fog(simColors.night, 28, 55);
  scene.add(new THREE.HemisphereLight(0xdfefff, 0x2a2418, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-8, 14, 6);
  scene.add(sun);

  // Terrain, coloured by elevation: valley green -> ridge tan.
  const low = new THREE.Color('#4f7a4a');
  const mid = new THREE.Color('#8d8458');
  const high = new THREE.Color('#cfc3a2');
  const tColors = new Float32Array(nx * ny * 3);
  const tmp = new THREE.Color();
  for (let k = 0; k < nx * ny; k++) {
    const f = (z[k] - zMin) / (zMax - zMin || 1);
    if (f < 0.4) tmp.copy(low).lerp(mid, f / 0.4);
    else tmp.copy(mid).lerp(high, (f - 0.4) / 0.6);
    tColors.set([tmp.r, tmp.g, tmp.b], k * 3);
  }
  const tGeo = new THREE.BufferGeometry();
  tGeo.setAttribute('position', new THREE.BufferAttribute(basePositions.slice(), 3));
  tGeo.setAttribute('color', new THREE.BufferAttribute(tColors, 3));
  tGeo.setIndex(index);
  tGeo.computeVertexNormals();
  scene.add(new THREE.Mesh(tGeo, new THREE.MeshLambertMaterial({ vertexColors: true })));

  // River centreline drawn through the stations, lifted slightly above the bed.
  const riverPts = terrain.stations_m.map(([x, y], i) => toScene(x, y, terrain.station_ground_m[i] + 1.5));
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(riverPts),
    new THREE.LineBasicMaterial({ color: 0x7fd3ff })));

  // Flood water: same grid as the terrain; dry vertices are tucked under the ground.
  const wGeo = new THREE.BufferGeometry();
  wGeo.setAttribute('position', new THREE.BufferAttribute(basePositions.slice(), 3));
  wGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nx * ny * 3), 3));
  wGeo.setIndex(index);
  const water = new THREE.Mesh(wGeo, new THREE.MeshPhongMaterial({
    vertexColors: true, transparent: true, opacity: 0.85, shininess: 90, specular: 0x9fd6ff, side: THREE.DoubleSide,
  }));
  scene.add(water);

  // Dam wall across the first river segment.
  const [s0, s1] = terrain.stations_m;
  const dam = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.35, 0.12), new THREE.MeshLambertMaterial({ color: simColors.dam }));
  dam.position.copy(toScene(terrain.dam_m[0], terrain.dam_m[1], terrain.station_ground_m[0] + 14));
  dam.rotation.y = Math.atan2(-(s1[1] - s0[1]), s1[0] - s0[0]) + Math.PI / 2;
  scene.add(dam);

  const cellIndex = ([x, y]) => {
    const i = clamp(Math.round((x - ox) / cell), 0, nx - 1);
    const j = clamp(Math.round((y - oy) / cell), 0, ny - 1);
    return j * nx + i;
  };
  const pin = (pos, geo, color, lift) => {
    const k = cellIndex(pos);
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
    m.position.set(basePositions[k * 3], groundY[k] + lift, basePositions[k * 3 + 2]);
    scene.add(m);
    return { mesh: m, k };
  };
  const campGeo = new THREE.ConeGeometry(0.16, 0.45, 12);
  terrain.shelters.forEach((s) => pin(s.pos_m, campGeo, '#2F7A55', 0.22));
  const areaGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.3, 14);
  const areas = terrain.localities.map((l) => pin(l.pos_m, areaGeo, '#F2F5F6', 0.15));

  // SPH particles for the near-field surge.
  const pPos = new Float32Array(N_PARTICLES * 3);
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({
    color: 0xb7a6ff, size: 0.07, transparent: true, opacity: 0.95, depthWrite: false,
  }));
  scene.add(particles);
  const pState = Array.from({ length: N_PARTICLES }, () => ({
    s: Math.random() * 4, u: Math.random() * 2 - 1, v: 0.7 + Math.random() * 0.6, lift: Math.random(),
  }));

  const column = (a) => terrain.stations_m.map((st) => st[a]);
  const stationCols = { x: column(0), y: column(1), nx: column(2), ny: column(3) };

  return {
    scene, wGeo, groundY, particles, pPos, pState, areas, toScene, stationCols,
    dispose: () => scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }),
  };
}

// Water surface and colours for one simulation frame.
function applyFrame(ctx, terrain, sim, frame, layers) {
  const { wGeo, groundY, areas } = ctx;
  const pos = wGeo.attributes.position.array;
  const col = wGeo.attributes.color.array;
  const reach = sim.reach_km;
  const widths = layers.delft ? frame.width_delft_m : layers.sph ? frame.width_sph_m : null;
  const shallow = new THREE.Color('#7fd8e6');
  const deep = new THREE.Color('#0b4f8a');
  const c = new THREE.Color();
  const wet = new Uint8Array(groundY.length);

  for (let k = 0; k < groundY.length; k++) {
    let depth = 0;
    if (widths) {
      const ch = terrain.chainage_km[k];
      const w = sampleAt(widths, ch, reach);
      if (w > 0) {
        const lateral = 1 - (terrain.dist_m[k] / w) ** 2;
        if (lateral > 0) depth = sampleAt(frame.depth_m, ch, reach) * lateral;
      }
    }
    if (depth > 0.05) {
      wet[k] = 1;
      pos[k * 3 + 1] = groundY[k] + 0.012 + (depth * WATER_EXAG) / 1000;
      c.copy(shallow).lerp(deep, Math.min(1, depth / 5));
    } else {
      pos[k * 3 + 1] = groundY[k] - 0.05;
      c.copy(shallow);
    }
    col.set([c.r, c.g, c.b], k * 3);
  }
  wGeo.attributes.position.needsUpdate = true;
  wGeo.attributes.color.needsUpdate = true;
  wGeo.computeVertexNormals();
  areas.forEach(({ mesh, k }) => mesh.material.color.set(wet[k] ? '#D93025' : '#F2F5F6'));
}

// Advance SPH particles along the near-field reach, scaled by the current breach discharge.
function stepParticles(ctx, terrain, sim, frame, dt, show) {
  const { particles, pPos, pState, toScene, stationCols: sc } = ctx;
  const intensity = frame.q_sph / (sim.peak_q_m3s || 1);
  particles.visible = show && intensity > 0.03;
  if (!particles.visible) return;
  const near = sim.near_field_km;
  const reach = sim.reach_km;
  for (let p = 0; p < pState.length; p++) {
    const q = pState[p];
    q.s += dt * q.v * (0.5 + 2.2 * intensity);
    if (q.s > near) { q.s = Math.random() * 0.25; q.u = Math.random() * 2 - 1; }
    const w = sampleAt(frame.width_sph_m, q.s, reach) * 0.9;
    const depth = sampleAt(frame.depth_m, q.s, reach);
    const x = sampleAt(sc.x, q.s, reach) + sampleAt(sc.nx, q.s, reach) * q.u * w;
    const y = sampleAt(sc.y, q.s, reach) + sampleAt(sc.ny, q.s, reach) * q.u * w;
    const ground = sampleAt(terrain.station_ground_m, q.s, reach);
    const v = toScene(x, y, ground);
    pPos[p * 3] = v.x;
    pPos[p * 3 + 1] = v.y + 0.02 + ((depth * (0.4 + q.lift)) * WATER_EXAG) / 1000;
    pPos[p * 3 + 2] = v.z;
  }
  particles.geometry.attributes.position.needsUpdate = true;
}

export default function Flood3D({ terrain, sim, frameIdx, layers, active = true, onInteract, t, height = 340 }) {
  const live = useRef({});
  live.current = { sim, frame: sim.frames[frameIdx], layers, active };
  const orbit = useRef({ ...HOME, lastDx: null, lastDy: null, pinch: null });
  const raf = useRef(null);
  const cleanup = useRef(null);
  const surface = useRef(null);

  // Browsers have no pinch gesture: zoom with the mouse wheel instead.
  useEffect(() => {
    const el = surface.current;
    if (Platform.OS !== 'web' || !el?.addEventListener) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      orbit.current.radius = clamp(orbit.current.radius * (1 + e.deltaY * 0.001), 5, 40);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    cleanup.current?.();
  }, []);

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      Object.assign(orbit.current, { lastDx: 0, lastDy: 0, pinch: null });
      onInteract?.(true);
    },
    onPanResponderMove: (e, g) => {
      const o = orbit.current;
      const touches = e.nativeEvent.touches || [];
      if (touches.length >= 2) {
        const d = Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);
        if (o.pinch) o.radius = clamp(o.radius * (o.pinch / d), 5, 40);
        o.pinch = d;
        o.lastDx = g.dx; o.lastDy = g.dy;
        return;
      }
      o.pinch = null;
      o.theta -= (g.dx - o.lastDx) * 0.008;
      o.phi = clamp(o.phi - (g.dy - o.lastDy) * 0.006, 0.25, 1.45);
      o.lastDx = g.dx; o.lastDy = g.dy;
    },
    onPanResponderRelease: () => onInteract?.(false),
    onPanResponderTerminate: () => onInteract?.(false),
  }), [onInteract]);

  const onContextCreate = (gl) => {
    const renderer = makeRenderer(gl);
    const camera = new THREE.PerspectiveCamera(45, gl.drawingBufferWidth / gl.drawingBufferHeight, 0.1, 120);
    const ctx = buildScene(terrain);
    const target = new THREE.Vector3(0, 0.3, 0);
    cleanup.current = () => { ctx.dispose(); renderer.dispose(); };
    let appliedKey = null;
    let last = Date.now();

    const loop = () => {
      raf.current = requestAnimationFrame(loop);
      const { sim: s, frame, layers: ly, active: on } = live.current;
      const now = Date.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!on || !frame) return;

      const key = `${s.scenario.id}|${JSON.stringify(s.params)}|${frame.t_min}|${ly.delft}|${ly.sph}`;
      if (key !== appliedKey) {
        applyFrame(ctx, terrain, s, frame, ly);
        appliedKey = key;
      }
      stepParticles(ctx, terrain, s, frame, dt, ly.sph);

      const o = orbit.current;
      camera.position.set(
        target.x + o.radius * Math.sin(o.phi) * Math.sin(o.theta),
        target.y + o.radius * Math.cos(o.phi),
        target.z + o.radius * Math.sin(o.phi) * Math.cos(o.theta),
      );
      camera.lookAt(target);
      renderer.render(ctx.scene, camera);
      gl.endFrameEXP();
    };
    loop();
  };

  return (
    <View style={[styles.wrap, { height }]}>
      <View ref={surface} style={StyleSheet.absoluteFill} {...pan.panHandlers}>
        <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />
      </View>
      <View style={styles.hint} pointerEvents="none">
        <Text style={styles.hintText}>{`${t(Platform.OS === 'web' ? 'drag3dWeb' : 'drag3d')} ${t('heightsExaggerated')}.`}</Text>
      </View>
      <Pressable
        style={styles.reset}
        onPress={() => Object.assign(orbit.current, HOME)}
        accessibilityRole="button"
        accessibilityLabel={t('resetView')}
        hitSlop={8}
      >
        <Ionicons name="scan-outline" size={18} color="#FFFFFF" />
      </Pressable>
      <View style={styles.legend} pointerEvents="none">
        <Key color="#2f86c4" label={t('legendWater')} />
        <Key color="#b7a6ff" label={t('legendParticles')} />
        <Key color="#F2F5F6" label={t('legendAreas')} />
        <Key color="#2F7A55" label={t('legendCamps')} />
        <Key color={simColors.dam} label={t('dam')} />
      </View>
    </View>
  );
}

function Key({ color, label }) {
  return (
    <View style={styles.keyRow}>
      <View style={[styles.swatch, { backgroundColor: color }]} />
      <Text style={styles.keyText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 14, overflow: 'hidden', backgroundColor: simColors.night },
  hint: { position: 'absolute', top: 10, left: 12, right: 52 },
  hintText: { color: 'rgba(255,255,255,0.75)', fontSize: 11, fontWeight: '600' },
  reset: {
    position: 'absolute', top: 8, right: 8, width: 34, height: 34, borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center',
  },
  legend: {
    position: 'absolute', left: 10, bottom: 10, backgroundColor: 'rgba(14,34,51,0.82)',
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6,
  },
  keyRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 1.5 },
  swatch: { width: 10, height: 10, borderRadius: 2, marginRight: 6 },
  keyText: { color: colors.card, fontSize: 10.5, fontWeight: '600' },
});
