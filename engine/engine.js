/* pwa-engine — squelette PWA reutilisable (vanilla JS, zero build).
 *
 * Extrait de plusieurs petites PWA qui partageaient toutes la meme "coque" :
 * service worker, bandeau d'installation, helpers localStorage, navigation
 * entre ecrans, petits sons, vibrations, fond etoile, serie de jours +
 * historique, bus d'evenements, region d'annonce accessible.
 *
 * Usage minimal dans app.js :
 *
 *   AppEngine.boot({ id: 'monapp', version: 'v1.0.0' });
 *
 * Puis on se sert des briques : AppEngine.screens.show('screen-play'),
 * AppEngine.store.save('state', ...), AppEngine.sound.feedback(true), etc.
 *
 * Rien ici ne connait le contenu d'une app : c'est au fichier app.js de
 * cabler sa propre logique de jeu par-dessus.
 *
 * Toutes les chaines visibles par l'utilisateur vivent dans STRINGS (defauts
 * FR) et se surchargent via AppEngine.boot({ strings: { ... } }) ou
 * AppEngine.setStrings({ ... }).
 */
(function (global) {
  'use strict';

  var ENGINE_VERSION = '1.1.0';

  /* ------------------------------------------------------------ Selecteurs */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var reduceMotion = false;
  try {
    reduceMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { /* ignore */ }

  /* --------------------------------------------------------- Chaines (i18n) */
  // Surcharge par boot({ strings }) ou AppEngine.setStrings({ ... }).
  var STRINGS = {
    // history.renderStreak
    streak: function (n) { return '🔥 ' + n + ' jour' + (n > 1 ? 's' : '') + " d'affilee"; },
    // history.renderWeek
    weekDayLabels: ['D', 'L', 'M', 'M', 'J', 'V', 'S'],
    weekNotPlayed: 'pas joue',
    weekCell: function (correct, seen, pct) { return correct + '/' + seen + ' — ' + pct + '%'; },
    weekSummary: function (seen, days, rate) {
      return seen + ' sur ' + days + ' jour' + (days > 1 ? 's' : '') + ' — ' + rate + '% de reussite';
    },
    // installBanner
    installIosHint: "Sur iPhone/iPad : touche « Partager » (le carre avec une fleche vers le haut), puis « Sur l'ecran d'accueil ».",
  };
  function setStrings(obj) {
    if (obj && typeof obj === 'object') {
      for (var k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) STRINGS[k] = obj[k]; }
    }
    return STRINGS;
  }

  /* --------------------------------------------------------- Bus d'evenements */
  // AppEngine.on('screen:show' | 'screen:back' | 'install:available' |
  //   'install:done' | 'sw:registered' | 'sw:updateready' | 'sw:error', fn)
  // -> renvoie une fonction pour se desabonner.
  var bus = {};
  function on(evt, fn) {
    if (typeof fn !== 'function') return function () {};
    (bus[evt] || (bus[evt] = [])).push(fn);
    return function off() {
      var a = bus[evt] || [];
      var i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    };
  }
  function emit(evt, data) {
    (bus[evt] || []).forEach(function (fn) { try { fn(data); } catch (e) { /* ignore */ } });
  }

  /* --------------------------------------------------------- localStorage */
  // Toutes les cles sont prefixees par l'id de l'app (voir boot()), pour que
  // deux apps servies depuis le meme domaine ne se marchent pas dessus.
  var NS = 'app';
  function key(k) { return NS + ':' + k; }

  var store = {
    ns: function (id) { if (id) NS = String(id); return NS; },
    load: function (k, dflt) {
      try {
        var v = localStorage.getItem(key(k));
        return v == null ? dflt : JSON.parse(v);
      } catch (e) { return dflt; }
    },
    save: function (k, val) {
      try {
        localStorage.setItem(key(k), JSON.stringify(val));
      } catch (e) {
        // mode prive, ou quota depasse : l'app peut vouloir prevenir l'utilisateur.
        emit('store:quota', { key: k, error: e });
      }
    },
    remove: function (k) {
      try { localStorage.removeItem(key(k)); } catch (e) { /* ignore */ }
    },
    // Toutes les cles de CETTE app (sans le prefixe).
    keys: function () {
      var out = [];
      try {
        var p = NS + ':';
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(p) === 0) out.push(k.slice(p.length));
        }
      } catch (e) { /* ignore */ }
      return out;
    },
    // Efface tout ce qui appartient a cette app (utile pour un bouton "reset").
    clear: function () {
      try { store.keys().forEach(function (k) { store.remove(k); }); } catch (e) { /* ignore */ }
    },
    // Migrations de schema. steps = { 1: fn, 2: fn, ... } ; chaque fn dont le
    // numero depasse le schema courant est jouee une fois, dans l'ordre.
    // Si une etape jette, on s'arrete SANS avancer le schema : sinon des
    // donnees a moitie migrees seraient marquees comme a jour pour toujours.
    migrate: function (steps) {
      if (!steps) return;
      var cur = store.load('__schema', 0);
      var list = Object.keys(steps).map(Number).sort(function (a, b) { return a - b; });
      for (var i = 0; i < list.length; i++) {
        var v = list[i];
        if (v <= cur) continue;
        try {
          steps[v]();
        } catch (e) {
          console.error('AppEngine.store.migrate: etape ' + v + ' a echoue, arret', e);
          emit('store:migrate-error', { step: v, error: e });
          return;
        }
        store.save('__schema', v);
        cur = v;
      }
    },
  };

  /* -------------------------------------------------- Annonce accessible */
  // Region visually-hidden aria-live : AppEngine.announce('Bravo !').
  var liveEl = null;
  function announce(msg, assertive) {
    try {
      if (!liveEl) {
        liveEl = document.createElement('div');
        liveEl.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
        liveEl.setAttribute('aria-atomic', 'true');
        liveEl.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;'
          + 'padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0';
        document.body.appendChild(liveEl);
      }
      liveEl.textContent = '';
      var el = liveEl;
      setTimeout(function () { el.textContent = String(msg); }, 30);
    } catch (e) { /* ignore */ }
  }

  /* -------------------------------------------------------------- Ecrans */
  // Un "ecran" = un <div class="screen" id="screen-xxx">. show() en montre un
  // seul, pose une classe body.xxx-active (CSS conditionnel), remonte en haut,
  // deplace le focus sur le titre de l'ecran et emet 'screen:show'.
  var backWired = false;
  var hashWired = false;
  var screenHashOn = false;
  var firstShow = true;
  function bareId(id) { return String(id).replace(/^screen-/, ''); }
  // id complet d'un ecran nomme par location.hash (#play ou #screen-play), sinon null.
  function hashScreen() {
    var h = (global.location.hash || '').replace(/^#/, '').replace(/^screen-/, '');
    if (!h) return null;
    var el = document.getElementById('screen-' + h);
    return (el && el.classList.contains('screen')) ? el.id : null;
  }

  var screens = {
    show: function (id, opts) {
      opts = opts || {};
      var target = null;
      $$('.screen').forEach(function (s) {
        var isOn = s.id === id;
        s.classList.toggle('active', isOn);
        if (isOn) target = s;
      });
      if (!target) console.warn('AppEngine.screens.show: ecran inconnu "' + id + '"');

      var bare = bareId(id);
      document.body.classList.add('screen-active');
      // Recalcule a chaque fois : les ecrans ajoutes dynamiquement marchent.
      $$('.screen').forEach(function (s) {
        var n = bareId(s.id);
        document.body.classList.toggle(n + '-active', n === bare);
      });

      try { global.scrollTo(0, 0); } catch (e) { /* ignore */ }

      // Historique : en mode hash, c'est le hash qui porte l'ecran. Chaque
      // changement empile une entree — c'est ce qui fait marcher le retour —
      // sauf le tout premier affichage (etat initial) et si push:false.
      if (screenHashOn && opts.hash !== false) {
        var want = '#' + bare;
        if (global.location.hash !== want) {
          try {
            if (opts.push === false || firstShow) {
              global.history.replaceState(global.history.state, '', want);
            } else {
              global.location.hash = want;                // nouvelle entree d'historique
            }
          } catch (e) { /* ignore */ }
        }
      } else if (opts.push) {
        try { global.history.pushState({ engineScreen: id }, '', global.location.href); } catch (e) { /* ignore */ }
      }
      firstShow = false;

      if (target && opts.focus !== false) {
        var f = target.querySelector('[autofocus], h1, h2, h3') || target;
        if (!f.hasAttribute('tabindex')) f.setAttribute('tabindex', '-1');
        try { f.focus({ preventScroll: true }); } catch (e) { try { f.focus(); } catch (e2) { /* ignore */ } }
      }

      emit('screen:show', id);
    },
    current: function () {
      var el = $('.screen.active');
      return el ? el.id : null;
    },
    // id d'ecran nomme par location.hash, ou null. Pour restaurer l'ecran au
    // chargement :  screens.show(screens.fromHash() || 'screen-home')
    fromHash: function () { return hashScreen(); },
    // Alias historique de on('screen:show', fn). Renvoie la fonction de retrait.
    onShow: function (fn) { return on('screen:show', fn); },
    // Cable le bouton retour (Android) / la fleche navigateur sur les ecrans
    // pousses avec screens.show(id, { push:true }). Appele par boot({ backButton:true }).
    wireBack: function () {
      if (backWired || !global.history) return;
      backWired = true;
      global.addEventListener('popstate', function (e) {
        var id = e.state && e.state.engineScreen;
        if (id) screens.show(id, { push: false });
        else emit('screen:back');
      });
    },
    // Mode hash : location.hash <-> ecran, dans les deux sens. Inclut la
    // gestion du retour (hashchange). Appele par boot({ screenHash:true }).
    wireHash: function () {
      if (hashWired) return;
      hashWired = true;
      screenHashOn = true;
      global.addEventListener('hashchange', function () {
        var id = hashScreen();
        if (id && id !== screens.current()) screens.show(id, { hash: false });
      });
    },
    // Retour arriere programmatique. Si screenHash / backButton est cable,
    // delegue a l'historique du navigateur (qui restaure l'ecran precedent) ;
    // sinon emet 'screen:back', a l'app de decider.
    back: function () {
      if (hashWired || backWired) {
        try { global.history.back(); return; } catch (e) { /* ignore */ }
      }
      emit('screen:back');
    },
  };

  /* -------------------------------------------------------- Petits sons */
  var audioCtx = null;
  var soundOn = true;
  var toneQueue = [];

  function playTone(freq, startAt, dur, type, peak) {
    var t0 = audioCtx.currentTime + (startAt || 0);
    var osc = audioCtx.createOscillator();
    var g = audioCtx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak || 0.2, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(audioCtx.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.03);
  }
  function flushTones() {
    if (!audioCtx || audioCtx.state !== 'running') return;
    var q = toneQueue; toneQueue = [];
    q.forEach(function (a) { try { playTone(a[0], a[1], a[2], a[3], a[4]); } catch (e) { /* ignore */ } });
  }

  var sound = {
    enable: function (v) { soundOn = !!v; if (soundOn) sound.resume(); },
    get enabled() { return soundOn; },
    resume: function () {
      if (!soundOn) return;
      try {
        var AC = global.AudioContext || global.webkitAudioContext;
        if (!AC) return;
        if (!audioCtx) audioCtx = new AC();
        if (audioCtx.state === 'suspended') audioCtx.resume().then(flushTones).catch(function () {});
        else flushTones();
      } catch (e) { audioCtx = null; }
    },
    // Joue tout de suite si le contexte tourne, sinon met en file et rejoue au
    // prochain resume() (1er geste utilisateur) -> plus de premier son muet.
    tone: function (freq, startAt, dur, type, peak) {
      if (!soundOn) return;
      if (audioCtx && audioCtx.state === 'running') {
        try { playTone(freq, startAt, dur, type, peak); } catch (e) { /* ignore */ }
        return;
      }
      toneQueue.push([freq, startAt, dur, type, peak]);
      if (toneQueue.length > 16) toneQueue.shift();
      sound.resume();
    },
    // Petit accord montant si ok, descendant sinon.
    feedback: function (ok) {
      if (!soundOn) return;
      sound.resume();
      if (ok) { sound.tone(660, 0, 0.12, 'sine', 0.22); sound.tone(988, 0.1, 0.16, 'sine', 0.2); }
      else { sound.tone(311, 0, 0.16, 'square', 0.12); sound.tone(233, 0.12, 0.22, 'square', 0.12); }
    },
  };

  /* ------------------------------------------------------------- Vibration */
  // 'success' | 'error' | 'tap' (defaut), ou passe directement un nombre / un
  // tableau de durees (ms) a navigator.vibrate.
  function haptic(type) {
    if (!('vibrate' in navigator)) return;
    var pat;
    if (type === 'success') pat = [20, 35, 25];
    else if (type === 'error') pat = [30, 25, 60];
    else if (type == null || type === 'tap') pat = 10;
    else pat = type;
    try { navigator.vibrate(pat); } catch (e) { /* ignore */ }
  }

  /* --------------------------------------------------------------- Effets */
  var autoBurstWrap = null;      // conteneur de particules cree d'office, reutilise
  var fx = {
    // Remplit un conteneur de petites etoiles qui scintillent (CSS: .star / @keyframes twinkle).
    stars: function (el, count) {
      if (typeof el === 'string') el = $(el);
      if (!el) return;
      var n = count == null ? 60 : count;
      var frag = document.createDocumentFragment();
      for (var i = 0; i < n; i++) {
        var s = document.createElement('div');
        s.className = 'star';
        var sz = Math.random() * 2.5 + 0.5;
        s.style.width = sz + 'px';
        s.style.height = sz + 'px';
        s.style.top = (Math.random() * 100) + '%';
        s.style.left = (Math.random() * 100) + '%';
        s.style.setProperty('--d', (Math.random() * 3 + 2).toFixed(1) + 's');
        s.style.setProperty('--delay', (Math.random() * 4).toFixed(1) + 's');
        s.style.setProperty('--op', (Math.random() * 0.6 + 0.2).toFixed(2));
        frag.appendChild(s);
      }
      el.appendChild(frag);
    },
    // Gerbe de particules depuis le centre de l'ecran (CSS: .burst-particle / @keyframes burst).
    // No-op si l'utilisateur a demande "moins d'animations".
    burst: function (positive, opts) {
      if (reduceMotion) return;
      opts = opts || {};
      // Le conteneur cree d'office est memorise : sans ca, chaque appel
      // ajoutait un nouveau div plein ecran au body, jamais retire.
      var wrap = opts.container || document.getElementById('burst') || autoBurstWrap;
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'burst-container';
        document.body.appendChild(wrap);
        autoBurstWrap = wrap;
      }
      // Un burst declenche moins d'une seconde apres le precedent ne doit pas
      // se faire effacer par le minuteur de celui-ci.
      if (wrap._burstTimer) { clearTimeout(wrap._burstTimer); wrap._burstTimer = null; }
      wrap.innerHTML = '';
      var colors = opts.colors || (positive
        ? ['#FFD60A', '#4ADE80', '#60A5FA', '#F472B6', '#FBBF24']
        : ['#FF6B6B', '#F87171', '#FCA5A5']);
      var cx = global.innerWidth / 2, cy = global.innerHeight / 2;
      var n = positive ? 28 : 12;
      for (var i = 0; i < n; i++) {
        var p = document.createElement('div');
        p.className = 'burst-particle';
        var angle = (i / n) * 360;
        var dist = positive ? (80 + Math.random() * 160) : (40 + Math.random() * 80);
        var rad = angle * Math.PI / 180;
        p.style.left = cx + 'px';
        p.style.top = cy + 'px';
        p.style.background = colors[i % colors.length];
        p.style.width = (positive ? 10 : 7) + 'px';
        p.style.height = (positive ? 10 : 7) + 'px';
        p.style.setProperty('--dx', (Math.cos(rad) * dist) + 'px');
        p.style.setProperty('--dy', (Math.sin(rad) * dist) + 'px');
        p.style.animationDuration = positive ? '0.9s' : '0.6s';
        wrap.appendChild(p);
      }
      wrap._burstTimer = setTimeout(function () {
        wrap.innerHTML = '';
        wrap._burstTimer = null;
      }, 1000);
    },
  };

  /* ------------------------------------------- Serie de jours + historique */
  var DAY = 864e5;
  function dayStr(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');
  }

  var history = {
    dayStr: dayStr,
    // A appeler une fois par partie : incremente la serie si on a joue hier,
    // la remet a 1 sinon, ne fait rien si on a deja joue aujourd'hui.
    bumpStreak: function () {
      var today = dayStr(Date.now());
      var yest = dayStr(Date.now() - DAY);
      var s = store.load('streak', { count: 0, lastDay: '' });
      if (s.lastDay === today) return;
      s.count = (s.lastDay === yest) ? (s.count + 1) : 1;
      s.lastDay = today;
      store.save('streak', s);
    },
    // -> { count, alive }  (alive = serie encore valable aujourd'hui ou hier)
    streak: function () {
      var s = store.load('streak', { count: 0, lastDay: '' });
      var today = dayStr(Date.now());
      var yest = dayStr(Date.now() - DAY);
      return { count: s.count, alive: s.count > 0 && (s.lastDay === today || s.lastDay === yest) };
    },
    renderStreak: function (el) {
      if (typeof el === 'string') el = $(el);
      if (!el) return;
      var s = history.streak();
      el.hidden = !s.alive;
      if (s.alive) el.textContent = STRINGS.streak(s.count);
    },
    // Journalise "vu / reussi" du jour, purge au-dela de 60 jours.
    logDaily: function (seen, correct) {
      // Coercition : un `correct` omis ecrirait NaN, qui ressort en "NaN%"
      // dans les barres et le resume de la semaine.
      seen = Number(seen) || 0;
      correct = Number(correct) || 0;
      if (!seen) return;
      var log = store.load('daily', {});
      var k = dayStr(Date.now());
      var e = log[k] || { seen: 0, correct: 0 };
      e.seen += seen;
      e.correct += correct;
      log[k] = e;
      var cutoff = dayStr(Date.now() - 60 * DAY);
      Object.keys(log).forEach(function (d) { if (d < cutoff) delete log[d]; });
      store.save('daily', log);
    },
    // Barres des 7 derniers jours. Passe les elements (ou leurs selecteurs) :
    //   { bars, block, summary }
    renderWeek: function (els) {
      els = els || {};
      var wrap = typeof els.bars === 'string' ? $(els.bars) : els.bars;
      var block = typeof els.block === 'string' ? $(els.block) : els.block;
      var sum = typeof els.summary === 'string' ? $(els.summary) : els.summary;
      if (!wrap || !block) return;
      var log = store.load('daily', {});
      var labels = STRINGS.weekDayLabels;
      wrap.innerHTML = '';
      var tSeen = 0, tCorrect = 0, days = 0;
      for (var i = 6; i >= 0; i--) {
        var ms = Date.now() - i * DAY;
        var e = log[dayStr(ms)];
        var has = !!(e && e.seen);
        var pct = has ? Math.round((e.correct / e.seen) * 100) : 0;
        if (has) { tSeen += e.seen; tCorrect += e.correct; days += 1; }
        var col = document.createElement('div');
        col.className = 'week-col';
        var bar = document.createElement('div');
        bar.className = 'week-bar';
        bar.style.height = has ? Math.max(8, pct) + '%' : '3px';
        if (has) bar.style.background = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--yellow)' : 'var(--red)';
        bar.title = has ? STRINGS.weekCell(e.correct, e.seen, pct) : STRINGS.weekNotPlayed;
        var lab = document.createElement('span');
        lab.className = 'week-lab';
        lab.textContent = labels[new Date(ms).getDay()];
        col.appendChild(bar); col.appendChild(lab);
        wrap.appendChild(col);
      }
      if (tSeen === 0) { block.hidden = true; return; }
      block.hidden = false;
      if (sum) {
        var rate = Math.round((tCorrect / tSeen) * 100);
        sum.textContent = STRINGS.weekSummary(tSeen, days, rate);
      }
    },
  };

  /* --------------------------------------------- Bandeau "Installer l'appli" */
  // Gere beforeinstallprompt (Android/Chrome) + le cas iOS Safari (qui ne le
  // declenche jamais : on affiche alors la marche a suivre manuelle).
  function installBanner(cfg) {
    cfg = cfg || {};
    var row = typeof cfg.row === 'string' ? $(cfg.row) : (cfg.row || $('#install-row'));
    var btn = typeof cfg.btn === 'string' ? $(cfg.btn) : (cfg.btn || $('#install-btn'));
    var dismiss = typeof cfg.dismiss === 'string' ? $(cfg.dismiss) : (cfg.dismiss || $('#install-dismiss'));
    var hint = typeof cfg.hint === 'string' ? $(cfg.hint) : (cfg.hint || $('#install-hint'));
    var api = { refresh: function () {} };
    if (!row || !btn) return api;

    var hideKey = cfg.hideKey || 'install-hidden';
    var showOn = typeof cfg.showOn === 'function' ? cfg.showOn : function () { return true; };
    var iosHint = cfg.iosHint || STRINGS.installIosHint;

    var deferred = null;
    var mode = null;               // null | 'prompt' | 'ios'
    var hiddenByUser = store.load(hideKey, false) === true || store.load(hideKey, false) === '1';

    function isStandalone() {
      return global.matchMedia('(display-mode: standalone)').matches
        || global.navigator.standalone === true
        || document.referrer.indexOf('android-app://') === 0;
    }
    var iOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var iOSSafari = iOS && /safari/i.test(navigator.userAgent)
      && !/crios|fxios|edgios|opios|android/i.test(navigator.userAgent);

    function refresh() {
      var show = !!mode && !hiddenByUser && !isStandalone() && !!showOn();
      row.hidden = !show;
      if (!show && hint) hint.hidden = true;
      if (show) row.dataset.mode = mode;
    }
    function forget() {
      hiddenByUser = true;
      store.save(hideKey, true);
      refresh();
    }

    global.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferred = e;
      mode = 'prompt';
      refresh();
      emit('install:available', { mode: 'prompt' });
    });
    global.addEventListener('appinstalled', function () {
      deferred = null;
      mode = null;
      // Pas de forget() : ca persisterait "masque" pour toujours et le bandeau
      // ne reviendrait jamais apres une desinstallation. isStandalone() suffit
      // a le cacher tant que l'app est installee.
      refresh();
      emit('install:done', null);
    });

    btn.addEventListener('click', function () {
      if (mode === 'ios') {
        if (hint) {
          hint.hidden = !hint.hidden;
          hint.textContent = iosHint;
          btn.setAttribute('aria-expanded', String(!hint.hidden));
        }
        return;
      }
      if (!deferred) return;
      btn.disabled = true;
      deferred.prompt();
      Promise.resolve(deferred.userChoice).catch(function () {}).then(function () {
        deferred = null;
        mode = null;
        btn.disabled = false;
        refresh();
      });
    });
    if (dismiss) dismiss.addEventListener('click', forget);

    if (iOSSafari) {
      mode = 'ios';
      if (hint && hint.id) btn.setAttribute('aria-controls', hint.id);
      btn.setAttribute('aria-expanded', 'false');
      emit('install:available', { mode: 'ios' });
    }
    refresh();
    api.refresh = refresh;
    on('screen:show', refresh);   // reevalue a chaque changement d'ecran
    return api;
  }

  /* --------------------------------------------------------- Service worker */
  // Enregistre le SW avec un cache-buster ?v=<version>. Quand une nouvelle
  // version est prete, emet 'sw:updateready' { registration, apply }. Par
  // defaut (autoReload !== false) applique et recharge une seule fois ; passe
  // autoReload:false pour laisser l'app afficher un "nouvelle version, toucher
  // pour recharger" et appeler apply() elle-meme.
  function registerServiceWorker(cfg) {
    cfg = cfg || {};
    if (!('serviceWorker' in navigator)) return;
    var version = cfg.version || 'v1';
    var url = cfg.url || 'service-worker.js';
    var autoReload = cfg.autoReload !== false;

    // On recharge sur 'controllerchange' (= le nouveau SW controle vraiment la
    // page), pas juste apres avoir poste SKIP_WAITING : sinon la course est
    // perdue et l'utilisateur reste sur l'ancienne version.
    // `hadController` distingue une MISE A JOUR d'une premiere installation
    // (ou controllerchange se declenche aussi, sans qu'il y ait rien a recharger).
    var hadController = !!navigator.serviceWorker.controller;
    var reloading = false;
    if (autoReload) {
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (reloading || !hadController) return;
        reloading = true;
        global.location.reload();
      });
    }

    global.addEventListener('load', function () {
      navigator.serviceWorker.register(url + '?v=' + encodeURIComponent(version)).then(function (reg) {
        function updateReady(worker) {
          var apply = function () { try { worker.postMessage({ type: 'SKIP_WAITING' }); } catch (e) { /* ignore */ } };
          emit('sw:updateready', { registration: reg, apply: apply });
          if (autoReload) apply();   // le rechargement suivra via controllerchange
        }
        if (reg.waiting && navigator.serviceWorker.controller) updateReady(reg.waiting);
        reg.addEventListener('updatefound', function () {
          var nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', function () {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) updateReady(nw);
          });
        });
        emit('sw:registered', reg);
      }).catch(function (err) {
        console.warn('Service worker registration failed:', err);
        emit('sw:error', err);
      });
    });
  }

  /* ---------------------------------------------------------------- boot() */
  // Cablage courant, a appeler tout en haut de app.js. Tout est optionnel
  // sauf `id`. Renvoie { install } (le handle du bandeau, avec .refresh()).
  function boot(config) {
    config = config || {};
    if (!config.id) console.warn('AppEngine.boot: pas d\'`id` -> localStorage non prefixe');
    store.ns(config.id || 'app');

    if (config.strings) setStrings(config.strings);

    // Badge de version dans l'entete
    if (config.version && config.versionBadgeSel !== false) {
      var badge = $(config.versionBadgeSel || '#app-version');
      if (badge) badge.textContent = config.version;
    }

    // Fond etoile
    if (config.stars !== false && config.stars !== 0) {
      fx.stars(config.starsSel || '#stars', typeof config.stars === 'number' ? config.stars : 60);
    }

    // Serie de jours (si un badge est present)
    if (config.streakBadgeSel !== false) {
      history.renderStreak(config.streakBadgeSel || '#streak-badge');
    }

    // Navigation (opt-in). screenHash inclut deja la gestion du retour :
    // ne combine pas les deux.
    if (config.screenHash) screens.wireHash();
    else if (config.backButton) screens.wireBack();

    // Bandeau d'installation
    var install = { refresh: function () {} };
    if (config.install !== false) {
      var ic = typeof config.install === 'object' ? config.install : {};
      if (ic.showOn == null) {
        ic.showOn = function () {
          var cur = screens.current();
          return cur == null || cur === 'screen-home' || cur === 'screen-settings' || cur === 'screen-title';
        };
      }
      install = installBanner(ic);
    }

    // Service worker
    if (config.serviceWorker !== false) {
      registerServiceWorker({
        version: config.version || 'v1',
        url: config.swUrl || 'service-worker.js',
        autoReload: config.autoReload,
      });
    }

    try {
      console.info('%cAppEngine ' + ENGINE_VERSION + '%c · ' + (config.id || 'app') + ' ' + (config.version || ''),
        'font-weight:bold', 'font-weight:normal');
    } catch (e) { /* ignore */ }

    return { install: install };
  }

  /* -------------------------------------------------------------- Exports */
  global.AppEngine = {
    version: ENGINE_VERSION,
    reduceMotion: reduceMotion,
    $: $,
    $$: $$,
    on: on,
    emit: emit,
    strings: STRINGS,
    setStrings: setStrings,
    announce: announce,
    store: store,
    screens: screens,
    sound: sound,
    haptic: haptic,
    fx: fx,
    history: history,
    installBanner: installBanner,
    registerServiceWorker: registerServiceWorker,
    boot: boot,
  };
})(typeof window !== 'undefined' ? window : this);
