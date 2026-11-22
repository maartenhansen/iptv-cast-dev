'use strict';
/* IPTV Cast: een kleine PWA die Xtream-IPTV naar een Chromecast stuurt, met ondertitels.
 *
 * Opbouw van dit bestand:
 *   1. Instellingen en hulpjes
 *   2. Praten met de Xtream-server (via de Worker-tussenschakel)
 *   3. Navigatie (schermen, terugknop)
 *   4. Schermen: Live, Films, Series, Film/aflevering-detail, Instellingen
 *   5. Ondertitels zoeken (OpenSubtitles)
 *   6. Casten naar de Chromecast + bediening (mini-speler)
 */

// ---------- 1. Instellingen en hulpjes ----------

const LS_SETTINGS = 'iptvcast.settings';
const LS_POS = 'iptvcast.positions';   // waar je gebleven was, per film/aflevering
const LS_LASTCAT = 'iptvcast.lastcat'; // laatst gekozen categorie per tab
const SS_NOW = 'iptvcast.now';         // wat er nu op de tv speelt

const DEFAULTS = { server: '', user: '', pass: '', worker: '', key: '', langs: 'nl,en', subScale: 1, vodMode: 'auto', home: '', subDelay: 0 };

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* opslag vol of geblokkeerd */ } },
};
let S = { ...DEFAULTS, ...store.get(LS_SETTINGS, {}) };
const configured = () => !!(S.server && S.user && S.pass && S.worker && S.key);

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const trim = s => String(s || '').trim().replace(/\/+$/, '');
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function setTitle(t) { $('#title').textContent = t; document.title = `${t} · IPTV Cast`; }

// "01:52:00" of duration_secs -> seconden
function durationSecs(info) {
  const d = +info?.duration_secs;
  if (d > 0) return d;
  const m = String(info?.duration || '').match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (!m) return 0;
  return m[3] ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
}

const LANGS = { nl: 'Nederlands', en: 'Engels', fr: 'Frans', de: 'Duits', es: 'Spaans', it: 'Italiaans', pt: 'Portugees', tr: 'Turks', ar: 'Arabisch', pl: 'Pools' };
const langName = code => LANGS[String(code || '').slice(0, 2).toLowerCase()] || (code ? String(code).toUpperCase() : '');

// "NL | De Film (2021)" -> "De Film"
function cleanName(n) {
  return String(n || '')
    .replace(/^\s*(\[[^\]]*\]|\|[^|]*\||[A-Z]{2,4}\s*[:|]|[A-Z]{2,4}\s+-)\s*/, '')
    .replace(/\(\s*(19|20)\d{2}\s*\)/, '')
    .replace(/\s+-\s*(19|20)\d{2}\s*$/, '')
    .replace(/\s+/g, ' ').trim();
}
function yearOf(info, name) {
  const y = String(info?.releasedate || info?.releaseDate || info?.release_date || '').slice(0, 4)
    || (String(name || '').match(/\((\d{4})\)/) || [])[1] || '';
  return /^(19|20)\d{2}$/.test(y) ? y : '';
}

// ---------- 2. Xtream-server via de Worker ----------

function workerUrl(path, params = {}) {
  return `${trim(S.worker)}${path}?${new URLSearchParams({ k: S.key, ...params })}`;
}
const proxied = url => workerUrl('/p', { url });
const playlistProxied = url => workerUrl('/m3u8', { url });
// Thuis-tussenschakel (Beelink met VPN): de Chromecast haalt de streams daar op.
const homeUrl = (path, url) => `${trim(S.home)}${path}?${new URLSearchParams({ k: S.key, url })}`;

// Afbeeldingen op http mogen niet in een https-app: die laten we via de Worker lopen.
function imgUrl(url) {
  url = String(url || '').trim();
  if (url.startsWith('https://')) return url;
  if (url.startsWith('http://') && S.worker) return proxied(url);
  return '';
}

const apiCache = new Map();
function xt(action, params = {}, { cache = true } = {}) {
  const p = { s: trim(S.server), username: S.user, password: S.pass, ...params };
  if (action) p.action = action;
  const url = workerUrl('/api', p);
  if (cache && apiCache.has(url)) return apiCache.get(url);
  const pr = fetch(url).then(async r => {
    const txt = await r.text();
    let data;
    try { data = JSON.parse(txt); } catch {
      throw new Error(r.ok ? 'De IPTV-server gaf een onverwacht antwoord.' : `Fout ${r.status}: ${txt.slice(0, 140)}`);
    }
    if (!r.ok || data?.error) throw new Error(data?.error || `Fout ${r.status}`);
    return data;
  }, () => { throw new Error('Geen verbinding met de tussenschakel (Worker). Klopt het Worker-adres?'); });
  if (cache) { apiCache.set(url, pr); pr.catch(() => apiCache.delete(url)); }
  return pr;
}

const streamBase = type => `${trim(S.server)}/${type}/${enc(S.user)}/${enc(S.pass)}`;
const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm',
  avi: 'video/x-msvideo', ts: 'video/mp2t', m3u8: 'application/x-mpegurl',
};

// ---------- 3. Navigatie ----------
// Elk scherm is een "state" in de browsergeschiedenis, zodat de terugknop van je gsm werkt.

const TABS = ['live', 'vod', 'series', 'settings'];
const TAB_OF = { movie: 'vod', show: 'series', episode: 'series' };
let renderToken = 0;
let pendingTab = null;

function go(name, params = {}) {
  const cur = history.state || {};
  history.replaceState({ ...cur, scroll: scrollY }, '');
  const st = { name, params, depth: (cur.depth || 0) + 1 };
  history.pushState(st, '');
  show(st);
}

function goTab(name) {
  const d = history.state?.depth || 0;
  if (d > 0) { pendingTab = name; history.go(-d); return; }
  const st = { name, params: {}, depth: 0 };
  history.replaceState(st, '');
  show(st);
}

window.addEventListener('popstate', e => {
  if (pendingTab) {
    const st = { name: pendingTab, params: {}, depth: 0 };
    pendingTab = null;
    history.replaceState(st, '');
    return show(st);
  }
  show(e.state || startState());
});

function startState() { return { name: configured() ? 'vod' : 'settings', params: {}, depth: 0 }; }

async function show(st) {
  const token = ++renderToken;
  const alive = () => token === renderToken;
  let { name, params = {} } = st;
  if (name !== 'settings' && !configured()) { name = 'settings'; params = { first: true }; }
  $('#back').hidden = !st.depth;
  const tab = TABS.includes(name) ? name : TAB_OF[name];
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  closeSheet();
  view.innerHTML = '<div class="loading">Laden…</div>';
  window.scrollTo(0, 0);
  try {
    await VIEWS[name](params, alive);
    if (alive() && st.scroll) requestAnimationFrame(() => window.scrollTo(0, st.scroll));
  } catch (e) {
    if (!alive()) return;
    console.error(e);
    view.innerHTML = `<div class="error"><b>Er ging iets mis</b><div>${esc(e.message)}</div>
      <button class="secondary" id="retry">Opnieuw proberen</button></div>`;
    $('#retry').onclick = () => show(history.state || st);
  }
}

// ---------- 4. Schermen ----------

const KIND = {
  live: { title: 'Live tv', cats: 'get_live_categories', items: 'get_live_streams' },
  vod: { title: 'Films', cats: 'get_vod_categories', items: 'get_vod_streams' },
  series: { title: 'Series', cats: 'get_series_categories', items: 'get_series' },
};

function thumb(url, name, cls) {
  const u = imgUrl(url);
  const ph = esc((cleanName(name) || String(name || '?')).replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 2));
  return `<div class="${cls}" data-ph="${ph}">${u ? `<img loading="lazy" src="${esc(u)}" alt="" onerror="this.remove()">` : ''}</div>`;
}

async function viewList(kind, params, alive) {
  const K = KIND[kind];
  setTitle(K.title);
  const cats = await xt(K.cats);
  if (!alive()) return;
  const lastCats = store.get(LS_LASTCAT, {});
  const catIds = (Array.isArray(cats) ? cats : []).map(c => String(c.category_id));
  let cat = params.cat ?? lastCats[kind] ?? catIds[0] ?? '';
  if (cat && !catIds.includes(String(cat))) cat = catIds[0] ?? '';
  let limit = params.limit || 120;

  view.innerHTML = `
    <div class="toolbar">
      <select id="cat" aria-label="Categorie">
        <option value="">Alle categorieën</option>
        ${(cats || []).map(c => `<option value="${esc(c.category_id)}">${esc(c.category_name)}</option>`).join('')}
      </select>
      <input id="q" type="search" placeholder="Zoeken…" value="${esc(params.q || '')}" autocomplete="off">
    </div>
    <div id="items"></div>`;
  const sel = $('#cat'), q = $('#q'), box = $('#items');
  sel.value = cat;
  let items = [], shown = [];

  const save = () => {
    history.replaceState({ ...history.state, params: { cat, q: q.value, limit } }, '');
    store.set(LS_LASTCAT, { ...store.get(LS_LASTCAT, {}), [kind]: cat });
  };

  function draw() {
    const term = norm(q.value.trim());
    const list = term ? items.filter(i => norm(i.name).includes(term)) : items;
    shown = list.slice(0, limit);
    const pos = kind === 'live' ? {} : store.get(LS_POS, {});
    const cards = shown.map((it, i) => {
      if (kind === 'live') {
        return `<button class="row" data-i="${i}">${thumb(it.stream_icon, it.name, 'logo')}<span>${esc(it.name)}</span></button>`;
      }
      const p = kind === 'vod' ? pos[`vod:${it.stream_id}`] : null;
      const bar = p?.d ? `<div class="progress"><i style="width:${clamp(p.t / p.d * 100, 2, 100)}%"></i></div>` : '';
      return `<button class="card" data-i="${i}">${thumb(kind === 'vod' ? it.stream_icon : it.cover, it.name, 'poster')}${bar}<span>${esc(cleanName(it.name) || it.name)}</span></button>`;
    }).join('');
    box.innerHTML =
      (list.length ? `<div class="${kind === 'live' ? 'rows' : 'grid'}">${cards}</div>` : '<p class="empty">Niets gevonden.</p>')
      + (list.length > limit ? `<button class="more" data-more>Meer tonen (nog ${list.length - limit})</button>` : '')
      + (term && cat ? '<button class="more" data-all>Zoek in alle categorieën</button>' : '');
  }

  async function load() {
    box.innerHTML = `<div class="loading">${cat ? 'Laden…' : 'Alles laden… (kan even duren)'}</div>`;
    const data = await xt(K.items, cat ? { category_id: cat } : {});
    if (!alive()) return;
    items = Array.isArray(data) ? data : [];
    draw();
  }

  sel.onchange = () => { cat = sel.value; limit = 120; save(); load().catch(showErr); };
  let deb;
  q.oninput = () => { clearTimeout(deb); deb = setTimeout(() => { limit = 120; save(); draw(); }, 200); };
  box.onclick = e => {
    if (e.target.closest('[data-more]')) { limit += 240; save(); return draw(); }
    if (e.target.closest('[data-all]')) { cat = ''; sel.value = ''; save(); return load().catch(showErr); }
    const b = e.target.closest('[data-i]');
    if (!b) return;
    const it = shown[+b.dataset.i];
    if (kind === 'live') chooseLive(it);
    else if (kind === 'vod') go('movie', { id: it.stream_id, ext: it.container_extension });
    else go('show', { id: it.series_id, tmdb: it.tmdb || it.tmdb_id || '' });
  };
  function showErr(e) { box.innerHTML = `<div class="error">${esc(e.message)}</div>`; }

  await load();
}

// Tik op een zender: kies casten naar de tv of rechtstreeks kijken in VLC op de gsm
function chooseLive(it) {
  openSheet(`
    <h3>${esc(it.name)}</h3>
    <button class="opt" data-act="cast">📺&nbsp; Casten naar tv</button>
    <button class="opt" data-act="vlc">📱&nbsp; Openen in VLC</button>`, e => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (!a) return;
    closeSheet();
    if (a === 'cast') playLive(it);
    else openInVlc(`${streamBase('live')}/${it.stream_id}.ts`, it.name);
  });
}

// VLC op de gsm haalt de stream zelf rechtstreeks op (via de VPN van de gsm), zonder Worker of Beelink.
function openInVlc(url, title) {
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
    location.href = `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}`;
    return;
  }
  const u = new URL(url);
  const store = 'https://play.google.com/store/apps/details?id=org.videolan.vlc';
  location.href = `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.slice(0, -1)};`
    + `package=org.videolan.vlc;type=video/*;S.title=${encodeURIComponent(title || '')};`
    + `S.browser_fallback_url=${encodeURIComponent(store)};end`;
}

function playLive(it) {
  castMedia({
    live: true,
    url: `${streamBase('live')}/${it.stream_id}.m3u8`,
    ext: 'm3u8',
    title: it.name,
    poster: it.stream_icon,
    key: `live:${it.stream_id}`,
  });
}

function detailHtml({ poster, title, meta, plot }) {
  return `
    <div class="detail-head">
      ${thumb(poster, title, 'poster')}
      <div><h2>${esc(title)}</h2><div class="meta">${esc(meta)}</div></div>
    </div>
    ${plot ? `<p class="plot">${esc(plot)}</p>` : ''}
    <div class="btns" id="playbtns"></div>
    <div id="subs"></div>`;
}

// Knoppen "Casten" / "Verder vanaf ..." onder een film of aflevering.
function bindPlay(key, getMedia) {
  const box = $('#playbtns');
  const pos = store.get(LS_POS, {})[key];
  const canResume = pos && pos.t > 60 && (!pos.d || pos.t < pos.d - 120);
  box.innerHTML = canResume
    ? `<button class="primary" data-t="${pos.t}">▶ Verder kijken vanaf ${fmt(pos.t)}</button>
       <button class="secondary" data-t="0">Vanaf het begin</button>`
    : '<button class="primary" data-t="0">▶ Casten naar tv</button>';
  box.insertAdjacentHTML('beforeend', '<button class="secondary" data-vlc>📱 Openen in VLC</button>');
  box.onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    if ('vlc' in b.dataset) { const m = getMedia(); return openInVlc(m.url, m.title); }
    castMedia({ ...getMedia(), key, start: +b.dataset.t });
  };
}

async function viewMovie({ id, ext }, alive) {
  const d = await xt('get_vod_info', { vod_id: id });
  if (!alive()) return;
  const info = d.info || {}, md = d.movie_data || {};
  const title = md.name || info.name || 'Film';
  const year = yearOf(info, title);
  const poster = info.cover_big || info.movie_image || info.cover;
  setTitle(cleanName(title) || title);
  view.innerHTML = detailHtml({
    poster, title,
    meta: [year, info.genre, info.duration].filter(Boolean).join(' · '),
    plot: info.plot || info.description,
  });
  const picker = subsPicker($('#subs'), { tmdb: info.tmdb_id || info.tmdb, query: cleanName(title), year });
  const fileExt = md.container_extension || ext || 'mp4';
  bindPlay(`vod:${id}`, () => ({
    url: `${streamBase('movie')}/${md.stream_id || id}.${fileExt}`,
    ext: fileExt, title, subtitle: [year, info.genre].filter(Boolean).join(' · '), poster, duration: durationSecs(info),
    ...picker.get(),
  }));
}

async function viewShow({ id, tmdb, season }, alive) {
  const d = await xt('get_series_info', { series_id: id });
  if (!alive()) return;
  const info = d.info || {};
  const title = info.name || 'Serie';
  setTitle(cleanName(title) || title);
  const eps = d.episodes || {};
  const seasons = Object.keys(eps).sort((a, b) => a - b);
  let cur = seasons.includes(String(season)) ? String(season) : seasons[0];

  view.innerHTML = `
    <div class="detail-head">
      ${thumb(info.cover || info.backdrop_path?.[0], title, 'poster')}
      <div><h2>${esc(title)}</h2>
      <div class="meta">${esc([String(info.releaseDate || info.release_date || '').slice(0, 4), info.genre].filter(Boolean).join(' · '))}</div></div>
    </div>
    ${info.plot ? `<p class="plot">${esc(info.plot)}</p>` : ''}
    ${seasons.length > 1 ? `<select id="season" aria-label="Seizoen">${seasons.map(s => `<option value="${esc(s)}">Seizoen ${esc(s)}</option>`).join('')}</select>` : ''}
    <div class="rows" id="eps"></div>`;
  if (!seasons.length) { $('#eps').innerHTML = '<p class="empty">Geen afleveringen gevonden.</p>'; return; }

  const drawEps = () => {
    const pos = store.get(LS_POS, {});
    $('#eps').innerHTML = (eps[cur] || []).map((ep, i) => {
      const p = pos[`ep:${ep.id}`];
      const bar = p?.d ? `<div class="progress"><i style="width:${clamp(p.t / p.d * 100, 2, 100)}%"></i></div>` : '';
      return `<button class="row" data-i="${i}">
        ${thumb(ep.info?.movie_image, String(ep.episode_num), 'logo')}
        <span>${esc(`${ep.episode_num}. ${ep.title || ''}`)}<small>${esc(ep.info?.duration || '')}</small>${bar}</span>
      </button>`;
    }).join('');
  };
  const sel = $('#season');
  if (sel) {
    sel.value = cur;
    sel.onchange = () => {
      cur = sel.value; drawEps();
      history.replaceState({ ...history.state, params: { id, tmdb, season: cur } }, '');
    };
  }
  $('#eps').onclick = e => {
    const b = e.target.closest('[data-i]');
    if (b) go('episode', { id, tmdb: info.tmdb || info.tmdb_id || tmdb || '', season: cur, i: +b.dataset.i });
  };
  drawEps();
}

async function viewEpisode({ id, tmdb, season, i }, alive) {
  const d = await xt('get_series_info', { series_id: id });
  if (!alive()) return;
  const info = d.info || {};
  const list = d.episodes?.[season] || [];
  const ep = list[i];
  if (!ep) throw new Error('Aflevering niet gevonden.');
  const showName = info.name || '';
  const sNum = ep.season || season;
  const eNum = ep.episode_num || i + 1;
  const label = `S${String(sNum).padStart(2, '0')}E${String(eNum).padStart(2, '0')}`;
  const title = ep.title || `${showName} ${label}`;
  const poster = ep.info?.movie_image || info.cover;
  setTitle(`${cleanName(showName)} · ${label}`);
  view.innerHTML = detailHtml({
    poster, title,
    meta: [cleanName(showName), label, ep.info?.duration].filter(Boolean).join(' · '),
    plot: ep.info?.plot,
  }) + (list[i + 1] ? '<button class="more" id="next">Volgende aflevering ›</button>' : '');
  const picker = subsPicker($('#subs'), { tmdb, query: cleanName(showName), season: sNum, episode: eNum });
  const ext = ep.container_extension || 'mp4';
  bindPlay(`ep:${ep.id}`, () => ({
    url: `${streamBase('series')}/${ep.id}.${ext}`,
    ext, title: `${cleanName(showName)} – ${label}`, subtitle: ep.title || '', poster, duration: durationSecs(ep.info),
    ...picker.get(),
  }));
  const next = $('#next');
  if (next) next.onclick = () => {
    history.replaceState({ ...history.state, params: { id, tmdb, season, i: i + 1 } }, '');
    show(history.state);
  };
}

async function viewSettings(params) {
  setTitle('Instellingen');
  view.innerHTML = `
    ${params.first ? '<div class="note">Welkom! Vul eerst je gegevens in. De uitleg voor de tussenschakel staat in de README van het project.</div>' : ''}
    <form id="f" class="form" autocomplete="on">
      <h3>Xtream-login</h3>
      <label>Serveradres<input name="server" type="url" inputmode="url" placeholder="http://provider.com:8080" required></label>
      <label>Gebruikersnaam<input name="user" type="text" autocomplete="username" autocapitalize="off" required></label>
      <label>Wachtwoord<input name="pass" type="password" autocomplete="current-password" required></label>

      <h3>Tussenschakel (Cloudflare Worker)</h3>
      <label>Worker-adres<input name="worker" type="url" inputmode="url" placeholder="https://iptv-cast.jouwnaam.workers.dev" required></label>
      <label>Sleutel (APP_KEY)<input name="key" type="password" autocapitalize="off" required></label>

      <h3>Ondertitels</h3>
      <label>Talen, in volgorde van voorkeur<input name="langs" type="text" placeholder="nl,en" autocapitalize="off"></label>
      <label>Grootte op tv<select name="subScale">
        <option value="0.8">Klein</option><option value="1">Normaal</option>
        <option value="1.3">Groot</option><option value="1.6">Extra groot</option></select></label>
      <label>Ondertitels verschuiven (seconden, bv. -1.5 = vroeger, 1 = later)<input name="subDelay" type="number" step="0.5" min="-30" max="30" inputmode="decimal"></label>

      <h3>Streams</h3>
      <label>Thuis-tussenschakel (Beelink met VPN)<input name="home" type="url" inputmode="url" placeholder="http://192.168.0.242:8030" autocapitalize="off"></label>
      <p class="muted" style="margin:0;font-size:13px">Ingevuld? Dan haalt de Chromecast alle streams via de Beelink op. Leeg laten om de instelling hieronder te gebruiken.</p>
      <label>Films en series afspelen (zonder Beelink)<select name="vodMode">
        <option value="auto">Automatisch (eerst rechtstreeks, anders via tussenschakel)</option>
        <option value="direct">Altijd rechtstreeks</option>
        <option value="proxy">Altijd via tussenschakel</option></select></label>

      <button class="primary" type="submit">Opslaan en verbinding testen</button>
    </form>
    <div id="status"></div>
    <details>
      <summary>Hulp: het lukt niet</summary>
      <ul>
        <li><b>Geen cast-knop?</b> Gebruik Chrome op Android, op hetzelfde wifi-netwerk als de Chromecast. Werkt het niet in de app op je startscherm, probeer dan dezelfde pagina in Chrome zelf.</li>
        <li><b>Film start niet?</b> De Chromecast speelt vooral <i>mp4</i> goed af. <i>mkv</i> lukt enkel op nieuwere modellen (Chromecast met Google TV), <i>avi</i> niet.</li>
        <li><b>Live tv start niet?</b> Je abonnement moet het formaat m3u8 (HLS) toestaan. Dat staat hieronder na het testen.</li>
        <li><b>Geen ondertitels in de lijst?</b> Kijk of OS_API_KEY in de Worker staat. Ondertitels uit de stream zelf kies je tijdens het kijken met de knop CC.</li>
      </ul>
    </details>`;
  const f = $('#f');
  for (const [k, v] of Object.entries(S)) if (f.elements[k]) f.elements[k].value = v;

  f.onsubmit = async e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    v.server = trim(v.server); v.worker = trim(v.worker);
    if (v.server && !/^https?:\/\//i.test(v.server)) v.server = 'http://' + v.server;
    if (v.worker && !/^https?:\/\//i.test(v.worker)) v.worker = 'https://' + v.worker;
    v.home = trim(v.home);
    if (v.home && !/^https?:\/\//i.test(v.home)) v.home = 'http://' + v.home;
    v.langs = String(v.langs || 'nl,en').toLowerCase().replace(/\s+/g, '');
    v.subScale = +v.subScale || 1;
    v.subDelay = Math.max(-30, Math.min(30, +v.subDelay || 0));
    S = { ...S, ...v };
    store.set(LS_SETTINGS, S);
    apiCache.clear();
    f.elements.server.value = S.server; f.elements.worker.value = S.worker;
    await testConnection();
  };
  if (configured() && !params.first) testConnection();
}

async function testConnection() {
  const st = $('#status');
  st.innerHTML = '<p class="muted">Verbinding testen…</p>';
  try {
    const d = await xt('', {}, { cache: false });
    const u = d.user_info || {};
    if (String(u.auth) !== '1') throw new Error('Inloggen mislukt: controleer server, gebruikersnaam en wachtwoord.');
    const exp = u.exp_date ? new Date(u.exp_date * 1000).toLocaleDateString('nl-BE') : 'onbeperkt';
    const formats = (u.allowed_output_formats || []).join(', ') || 'onbekend';
    const hls = (u.allowed_output_formats || []).includes('m3u8');
    st.innerHTML = `<div class="note">
      <div class="status-ok"><b>✓ Verbonden</b></div>
      <div>Status: ${esc(u.status || '?')} · geldig tot ${esc(exp)}</div>
      <div>Max. gelijktijdige streams: ${esc(u.max_connections || '?')}</div>
      <div>Toegestane formaten: ${esc(formats)} ${hls ? '' : '<span class="status-bad">(m3u8 ontbreekt: live tv casten lukt dan waarschijnlijk niet)</span>'}</div>
    </div>`;
  } catch (e) {
    st.innerHTML = `<div class="error status-bad">${esc(e.message)}</div>`;
  }
}

const VIEWS = {
  live: (p, a) => viewList('live', p, a),
  vod: (p, a) => viewList('vod', p, a),
  series: (p, a) => viewList('series', p, a),
  movie: viewMovie,
  show: viewShow,
  episode: viewEpisode,
  settings: viewSettings,
};

// ---------- 5. Ondertitels (OpenSubtitles) ----------
// Zoekt ondertitels en toont een keuzelijst. De gekozen ondertitels gaan mee
// naar de Chromecast; tijdens het kijken kun je wisselen met de knop CC.

function subsPicker(el, q) {
  let tracks = [], active = 0; // active = nummer van het gekozen spoor, 0 = geen
  const api = { get: () => ({ subs: tracks, active }) };
  el.innerHTML = '<h3>Ondertitels</h3><div class="muted">Zoeken op OpenSubtitles…</div>';
  const langs = (S.langs || 'nl,en').split(',').map(s => s.trim()).filter(Boolean);
  const params = { lang: langs.join(',') };
  if (q.tmdb) params.tmdb = q.tmdb;
  if (q.query) params.query = q.query;
  if (q.year) params.year = q.year;
  if (q.season) { params.season = q.season; params.episode = q.episode; }

  fetch(workerUrl('/subs/search', params))
    .then(r => r.json())
    .then(list => {
      if (!Array.isArray(list)) throw new Error(list?.error || 'Onbekende fout');
      const picked = [];
      for (const l of langs) {
        picked.push(...list.filter(x => String(x.lang).toLowerCase().startsWith(l))
          .sort((a, b) => b.downloads - a.downloads).slice(0, 4));
      }
      tracks = picked.map(x => ({
        url: workerUrl('/subs/file', { id: x.id }),
        lang: x.lang,
        label: `${langName(x.lang)}${x.hi ? ' (doven/slechthorenden)' : ''}`,
        release: x.release,
      }));
      active = tracks.length ? 1 : 0;
      el.innerHTML = '<h3>Ondertitels</h3><div class="subs">'
        + `<label class="sub"><input type="radio" name="sub" value="0" ${active ? '' : 'checked'}><span>Geen (of uit de stream zelf, kies tijdens het kijken via CC)</span></label>`
        + tracks.map((t, i) => `<label class="sub"><input type="radio" name="sub" value="${i + 1}" ${i === 0 ? 'checked' : ''}>
            <span><b>${esc(t.label)}</b> · <span class="muted">${esc(t.release)}</span></span></label>`).join('')
        + '</div>'
        + (tracks.length ? '' : '<p class="muted">Geen ondertitels gevonden op OpenSubtitles.</p>');
      el.onchange = e => { if (e.target.name === 'sub') active = +e.target.value; };
    })
    .catch(e => {
      el.innerHTML = `<h3>Ondertitels</h3><p class="muted">OpenSubtitles: ${esc(e.message)}.
        Ondertitels die in de stream zelf zitten, kies je tijdens het kijken via CC.</p>`;
    });
  return api;
}

// ---------- 6. Casten naar de Chromecast ----------

let castCtx = null, player = null, ctrl = null;
let seeking = false, lastSave = 0, lastMedia = null;
const SS_SUB = 'iptvcast.sub'; // gekozen ondertiteltaal ('off' = uit), blijft bij herladen of spoelen

function nowInfo() {
  try { return JSON.parse(sessionStorage.getItem(SS_NOW) || 'null'); } catch { return null; }
}

// Echte positie in de film: bij omzetting begint de tv op 0 vanaf het startpunt.
function realTime() {
  const now = nowInfo();
  const off = now && now.conv && now.contentId === player?.mediaInfo?.contentId ? now.offset : 0;
  return off + (player?.currentTime || 0);
}

function seekTo(T) {
  if (!ctrl || !player?.mediaInfo) return;
  T = Math.max(0, T);
  const now = nowInfo();
  if (now?.conv && now.contentId === player.mediaInfo.contentId) {
    const rel = T - now.offset;
    const have = player.duration || 0; // wat al omgezet is
    if (rel >= 0 && rel <= have - 3) { player.currentTime = rel; ctrl.seek(); return; }
    if (lastMedia && lastMedia.key === now.key) {
      toast('Verder springen: de Beelink start opnieuw vanaf dat punt…', 6000);
      castMedia({ ...lastMedia, start: Math.floor(T) });
      return;
    }
    player.currentTime = Math.max(0, rel); ctrl.seek(); return;
  }
  player.currentTime = T; ctrl.seek();
}

// Zet de ondertitels aan in je voorkeurtaal (of de taal die je zelf koos via CC).
async function autoSubs() {
  const choice = sessionStorage.getItem(SS_SUB);
  if (choice === 'off') return;
  const prefs = choice ? [choice] : (S.langs || 'nl,en').split(',').map(x => x.trim()).filter(Boolean);
  const TEXT = chrome.cast.media.TrackType.TEXT;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    const ms = castCtx?.getCurrentSession()?.getMediaSession();
    const tracks = (ms?.media?.tracks || []).filter(t => t.type === TEXT);
    if (!tracks.length) continue;
    let pick = null;
    for (const l of prefs) {
      pick = tracks.find(t => String(t.language || '').toLowerCase().startsWith(l) && !/sdh/i.test(t.name || ''))
        || tracks.find(t => String(t.language || '').toLowerCase().startsWith(l));
      if (pick) break;
    }
    if (!pick) return;
    const others = (ms.activeTrackIds || []).filter(id => !tracks.some(t => t.trackId === id));
    ms.editTracksInfo(new chrome.cast.media.EditTracksInfoRequest([...others, pick.trackId], trackStyle()),
      () => toast(`Ondertitels: ${pick.name || langName(pick.language)}`), () => {});
    return;
  }
}

window.__onGCastApiAvailable = ok => { if (ok) initCast(); };

function initCast() {
  castCtx = cast.framework.CastContext.getInstance();
  castCtx.setOptions({
    receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });
  player = new cast.framework.RemotePlayer();
  ctrl = new cast.framework.RemotePlayerController(player);
  ctrl.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, onPlayerChange);
  onPlayerChange();
}

function trackStyle() {
  const s = new chrome.cast.media.TextTrackStyle();
  s.foregroundColor = '#FFFFFFFF';
  s.backgroundColor = '#00000000';
  s.edgeType = chrome.cast.media.TextTrackEdgeType.OUTLINE;
  s.edgeColor = '#000000FF';
  s.fontScale = +S.subScale || 1;
  s.fontGenericFamily = chrome.cast.media.TextTrackFontGenericFamily.SANS_SERIF;
  return s;
}

// Welke adressen proberen we, in welke volgorde?
function mediaAttempts(m) {
  const type = MIME[m.ext] || 'video/mp4';
  if (S.home) {
    if (m.live || m.ext === 'm3u8') return [{ url: homeUrl('/m3u8', m.url), type: MIME.m3u8, hls: true }];
    // De Beelink zet geluid (E-AC3 -> AAC) en ondertitels om, vanaf het gevraagde startpunt.
    const start = Math.max(0, Math.floor(m.start || 0));
    const url = `${homeUrl('/hls/play', m.url)}&start=${start}&langs=${enc(S.langs || 'nl,en')}&subdelay=${+S.subDelay || 0}`;
    return [{ url, type: MIME.m3u8, hls: true, conv: true, offset: start }];
  }
  if (m.live || m.ext === 'm3u8') {
    return [
      { url: playlistProxied(m.url), type: MIME.m3u8, hls: true },
      { url: m.url, type: MIME.m3u8, hls: true },
    ];
  }
  const direct = { url: m.url, type }, viaWorker = { url: proxied(m.url), type };
  if (S.vodMode === 'direct') return [direct];
  if (S.vodMode === 'proxy') return [viaWorker];
  return [direct, viaWorker];
}

function buildRequest(m, a) {
  const C = chrome.cast.media;
  const mi = new C.MediaInfo(a.url, a.type);
  mi.streamType = m.live ? C.StreamType.LIVE : C.StreamType.BUFFERED;
  if (a.hls && C.HlsSegmentFormat) {
    mi.hlsSegmentFormat = C.HlsSegmentFormat.TS;
    if (C.HlsVideoSegmentFormat) mi.hlsVideoSegmentFormat = C.HlsVideoSegmentFormat.MPEG2_TS;
  }
  const md = new C.GenericMediaMetadata();
  md.title = m.title || '';
  if (m.subtitle) md.subtitle = m.subtitle;
  const p = imgUrl(m.poster);
  if (p) md.images = [new chrome.cast.Image(p)];
  mi.metadata = md;
  if (m.subs?.length && !a.conv) {
    mi.tracks = m.subs.map((s, i) => {
      const t = new C.Track(i + 1, C.TrackType.TEXT);
      t.trackContentId = s.url;
      t.trackContentType = 'text/vtt';
      t.subtype = C.TextTrackType.SUBTITLES;
      t.name = `${s.label}${s.release ? ' – ' + s.release.slice(0, 40) : ''}`;
      t.language = s.lang;
      return t;
    });
  }
  mi.textTrackStyle = trackStyle();
  const req = new C.LoadRequest(mi);
  req.autoplay = true;
  if (!m.live) req.currentTime = a.conv ? 0 : (m.start || 0);
  req.activeTrackIds = (m.active && !a.conv) ? [m.active] : [];
  return req;
}

async function castMedia(m) {
  if (!castCtx) {
    return toast('Casten is niet beschikbaar. Gebruik Chrome op Android, op hetzelfde wifi als je Chromecast.', 6000);
  }
  if (!castCtx.getCurrentSession()) {
    try { await castCtx.requestSession(); } catch (e) {
      if (e !== 'cancel') toast('Kon geen verbinding maken met de Chromecast.');
      return;
    }
  }
  const session = castCtx.getCurrentSession();
  if (!session) return;
  const attempts = mediaAttempts(m);
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    toast(a.conv ? 'De Beelink zet de film klaar…' : i ? 'Opnieuw proberen via de tussenschakel…' : 'Versturen naar tv…', 10000);
    try {
      await session.loadMedia(buildRequest(m, a));
      sessionStorage.setItem(SS_NOW, JSON.stringify({
        key: m.key, contentId: a.url, conv: !!a.conv, offset: a.offset || 0, total: m.duration || 0,
      }));
      lastMedia = m;
      if (a.conv) autoSubs();
      toast(`Speelt af op ${session.getCastDevice()?.friendlyName || 'tv'}`);
      return;
    } catch (e) {
      console.warn('Laden mislukt', a.url, e);
    }
  }
  toast(m.live
    ? 'De tv kon deze zender niet afspelen. Mogelijk staat m3u8 niet in je abonnement.'
    : `De tv kon dit bestand (.${m.ext}) niet afspelen.`, 7000);
}

function savePos(key, t, d) {
  const all = store.get(LS_POS, {});
  all[key] = { t: Math.floor(t), d: Math.floor(d || 0), at: Date.now() };
  // Bewaar enkel de 300 recentste
  const keys = Object.keys(all);
  if (keys.length > 300) keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 300).forEach(k => delete all[k]);
  store.set(LS_POS, all);
}

function onPlayerChange() {
  const mi = player?.isConnected ? player.mediaInfo : null;
  const mini = $('#mini');
  mini.hidden = !mi;
  document.body.classList.toggle('has-mini', !!mi);
  if (!mi) return;
  const now = nowInfo();
  const mine = !!now && now.contentId === mi.contentId;
  const conv = mine && now.conv;
  const live = !conv && (mi.streamType === chrome.cast.media.StreamType.LIVE || !player.duration);
  const real = realTime();
  const total = conv ? (now.total || now.offset + (player.duration || 0)) : player.duration;
  $('#mini-title').textContent = mi.metadata?.title || 'Speelt af op tv';
  const imgEl = $('#mini-img');
  const src = mi.metadata?.images?.[0]?.url || '';
  if (imgEl.getAttribute('src') !== src) imgEl.setAttribute('src', src);
  const state = player.playerState;
  $('#mini-time').textContent = state === 'BUFFERING' ? 'Bufferen…'
    : live ? 'Live' : `${fmt(real)} / ${fmt(total)}`;
  const seek = $('#mini-seek');
  seek.disabled = live;
  if (!live) { seek.max = Math.floor(total || 0); if (!seeking) seek.value = Math.floor(real); }
  $('#mini [data-act=play]').textContent = player.isPaused ? '▶' : '⏸';

  // Onthoud waar je bent (voor "verder kijken")
  if (mine && !live && real > 5 && Date.now() - lastSave > 5000) {
    savePos(now.key, real, total);
    lastSave = Date.now();
  }
}

$('#mini').addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !ctrl) return;
  if (act === 'play') ctrl.playOrPause();
  if (act === 'stop') ctrl.stop();
  if (act === 'back' || act === 'fwd') seekTo(realTime() + (act === 'back' ? -10 : 30));
  if (act === 'vol-' || act === 'vol+') {
    player.volumeLevel = clamp((player.volumeLevel || 0) + (act === 'vol+' ? 0.05 : -0.05), 0, 1);
    ctrl.setVolumeLevel();
  }
  if (act === 'cc') openTracks();
});
$('#mini-seek').addEventListener('input', () => { seeking = true; $('#mini-time').textContent = `${fmt(+$('#mini-seek').value)} / ${fmt(+$('#mini-seek').max)}`; });
$('#mini-seek').addEventListener('change', () => {
  seekTo(+$('#mini-seek').value);
  seeking = false;
});

// Keuzemenu met alle ondertitelsporen: die van OpenSubtitles én die uit de stream zelf.
function openTracks() {
  const ms = castCtx?.getCurrentSession()?.getMediaSession();
  if (!ms) return;
  const TEXT = chrome.cast.media.TrackType.TEXT;
  const tracks = (ms.media?.tracks || []).filter(t => t.type === TEXT);
  const activeIds = ms.activeTrackIds || [];
  const otherIds = activeIds.filter(id => !tracks.some(t => t.trackId === id)); // audio/video niet aanraken
  const cur = tracks.find(t => activeIds.includes(t.trackId))?.trackId ?? '';
  const scale = +S.subScale || 1;
  const apply = (ids, msg) => ms.editTracksInfo(
    new chrome.cast.media.EditTracksInfoRequest(ids, trackStyle()),
    () => toast(msg), err => toast('Lukt niet: ' + (err?.description || err?.code || 'onbekende fout')));

  openSheet(`
    <h3>Ondertitels</h3>
    <button class="opt ${cur === '' ? 'on' : ''}" data-id="">Uit</button>
    ${tracks.map(t => `<button class="opt ${cur === t.trackId ? 'on' : ''}" data-id="${t.trackId}">
      ${esc(t.name || langName(t.language) || 'Spoor ' + t.trackId)}</button>`).join('')}
    ${tracks.length ? '' : '<p class="muted">Deze stream heeft geen ondertitelsporen.</p>'}
    <h3>Grootte</h3>
    <div class="seg">${[[0.8, 'Klein'], [1, 'Normaal'], [1.3, 'Groot'], [1.6, 'XL']].map(([v, l]) =>
      `<button data-scale="${v}" class="${v === scale ? 'on' : ''}">${l}</button>`).join('')}</div>`,
  e => {
    const o = e.target.closest('[data-id]');
    if (o) {
      const id = o.dataset.id;
      const tr = tracks.find(t => String(t.trackId) === id);
      sessionStorage.setItem(SS_SUB, id ? String(tr?.language || '').toLowerCase().slice(0, 2) || 'off' : 'off');
      apply(id ? [...otherIds, +id] : otherIds, id ? 'Ondertitels aan' : 'Ondertitels uit');
      return closeSheet();
    }
    const sc = e.target.closest('[data-scale]');
    if (sc) {
      S.subScale = +sc.dataset.scale; store.set(LS_SETTINGS, S);
      apply(activeIds, 'Grootte aangepast');
      closeSheet();
    }
  });
}

function openSheet(html, onClick) {
  const sh = $('#sheet');
  $('.sheet-box', sh).innerHTML = html;
  sh.hidden = false;
  sh.onclick = e => { if (e.target === sh) return closeSheet(); onClick(e); };
}
function closeSheet() { $('#sheet').hidden = true; }

// ---------- Start ----------

document.querySelector('.tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (b) goTab(b.dataset.tab);
});
$('#back').onclick = () => history.back();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

{
  const st = history.state || startState();
  history.replaceState(st, '');
  show(st);
}
