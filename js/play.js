// Player = phone controller. Connects to the host's peer and renders whatever view the host sends.
(() => {
  const app = $('#app');
  const params = new URLSearchParams(location.search);

  // Per-tab id (survives reloads, so a refreshed phone rejoins as the same player)
  let pid;
  try { pid = sessionStorage.getItem('bluff.pid'); } catch (e) {}
  if (!pid) {
    pid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem('bluff.pid', pid); } catch (e) {}
  }
  let name = lsGet('bluff.name', '');
  let avatar = lsGet('bluff.avatar') || AVATARS[Math.floor(Math.random() * AVATARS.length)];
  let gender = lsGet('bluff.gender', '');
  const G = (m, f) => gw(view?.me?.g || gender, m, f);
  let room = (params.get('room') || '').toUpperCase().slice(0, 4);

  let peer = null, conn = null, view = null, joined = false, wantConnected = false;
  let lastKey = '', lieErr = '', draft = '', retryTimer;

  // ---------- UI helpers ----------
  function overlay(msg) { $('#overlayMsg').textContent = msg; $('#overlay').classList.add('show'); }
  function hideOverlay() { $('#overlay').classList.remove('show'); }
  function send(m) { if (conn && conn.open) try { conn.send(m); } catch (e) {} }
  const buzz = (ms = 40) => { try { navigator.vibrate?.(ms); } catch (e) {} };

  // ---------- Join form ----------
  function showJoin(err = '') {
    view = null;
    lastKey = '';
    $('#me').innerHTML = '';
    $('#ptimer').hidden = true;
    app.innerHTML = `
      <div class="scene glass pcard">
        <h2 style="text-align:center;margin:0 0 18px;font-family:var(--display);font-size:2rem">הצטרפות למשחק</h2>
        ${err ? `<div class="err shake">${esc(err)}</div>` : ''}
        <div class="field"><label for="room">קוד חדר</label>
          <input class="input code" id="room" maxlength="4" autocomplete="off" autocapitalize="characters" inputmode="latin" value="${esc(room)}" placeholder="ABCD"></div>
        <div class="field"><label for="name">מה השם?</label>
          <input class="input" id="name" maxlength="14" autocomplete="nickname" value="${esc(name)}" placeholder="השם שלך"></div>
        <div class="field"><label>בן או בת?</label>
          <div class="gender-row" id="gRow">
            <button type="button" data-g="m" class="${gender === 'm' ? 'on' : ''}"><span>👦</span>בן</button>
            <button type="button" data-g="f" class="${gender === 'f' ? 'on' : ''}"><span>👧</span>בת</button>
          </div></div>
        <div class="field"><label>דמות</label>
          <div class="av-grid" id="avGrid">${AVATARS.map((a) => `<button type="button" class="${a === avatar ? 'on' : ''}" data-a="${a}">${a}</button>`).join('')}</div></div>
        <button class="btn block big" id="joinBtn">יאללה! 🎉</button>
      </div>`;
    $('#avGrid').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      avatar = b.dataset.a;
      $$('#avGrid button').forEach((x) => x.classList.toggle('on', x === b));
      SFX.play('pop');
    };
    $('#gRow').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      gender = b.dataset.g;
      $$('#gRow button').forEach((x) => x.classList.toggle('on', x === b));
      SFX.play('pop');
    };
    $('#room').oninput = (e) => (e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''));
    const go = () => {
      SFX.unlock();
      room = $('#room').value.trim().toUpperCase();
      name = $('#name').value.replace(/\s+/g, ' ').trim();
      if (room.length !== 4) { $('#room').classList.add('shake'); setTimeout(() => $('#room').classList.remove('shake'), 500); return toast('קוד החדר הוא 4 אותיות'); }
      if (!name) { $('#name').focus(); return toast('מה השם? 🙂'); }
      if (!gender) { $('#gRow').classList.add('shake'); setTimeout(() => $('#gRow').classList.remove('shake'), 500); return toast('בן או בת? 🙂'); }
      lsSet('bluff.name', name);
      lsSet('bluff.gender', gender);
      lsSet('bluff.avatar', avatar);
      history.replaceState(null, '', `?room=${room}`);
      if (conn && conn.open && joined) send({ t: 'join', pid, name, avatar, g: gender });
      else connect();
    };
    $('#joinBtn').onclick = go;
    $('#name').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    if (!room) $('#room').focus();
  }

  // ---------- Networking ----------
  function connect() {
    wantConnected = true;
    clearTimeout(retryTimer);
    overlay(joined ? 'מתחברים מחדש…' : `מתחברים לחדר ${room}…`);
    if (!peer || peer.destroyed) {
      peer = new Peer(PEER_OPTS);
      peer.on('open', openConn);
      peer.on('error', onPeerError);
      peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => peer.reconnect(), 1000); });
    } else if (peer.open) openConn();
    else if (peer.disconnected) peer.reconnect();
  }

  function openConn() {
    if (!wantConnected) return;
    if (conn) try { conn.close(); } catch (e) {}
    const c = peer.connect(PEER_PREFIX + room, { reliable: true });
    conn = c;
    const timeout = setTimeout(() => { if (c === conn && !c.open) { try { c.close(); } catch (e) {} scheduleRetry(); } }, 9000);
    c.on('open', () => { clearTimeout(timeout); c.send({ t: 'join', pid, name, avatar, g: gender }); });
    c.on('data', (m) => { if (c === conn) onData(m); });
    c.on('close', () => { if (c === conn) lost(); });
    c.on('error', () => { if (c === conn) lost(); });
  }

  function lost() {
    conn = null;
    if (!wantConnected) return;
    overlay('החיבור נותק – מתחברים מחדש…');
    scheduleRetry();
  }
  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => wantConnected && connect(), 1800);
  }

  function onPeerError(e) {
    console.warn('peer error', e.type, e);
    if (e.type === 'peer-unavailable') {
      if (!joined) {
        wantConnected = false;
        hideOverlay();
        showJoin(`לא מצאנו חדר עם הקוד ${room} 🤔 ${G('בדוק', 'בדקי')} את הקוד על המסך`);
      } else {
        overlay('המסך הראשי לא זמין – מנסים שוב…');
        scheduleRetry();
      }
      return;
    }
    if (wantConnected) scheduleRetry();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wantConnected && !(conn && conn.open)) connect();
  });

  function onData(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'rejected') {
      wantConnected = false;
      joined = false;
      hideOverlay();
      try { conn?.close(); } catch (e) {}
      showJoin(m.msg);
      return;
    }
    if (m.t === 'lieError') {
      lieErr = m.msg;
      const box = $('#lieErr');
      if (box) { box.innerHTML = `<div class="err shake">${esc(lieErr)}</div>`; buzz([60, 40, 60]); }
      const b = $('#sendLie');
      if (b) b.disabled = false;
      return;
    }
    if (m.t === 'view') {
      if (!joined) SFX.play('join');
      joined = true;
      hideOverlay();
      render(m);
    }
  }

  // ---------- Rendering ----------
  function timerBar(v) {
    const el = $('#ptimer');
    const i = $('i', el);
    if (!v.total || !v.remain) { el.hidden = true; return; }
    el.hidden = false;
    i.style.transition = 'none';
    i.style.width = (v.remain / v.total) * 100 + '%';
    void i.offsetWidth;
    i.style.transition = `width ${v.remain}ms linear`;
    i.style.width = '0%';
  }

  function render(v) {
    const { remain, total, ...rest } = v;
    const key = JSON.stringify(rest);
    const phaseChanged = !view || view.phase !== v.phase;
    view = v;
    document.body.classList.toggle('kids', !!v.kids);
    $('#me').innerHTML = `<span class="pts">${v.me.score.toLocaleString()}</span><div class="avatar sm" style="--c:${v.me.color}">${v.me.avatar}</div>`;
    if (key === lastKey) return;
    lastKey = key;
    if (phaseChanged) { buzz(); lieErr = ''; draft = ''; }
    timerBar(v);
    (screens[v.phase] || screens.wait)(v);
  }

  const center = (html) => (app.innerHTML = `<div class="pcenter scene">${html}</div>`);

  const screens = {
    wait: () => center(`<div class="big-emoji bounce">👀</div><h2>${G('תסתכל', 'תסתכלי')} על המסך!</h2>`),

    lobby(v) {
      center(`
        <div class="avatar lg bounce" style="--c:${v.me.color}">${v.me.avatar}</div>
        <h2>${esc(v.me.name)}, ${G('אתה', 'את')} בפנים! 🎉</h2>
        <p>${v.count} שחקנים בחדר</p>
        ${v.vip
          ? `<p>👑 ${G('אתה', 'את')} ה-VIP – ${G('אתה מתחיל', 'את מתחילה')} את המשחק</p>
             ${v.canStart ? '<button class="btn big" id="startBtn">כולם פה – מתחילים! 🚀</button>' : '<p>מחכים לעוד שחקנים…</p>'}`
          : '<p>מחכים שהמשחק יתחיל… ⏳</p>'}
        <button class="btn ghost" id="editBtn" style="margin-top:20px">שינוי פרטים</button>`);
      $('#startBtn') && ($('#startBtn').onclick = () => { send({ t: 'start' }); SFX.play('submit'); });
      $('#editBtn').onclick = () => showJoin();
    },

    roundIntro(v) {
      center(`<div class="big-emoji zoom-in">🎬</div><h2>${esc(v.round)}</h2>${v.sub ? `<p class="mult" style="font-weight:800;color:var(--accent)">${esc(v.sub)}</p>` : ''}<p>${G('תסתכל', 'תסתכלי')} על המסך!</p>`);
    },

    pick(v) {
      if (!v.isChooser) {
        const c = v.chooser;
        return center(`${c ? `<div class="avatar lg bounce" style="--c:${c.color}">${c.avatar}</div>` : ''}<h2>הבחירה אצל ${esc(c?.name || '')}</h2><p>עוד רגע מתחילים…</p>`);
      }
      app.innerHTML = `
        <div class="scene">
          <h2 style="text-align:center;font-family:var(--display);font-size:2rem;margin:0 0 16px">${G('בחר', 'בחרי')} נושא! 👇</h2>
          <div class="plist stagger">${v.cats.map((c, i) => `<button class="popt cat-btn ${v.picked === i ? 'sel' : ''}" data-i="${i}" ${v.picked !== null ? 'disabled' : ''}>${esc(c)}</button>`).join('')}</div>
        </div>`;
      $$('.cat-btn').forEach((b) => (b.onclick = () => {
        send({ t: 'pick', i: +b.dataset.i });
        b.classList.add('sel');
        $$('.cat-btn').forEach((x) => (x.disabled = true));
        SFX.play('submit');
      }));
    },

    lie(v) {
      if (v.submitted) {
        return center(`<div class="big-emoji pop-in">🤫</div><h2>השקר נשלח!</h2><p style="font-size:1.3rem;font-weight:700;color:#fff">"${esc(v.submitted)}"</p><p>מחכים לשאר השחקנים…</p>`);
      }
      app.innerHTML = `
        <div class="scene">
          <span class="q-cat" style="font-size:1rem">${esc(v.cat)}</span>
          <p class="pq" style="margin-top:14px">${qHTML(v.q)}</p>
          <div id="lieErr">${lieErr ? `<div class="err">${esc(lieErr)}</div>` : ''}</div>
          <input class="input" id="lie" maxlength="${MAX_LIE}" autocomplete="off" placeholder="${G('כתוב', 'כתבי')} שקר משכנע…" value="${esc(draft)}">
          <div class="counter"><span id="cnt">${draft.length}</span>/${MAX_LIE}</div>
          <button class="btn block big" id="sendLie">שליחת השקר 🤥</button>
          <button class="btn ghost block" id="lfm" style="margin-top:12px">🎲 אין לי רעיון – ${G('תן', 'תני')} לי שקר</button>
          ${v.suggest?.length ? `<div class="suggest stagger">${v.suggest.map((s) => `<button class="popt sug">${esc(s)}</button>`).join('')}</div>` : ''}
        </div>`;
      const inp = $('#lie');
      inp.oninput = () => { draft = inp.value; $('#cnt').textContent = draft.length; };
      const submit = (text) => {
        text = text.trim();
        if (!text) { inp.focus(); return toast(`${G('כתוב', 'כתבי')} משהו 🙂`); }
        $('#sendLie').disabled = true;
        send({ t: 'lie', text });
        SFX.play('submit');
      };
      $('#sendLie').onclick = () => submit(inp.value);
      inp.onkeydown = (e) => { if (e.key === 'Enter') submit(inp.value); };
      $('#lfm').onclick = () => { send({ t: 'lieForMe' }); SFX.play('pop'); };
      $$('.sug').forEach((b) => (b.onclick = () => submit(b.textContent)));
    },

    choose(v) {
      if (v.chosen !== null) {
        const o = v.options.find((x) => x.id === v.chosen);
        return center(`<div class="big-emoji pop-in">🤞</div><h2>הבחירה נקלטה!</h2><p style="font-size:1.3rem;font-weight:700;color:#fff">"${esc(o?.text)}"</p><p>מחכים לשאר השחקנים…</p>`);
      }
      app.innerHTML = `
        <div class="scene">
          <p class="pq">${qHTML(v.q)}</p>
          <h2 style="font-family:var(--display);margin:0 0 12px">מה האמת? 🔎</h2>
          <div class="plist stagger">${v.options.map((o) => `<button class="popt" data-id="${o.id}">${esc(o.text)}</button>`).join('')}</div>
          ${v.mine ? `<p style="color:var(--ink-soft);text-align:center;margin-top:16px">השקר שלך לא מופיע כאן 😉</p>` : ''}
        </div>`;
      $$('.popt').forEach((b) => (b.onclick = () => {
        b.classList.add('sel');
        $$('.popt').forEach((x) => (x.disabled = true));
        send({ t: 'choose', id: +b.dataset.id });
        SFX.play('submit');
      }));
    },

    reveal: () => center(`<div class="big-emoji bounce">👀</div><h2>${G('תסתכל', 'תסתכלי')} על המסך!</h2><p>מי שיקר ומי נפל בפח?</p>`),

    scores(v) {
      const lines = [];
      if (v.gotTruth) lines.push(`🎯 ${G('מצאת', 'מצאת')} את האמת!`);
      else if (v.fellFor) lines.push(`🙈 ${G('נפלת', 'נפלת')} בשקר: "${esc(v.fellFor)}"`);
      if (v.fooled) lines.push(`😈 ${G('עבדת', 'עבדת')} על ${v.fooled === 1 ? 'שחקן אחד' : v.fooled + ' שחקנים'}!`);
      center(`
        <div class="big-emoji pop-in">${v.gotTruth || v.fooled ? '🥳' : '😅'}</div>
        <div class="result-num pop-in">+${v.delta.toLocaleString()}</div>
        ${lines.map((l) => `<p style="color:#fff;font-weight:700">${l}</p>`).join('')}
        <p>האמת: <b style="color:var(--good)">${esc(v.truth)}</b></p>
        <p>${G('אתה', 'את')} במקום ה-${v.rank} עם ${v.me.score.toLocaleString()} נקודות</p>`);
    },

    gameover(v) {
      const medal = ['🏆', '🥈', '🥉'][v.rank - 1] || '🎈';
      center(`
        <div class="big-emoji bounce">${medal}</div>
        <h2>${v.rank === 1 ? G('ניצחת!!!', 'ניצחת!!!') : `${G('סיימת', 'סיימת')} במקום ${v.rank}`}</h2>
        <p style="font-size:1.4rem;color:#fff;font-weight:700">${v.me.score.toLocaleString()} נקודות</p>
        ${v.vip ? '<button class="btn big" id="againBtn" style="margin-top:16px">עוד סיבוב! 🔁</button>' : `<p>תודה ש${G('שיחקת', 'שיחקת')}! 💜</p>`}`);
      if (v.rank === 1) SFX.play('fanfare');
      $('#againBtn') && ($('#againBtn').onclick = () => send({ t: 'again' }));
    },
  };

  if (typeof Peer === 'undefined') {
    app.innerHTML = '<div class="pcenter"><div class="big-emoji">😵</div><h2>שגיאת טעינה</h2><p>בדקו את החיבור לאינטרנט ורעננו</p></div>';
    return;
  }
  // Came from a QR code with a remembered name? Jump straight in.
  if (room.length === 4 && name && gender && params.get('room')) connect();
  else showJoin();
  keepAwake();
})();
