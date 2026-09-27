// Browser stand-in for react-native-maps, built on Leaflet.
// metro.config.js points `react-native-maps` here for the web build only, so screens keep
// importing `react-native-maps` and phones still use the native maps.
import React, { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const MapCtx = createContext(null);
const PIN = { navy: '#12324A', green: '#2F7A55', blue: '#1B6CA8', violet: '#6A4FD0', orange: '#E3A13B', red: '#A61B1B' };
const ll = (c) => [c.latitude, c.longitude];
const esc = (v) => String(v).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const MapView = forwardRef(function MapView({ style, initialRegion, children }, ref) {
  const host = useRef(null);
  const [map, setMap] = useState(null);

  useEffect(() => {
    const m = L.map(host.current, { zoomControl: true, attributionControl: true });
    const r = initialRegion;
    m.fitBounds([
      [r.latitude - r.latitudeDelta / 2, r.longitude - r.longitudeDelta / 2],
      [r.latitude + r.latitudeDelta / 2, r.longitude + r.longitudeDelta / 2],
    ]);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '&copy; OpenStreetMap contributors',
    }).addTo(m);
    setMap(m);
    // The container can change size after first paint (tabs, scroll views).
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(host.current);
    return () => { ro.disconnect(); m.remove(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    fitToCoordinates: (coords, { edgePadding: p = {} } = {}) => {
      if (map && coords.length) {
        map.fitBounds(coords.map(ll), { paddingTopLeft: [p.left || 0, p.top || 0], paddingBottomRight: [p.right || 0, p.bottom || 0] });
      }
    },
  }), [map]);

  return (
    <View style={style}>
      <div ref={host} style={{ position: 'absolute', inset: 0, zIndex: 0 }} />
      <MapCtx.Provider value={map}>{map ? children : null}</MapCtx.Provider>
    </View>
  );
});

// Adds a Leaflet layer while mounted and rebuilds it when its props change.
function useLayer(build, deps) {
  const map = useContext(MapCtx);
  useEffect(() => {
    if (!map) return undefined;
    const layer = build().addTo(map);
    return () => layer.remove();
  }, [map, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

const dash = (p) => (p ? p.join(',') : undefined);

export function Polygon({ coordinates, fillColor, strokeColor, strokeWidth = 1 }) {
  return useLayer(() => L.polygon(coordinates.map(ll), {
    fillColor, fillOpacity: 1, color: strokeColor === 'transparent' ? undefined : strokeColor,
    weight: strokeColor === 'transparent' ? 0 : strokeWidth, stroke: strokeColor !== 'transparent',
  }), [JSON.stringify(coordinates), fillColor, strokeColor, strokeWidth]);
}

export function Polyline({ coordinates, strokeColor, strokeWidth = 2, lineDashPattern }) {
  return useLayer(() => L.polyline(coordinates.map(ll), {
    color: strokeColor, weight: strokeWidth, dashArray: dash(lineDashPattern),
  }), [JSON.stringify(coordinates), strokeColor, strokeWidth, dash(lineDashPattern)]);
}

export function Circle({ center, radius, fillColor, strokeColor, strokeWidth = 1 }) {
  return useLayer(() => L.circle(ll(center), {
    radius, fillColor, fillOpacity: 1, color: strokeColor, weight: strokeWidth,
  }), [center.latitude, center.longitude, radius, fillColor, strokeColor, strokeWidth]);
}

// Markers become coloured dots. A custom child view lends its colour and size.
export function Marker({ coordinate, title, description, pinColor, children }) {
  const child = React.Children.toArray(children)[0];
  const s = child ? StyleSheet.flatten(child.props?.style) || {} : {};
  const color = s.backgroundColor || PIN[pinColor] || pinColor || PIN.red;
  const radius = s.width ? s.width / 2 : 8;
  return useLayer(() => {
    const m = L.circleMarker(ll(coordinate), {
      radius, fillColor: color, fillOpacity: 1, color: s.borderColor || '#FFFFFF', weight: s.borderWidth || 2,
    });
    if (title) m.bindTooltip(description ? `<b>${esc(title)}</b><br>${esc(description)}` : esc(title));
    return m;
  }, [coordinate.latitude, coordinate.longitude, title, description, color, radius]);
}

export function Overlay({ image, bounds, opacity = 1 }) {
  const uri = typeof image === 'string' ? image : image?.uri;
  return useLayer(() => L.imageOverlay(uri, bounds, { opacity }), [uri, JSON.stringify(bounds), opacity]);
}

export default MapView;
