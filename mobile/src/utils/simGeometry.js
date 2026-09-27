// Geometry helpers for the Simulation screen. All flood numbers come from /api/simulation;
// this file only turns them into shapes (map polygons, 3D water, export files).

// Linear interpolation of a per-station array at a chainage (km).
export function sampleAt(values, chainageKm, reachKm) {
  const n = values.length;
  const f = Math.max(0, Math.min(n - 1, (chainageKm / reachKm) * (n - 1)));
  const i = Math.floor(f);
  const j = Math.min(n - 1, i + 1);
  return values[i] + (values[j] - values[i]) * (f - i);
}

// One polygon per run of consecutive wet stations: left bank downstream, right bank back up.
// Returns arrays of [lat, lng].
export function extentRings(stations, widths) {
  const rings = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      const left = run.map(({ s, w }) => [s.lat + s.nlat * w, s.lng + s.nlng * w]);
      const right = run.map(({ s, w }) => [s.lat - s.nlat * w, s.lng - s.nlng * w]).reverse();
      rings.push([...left, ...right]);
    }
    run = [];
  };
  stations.forEach((s, i) => {
    if (widths[i] > 0) run.push({ s, w: widths[i] });
    else flush();
  });
  flush();
  return rings;
}

export function extentGeoJSON(sim, frame) {
  const feature = (layer, widths) =>
    extentRings(sim.stations, widths).map((ring) => ({
      type: 'Feature',
      properties: { layer, scenario_id: sim.scenario.id, t_min: frame.t_min, sample_data: true },
      geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]].map(([lat, lng]) => [+lng.toFixed(6), +lat.toFixed(6)])] },
    }));
  return {
    type: 'FeatureCollection',
    features: [...feature('delft3d_far_field', frame.width_delft_m), ...feature('sph_near_field', frame.width_sph_m)],
  };
}

export function extentKML(sim, frame) {
  const placemarks = extentGeoJSON(sim, frame).features.map((f) => {
    const coords = f.geometry.coordinates[0].map(([lng, lat]) => `${lng},${lat},0`).join(' ');
    return `<Placemark><name>${f.properties.layer} T+${f.properties.t_min} min</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Jal Drishti ${sim.scenario.id} (sample)</name>${placemarks.join('')}</Document></kml>`;
}

export function formatClock(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `T+${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
