/* Background music engine (shared with Quizzle): every sound effect and music track is synthesized live with
   the Web Audio API, so there are no audio files to download or license. */
const Sound = (() => {
  const pref = {
    get(k, d) { try { const v = localStorage.getItem('blof.' + k); return v === null ? d : v === '1'; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('blof.' + k, v ? '1' : '0'); } catch { /* private mode */ } },
  };

  let ctx = null, master, musicBus, sfxBus, noiseBuf;
  let soundOn = pref.get('sound', true);
  let musicOn = pref.get('music', true);
  let wanted = null, current = null;
  const readyListeners = [];

  const ready = () => !!ctx && ctx.state === 'running';

  function init() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = soundOn ? 1 : 0;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.ratio.value = 4;
      master.connect(comp).connect(ctx.destination);
      musicBus = ctx.createGain();
      musicBus.gain.value = musicOn ? 0.3 : 0;
      musicBus.connect(master);
      sfxBus = ctx.createGain();
      sfxBus.gain.value = 0.8;
      sfxBus.connect(master);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const onReady = () => {
      if (wanted && musicOn && current?.name !== wanted) startMusic(wanted);
      readyListeners.splice(0).forEach(f => f());
    };
    if (ctx.state === 'running') onReady();
    else ctx.resume().then(onReady).catch(() => {});
  }
  for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, init, { capture: true, passive: true });

  // ── Synth building blocks ────────────────────────────────────────────────
  const NOTES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function midi(n) {
    if (typeof n === 'number') return n;
    const m = /^([A-G])([#b]?)(-?\d)$/.exec(n);
    return (Number(m[3]) + 1) * 12 + NOTES[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  }
  const hz = n => 440 * Math.pow(2, (midi(n) - 69) / 12);

  function env(g, t, vol, attack, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  function tone(dest, { n, f, t, dur = 0.2, type = 'square', vol = 0.2, attack = 0.005, slide, slideF, cutoff, detune = 0 }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(f ?? hz(n), t);
    const target = slideF ?? (slide != null ? hz(slide) : null);
    if (target) osc.frequency.exponentialRampToValueAtTime(target, t + dur * 0.9);
    const g = ctx.createGain();
    env(g, t, vol, attack, dur);
    let out = osc;
    if (cutoff) {
      const flt = ctx.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.value = cutoff;
      out = out.connect(flt);
    }
    out.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  function noise(dest, { t, dur = 0.1, vol = 0.2, type = 'highpass', f = 5000, q = 0.7, sweepTo, attack = 0.002 }) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.Q.value = q;
    flt.frequency.setValueAtTime(f, t);
    if (sweepTo) flt.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    env(g, t, vol, attack, dur);
    src.connect(flt).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  function kick(dest, t, vol = 0.7) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g = ctx.createGain();
    env(g, t, vol, 0.002, 0.22);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + 0.25);
  }
  const snare = (d, t, vol = 0.18) => {
    noise(d, { t, dur: 0.14, vol, type: 'bandpass', f: 1800, q: 0.8 });
    tone(d, { f: 190, t, dur: 0.08, type: 'triangle', vol: vol * 0.8 });
  };
  const hat = (d, t, vol = 0.05) => noise(d, { t, dur: 0.04, vol, f: 8000 });

  // ── Sound effects ────────────────────────────────────────────────────────
  const SFX = {
    click(t) { tone(sfxBus, { f: 900, t, dur: 0.05, vol: 0.08, cutoff: 3000 }); },
    pop(t) {
      const f = 320 + Math.random() * 320;
      tone(sfxBus, { f, slideF: f * 2.6, t, dur: 0.13, type: 'sine', vol: 0.4 });
      tone(sfxBus, { f: f * 2, t: t + 0.05, dur: 0.08, type: 'triangle', vol: 0.12 });
    },
    tick(t) {
      tone(sfxBus, { f: 1250, t, dur: 0.07, type: 'sine', vol: 0.35 });
      tone(sfxBus, { f: 2500, t, dur: 0.03, vol: 0.04 });
    },
    whoosh(t) { noise(sfxBus, { t, dur: 0.7, vol: 0.3, type: 'bandpass', f: 250, sweepTo: 4000, q: 1.4, attack: 0.3 }); },
    start(t) {
      ['C4', 'G4', 'C5', 'E5', 'G5', 'C6'].forEach((n, i) => tone(sfxBus, { n, t: t + i * 0.06, dur: 0.18, vol: 0.1, cutoff: 3500 }));
      noise(sfxBus, { t: t + 0.36, dur: 0.6, vol: 0.12, f: 5000 });
    },
    lock(t) {
      tone(sfxBus, { n: 'E6', t, dur: 0.15, type: 'sine', vol: 0.3 });
      tone(sfxBus, { n: 'B6', t: t + 0.08, dur: 0.35, type: 'sine', vol: 0.22 });
    },
    correct(t) {
      ['C5', 'E5', 'G5', 'C6'].forEach((n, i) => {
        tone(sfxBus, { n, t: t + i * 0.08, dur: 0.3, vol: 0.12, cutoff: 3500 });
        tone(sfxBus, { n, t: t + i * 0.08, dur: 0.3, type: 'triangle', vol: 0.15 });
      });
      ['G6', 'C7', 'E7'].forEach((n, i) => tone(sfxBus, { n, t: t + 0.4 + i * 0.07, dur: 0.4, type: 'sine', vol: 0.1 }));
    },
    wrong(t) {
      tone(sfxBus, { n: 'D4', slide: 'C#4', t, dur: 0.3, type: 'sawtooth', vol: 0.14, cutoff: 1300 });
      tone(sfxBus, { n: 'C#4', slide: 'A3', t: t + 0.32, dur: 0.6, type: 'sawtooth', vol: 0.14, cutoff: 1000 });
    },
    timeout(t) {
      tone(sfxBus, { n: 'A4', slide: 'E4', t, dur: 0.5, type: 'triangle', vol: 0.25 });
    },
    gong(t) {
      [[196, 1], [394, 0.5], [588, 0.35], [836, 0.2], [1180, 0.1]].forEach(([f, v]) =>
        tone(sfxBus, { f, t, dur: 2.2, type: 'sine', vol: 0.3 * v, attack: 0.004 }));
      noise(sfxBus, { t, dur: 0.25, vol: 0.1, type: 'bandpass', f: 3000 });
    },
    reveal(t) {
      [['G4', 0], ['C5', 0.1], ['E5', 0.2]].forEach(([n, d]) => tone(sfxBus, { n, t: t + d, dur: 0.12, vol: 0.1, cutoff: 3000 }));
      ['C5', 'E5', 'G5', 'C6'].forEach(n => tone(sfxBus, { n, t: t + 0.32, dur: 0.9, type: 'triangle', vol: 0.12, attack: 0.02 }));
      noise(sfxBus, { t: t + 0.32, dur: 0.9, vol: 0.08, f: 6000 });
    },
    coin(t) {
      tone(sfxBus, { n: 'B5', t, dur: 0.08, vol: 0.1 });
      tone(sfxBus, { n: 'E6', t: t + 0.08, dur: 0.4, vol: 0.1 });
    },
    fanfare(t) {
      [['G4', 0, 0.14], ['C5', 0.15, 0.14], ['E5', 0.3, 0.14], ['G5', 0.45, 0.3], ['E5', 0.8, 0.14], ['G5', 0.95, 1.2]].forEach(([n, d, l]) => {
        tone(sfxBus, { n, t: t + d, dur: l + 0.1, type: 'sawtooth', vol: 0.12, cutoff: 2600, attack: 0.02 });
        tone(sfxBus, { n, t: t + d, dur: l + 0.1, vol: 0.06, cutoff: 3200, detune: 9, attack: 0.02 });
      });
      ['C4', 'E4', 'G4', 'C5'].forEach(n => tone(sfxBus, { n, t: t + 0.95, dur: 1.4, type: 'triangle', vol: 0.12, attack: 0.03 }));
      noise(sfxBus, { t: t + 0.95, dur: 1.6, vol: 0.18, f: 4500 });
      kick(sfxBus, t + 0.95, 0.9);
    },
    drumroll(t, dur = 4) {
      for (let x = 0; x < dur; x += Math.max(0.035, 0.085 - 0.05 * (x / dur))) {
        noise(sfxBus, { t: t + x, dur: 0.08, vol: 0.04 + 0.2 * (x / dur), type: 'bandpass', f: 1900, q: 0.9 });
      }
      noise(sfxBus, { t: t + dur, dur: 1.8, vol: 0.3, f: 4000 });
      kick(sfxBus, t + dur, 1);
    },
    cheer(t) {
      for (let i = 0; i < 90; i++) {
        noise(sfxBus, { t: t + Math.random() * 2, dur: 0.03 + Math.random() * 0.05, vol: 0.05 + Math.random() * 0.08, type: 'bandpass', f: 1200 + Math.random() * 2500, q: 1.5 });
      }
    },
  };

  // ── Music: tiny step sequencer with six themes ───────────────────────────
  // Each theme has a calm "lobby" tune (lobby + scoreboard) and a softer, tenser
  // "question" tune. The victory tune is shared.
  const CH = {
    C: ['C3', 'C4', 'E4', 'G4'], Am: ['A2', 'A3', 'C4', 'E4'], F: ['F2', 'F3', 'A3', 'C4'],
    G: ['G2', 'G3', 'B3', 'D4'], E: ['E2', 'E3', 'G#3', 'B3'], Dm: ['D3', 'D4', 'F4', 'A4'],
    Bb: ['Bb2', 'Bb3', 'D4', 'F4'], Fmaj7: ['F2', 'A3', 'C4', 'E4'], Em7: ['E2', 'G3', 'B3', 'D4'],
    Dm7: ['D2', 'F3', 'A3', 'C4'], Cmaj7: ['C2', 'E3', 'G3', 'B3'],
  };
  const mel = s => s.trim().split(/\s+/);
  const lead = (d, n, t, dur) => {
    tone(d, { n, t, dur: dur * 0.95, vol: 0.07, cutoff: 2600, attack: 0.01 });
    tone(d, { n, t, dur: dur * 0.95, type: 'triangle', vol: 0.12, attack: 0.01, detune: 6 });
  };
  // Instruments
  const marimba = (d, n, t, vol = 0.12) => {
    tone(d, { n, t, dur: 0.35, type: 'sine', vol, attack: 0.003 });
    tone(d, { n: midi(n) + 24, t, dur: 0.06, type: 'sine', vol: vol * 0.25, attack: 0.002 });
  };
  const bell = (d, n, t, vol = 0.08) => {
    tone(d, { n, t, dur: 1.4, type: 'sine', vol, attack: 0.003 });
    tone(d, { n: midi(n) + 12, t, dur: 0.7, type: 'sine', vol: vol * 0.3, attack: 0.003 });
    tone(d, { f: hz(n) * 2.76, t, dur: 0.25, type: 'sine', vol: vol * 0.12, attack: 0.002 });
  };
  const rhodes = (d, n, t, dur, vol = 0.07) => {
    tone(d, { n, t, dur, type: 'triangle', vol, attack: 0.01 });
    tone(d, { n: midi(n) + 12, t, dur: dur * 0.6, type: 'sine', vol: vol * 0.35, attack: 0.01 });
  };
  const pad = (d, notes, t, dur, vol = 0.03) => notes.forEach(n => {
    tone(d, { n, t, dur, type: 'sawtooth', vol, attack: 0.4, cutoff: 900, detune: -8 });
    tone(d, { n, t, dur, type: 'sawtooth', vol, attack: 0.4, cutoff: 900, detune: 8 });
  });
  const synthLead = (d, n, t, dur) => {
    tone(d, { n, t, dur: dur * 0.95, type: 'triangle', vol: 0.09, attack: 0.03 });
    tone(d, { n, t, dur: dur * 0.95, type: 'sine', vol: 0.05, attack: 0.03, detune: 10 });
  };
  const chip = (d, n, t, dur, vol = 0.045) => tone(d, { n, t, dur: dur * 0.9, vol, attack: 0.002 });
  const shaker = (d, t, vol = 0.025) => noise(d, { t, dur: 0.05, vol, type: 'bandpass', f: 7000, q: 1.2 });
  const tick = (d, t, vol = 0.04) => tone(d, { f: 1900, t, dur: 0.03, type: 'sine', vol });

  // '-' is a rest, '_' holds the previous note.
  function melody(tokens, i, t, s, d, voice = lead) {
    const n = tokens[i % tokens.length];
    if (n === '-' || n === '_') return;
    let len = 1;
    while (tokens[(i + len) % tokens.length] === '_') len++;
    voice(d, n, t, len * s);
  }
  const bounceBass = (d, root, i, t, s) =>
    tone(d, { n: midi(root) + (i % 2 ? 12 : 0), t, dur: s * 0.8, type: 'triangle', vol: 0.4 });
  const arpNote = (tones, i, oct) => midi(tones[[0, 1, 2, 1][i % 4]]) + oct;

  const VICTORY = {
    bpm: 124, div: 2, bars: ['C', 'F', 'G', 'C', 'Am', 'F', 'G', 'C'],
    melody: mel(`C5 _ E5 G5 C6 _ _ G5   A5 _ F5 A5 C6 _ A5 _   B5 _ G5 B5 D6 _ B5 _   C6 _ _ _ G5 _ E5 _
                 A5 _ E5 A5 C6 _ B5 A5   F5 _ A5 C6 F6 _ E6 D6   D6 _ B5 _ G5 _ B5 D6   C6 _ _ _ - - - -`),
    play(d, chord, i, g, t, s) {
      const [root, ...tones] = CH[chord];
      bounceBass(d, root, i, t, s);
      if (i % 2) tones.forEach(n => tone(d, { n: midi(n) + 12, t, dur: 0.12, vol: 0.03, cutoff: 2000 }));
      melody(this.melody, g, t, s, d);
      if (i % 2 === 0) kick(d, t, 0.45);
      if (i === 2 || i === 6) snare(d, t, 0.1);
      hat(d, t, 0.03);
      if (g % 32 === 0) noise(d, { t, dur: 1, vol: 0.1, f: 4500 });
    },
  };

  const THEMES = {
    // 🎈 Bouncy: the original happy pop tune
    bouncy: {
      lobby: {
        bpm: 116, div: 2, bars: ['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'G'],
        melody: mel(`E5 G5 C6 G5 E5 - D5 E5   C5 E5 A5 G5 E5 - C5 D5   F5 A5 C6 A5 G5 F5 E5 D5   D5 _ G5 _ B4 _ - -
                     G5 _ E5 G5 C6 _ B5 C6   A5 _ E5 A5 C6 _ B5 A5   F5 _ A5 C6 D6 C6 A5 F5   G5 F5 E5 D5 B4 _ - -`),
        play(d, chord, i, g, t, s) {
          const [root, ...tones] = CH[chord];
          bounceBass(d, root, i, t, s);
          if (i === 2 || i === 6) tones.forEach(n => tone(d, { n: midi(n) + 12, t, dur: 0.14, vol: 0.035, cutoff: 1800 }));
          melody(this.melody, g, t, s, d);
          if (i === 0 || i === 4) kick(d, t, 0.45);
          if (i === 2 || i === 6) snare(d, t, 0.07);
          if (i % 2) hat(d, t, 0.03);
        },
      },
      question: {
        bpm: 128, div: 4, bars: ['Am', 'Am', 'F', 'F', 'C', 'C', 'E', 'E'],
        play(d, chord, i, g, t, s) {
          const [root, ...tones] = CH[chord];
          if (i % 2 === 0) tone(d, { n: root, t, dur: s * 1.6, type: 'sawtooth', vol: 0.16, cutoff: 600 });
          tone(d, { n: arpNote(tones, i, (i >> 2) % 2 ? 24 : 12), t, dur: s * 0.9, vol: 0.045, cutoff: 2600 });
          if (i % 4 === 0) kick(d, t, 0.5);
          if (i === 4 || i === 12) snare(d, t, 0.07);
          if (i % 2) hat(d, t, 0.03);
        },
      },
    },

    // 🌴 Tropical: marimba and shakers on a sunny beach
    tropical: {
      lobby: {
        bpm: 104, div: 2, bars: ['F', 'Bb', 'C', 'F', 'F', 'Bb', 'C', 'F'],
        melody: mel(`A5 _ C6 A5 G5 F5 G5 _   F5 _ D5 F5 G5 _ - -   E5 _ G5 E5 D5 C5 D5 _   F5 _ - - A4 C5 F5 _
                     A5 G5 A5 C6 _ A5 G5 F5   D5 _ F5 _ G5 F5 D5 _   C5 E5 G5 _ E5 D5 C5 _   F5 _ _ _ - - - -`),
        play(d, chord, i, g, t, s) {
          const [root, ...tones] = CH[chord];
          if (i === 0 || i === 3 || i === 6) tone(d, { n: midi(root) + (i === 6 ? 12 : 0), t, dur: s * 1.2, type: 'sine', vol: 0.3 });
          if (i === 2 || i === 6) tones.forEach(n => marimba(d, midi(n) + 12, t, 0.035));
          melody(this.melody, g, t, s, d, (dd, n, tt) => marimba(dd, n, tt, 0.13));
          if (i === 0 || i === 4) kick(d, t, 0.3);
          shaker(d, t, i % 2 ? 0.03 : 0.015);
        },
      },
      question: {
        bpm: 118, div: 4, bars: ['Dm', 'Dm', 'Bb', 'Bb', 'F', 'F', 'C', 'C'],
        play(d, chord, i, g, t, s) {
          const [root, ...tones] = CH[chord];
          if (i % 4 === 0) tone(d, { n: midi(root) - 12, t, dur: s * 3, type: 'sine', vol: 0.28 });
          marimba(d, arpNote(tones, i, 12), t, 0.06);
          if (i % 8 === 0) kick(d, t, 0.3);
          shaker(d, t, i % 2 ? 0.025 : 0.012);
        },
      },
    },

    // 🚀 Space: dreamy synth pads and arpeggios
    space: {
      gain: 1.4, // evens out loudness between themes
      lobby: {
        bpm: 96, div: 2, bars: ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'],
        melody: mel(`E5 _ _ _ A5 _ G5 _   F5 _ _ _ E5 _ C5 _   E5 _ _ _ G5 _ C6 _   B5 _ _ _ _ _ - -
                     A5 _ _ _ C6 _ B5 _   A5 _ _ _ G5 _ F5 _   E5 _ G5 _ C6 _ B5 _   G5 _ _ _ - - - -`),
        play(d, chord, i, g, t, s) {
          const [root, ...tones] = CH[chord];
          if (i === 0) pad(d, tones, t, s * 8, 0.022);
          tone(d, { n: root, t, dur: s * 0.8, type: 'sawtooth', vol: 0.1, cutoff: 380 });
          tone(d, { n: arpNote(tones, i, 12), t, dur: s * 0.7, vol: 0.025, cutoff: 1800 });
          melody(this.melody, g, t, s, d, synthLead);
          if (i === 0 || i === 4) kick(d, t, 0.35);
          if (i === 2 || i === 6) snare(d, t, 0.05);
          if (i % 2) hat(d, t, 0.02);
        },
      },
      question: {
        bpm: 116, div: 4, bars: ['Am', 'Am', 'F', 'F', 'G', 'G', 'E', 'E'],
        play(d, chord, i, g, t, s) {
          const [root, ...tones] = CH[chord];
          if (i === 0 && g % 32 === 0) pad(d, tones, t, s * 32, 0.018);
          if (i % 2 === 0) tone(d, { n: root, t, dur: s * 1.5, type: 'sawtooth', vol: 0.1, cutoff: 350 });
          tone(d, { n: arpNote(tones, i, (i >> 3) % 2 ? 24 : 12), t, dur: s * 0.8, type: 'sawtooth', vol: 0.022, cutoff: 1500 });
          if (i % 4 === 0) kick(d, t, 0.35);
          if (i % 2) hat(d, t, 0.018);
        },
      },
    },

    // 🎧 Chill: laid-back lo-fi electric piano with a lazy swing
    lofi: {
      lobby: {
        bpm: 78, div: 2, swing: 0.16, bars: ['Fmaj7', 'Em7', 'Dm7', 'Cmaj7', 'Fmaj7', 'Em7', 'Dm7', 'Cmaj7'],
        melody: mel(`C5 _ _ A4 _ _ G4 _   B4 _ _ _ - - D5 _   C5 _ A4 _ F4 _ _ _   E4 _ _ _ - - - -
                     A4 _ C5 _ E5 _ D5 _   B4 _ G4 _ _ _ - -   A4 _ _ C5 _ _ D5 _   E5 _ _ _ - - - -`),
        play(d, chord, i, g, t, s) {
          const [root, ...tones] = CH[chord];
          if (i === 0) tones.forEach(n => rhodes(d, n, t, s * 6, 0.045));
          if (i === 5) tones.forEach(n => rhodes(d, n, t, s * 2.5, 0.025));
          if (i === 0 || i === 3 || i === 6) tone(d, { n: root, t, dur: s * 2, type: 'sine', vol: 0.3 });
          melody(this.melody, g, t, s, d, (dd, n, tt, dur) => rhodes(dd, midi(n) + 12, tt, dur, 0.05));
          if (i === 0 || i === 5) kick(d, t, 0.3);
          if (i === 2 || i === 6) noise(d, { t, dur: 0.18, vol: 0.035, type: 'bandpass', f: 2500, q: 0.7 });
          hat(d, t, 0.012);
        },
      },
      question: {
        bpm: 90, div: 4, swing: 0.12, bars: ['Dm7', 'Dm7', 'Em7', 'Em7', 'Fmaj7', 'Fmaj7', 'Em7', 'Em7'],
        play(d, chord, i, g, t, s) {
          const [root, ...tones] = CH[chord];
          if (i === 0) tone(d, { n: root, t, dur: s * 12, type: 'sine', vol: 0.25 });
          if (i % 2 === 0) rhodes(d, arpNote(tones, i / 2, 12), t, s * 1.6, 0.03);
          if (i === 0 || i === 10) kick(d, t, 0.28);
          if (i === 4 || i === 12) noise(d, { t, dur: 0.15, vol: 0.03, type: 'bandpass', f: 2500, q: 0.7 });
          if (i % 2) hat(d, t, 0.012);
        },
      },
    },

    // 🕹️ Arcade: retro 8-bit video game chiptune
    arcade: {
      gain: 1.3, // evens out loudness between themes
      lobby: {
        bpm: 132, div: 2, bars: ['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'G'],
        melody: mel(`G5 _ E5 G5 C6 _ G5 _   A5 _ E5 A5 C6 _ A5 _   F5 G5 A5 _ C6 A5 F5 _   G5 _ B5 _ D6 _ - -
                     E6 _ D6 C6 G5 _ E5 _   A5 _ C6 B5 A5 _ E5 _   F5 _ A5 C6 D6 C6 A5 F5   G5 _ B5 D6 C6 _ - -`),
        play(d, chord, i, g, t, s) {
          const [root, ...tones] = CH[chord];
          tone(d, { n: midi(root) + (i % 2 ? 12 : 0), t, dur: s * 0.7, type: 'triangle', vol: 0.3 });
          if (i % 2) chip(d, arpNote(tones, i >> 1, 12), t, s * 0.5, 0.02);
          melody(this.melody, g, t, s, d, (dd, n, tt, dur) => chip(dd, n, tt, dur, 0.04));
          if (i === 0 || i === 4) noise(d, { t, dur: 0.06, vol: 0.12, type: 'lowpass', f: 400 });
          if (i === 2 || i === 6) noise(d, { t, dur: 0.07, vol: 0.06, type: 'bandpass', f: 2500 });
          if (i % 2) noise(d, { t, dur: 0.02, vol: 0.02, f: 9000 });
        },
      },
      question: {
        bpm: 144, div: 4, bars: ['Am', 'Am', 'F', 'F', 'G', 'G', 'E', 'E'],
        play(d, chord, i, g, t, s) {
          const [root, ...tones] = CH[chord];
          if (i % 2 === 0) tone(d, { n: midi(root) + ((i >> 1) % 2 ? 12 : 0), t, dur: s * 1.4, type: 'triangle', vol: 0.28 });
          chip(d, arpNote(tones, i, (i >> 2) % 2 ? 24 : 12), t, s, 0.022);
          if (i % 4 === 0) noise(d, { t, dur: 0.05, vol: 0.1, type: 'lowpass', f: 400 });
          if (i % 2) noise(d, { t, dur: 0.02, vol: 0.015, f: 9000 });
        },
      },
    },

    // 🎠 Music box: gentle fairy-tale bells, no drums
    musicbox: {
      gain: 1.35, // evens out loudness between themes
      lobby: {
        bpm: 88, div: 2, bars: ['C', 'G', 'Am', 'F', 'C', 'G', 'F', 'C'],
        melody: mel(`E5 _ G5 _ C6 _ B5 _   D6 _ B5 _ G5 _ - -   C6 _ A5 _ E5 _ A5 _   F5 _ A5 _ C6 _ - -
                     G5 _ E5 _ C5 _ E5 _   D5 _ G5 _ B5 _ D6 _   C6 _ A5 _ F5 _ A5 _   C6 _ _ _ - - - -`),
        play(d, chord, i, g, t, s) {
          const [root, ...tones] = CH[chord];
          if (i === 0) tone(d, { n: root, t, dur: s * 7, type: 'sine', vol: 0.18, attack: 0.05 });
          bell(d, arpNote(tones, i, 0), t, 0.035);
          melody(this.melody, g, t, s, d, (dd, n, tt) => bell(dd, midi(n) + 12, tt, 0.07));
        },
      },
      question: {
        bpm: 100, div: 4, bars: ['Am', 'Am', 'E', 'E', 'F', 'F', 'E', 'E'],
        play(d, chord, i, g, t, s) {
          const [root, ...tones] = CH[chord];
          if (i % 8 === 0) tone(d, { n: root, t, dur: s * 7, type: 'sine', vol: 0.2, attack: 0.03 });
          if (i % 2 === 0) bell(d, arpNote(tones, i / 2, 12), t, 0.035);
          if (i % 4 === 0) tick(d, t, 0.035);
        },
      },
    },
  };
  const THEME_IDS = Object.keys(THEMES);
  let theme = (() => { try { const v = localStorage.getItem('blof.theme'); return THEMES[v] ? v : 'bouncy'; } catch { return 'bouncy'; } })();
  const trackFor = name => (name === 'victory' ? VICTORY : THEMES[theme][name]);

  function startMusic(name) {
    stopCurrent(0.05);
    const tr = trackFor(name);
    if (!tr) return;
    const bus = ctx.createGain();
    bus.gain.value = name === 'victory' ? 1 : THEMES[theme].gain || 1;
    bus.connect(musicBus);
    const perBar = tr.div * 4, total = perBar * tr.bars.length, s = 60 / tr.bpm / tr.div;
    const cur = { name, theme, bus, step: 0, next: ctx.currentTime + 0.08 };
    cur.timer = setInterval(() => {
      if (cur.next < ctx.currentTime - 0.05) cur.next = ctx.currentTime + 0.05; // tab was asleep
      while (cur.next < ctx.currentTime + 0.2) {
        const g = cur.step % total;
        const swing = tr.swing && g % 2 ? tr.swing * s : 0;
        tr.play(bus, tr.bars[Math.floor(g / perBar)], g % perBar, g, cur.next + swing, s);
        cur.step++;
        cur.next += s;
      }
    }, 40);
    current = cur;
  }

  function stopCurrent(fade = 0.4) {
    if (!current) return;
    const { bus, timer } = current;
    clearInterval(timer);
    current = null;
    const now = ctx.currentTime;
    bus.gain.setValueAtTime(bus.gain.value, now);
    bus.gain.linearRampToValueAtTime(0, now + fade);
    setTimeout(() => bus.disconnect(), fade * 1000 + 500);
  }

  return {
    init,
    ready,
    onReady(fn) { ready() ? fn() : readyListeners.push(fn); },
    sfx(name, ...args) {
      if (ready() && soundOn && SFX[name]) SFX[name](ctx.currentTime + 0.01, ...args);
    },
    music(name) {
      wanted = name;
      if (ready() && musicOn && (current?.name !== name || current?.theme !== theme)) startMusic(name);
    },
    themes: THEME_IDS,
    get theme() { return theme; },
    /* Switch the background music style; the tune that's playing restarts in the new style. */
    setTheme(id) {
      if (!THEMES[id]) return;
      theme = id;
      try { localStorage.setItem('blof.theme', id); } catch { }
      if (current && current.name !== 'victory' && ready() && musicOn) startMusic(current.name);
    },
    stopMusic(fade) {
      wanted = null;
      if (ctx) stopCurrent(fade);
    },
    get soundOn() { return soundOn; },
    get musicOn() { return musicOn; },
    toggleSound() {
      soundOn = !soundOn;
      pref.set('sound', soundOn);
      if (master) master.gain.setTargetAtTime(soundOn ? 1 : 0, ctx.currentTime, 0.05);
      return soundOn;
    },
    toggleMusic() {
      musicOn = !musicOn;
      pref.set('music', musicOn);
      if (ctx) {
        musicBus.gain.setTargetAtTime(musicOn ? 0.3 : 0, ctx.currentTime, 0.05);
        if (!musicOn) stopCurrent(0.2);
        else if (wanted && ready()) startMusic(wanted);
      }
      return musicOn;
    },
  };
})();
