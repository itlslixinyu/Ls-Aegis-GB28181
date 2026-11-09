export interface PlaybackClock {
  position: number;
  playing: boolean;
  speed: number;
  muted: boolean;
  revision: number;
  direction?: 1 | -1;
}
export interface PlaybackRange {
  start: number;
  end: number;
}
