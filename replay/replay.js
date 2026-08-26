'use strict';
/* Replay harness: serves a recorded run to the unmodified dashboard by
   intercepting fetch(). Loaded before the dashboard script so the shim is
   installed before the first poll. Static hosting only - no daemon. */
(() => {
  const nativeFetch = window.fetch.bind(window);
  const loadWall = Date.now();
  const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

  /* ---------- data ---------- */
  let DATA = null;
  let LOG = null;
  let loadErr = null;
  const dataReady = Promise.all([
    nativeFetch('data/run.json').then((r) => { if (!r.ok) throw new Error('run.json ' + r.status); return r.json(); }),
    nativeFetch('data/log-t-bc53c776.json').then((r) => { if (!r.ok) throw new Error('log ' + r.status); return r.json(); }),
  ]).then(([run, log]) => { DATA = run; LOG = log; v = startV(); setRate(); initTrack(); }).catch((e) => { loadErr = e; showFatal(); });

  /* ---------- virtual clock ---------- */
  /* preroll is wall-time: the queued state holds for prerollMs before the run plays */
  const startV = () => -(DATA ? DATA.meta.prerollMs * DATA.meta.baseRate : 3000);
  let v = -3000;
  let playing = true;
  let speed = 1;
  let finished = false;
  let restartAtWall = Infinity;
  let lastTick = performance.now();
  /* wall-ms spent paused/hidden; served timestamps shift by this so "ago" labels freeze */
  let pausedAccum = 0;
  const setRate = () => { window.__replayRate = DATA && playing && !finished ? DATA.meta.baseRate * speed : 0; };
  setRate();

  function restart() {
    stampMap.clear();
    v = startV();
    finished = false;
    restartAtWall = Infinity;
    playing = true;
    setRate();
    const drawer = document.querySelector('#drawer');
    if (drawer && drawer.classList.contains('open')) document.querySelector('#dclose')?.click();
    forcePoll();
    updateBar();
  }
  function setPlaying(on) {
    if (finished) {
      if (on) restart();
      else restartAtWall = Infinity;
      updateBar();
      return;
    }
    playing = on;
    setRate();
    forcePoll();
    updateBar();
  }
  function setSpeed(n) {
    speed = [1, 2, 4].includes(n) ? n : 1;
    setRate();
    forcePoll();
    updateBar();
  }
  function forcePoll() {
    /* the dashboard's own visibilitychange listener calls poll() */
    document.dispatchEvent(new Event('visibilitychange'));
  }
  setInterval(() => {
    const now = performance.now();
    if (DATA && playing && !finished && document.visibilityState === 'visible') {
      v += (now - lastTick) * DATA.meta.baseRate * speed;
      if (v >= DATA.meta.endMs) {
        v = DATA.meta.endMs + 1;
        finished = true;
        playing = false;
        restartAtWall = Date.now() + 8000;
        setRate();
        forcePoll();
      }
    } else if (DATA) {
      pausedAccum += now - lastTick;
    }
    lastTick = now;
    if (finished && Date.now() >= restartAtWall) restart();
    updateBar();
  }, 250);

  /* ---------- timestamp stamping: offsets -> live ISO ---------- */
  const stampMap = new Map();
  function stamp(ots) {
    /* far negatives are backdrop history (anchored to page load); run-adjacent
       offsets stamp on first sight so they read "just now" even after restarts */
    if (ots < -60000) return new Date(loadWall + ots + pausedAccum).toISOString();
    let s = stampMap.get(ots);
    if (!s) { s = { ms: Date.now(), acc: pausedAccum }; stampMap.set(ots, s); }
    return new Date(s.ms + (pausedAccum - s.acc)).toISOString();
  }
  const TS_KEYS = new Set(['ts', 'createdAt', 'startedAt', 'finishedAt', 'workerFinishedAt']);
  function stampDeep(node) {
    if (Array.isArray(node)) { node.forEach(stampDeep); return; }
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        const val = node[k];
        if (TS_KEYS.has(k) && typeof val === 'number') node[k] = stamp(val);
        else stampDeep(val);
      }
    }
  }

  /* ---------- frame synthesis ---------- */
  function frame() {
    const kfs = DATA.keyframes;
    let kf = kfs[0];
    for (const k of kfs) { if (k.ots <= v) kf = k; else break; }
    const f = clone({
      stats: kf.stats,
      tasks: {
        pending: kf.pending,
        running: kf.running,
        blocked: [],
        recent: (kf.final ? [DATA.realRecent, ...DATA.backdrop.recent] : DATA.backdrop.recent).slice(0, 20),
      },
      messages: [...DATA.narration.slice(0, kf.msgCount).reverse(), ...DATA.backdrop.messages].slice(0, 50),
      events: [...DATA.runRows.slice(0, kf.eventCount).reverse(), ...DATA.backdrop.events].slice(0, 30),
    });
    const run = f.tasks.running[0];
    if (run) {
      run.elapsedMs = Math.max(0, Math.round(v - run.startedAt));
      let act = null;
      for (const a of DATA.activity) { if (a.ots <= v) act = a; else break; }
      if (act) { run.lastActivity = act.text; run.toolCalls = act.toolCalls; }
    }
    stampDeep(f);
    f.daemon = {
      alive: true,
      pid: DATA.daemon.pid,
      port: DATA.daemon.port,
      engine: DATA.daemon.engine || DATA.realRecent?.engine || 'claude',
      startedAt: new Date(loadWall - DATA.daemon.startedBackMs + pausedAccum).toISOString(),
      ts: new Date().toISOString(),
    };
    f.bridge = { running: bridgeUp };
    return f;
  }

  /* ---------- fetch shim ---------- */
  /* mock connector info: the bridge really was running for this run (source: mcp),
     but the endpoint is the stock default and the token is fake */
  const FAKE_TOKEN = '9f3ce8a41b76d2054c3f8e21ab90dd17e64f0b2c85a1d3964b7f21c08e5a63bd';
  const MOCK_BRIDGE = {
    running: true,
    port: 5758,
    localEndpoint: 'http://127.0.0.1:5758/mcp',
    connectorUrl: 'http://127.0.0.1:5758/mcp?key=' + FAKE_TOKEN,
    publicUrl: null,
    token: FAKE_TOKEN,
  };
  let bridgeUp = true; /* Start/Stop simulate locally, like the dashboard's own mock mode */
  const jsonResp = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = function (input, opts) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = ((opts && opts.method) || (input && input.method) || 'GET').toUpperCase();
    if (!url.startsWith('/api/')) return nativeFetch(input, opts);
    if (method !== 'GET') {
      if (url.startsWith('/api/bridge/')) {
        bridgeUp = url.endsWith('/start');
        return Promise.resolve(jsonResp({ running: bridgeUp }));
      }
      return Promise.reject(new Error('This is a replay - AgentLoop runs locally.'));
    }
    return dataReady.then(() => {
      if (loadErr || !DATA) return new Promise(() => {});
      if (url.startsWith('/api/state')) return jsonResp(frame());
      if (url.startsWith('/api/bridge')) return jsonResp({ ...MOCK_BRIDGE, running: bridgeUp });
      if (url.startsWith('/api/log/')) {
        const id = decodeURIComponent(url.slice('/api/log/'.length).split('?')[0]);
        return jsonResp(id.startsWith(DATA.meta.runId) ? LOG : { lines: [] });
      }
      return jsonResp({ error: 'not found' }, 404);
    });
  };

  /* ---------- replay bar UI ---------- */
  const css = document.createElement('style');
  css.textContent = [
    ':root{--rp-h:42px}',
    '#rp-bar{position:sticky;top:0;z-index:55;display:flex;align-items:center;gap:10px;min-height:var(--rp-h);',
    'padding:6px 14px;',
    'background:color-mix(in srgb,var(--card) 92%,transparent);border-bottom:1px solid var(--line);',
    'box-shadow:0 12px 30px -28px rgba(0,0,0,.8);color:var(--txt);font:600 12px var(--sans);',
    'backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2)}',
    '#rp-bar .rp-dot{flex:none;width:8px;height:8px;border-radius:2px;background:var(--blue);box-shadow:0 0 12px var(--blue-soft);animation:rp-pulse 2s ease-in-out infinite}',
    '@keyframes rp-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
    '#rp-bar .rp-txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;color:var(--sub)}',
    '#rp-bar .rp-spacer{flex:1}',
    '#rp-bar .rp-status{color:var(--sub);font-weight:400;white-space:nowrap}',
    '#rp-track{position:relative;flex:0 1 320px;width:clamp(180px,22vw,320px);height:5px;border-radius:99px;background:var(--line);overflow:visible}',
    '#rp-fill{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:99px;background:var(--blue);box-shadow:0 0 10px var(--blue-soft)}',
    '#rp-track .rp-mark{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--mut);opacity:.7}',
    '#rp-bar .rp-actions{display:flex;gap:6px;flex:none}',
    '#rail{top:var(--rp-h)}',
    '@media (min-width:901px){#rail{height:calc(100vh - var(--rp-h));height:calc(100dvh - var(--rp-h))}}',
    '#newLoopBtn,#newTaskBtn{display:none!important}',
    '[data-cancel]{display:none!important}',
    '@media (max-width:720px){#rp-bar .rp-txt{display:none}#rp-track{flex:1;width:auto;min-width:80px}}',
    '@media (max-width:520px){#rp-bar{gap:7px}#rp-status{display:none}}',
    '@media (pointer:coarse){:root{--rp-h:52px}#rp-bar{padding-block:3px}}',
    '#rp-credit{white-space:nowrap}',
    '#rp-credit a{color:var(--blue);text-decoration:none}',
    '#rp-credit a:hover{text-decoration:underline}',
    '.rp-heart{display:inline-block;color:var(--red)}',
    '@media (prefers-reduced-motion:reduce){#rp-bar .rp-dot{animation:none}}',
  ].join('\n');
  document.head.appendChild(css);

  const bar = document.createElement('div');
  bar.id = 'rp-bar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Replay controls');
  bar.innerHTML =
    '<span class="rp-dot"></span>' +
    '<span class="rp-txt">Replay of a real run - AgentLoop runs locally.</span>' +
    '<span class="rp-spacer"></span>' +
    '<span class="rp-status" id="rp-status"></span>' +
    '<div id="rp-track" role="progressbar" aria-label="Replay progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="rp-fill"></i></div>' +
    '<div class="rp-actions" role="group" aria-label="Playback controls">' +
      '<button class="btn sm" id="rp-play" type="button">Pause</button>' +
      '<button class="btn sm" id="rp-speed" type="button" title="Playback speed">1x</button>' +
      '<button class="btn sm" id="rp-restart" type="button">Restart</button>' +
    '</div>';
  document.body.insertBefore(bar, document.body.firstChild);

  /* credit joins the rail footer under the daemon pid/port lines */
  const credit = document.createElement('span');
  credit.id = 'rp-credit';
  credit.innerHTML = 'Made with <span class="rp-heart">♥</span> by <a href="https://github.com/aiedwardyi" target="_blank" rel="noopener">Edward Yi</a>';
  const foot = document.querySelector('#railfoot');
  if (foot) {
    foot.appendChild(document.createElement('br'));
    foot.appendChild(credit);
  } else {
    document.body.appendChild(credit);
  }

  const el = (id) => document.getElementById(id);
  el('rp-play').addEventListener('click', () => setPlaying(finished ? true : !playing));
  el('rp-speed').addEventListener('click', () => setSpeed(speed === 1 ? 2 : speed === 2 ? 4 : 1));
  el('rp-restart').addEventListener('click', restart);

  function initTrack() {
    const track = el('rp-track');
    for (const m of DATA.meta.cycleMarks) {
      const mark = document.createElement('i');
      mark.className = 'rp-mark';
      mark.style.left = ((m / DATA.meta.endMs) * 100).toFixed(2) + '%';
      track.appendChild(mark);
    }
  }
  function updateBar() {
    if (!DATA) return;
    const pct = Math.max(0, Math.min(1, v / DATA.meta.endMs));
    el('rp-fill').style.width = (pct * 100).toFixed(2) + '%';
    el('rp-track').setAttribute('aria-valuenow', Math.round(pct * 100));
    el('rp-play').textContent = finished ? 'Replay' : playing ? 'Pause' : 'Play';
    el('rp-speed').textContent = speed + 'x';
    const status = el('rp-status');
    if (finished) {
      status.textContent = restartAtWall === Infinity
        ? 'Replay finished'
        : 'Restarting in ' + Math.max(0, Math.ceil((restartAtWall - Date.now()) / 1000)) + 's';
    } else if (!playing) {
      status.textContent = 'Paused';
    } else {
      status.textContent = '';
    }
  }

  function showFatal() {
    const note = document.createElement('div');
    note.setAttribute('role', 'alert');
    note.style.cssText = 'position:fixed;inset:auto 0 0 0;z-index:99;padding:10px 14px;background:var(--red,#f7768e);color:#fff;font:600 13px var(--sans,sans-serif);text-align:center';
    note.textContent = 'Replay data failed to load - refresh the page.';
    document.body.appendChild(note);
  }

  /* test hook */
  window.__replay = {
    get v() { return v; },
    get playing() { return playing; },
    get speed() { return speed; },
    get finished() { return finished; },
    get ready() { return !!DATA; },
    play: () => setPlaying(true),
    pause: () => setPlaying(false),
    restart,
    setSpeed,
  };
})();
