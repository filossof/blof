// Shared helpers for host + player
const PEER_PREFIX = 'bluff-he-v1-';
const PEER_OPTS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ],
  },
};

const AVATARS = ['🦊', '🐼', '🐸', '🦄', '🐙', '🐯', '🐵', '🦁', '🐧', '🐨', '🐷', '🐲', '🦖', '🐝', '🦉', '🐬'];
const COLORS = ['#ff5d8f', '#ffb703', '#3ddc97', '#4cc9f0', '#b388ff', '#ff8c42', '#f15bb5', '#00f5d4'];
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const MAX_LIE = 40;

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shuffle(a) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Strip niqqud, punctuation, case and extra spaces
function normalize(s) {
  return String(s || '')
    .replace(/[֑-ׇ]/g, '')
    .toLowerCase()
    .replace(/[״"׳'`.,!?\-־_:;()[\]{}\/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Looser key: also drops the Hebrew definite article so "הירח" == "ירח"
function normCore(s) {
  return normalize(s)
    .split(' ')
    .map((w) => (w.length > 2 && w[0] === 'ה' ? w.slice(1) : w))
    .join(' ')
    .replace(/ /g, '');
}

function isTruth(text, q) {
  const k = normCore(text);
  return [q.a, ...(q.alt || [])].some((t) => normCore(t) === k);
}

const BAD_WORDS = ['זין', 'זונה', 'שרמוטה', 'מזדיין', 'להזדיין', 'זיון', 'מניאק', 'חרא', 'כוסית', 'כוסעמק', 'כוסאמק', 'פאק', 'שיט', 'fuck', 'shit', 'bitch', 'dick', 'ass', 'sex', 'סקס', 'בולבול', 'פוסי'];
const PREFIXES = 'והשבלמכ';
function isBad(s) {
  return normalize(s)
    .split(' ')
    .some((w) => {
      for (let i = 0; i <= 2 && i < w.length; i++) {
        if (i > 0 && !PREFIXES.includes(w[i - 1])) break;
        if (BAD_WORDS.includes(w.slice(i))) return true;
      }
      return false;
    });
}

function qHTML(text, fill) {
  const parts = esc(text).split('_____');
  const mid = fill ? `<span class="blank filled">${esc(fill)}</span>` : '<span class="blank"></span>';
  return parts.join(mid);
}

// Tiny WebAudio synth – no audio files needed
const SFX = (() => {
  let ctx;
  let muted = false;
  function ac() {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, dur, type = 'sine', vol = 0.15, when = 0, slide = 0) {
    const c = ac();
    const o = c.createOscillator();
    const g = c.createGain();
    const t = c.currentTime + when;
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  const fx = {
    pop: () => tone(520, 0.12, 'sine', 0.2, 0, 1.9),
    tick: () => tone(1100, 0.05, 'square', 0.04),
    ding: () => { tone(880, 0.35, 'sine', 0.2); tone(1320, 0.5, 'sine', 0.16, 0.09); tone(1760, 0.6, 'sine', 0.1, 0.18); },
    buzz: () => { tone(160, 0.45, 'sawtooth', 0.1, 0, 0.6); },
    whoosh: () => tone(220, 0.35, 'triangle', 0.1, 0, 3.5),
    join: () => { tone(523, 0.1, 'sine', 0.18); tone(784, 0.18, 'sine', 0.18, 0.08); },
    submit: () => { tone(660, 0.08, 'triangle', 0.15); tone(990, 0.12, 'triangle', 0.12, 0.06); },
    fanfare: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0.4, 'triangle', 0.16, i * 0.13)),
    drum: () => { for (let i = 0; i < 10; i++) tone(90 + Math.random() * 30, 0.08, 'triangle', 0.12, i * 0.07); },
  };
  return {
    play(n) { if (!muted) try { fx[n]?.(); } catch (e) {} },
    unlock() { try { ac(); } catch (e) {} },
    get muted() { return muted; },
    set muted(v) { muted = v; },
  };
})();

// Keep screens awake where supported
async function keepAwake() {
  try {
    if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

function toast(msg, ms = 2600) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms);
}

function lsGet(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
