// panel.js — the page a phone opens from a QR code: only that code's tiles.
//
// The address carries the code after the #, so it never reaches a web server:
//   …/app/panel/#c=<id>.<secret>[&p=<broker port>]
// The page is an MQTT client of the edge's broker (tinymqtt.js). It reads its
// tiles (scope) and their values (state), sends taps (act), and with a bell
// code rings or shows who rings. Plain ES2017, no libraries.
'use strict';

var TEXTS = {
  en: { up: 'connected', down: 'no link', nocode: 'This address has no code. Scan the QR code again.', refused: 'This code is no longer valid. Ask for a new one.',
    empty: 'Nothing to switch here.', on: 'on', off: 'off', away: 'not reachable', open: 'open', closed: 'closed', ring: 'Ring', rung: 'I have rung.', nobody: 'I have rung. Please wait.',
    rings: 'is ringing', coming: 'I am coming', wait: 'One moment', leave: 'Leave it at the door', close: 'Close',
    a_coming: 'Someone is coming.', a_wait: 'One moment, please.', a_leave: 'Please leave it at the door.', answered: 'answered', listen: 'This phone rings with the door bell while this page is open.', sound: 'Tap once so the bell can sound' },
  de: { up: 'verbunden', down: 'keine Verbindung', nocode: 'Diese Adresse hat keinen Code. Bitte den QR-Code noch einmal scannen.', refused: 'Dieser Code gilt nicht mehr. Bitte einen neuen geben lassen.',
    empty: 'Hier gibt es nichts zu schalten.', on: 'an', off: 'aus', away: 'nicht erreichbar', open: 'offen', closed: 'zu', ring: 'Klingeln', rung: 'Ich habe geklingelt.', nobody: 'Ich habe geklingelt. Bitte warten.',
    rings: 'klingelt', coming: 'Ich komme', wait: 'Einen Moment', leave: 'Bitte abstellen', close: 'Schließen',
    a_coming: 'Es kommt jemand.', a_wait: 'Einen Moment, bitte.', a_leave: 'Bitte vor der Tür abstellen.', answered: 'hat geantwortet', listen: 'Dieses Handy klingelt mit, solange diese Seite offen ist.', sound: 'Einmal tippen, damit die Klingel zu hören ist' },
  fr: { up: 'connecté', down: 'pas de lien', nocode: 'Cette adresse n\'a pas de code. Scannez de nouveau le code QR.', refused: 'Ce code n\'est plus valable. Demandez-en un nouveau.',
    empty: 'Rien à commander ici.', on: 'allumé', off: 'éteint', away: 'injoignable', open: 'ouvert', closed: 'fermé', ring: 'Sonner', rung: 'J\'ai sonné.', nobody: 'J\'ai sonné. Merci de patienter.',
    rings: 'sonne', coming: 'J\'arrive', wait: 'Un instant', leave: 'Déposez-le devant la porte', close: 'Fermer',
    a_coming: 'Quelqu\'un arrive.', a_wait: 'Un instant, s\'il vous plaît.', a_leave: 'Merci de le déposer devant la porte.', answered: 'a répondu', listen: 'Ce téléphone sonne avec la sonnette tant que cette page est ouverte.', sound: 'Touchez une fois pour entendre la sonnette' }
};
var ICONS = { light: '💡', switch: '🔌', blind: '🪟', heating: '🌡️' };

var Q = {};
location.hash.slice(1).split('&').forEach(function (kv) { var i = kv.indexOf('='); if (i > 0) Q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
var parts = (Q.c || '').split('.'), ID = parts[0], SECRET = parts[1];
var BASE = 'dhc/panel/' + ID + '/';
// The code's language travels in the QR link (&l=), so the first screen already speaks it.
var lang = Q.l || (navigator.language || 'en').slice(0, 2); if (!TEXTS[lang]) lang = 'en';
document.documentElement.lang = lang;
var scope = null, state = {}, pending = {}, link = null, audio = null, ringTimer = 0, cardTimer = 0;

function t(k) { return TEXTS[lang][k] || TEXTS.en[k] || k; }
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
var $ = function (id) { return document.getElementById(id); };
function note(text) { $('note').textContent = text || ''; }
function showLink(up) { $('link').className = 'link ' + (up ? 'up' : 'down'); $('link').textContent = t(up ? 'up' : 'down'); }

// ── tiles ───────────────────────────────────────────────────────────────────

function act(tile, action, value) {
  if (!link || !link.publish(BASE + 'act', JSON.stringify({ tile: tile.id, action: action, value: value }))) return;
  pending[tile.id] = Date.now();
  if (navigator.vibrate) navigator.vibrate(30);
  paint();
  setTimeout(paint, 2600);
}

function valueText(tile, s) {
  if (s.reachable === false) return t('away');
  if (tile.kind === 'thermostat') return (s.setpoint != null ? s.setpoint.toFixed(1) + ' °C' : '–') + (s.temp != null ? '  ·  ' + s.temp.toFixed(1) + ' °C' : '');
  if (tile.kind === 'blind') return s.level == null ? '–' : (s.level >= 99 ? t('open') : s.level <= 1 ? t('closed') : s.level + ' %');
  if (s.on == null) return '–';
  return s.on ? (tile.kind === 'dimmer' && s.level != null ? s.level + ' %' : t('on')) : t('off');
}

function step(label, name, fn) { var b = el('button', 'step', label); b.type = 'button'; b.setAttribute('aria-label', name); b.onclick = fn; return b; }

function tileNode(tile) {
  var s = state[tile.id] || {}, box = el('div', 'tile' + (s.on ? ' on' : '') + (s.reachable === false ? ' away' : '') + (pending[tile.id] && Date.now() - pending[tile.id] < 2500 ? ' wait' : ''));
  var main = el('button', 'tile-main'); main.type = 'button';
  main.appendChild(el('span', 'icon', ICONS[tile.func] || '•'));
  main.appendChild(el('span', 'label', tile.label));
  main.appendChild(el('span', 'value', valueText(tile, s)));
  box.appendChild(main);
  var steps = el('div', 'steps');
  if (tile.kind === 'switch' || tile.kind === 'dimmer') main.onclick = function () { act(tile, s.on ? 'off' : 'on'); };
  if (tile.kind === 'dimmer') {
    var lv = s.on && s.level != null ? s.level : 0;
    steps.appendChild(step('−', tile.label + ' −', function () { act(tile, 'level', Math.max(0, lv - 20)); }));
    steps.appendChild(step('+', tile.label + ' +', function () { act(tile, 'level', Math.min(100, lv + 20)); }));
  }
  if (tile.kind === 'blind') {
    steps.appendChild(step('▼', tile.label + ' ' + t('closed'), function () { act(tile, 'level', 0); }));
    steps.appendChild(step('▲', tile.label + ' ' + t('open'), function () { act(tile, 'level', 100); }));
  }
  if (tile.kind === 'thermostat') {
    var sp = s.setpoint != null ? s.setpoint : 20;
    steps.appendChild(step('−', tile.label + ' −', function () { act(tile, 'setpoint', sp - 0.5); }));
    steps.appendChild(step('+', tile.label + ' +', function () { act(tile, 'setpoint', sp + 0.5); }));
  }
  if (steps.childNodes.length) box.appendChild(steps);
  return box;
}

function paint() {
  if (!scope) return;
  var main = $('main'), keep = window.scrollY;
  main.textContent = '';
  $('name').textContent = scope.name; document.title = scope.name;
  if (scope.bell === 'ring') {
    var b = el('button', 'ring'); b.type = 'button'; b.appendChild(el('small', '', '🔔')); b.appendChild(document.createTextNode(t('ring')));
    b.onclick = function () { soundOn(); if (link) link.publish(BASE + 'ring', '{}'); if (navigator.vibrate) navigator.vibrate(80); };
    main.appendChild(b);
  }
  var rooms = [], byRoom = {};
  scope.tiles.forEach(function (tile) { var r = tile.room || ''; if (!byRoom[r]) { byRoom[r] = []; rooms.push(r); } byRoom[r].push(tile); });
  rooms.forEach(function (r) {
    if (rooms.length > 1 || r) main.appendChild(el('h2', '', r || '·'));
    var grid = el('div', 'tiles'); byRoom[r].forEach(function (tile) { grid.appendChild(tileNode(tile)); }); main.appendChild(grid);
  });
  if (scope.bell === 'listen') note(audio ? t('listen') : t('sound'));
  else if (!scope.tiles.length && scope.bell !== 'ring') note(t('empty'));
  else note('');
  window.scrollTo(0, keep);
}

// ── the bell ────────────────────────────────────────────────────────────────

function soundOn() {   // browsers let a page sound only after a touch
  if (audio) return;
  var A = window.AudioContext || window.webkitAudioContext; if (!A) return;
  try { audio = new A(); if (scope && scope.bell === 'listen') note(t('listen')); } catch (e) { audio = null; }
}
document.addEventListener('click', soundOn);

function dingDong() {
  if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
  if (!audio) return;
  [[660, 0], [520, 0.45]].forEach(function (n) {
    var o = audio.createOscillator(), g = audio.createGain(), at = audio.currentTime + n[1];
    o.type = 'sine'; o.frequency.value = n[0]; g.gain.setValueAtTime(0.5, at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.9);
    o.connect(g); g.connect(audio.destination); o.start(at); o.stop(at + 1);
  });
}

function card(icon, text, buttons, ringing, ms) {
  clearTimeout(cardTimer); clearInterval(ringTimer);
  $('card-icon').textContent = icon; $('card-text').textContent = text;
  var box = $('card-buttons'); box.textContent = '';
  buttons.forEach(function (b) { var n = el('button', b.quiet ? 'quiet' : '', b.label); n.type = 'button'; n.onclick = b.fn; box.appendChild(n); });
  $('card').className = 'card' + (ringing ? ' ringing' : ''); $('card').hidden = false;
  if (ringing) { dingDong(); ringTimer = setInterval(dingDong, 4000); }
  cardTimer = setTimeout(closeCard, ms || 60000);
}
function closeCard() { clearTimeout(cardTimer); clearInterval(ringTimer); $('card').hidden = true; }

function onEvent(e) {
  var close = { label: t('close'), quiet: true, fn: closeCard };
  if (e.t === 'ring') {
    var answer = function (a) { return { label: t(a), fn: function () { link.publish(BASE + 'answer', JSON.stringify({ answer: a })); closeCard(); } }; };
    card('🔔', e.from + ' ' + t('rings'), [answer('coming'), answer('wait'), answer('leave'), close], true, 60000);
  } else if (e.t === 'answered') {
    if (!$('card').hidden) card('✅', e.by + ' ' + t('answered') + ': ' + t(e.answer), [close], false, 4000);
  } else if (e.t === 'rung') {
    card('🔔', t(e.listeners > 0 ? 'rung' : 'nobody'), [close], false, 20000);
  } else if (e.t === 'answer') {
    card(e.answer === 'coming' ? '🙂' : e.answer === 'wait' ? '⏳' : '📦', t('a_' + e.answer), [close], false, 30000);
    if (navigator.vibrate) navigator.vibrate(200);
  } else if (e.t === 'refused') {
    delete pending[e.tile]; paint();
  }
}

// ── the link ────────────────────────────────────────────────────────────────

function start() {
  showLink(false);
  if (!ID || !SECRET) { $('name').textContent = 'DigitalHome'; note(t('nocode')); return; }
  var secure = location.protocol === 'https:';
  link = tinymqtt({
    url: (secure ? 'wss://' : 'ws://') + location.hostname + ':' + (Q.p || '9001'),
    username: ID, password: SECRET,
    will: { topic: BASE + 'status', payload: '{"state":"offline"}', retain: true },
    onUp: function () { showLink(true); link.publish(BASE + 'status', '{"state":"online"}', true); },
    onDown: function (why) { showLink(false); if (why === 'refused') { scope = null; $('main').textContent = ''; closeCard(); note(t('refused')); } },
    onMessage: function (topic, text) {
      var body; try { body = text ? JSON.parse(text) : null; } catch (e) { return; }
      var leaf = topic.slice(BASE.length);
      if (leaf === 'scope' && body) { scope = body; if (TEXTS[body.lang]) { lang = body.lang; document.documentElement.lang = lang; showLink(true); } paint(); }
      else if (leaf === 'state' && body) { state = body; pending = {}; paint(); }
      else if (leaf === 'event' && body) onEvent(body);
    }
  });
  link.subscribe(BASE + '#');
}
window.addEventListener('hashchange', function () { location.reload(); });
start();
