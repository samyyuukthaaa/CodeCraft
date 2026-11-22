// Day / Night palettes for Code Town (pure data; no DOM, no Three.js). Night is the default. Only the
// environment, idle walls and rooftops change between themes: state colours (with their icon and text) are the
// same in both, so every state still reads by colour + icon + text. String lights stay on by day too.

export type TownTheme = 'night' | 'day';
export const DEFAULT_THEME: TownTheme = 'night';

export interface ThemePalette {
  /** Shown on the switch (icon + text). */
  icon: string;
  label: string;
  /** Sky gradient, top to horizon. */
  skyTop: string;
  skyHorizon: string;
  fog: string;
  fogDensity: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  /** Moon by night, sun by day. */
  sun: string;
  sunIntensity: number;
  ground: string;
  slab: string;
  road: string;
  /** Idle walls are mixed with `dim` by this amount (touched buildings show their state colour unchanged). */
  dim: string;
  dimAmount: number;
  /** Saturation and lightness boost for idle walls and rooftops (HSL offsets). */
  saturate: number;
  lighten: number;
  /** Window glow (emissive intensity). */
  windows: number;
  stars: boolean;
}

export const THEMES: Record<TownTheme, ThemePalette> = {
  night: {
    icon: '🌙',
    label: 'Night',
    skyTop: '#060d26',
    skyHorizon: '#1b2a63',
    fog: '#0a1330',
    fogDensity: 0.0028,
    hemiSky: '#6d82c9',
    hemiGround: '#141a33',
    hemiIntensity: 1.7,
    sun: '#dbe4ff',
    sunIntensity: 1.6,
    ground: '#0c1530',
    slab: '#141e3a',
    road: '#2b4a7a',
    dim: '#0b1430',
    // playful night: district colours more saturated and less dimmed
    dimAmount: 0.26,
    saturate: 0.16,
    lighten: 0,
    windows: 0.9,
    stars: true,
  },
  day: {
    icon: '☀️',
    label: 'Day',
    // a sunny sky that warms into a sunset glow at the horizon
    skyTop: '#3d9bff',
    skyHorizon: '#ffc98a',
    fog: '#cfe3ff',
    fogDensity: 0.0016,
    hemiSky: '#ffffff',
    hemiGround: '#6b8f4e',
    hemiIntensity: 1.5,
    sun: '#fff1d6',
    sunIntensity: 2.3,
    ground: '#78b05a',
    slab: '#e5d6b8',
    road: '#9b7f5c',
    dim: '#ffffff',
    dimAmount: 0.05,
    saturate: 0.25,
    lighten: 0.08,
    windows: 0.25,
    stars: false,
  },
};

export const isTheme = (v: unknown): v is TownTheme => v === 'night' || v === 'day';
export const otherTheme = (t: TownTheme): TownTheme => (t === 'night' ? 'day' : 'night');
