// Host = the big screen. It is also the game server: phones connect to it over WebRTC.
(() => {
  const stage = $('#stage');
  const bar = $('#playerbar');
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const LENGTHS = { short: [2, 2], normal: [3, 3], long: [4, 4] };
  const T = { pick: 15, lie: 75, lieKids: 100, choose: 30, chooseKids: 45, scores: 9 };
  const RING = 276.46; // 2πr for r=44
  const THEME_LABELS = { bouncy: '🎈 קופצני', tropical: '🌴 טרופי', space: '🚀 חלל', lofi: '🎧 לו-פיי', arcade: '🕹️ ארקייד', musicbox: '🎶 תיבת נגינה' };
  const TRUTH_BONUS = 500; // for typing the real answer as your lie (x round multiplier)

  const S = {
    code: null, peer: null,
    kids: lsGet('bluff.kids') === '1',
    length: lsGet('bluff.len') || 'normal',
    tts: lsGet('bluff.tts') !== '0',
    phase: 'boot', players: new Map(), used: new Set(),
    plan: [], roundIdx: 0, qInRound: 0,
    cur: null, chooser: null, picks: [], pickedIdx: null,
    timer: null, deadline: 0, total: 0, onTimeout: null, silent: false, lastSec: null,
    flow: 0, // bumped on every phase change; async sequences bail out when it changes
  };

  document.body.classList.toggle('kids', S.kids);

  // ---------- Room / networking ----------
  function openRoom() {
    const code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    const peer = new Peer(PEER_PREFIX + code, PEER_OPTS);
    peer.on('open', () => {
      S.code = code;
      S.peer = peer;
      $('#roomChip').hidden = false;
      $('#roomChip span').textContent = code;
      showLobby();
    });
    peer.on('connection', onConnection);
    peer.on('disconnected', () => setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500));
    peer.on('error', (e) => {
      console.warn('peer error', e.type, e);
      if (e.type === 'unavailable-id') { peer.destroy(); openRoom(); return; }
      if (!S.code) showError('לא הצלחנו לפתוח חדר. בדקו את החיבור לאינטרנט.');
    });
  }

  function onConnection(conn) {
    conn.on('data', (m) => handle(conn, m));
    conn.on('close', () => dropConn(conn));
    conn.on('error', () => dropConn(conn));
  }

  function dropConn(conn) {
    const p = conn.pid && S.players.get(conn.pid);
    if (!p || p.conn !== conn) return;
    p.online = false;
    p.conn = null;
    refreshPlayers();
    checkAllDone();
  }

  function handle(conn, m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'join') return onJoin(conn, m);
    const p = conn.pid && S.players.get(conn.pid);
    if (!p || p.conn !== conn) return;
    switch (m.t) {
      case 'start': if (isVip(p)) startGame(); break;
      case 'again': if (isVip(p) && S.phase === 'gameover') startGame(); break;
      case 'pick': onPick(p, m.i, false); break;
      case 'lie': onLie(p, m.text); break;
      case 'lieForMe': onLieForMe(p); break;
      case 'choose': onChoose(p, m.id); break;
    }
  }

  function onJoin(conn, m) {
    const pid = String(m.pid || '').slice(0, 40);
    if (!pid) return;
    const name = String(m.name || '').replace(/\s+/g, ' ').trim().slice(0, 14) || 'שחקן';
    const gender = m.g === 'f' ? 'f' : 'm';
    let p = S.players.get(pid);
    if (p) {
      p.gender = gender;
      const seq = Number(m.seq) || 0;
      if (p.conn && p.conn !== conn) {
        // A late join from an older connection attempt must not kick out the newer one
        if (seq && p.seq && seq < p.seq) { try { conn.close(); } catch (e) {} return; }
        try { p.conn.close(); } catch (e) {}
      }
      p.seq = seq;
      p.conn = conn;
      p.online = true;
      if (S.phase === 'lobby') {
        p.name = uniqueName(name, p);
        if (AVATARS.includes(m.avatar) && !takenAvatars(p).has(m.avatar)) p.avatar = m.avatar;
      }
    } else {
      if (S.phase !== 'lobby') return reject(conn, `המשחק כבר התחיל 🙈 ${gw(m.g, 'חכה', 'חכי')} למשחק הבא`);
      if (S.players.size >= MAX_PLAYERS) return reject(conn, `החדר מלא – מקסימום ${MAX_PLAYERS} שחקנים`);
      const taken = takenAvatars();
      const usedColors = new Set([...S.players.values()].map((x) => x.color));
      p = {
        id: pid,
        name: uniqueName(name),
        avatar: AVATARS.includes(m.avatar) && !taken.has(m.avatar) ? m.avatar : AVATARS.find((a) => !taken.has(a)),
        color: COLORS.find((c) => !usedColors.has(c)) || COLORS[0],
        score: 0, conn, online: true, suggest: null, gender, seq: Number(m.seq) || 0,
      };
      S.players.set(pid, p);
      SFX.play('join');
    }
    conn.pid = pid;
    refreshPlayers();
    sendView(p);
  }

  function uniqueName(name, self) {
    let n = name, i = 2;
    while ([...S.players.values()].some((x) => x !== self && x.name === n)) n = `${name} ${i++}`;
    return n;
  }
  function takenAvatars(self) { return new Set([...S.players.values()].filter((x) => x !== self).map((x) => x.avatar)); }

  function reject(conn, msg) {
    try { conn.send({ t: 'rejected', msg }); } catch (e) {}
    setTimeout(() => conn.close(), 600);
  }

  const onlinePlayers = () => [...S.players.values()].filter((p) => p.online);
  const isVip = (p) => onlinePlayers()[0] === p;
  const ranked = () => [...S.players.values()].sort((a, b) => b.score - a.score);

  function sendView(p) {
    if (p.conn && p.conn.open) try { p.conn.send(viewFor(p)); } catch (e) {}
  }
  function broadcast() { for (const p of S.players.values()) sendView(p); }

  function viewFor(p) {
    const v = {
      t: 'view', phase: S.phase, kids: S.kids, vip: isVip(p),
      me: { name: p.name, avatar: p.avatar, color: p.color, score: p.score, g: p.gender },
      remain: remainMs(), total: S.timer ? S.total : 0,
    };
    const cur = S.cur;
    switch (S.phase) {
      case 'lobby':
        v.count = onlinePlayers().length;
        v.canStart = v.count >= MIN_PLAYERS;
        break;
      case 'roundIntro': {
        const r = S.plan[S.roundIdx];
        v.round = r.name; v.sub = r.sub || '';
        break;
      }
      case 'pick': {
        const c = S.players.get(S.chooser);
        v.isChooser = S.chooser === p.id;
        v.chooser = c ? { name: c.name, avatar: c.avatar, color: c.color } : null;
        v.picked = S.pickedIdx;
        if (v.isChooser) v.cats = S.picks.map((q) => q.c);
        break;
      }
      case 'lie':
        v.q = cur.q.q; v.cat = cur.q.c;
        v.submitted = cur.lies.get(p.id)?.text ?? null;
        v.suggest = p.suggest;
        break;
      case 'choose':
        v.q = cur.q.q;
        v.options = cur.options.filter((o) => !o.authors.includes(p.id)).map((o) => ({ id: o.id, text: o.text }));
        v.chosen = cur.choices.has(p.id) ? cur.choices.get(p.id) : null;
        v.mine = cur.lies.get(p.id)?.text ?? null;
        break;
      case 'scores': {
        const mine = cur.options.find((o) => o.authors.includes(p.id));
        const choice = cur.choices.has(p.id) ? cur.options[cur.choices.get(p.id)] : null;
        v.delta = cur.delta[p.id] || 0;
        v.bonus = cur.bonus[p.id] || 0;
        v.truth = cur.q.a;
        v.gotTruth = !!choice?.truth;
        v.fellFor = choice && !choice.truth ? choice.text : null;
        v.fooled = mine ? [...cur.choices.values()].filter((id) => id === mine.id).length : 0;
        v.rank = ranked().indexOf(p) + 1;
        break;
      }
      case 'gameover':
        v.rank = ranked().indexOf(p) + 1;
        v.count = S.players.size;
        break;
    }
    return v;
  }

  // ---------- Timer ----------
  function timerHTML() {
    return `<div class="timer"><svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="44"/><circle class="prog" cx="50" cy="50" r="44" stroke-dasharray="${RING}" stroke-dashoffset="0"/></svg><span></span></div>`;
  }
  function timerStart(sec, fn, silent = false) {
    clearTimer();
    S.total = sec * 1000;
    S.deadline = Date.now() + S.total;
    S.onTimeout = fn;
    S.silent = silent;
    S.lastSec = null;
    S.timer = setInterval(tick, 200);
    tick();
  }
  function tick() {
    const left = Math.max(0, S.deadline - Date.now());
    const sec = Math.ceil(left / 1000);
    for (const t of $$('.timer')) {
      t.querySelector('span').textContent = sec;
      t.querySelector('.prog').style.strokeDashoffset = RING * (1 - left / S.total);
      t.classList.toggle('low', sec <= 5);
    }
    if (sec !== S.lastSec) {
      S.lastSec = sec;
      if (!S.silent && sec <= 5 && sec > 0) SFX.play('tick');
    }
    if (left <= 0) {
      const f = S.onTimeout;
      clearTimer();
      f && f();
    }
  }
  function clearTimer() { clearInterval(S.timer); S.timer = null; S.onTimeout = null; }
  const remainMs = () => (S.timer ? Math.max(0, S.deadline - Date.now()) : 0);
  function setSkip(on) { $('#skipBtn').hidden = !on; }

  // ---------- Speech ----------
  let heVoice = null;
  function loadVoices() { heVoice = speechSynthesis.getVoices().find((v) => /^(he|iw)/i.test(v.lang)) || null; }
  if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
  function speak(text) {
    if (!S.tts || !heVoice || SFX.muted) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.voice = heVoice; u.lang = heVoice.lang; u.rate = 1.02;
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  // ---------- Screens ----------
  function showError(msg) {
    stage.innerHTML = `<div class="scene title-card"><div class="big-emoji">😵</div><p class="q-sub">${esc(msg)}</p><button class="btn" onclick="location.reload()">נסו שוב</button></div>`;
  }

  function joinUrl() { return new URL(`play.html?room=${S.code}`, location.href).href; }
  function qrSvg(url) {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }

  function showLobby() {
    S.flow++;
    clearTimer();
    setSkip(false);
    S.phase = 'lobby';
    S.cur = null;
    const url = joinUrl();
    stage.innerHTML = `
      <div class="scene lobby">
        <div class="join-card glass">
          <h3>סרקו כדי להצטרף 📱</h3>
          <div class="qr">${qrSvg(url)}</div>
          <div class="url">${esc(url.replace(/^https?:\/\//, ''))}</div>
          <h3>קוד החדר</h3>
          <div class="room-code">${S.code}</div>
        </div>
        <div class="lobby-main">
          <h2>מי משחק? <span class="count" id="pcount"></span></h2>
          <div class="lobby-players" id="lobbyPlayers"></div>
          <div class="settings glass">
            <label class="toggle"><input type="checkbox" id="kidsT" ${S.kids ? 'checked' : ''}><span class="sw"></span>מצב ילדים 🧒</label>
            <div class="toggle music-pick">מוזיקה:
              <div class="seg" id="themeSeg">${Sound.themes.map((id) => `<button data-t="${id}" class="${Sound.musicOn && Sound.theme === id ? 'on' : ''}">${THEME_LABELS[id] || id}</button>`).join('')}<button data-t="off" class="${Sound.musicOn ? '' : 'on'}">🔇 בלי</button></div>
            </div>
            <div class="toggle">אורך המשחק:
              <div class="seg" id="lenSeg">${Object.entries({ short: 'קצר', normal: 'רגיל', long: 'ארוך' })
                .map(([k, l]) => `<button data-k="${k}" class="${S.length === k ? 'on' : ''}">${l}</button>`).join('')}</div>
            </div>
          </div>
          <div class="start-row">
            <button class="btn big" id="startBtn">יאללה, מתחילים! 🚀</button>
            <span class="hint" id="startHint"></span>
          </div>
        </div>
      </div>`;
    $('#kidsT').onchange = (e) => {
      S.kids = e.target.checked;
      lsSet('bluff.kids', S.kids ? '1' : '0');
      document.body.classList.toggle('kids', S.kids);
      SFX.play('pop');
      broadcast();
    };
    $$('#lenSeg button').forEach((b) => (b.onclick = () => {
      S.length = b.dataset.k;
      lsSet('bluff.len', S.length);
      $$('#lenSeg button').forEach((x) => x.classList.toggle('on', x === b));
      SFX.play('pop');
    }));
    $$('#themeSeg button').forEach((b) => (b.onclick = () => {
      Sound.init();
      const t = b.dataset.t;
      if (t === 'off') { if (Sound.musicOn) Sound.toggleMusic(); }
      else { Sound.setTheme(t); if (!Sound.musicOn) Sound.toggleMusic(); Sound.music('lobby'); }
      syncMusicUI();
    }));
    $('#startBtn').onclick = startGame;
    // Browsers keep audio locked until the first click on the page. The hint floats (position: fixed) so
    // hiding it never shifts the layout under the cursor mid-click.
    if (!Sound.ready() && !$('#soundHint')) {
      const hint = document.createElement('button');
      hint.id = 'soundHint';
      hint.className = 'btn ghost sound-hint';
      hint.textContent = '🔊 לחצו להפעלת מוזיקה וצלילים';
      hint.onclick = () => { Sound.init(); SFX.unlock(); };
      document.body.appendChild(hint);
      Sound.onReady(() => hint.remove());
    }
    $('#lobbyPlayers').onclick = (e) => {
      const el = e.target.closest('.pslot.filled');
      if (!el) return;
      const p = S.players.get(el.dataset.id);
      if (p && confirm(`להוציא את ${p.name} מהמשחק?`)) {
        if (p.conn) reject(p.conn, gw(p.gender, 'הוצאת מהחדר', 'הוצאת מהחדר'));
        S.players.delete(p.id);
        refreshPlayers();
      }
    };
    bar.innerHTML = '';
    renderLobbyPlayers();
    broadcast();
    Sound.music('lobby');
  }

  function renderLobbyPlayers() {
    const box = $('#lobbyPlayers');
    if (!box) return;
    $$('.pslot.empty', box).forEach((e) => e.remove());
    const existing = new Map($$('.pslot.filled', box).map((el) => [el.dataset.id, el]));
    for (const [id, el] of existing) if (!S.players.has(id)) el.remove();
    for (const p of S.players.values()) {
      let el = existing.get(p.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'pslot filled';
        el.dataset.id = p.id;
        box.appendChild(el);
      }
      el.classList.toggle('offline', !p.online);
      el.title = 'לחצו כדי להוציא מהמשחק';
      el.innerHTML = `${isVip(p) ? '<span class="vip">VIP</span>' : ''}<span class="kick">✖</span><div class="avatar" style="--c:${p.color}">${p.avatar}</div><div class="name">${esc(p.name)}</div>`;
    }
    for (let i = S.players.size; i < MAX_PLAYERS; i++) box.insertAdjacentHTML('beforeend', '<div class="pslot empty">?</div>');
    const n = onlinePlayers().length;
    $('#pcount').textContent = `${S.players.size}/${MAX_PLAYERS}`;
    $('#startBtn').disabled = n < MIN_PLAYERS;
    $('#startHint').textContent = n < MIN_PLAYERS ? `צריך לפחות ${MIN_PLAYERS} שחקנים` : 'או שה-VIP יתחיל מהטלפון';
  }

  function refreshPlayers() {
    if (S.phase === 'lobby') { renderLobbyPlayers(); broadcast(); } else renderBar();
  }

  function renderBar() {
    if (['lobby', 'scores', 'gameover', 'boot'].includes(S.phase)) { bar.innerHTML = ''; return; }
    bar.classList.toggle('compact', S.players.size > 8);
    const ids = [...S.players.keys()].join('|');
    if (bar.dataset.ids !== ids) {
      bar.dataset.ids = ids;
      bar.innerHTML = [...S.players.values()].map((p) =>
        `<div class="pb" data-id="${p.id}"><div class="avatar" style="--c:${p.color}">${p.avatar}</div><div class="name">${esc(p.name)}</div><div class="score"></div></div>`).join('');
    }
    for (const el of $$('.pb', bar)) {
      const p = S.players.get(el.dataset.id);
      let st = '';
      if (S.phase === 'lie') st = S.cur.lies.has(p.id) ? 'done' : 'waiting';
      if (S.phase === 'choose') st = S.cur.choices.has(p.id) ? 'done' : 'waiting';
      el.classList.toggle('done', st === 'done');
      el.classList.toggle('waiting', st === 'waiting');
      el.classList.toggle('offline', !p.online);
      $('.score', el).textContent = p.score.toLocaleString();
    }
  }

  const chip = (p, pts = '') =>
    `<div class="chip"><div class="avatar sm" style="--c:${p.color}">${p.avatar}</div>${esc(p.name)}${pts ? ` <span class="pts">${pts}</span>` : ''}</div>`;

  // ---------- Game flow ----------
  function pool() {
    const ok = (q) => (!S.kids || q.kids) && !S.used.has(q);
    let p = QUESTIONS.filter(ok);
    if (p.length < 4) { S.used.clear(); p = QUESTIONS.filter(ok); }
    return p;
  }

  function startGame() {
    if (S.phase !== 'lobby' && S.phase !== 'gameover') return;
    if (onlinePlayers().length < MIN_PLAYERS) return toast(`צריך לפחות ${MIN_PLAYERS} שחקנים`);
    SFX.unlock();
    for (const p of [...S.players.values()]) if (!p.online) S.players.delete(p.id);
    for (const p of S.players.values()) p.score = 0;
    const [a, b] = LENGTHS[S.length] || LENGTHS.normal;
    S.plan = [
      { name: 'סיבוב 1', mult: 1, count: a },
      { name: 'סיבוב 2', mult: 2, count: b, sub: 'נקודות כפולות!' },
      { name: 'הבלוף האחרון', mult: 3, count: 1, final: true, sub: 'נקודות משולשות!' },
    ];
    S.roundIdx = 0;
    S.qInRound = 0;
    S.chooser = null;
    bar.dataset.ids = '';
    roundIntro();
  }

  async function roundIntro() {
    const tok = ++S.flow;
    const r = S.plan[S.roundIdx];
    S.phase = 'roundIntro';
    setSkip(false);
    stage.innerHTML = `
      <div class="scene title-card">
        <div class="kicker">${r.final ? '🔥 זה הרגע 🔥' : 'מוכנים?'}</div>
        <h1 class="zoom-in">${r.name}</h1>
        ${r.sub ? `<div class="mult pop-in" style="animation-delay:.6s">x${r.mult} ${r.sub}</div>` : ''}
      </div>`;
    renderBar();
    broadcast();
    Sound.music('lobby');
    SFX.play('fanfare');
    speak(r.name + (r.sub ? '. ' + r.sub : ''));
    await sleep(3800);
    if (tok !== S.flow) return;
    if (r.final) startQuestion(shuffle(pool())[0]);
    else pickPhase();
  }

  function pickPhase() {
    ++S.flow;
    const ps = onlinePlayers().length ? onlinePlayers() : [...S.players.values()];
    const min = Math.min(...ps.map((p) => p.score));
    const lowest = ps.filter((p) => p.score === min);
    const c = shuffle(lowest).find((p) => p.id !== S.chooser) || shuffle(ps).find((p) => p.id !== S.chooser) || ps[0];
    S.chooser = c.id;
    S.picks = [];
    const seen = new Set();
    for (const q of shuffle(pool())) {
      if (seen.has(q.c)) continue;
      seen.add(q.c);
      S.picks.push(q);
      if (S.picks.length === 4) break;
    }
    S.pickedIdx = null;
    S.phase = 'pick';
    setSkip(true);
    stage.innerHTML = `
      <div class="scene q-wrap">
        <div class="row-center">
          <div class="avatar lg bounce" style="--c:${c.color}">${c.avatar}</div>
          <div style="text-align:right">
            <div class="q-text" style="margin:0">הבחירה אצל ${esc(c.name)}!</div>
            <div class="q-sub">${esc(c.name)} ${gw(c.gender, 'בוחר', 'בוחרת')} נושא בטלפון</div>
          </div>
          ${timerHTML()}
        </div>
        <div class="pick-grid stagger">${S.picks.map((q) => `<div class="cat">${esc(q.c)}</div>`).join('')}</div>
      </div>`;
    renderBar();
    broadcast();
    SFX.play('whoosh');
    Sound.music('question');
    speak(`הבחירה אצל ${c.name}`);
    timerStart(T.pick, () => onPick(c, Math.floor(Math.random() * S.picks.length), true));
  }

  async function onPick(p, i, forced) {
    if (S.phase !== 'pick' || S.pickedIdx !== null) return;
    if (!forced && p.id !== S.chooser) return;
    i = Number(i);
    if (!(i >= 0 && i < S.picks.length)) return;
    S.pickedIdx = i;
    clearTimer();
    setSkip(false);
    const tok = ++S.flow;
    $$('.cat').forEach((el, j) => el.classList.add(j === i ? 'chosen' : 'dim'));
    SFX.play('ding');
    broadcast();
    await sleep(1500);
    if (tok !== S.flow) return;
    startQuestion(S.picks[i]);
  }

  function startQuestion(q) {
    ++S.flow;
    S.used.add(q);
    const r = S.plan[S.roundIdx];
    S.cur = { q, mult: r.mult, lies: new Map(), choices: new Map(), options: [], delta: {}, prev: {}, bonus: {} };
    for (const p of S.players.values()) p.suggest = null;
    S.phase = 'lie';
    setSkip(true);
    stage.innerHTML = `
      <div class="scene q-wrap">
        <span class="q-cat pop-in">${esc(q.c)}</span>
        <div class="q-text">${qHTML(q.q)}</div>
        <div class="row-center">${timerHTML()}<div class="q-sub">כתבו בטלפון שקר משכנע! 🤫</div></div>
      </div>`;
    renderBar();
    broadcast();
    SFX.play('whoosh');
    Sound.music('question');
    speak(q.q.replace('_____', ' משהו '));
    timerStart(S.kids ? T.lieKids : T.lie, endLie);
  }

  function onLie(p, text) {
    if (S.phase !== 'lie' || S.cur.lies.has(p.id)) return;
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LIE);
    if (!text) return;
    const err = (msg) => { try { p.conn.send({ t: 'lieError', msg }); } catch (e) {} };
    if (isTruth(text, S.cur.q)) {
      // Knowing the real answer earns a one-time bonus – but they still owe us a lie
      if (S.cur.bonus[p.id]) return err(`זו עדיין התשובה הנכונה 😉 ${gw(p.gender, 'כתוב', 'כתבי')} שקר`);
      const pts = TRUTH_BONUS * S.cur.mult;
      S.cur.bonus[p.id] = pts;
      SFX.play('ding');
      try { p.conn.send({ t: 'lieBonus', msg: `🎯 ${gw(p.gender, 'ידעת', 'ידעת')} את התשובה הנכונה! +${pts.toLocaleString()} בונוס. עכשיו ${gw(p.gender, 'כתוב', 'כתבי')} שקר 🤥` }); } catch (e) {}
      return;
    }
    if (S.kids && isBad(text)) return err(`בוא${gw(p.gender, '', 'י')} נשמור על שפה נקייה 😇 ${gw(p.gender, 'נסה', 'נסי')} משהו אחר`);
    S.cur.lies.set(p.id, { text });
    SFX.play('submit');
    renderBar();
    sendView(p);
    checkAllDone();
  }

  function onLieForMe(p) {
    if (S.phase !== 'lie' || S.cur.lies.has(p.id)) return;
    const taken = new Set([...S.cur.lies.values()].map((l) => normCore(l.text)));
    p.suggest = shuffle(S.cur.q.lies.filter((l) => !taken.has(normCore(l)))).slice(0, 2);
    sendView(p);
  }

  function checkAllDone() {
    const ps = onlinePlayers();
    if (!ps.length || !S.cur) return;
    const tok = S.flow;
    const later = (fn) => { clearTimer(); setTimeout(() => tok === S.flow && fn(), 900); };
    if (S.phase === 'lie' && S.timer && ps.every((p) => S.cur.lies.has(p.id))) later(endLie);
    if (S.phase === 'choose' && S.timer && ps.every((p) => S.cur.choices.has(p.id))) later(endChoose);
  }

  function endLie() {
    if (S.phase !== 'lie') return;
    clearTimer();
    const { q } = S.cur;
    const groups = new Map();
    for (const [pid, l] of S.cur.lies) {
      const k = normCore(l.text);
      if (!groups.has(k)) groups.set(k, { text: l.text, authors: [] });
      groups.get(k).authors.push(pid);
    }
    const opts = [...groups.values()];
    opts.push({ text: q.a, truth: true, authors: [] });
    const keys = new Set([...groups.keys(), ...[q.a, ...(q.alt || [])].map(normCore)]);
    // One house lie for small groups; with many players there are enough answers already
    for (const h of groups.size <= HOUSE_LIE_MAX ? shuffle(q.lies) : []) {
      if (opts.some((o) => o.house)) break;
      const k = normCore(h);
      if (keys.has(k)) continue;
      keys.add(k);
      opts.push({ text: h, house: true, authors: [] });
    }
    S.cur.options = shuffle(opts).map((o, i) => ({ ...o, id: i }));
    choosePhase();
  }

  function choosePhase() {
    ++S.flow;
    const { q, options } = S.cur;
    S.phase = 'choose';
    setSkip(true);
    stage.innerHTML = `
      <div class="scene q-wrap">
        <div class="row-center">
          ${timerHTML()}
          <div class="q-text" style="margin:0;font-size:clamp(1.5rem,3vw,2.5rem)">${qHTML(q.q)}</div>
        </div>
        <div class="opts stagger ${options.length > 8 ? 'many' : ''}">${options.map((o) => `<div class="opt">${esc(o.text)}</div>`).join('')}</div>
        <p class="q-sub" style="margin-top:24px">מה האמת? בחרו בטלפון 🔎</p>
      </div>`;
    renderBar();
    broadcast();
    SFX.play('whoosh');
    speak('איזו מהתשובות היא האמת?');
    // More answers to read -> a bit more time (2s for each answer beyond 6)
    timerStart((S.kids ? T.chooseKids : T.choose) + Math.max(0, options.length - 6) * 2, endChoose);
  }

  function onChoose(p, id) {
    if (S.phase !== 'choose' || S.cur.choices.has(p.id)) return;
    const o = S.cur.options[Number(id)];
    if (!o || o.authors.includes(p.id)) return;
    S.cur.choices.set(p.id, o.id);
    SFX.play('submit');
    renderBar();
    sendView(p);
    checkAllDone();
  }

  function endChoose() {
    if (S.phase !== 'choose') return;
    clearTimer();
    const cur = S.cur;
    const d = {};
    for (const p of S.players.values()) d[p.id] = cur.bonus[p.id] || 0;
    for (const [pid, oid] of cur.choices) {
      const o = cur.options[oid];
      if (o.truth) d[pid] += 1000 * cur.mult;
      else for (const a of o.authors) if (a !== pid) d[a] = (d[a] || 0) + 500 * cur.mult;
    }
    cur.delta = d;
    for (const p of S.players.values()) {
      cur.prev[p.id] = p.score;
      p.score += d[p.id] || 0;
    }
    runReveal();
  }

  async function runReveal() {
    const tok = ++S.flow;
    const cur = S.cur;
    const m = cur.mult;
    S.phase = 'reveal';
    setSkip(false);
    stage.innerHTML = `<div class="scene reveal"><div class="q-text">${qHTML(cur.q.q)}</div><div id="revealBox"></div></div>`;
    bar.innerHTML = '';
    bar.dataset.ids = '';
    broadcast();
    Sound.stopMusic(0.6); // let the stamps and drumrolls breathe
    const box = $('#revealBox');
    const alive = async (ms) => { await sleep(ms); return tok === S.flow; };
    const pickers = (o) => [...cur.choices].filter(([, id]) => id === o.id).map(([pid]) => S.players.get(pid)).filter(Boolean);

    const lies = cur.options
      .filter((o) => !o.truth && pickers(o).length)
      .sort((a, b) => pickers(a).length - pickers(b).length || (b.house ? 1 : 0) - (a.house ? 1 : 0));

    if (!lies.length) {
      box.innerHTML = '<div class="verdict pop-in" style="margin-top:100px">אף אחד לא נפל באף שקר! 😮</div>';
      SFX.play('pop');
      if (!(await alive(2200))) return;
    }

    // Big groups can have many fooled lies to reveal – move through them a little faster
    const pace = lies.length > 4 ? 0.7 : 1;
    async function revealOne(o, isTruth) {
      const ps = pickers(o);
      const k = isTruth ? 1 : pace;
      box.innerHTML = `<div class="rv-card pop-in">${esc(o.text)}</div><div class="rv-row" id="rvPick"></div><div class="rv-row" id="rvVerdict"></div>`;
      SFX.play('whoosh');
      if (!(await alive(1000 * k))) return false;
      const pr = $('#rvPick');
      pr.innerHTML = ps.length
        ? `<span class="label">${isTruth ? 'מצאו את האמת:' : 'נפלו בפח:'}</span>`
        : '<span class="label">אף אחד לא מצא את האמת 🤦</span>';
      for (const p of ps) {
        pr.insertAdjacentHTML('beforeend', chip(p, isTruth ? `+${1000 * m}` : ''));
        SFX.play('pop');
        if (!(await alive(380 * k))) return false;
      }
      SFX.play('drum');
      if (!(await alive(950 * k))) return false;
      const card = $('.rv-card', box);
      const vd = $('#rvVerdict');
      if (isTruth) {
        card.classList.add('truth');
        card.insertAdjacentHTML('beforeend', '<span class="stamp good">האמת!</span>');
        SFX.play('ding');
        speak(`האמת היא: ${o.text}`);
        if (ps.length && window.confetti) confetti({ particleCount: 140, spread: 100, origin: { y: 0.45 } });
      } else {
        card.classList.add('lie', 'shake');
        card.insertAdjacentHTML('beforeend', '<span class="stamp">שקר!</span>');
        SFX.play('buzz');
        if (o.house) {
          vd.innerHTML = '<div class="verdict pop-in">🏠 שקר של הבית</div>';
        } else {
          const authors = o.authors.map((id) => S.players.get(id)).filter(Boolean);
          vd.innerHTML = `<div class="verdict pop-in"><span>השקר של</span>${authors
            .map((a) => chip(a, `+${500 * m * ps.filter((x) => x.id !== a.id).length}`)).join('')}</div>`;
          speak(`השקר של ${authors.map((a) => a.name).join(' ו')}`);
        }
      }
      return alive(isTruth ? 3300 : 2900 * pace);
    }

    for (const o of lies) if (!(await revealOne(o, false))) return;
    if (!(await revealOne(cur.options.find((o) => o.truth), true))) return;
    scoresPhase();
  }

  function scoresPhase() {
    ++S.flow;
    const cur = S.cur;
    S.phase = 'scores';
    setSkip(true);
    const ps = ranked();
    const max = Math.max(1, ...ps.map((p) => p.score));
    const medal = (i) => ['🥇', '🥈', '🥉'][i] || i + 1;
    stage.innerHTML = `
      <div class="scene board">
        <h1>טבלת הניקוד</h1>
        ${ps.map((p, i) => `
          <div class="brow" style="animation-delay:${i * 0.08}s">
            <div class="rank">${medal(i)}</div>
            <div class="avatar sm" style="--c:${p.color}">${p.avatar}</div>
            <div class="nm">${esc(p.name)}</div>
            <div class="bar"><i data-w="${(p.score / max) * 100}" style="width:${((cur.prev[p.id] || 0) / max) * 100}%"></i></div>
            <div class="dl">${cur.delta[p.id] ? '+' + cur.delta[p.id].toLocaleString() : ''}</div>
            <div class="sc" data-from="${cur.prev[p.id] || 0}" data-to="${p.score}">${(cur.prev[p.id] || 0).toLocaleString()}</div>
          </div>`).join('')}
      </div>`;
    bar.innerHTML = '';
    broadcast();
    Sound.music('lobby');
    setTimeout(() => {
      $$('.brow .bar i').forEach((i) => (i.style.width = i.dataset.w + '%'));
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / 1300);
        const e = 1 - Math.pow(1 - k, 3);
        for (const el of $$('.brow .sc')) {
          const a = +el.dataset.from, b = +el.dataset.to;
          el.textContent = Math.round(a + (b - a) * e).toLocaleString();
        }
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      if (Object.values(cur.delta).some(Boolean)) SFX.play('pop');
    }, 700);
    timerStart(T.scores, nextQuestion, true);
  }

  function nextQuestion() {
    clearTimer();
    S.qInRound++;
    if (S.qInRound >= S.plan[S.roundIdx].count) {
      S.roundIdx++;
      S.qInRound = 0;
      if (S.roundIdx >= S.plan.length) return gameOver();
      return roundIntro();
    }
    pickPhase();
  }

  async function gameOver() {
    const tok = ++S.flow;
    S.phase = 'gameover';
    setSkip(false);
    const ps = ranked();
    const top = ps[0].score;
    const winners = ps.filter((p) => p.score === top);
    const pod = (p, cls, n) => p ? `
      <div class="pod ${cls}">
        <div class="who">${cls === 'p1' ? '<div class="crown">👑</div>' : ''}
          <div class="avatar lg" style="--c:${p.color};margin:0 auto">${p.avatar}</div>
          <div class="name">${esc(p.name)}</div><div class="pts">${p.score.toLocaleString()}</div>
        </div>
        <div class="blk">${n}</div>
      </div>` : '';
    stage.innerHTML = `
      <div class="scene title-card">
        <div class="kicker">המשחק נגמר!</div>
        <div class="podium">${pod(ps[1], 'p2', 2)}${pod(ps[0], 'p1', 1)}${pod(ps[2], 'p3', 3)}</div>
        <div class="row-center" style="margin-top:34px;flex-wrap:wrap">
          <button class="btn big" id="againBtn">עוד סיבוב! 🔁</button>
          <button class="btn ghost" id="lobbyBtn">חזרה ללובי</button>
        </div>
      </div>`;
    $('#againBtn').onclick = startGame;
    $('#lobbyBtn').onclick = showLobby;
    bar.innerHTML = '';
    broadcast();
    SFX.play('drum');
    if (!(await sleep(2000), tok === S.flow)) return;
    SFX.play('fanfare');
    Sound.music('victory');
    speak(`${winners.map((w) => w.name).join(' ו')} בראש הטבלה!`);
    const end = Date.now() + 4000;
    (function frame() {
      if (tok !== S.flow || !window.confetti) return;
      confetti({ particleCount: 6, angle: 60, spread: 60, origin: { x: 0 } });
      confetti({ particleCount: 6, angle: 120, spread: 60, origin: { x: 1 } });
      if (Date.now() < end) requestAnimationFrame(frame);
    })();
  }

  // ---------- Top bar controls ----------
  $('#skipBtn').onclick = () => {
    const f = S.onTimeout;
    if (f) { clearTimer(); f(); }
  };
  const ttsBtn = $('#ttsBtn');
  const syncTts = () => (ttsBtn.style.opacity = S.tts ? 1 : 0.4);
  syncTts();
  ttsBtn.onclick = () => {
    S.tts = !S.tts;
    lsSet('bluff.tts', S.tts ? '1' : '0');
    syncTts();
    if (S.tts && !heVoice) toast('אין קול עברי בדפדפן הזה – נסו כרום או ספארי');
    else toast(S.tts ? 'הקראת שאלות פעילה 🗣️' : 'הקראת שאלות כבויה');
  };
  if (!Sound.soundOn) Sound.toggleSound(); // the old mute button is gone – never stay silently muted
  function syncMusicUI() {
    $('#musicBtn').style.opacity = Sound.musicOn ? 1 : 0.4;
    $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.t === 'off' ? !Sound.musicOn : Sound.musicOn && Sound.theme === b.dataset.t));
  }
  syncMusicUI();
  $('#musicBtn').onclick = () => {
    Sound.init();
    const on = Sound.toggleMusic();
    toast(on ? `מוזיקה: ${THEME_LABELS[Sound.theme]}` : 'מוזיקה כבויה');
    syncMusicUI();
  };
  $('#fsBtn').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };
  document.addEventListener('pointerdown', () => SFX.unlock(), { once: true });
  window.addEventListener('beforeunload', (e) => {
    if (S.players.size && S.phase !== 'lobby') { e.preventDefault(); e.returnValue = ''; }
  });

  if (typeof Peer === 'undefined') showError('לא הצלחנו לטעון את רכיב החיבור. בדקו את האינטרנט.');
  else openRoom();
  keepAwake();
})();
