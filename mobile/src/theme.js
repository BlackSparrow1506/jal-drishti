export const colors = {
  ink: '#12324A',
  inkSoft: '#4E6A7E',
  paper: '#F2F5F6',
  card: '#FFFFFF',
  line: '#D6DFE4',
  water: '#1B6CA8',
  waterSoft: '#DCEAF4',
};

// One colour per risk level, used everywhere (hero, map zones, alerts, badges).
export const risk = {
  EXTREME: { bg: '#A61B1B', fg: '#FFFFFF', soft: '#F6DEDC' },
  HIGH: { bg: '#C8561A', fg: '#FFFFFF', soft: '#F8E4D6' },
  MODERATE: { bg: '#E3B53B', fg: '#2A2105', soft: '#FBF0CF' },
  SAFE: { bg: '#2F7A55', fg: '#FFFFFF', soft: '#DDEFE5' },
  INFO: { bg: '#1B6CA8', fg: '#FFFFFF', soft: '#DCEAF4' },
};

export const zoneFill = {
  EXTREME: 'rgba(166,27,27,0.38)',
  HIGH: 'rgba(200,86,26,0.28)',
  MODERATE: 'rgba(227,181,59,0.26)',
};

// Simulation layers: SPH near-field surge and Delft3D far-field routing.
export const sim = {
  sph: '#6A4FD0', sphFill: 'rgba(106,79,208,0.38)',
  delft: '#1B6CA8', delftFill: 'rgba(27,108,168,0.30)',
  dam: '#E3A13B', night: '#0E2233',
};

export const routeColor = { SAFE: '#2F7A55', CAUTION: '#C8561A', UNSAFE: '#A61B1B' };

export const type = {
  hero: { fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  countdown: { fontSize: 52, fontWeight: '800', letterSpacing: -1.5, fontVariant: ['tabular-nums'] },
  title: { fontSize: 22, fontWeight: '700', color: colors.ink },
  section: { fontSize: 17, fontWeight: '700', color: colors.ink },
  body: { fontSize: 16, lineHeight: 23, color: colors.ink },
  small: { fontSize: 13, lineHeight: 18, color: colors.inkSoft },
  num: { fontVariant: ['tabular-nums'] },
};
