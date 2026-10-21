// Tiny synthesized sound effects (no audio files).
let ctx = null;
let muted = false;
try {
  muted = localStorage.getItem('cb-muted') === '1';
} catch {}

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, dur, { type = 'sine', gain = 0.12, slide = null, delay = 0 } = {}) {
  if (muted) return;
  const a = ac();
  const t = a.currentTime + delay;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sfx = {
  unlock() {
    if (!muted) ac();
  },
  get muted() {
    return muted;
  },
  toggle() {
    muted = !muted;
    try {
      localStorage.setItem('cb-muted', muted ? '1' : '0');
    } catch {}
    return muted;
  },
  step() { tone(520, 0.05, { type: 'triangle', gain: 0.05 }); },
  grab() { tone(330, 0.07, { type: 'triangle', gain: 0.07, slide: 440 }); },
  exit() {
    tone(420, 0.22, { type: 'sine', gain: 0.14, slide: 1100 });
    tone(840, 0.18, { type: 'triangle', gain: 0.05, slide: 1600, delay: 0.05 });
  },
  peel() { tone(600, 0.16, { type: 'square', gain: 0.04, slide: 900 }); },
  deny() { tone(150, 0.14, { type: 'square', gain: 0.05, slide: 110 }); },
  ping() { tone(988, 0.12, { gain: 0.08 }); tone(1318, 0.15, { gain: 0.06, delay: 0.08 }); },
  emote() { tone(700, 0.08, { type: 'triangle', gain: 0.06 }); },
  join() { tone(523, 0.12, { gain: 0.08 }); tone(784, 0.16, { gain: 0.08, delay: 0.1 }); },
  win() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.25, { type: 'triangle', gain: 0.12, delay: i * 0.11 })); },
  lose() { [392, 330, 262].forEach((f, i) => tone(f, 0.3, { type: 'sawtooth', gain: 0.05, delay: i * 0.16 })); },
};
