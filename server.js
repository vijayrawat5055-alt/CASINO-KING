// 3 IKKE multiplayer server — Node.js + Express + Socket.IO
// Server shuffles/deals, validates every move, keeps cards private per player.
const express = require('express'), http = require('http'), crypto = require('crypto');
const { Server } = require('socket.io');
const app = express();
app.use(express.static(__dirname + '/public'));
// Pages also work if uploaded flat next to server.js (phone upload): safe whitelist, nothing else is exposed
const sendPage = f => (q, r) => { const p = require('path').join(__dirname, 'public', f); r.sendFile(require('fs').existsSync(p) ? p : require('path').join(__dirname, f)); };
app.get(['/', '/index.html'], sendPage('index.html'));
app.get('/ikke.html', sendPage('ikke.html'));
app.get('/mang.html', sendPage('mang.html'));
app.get('/health', (_, r) => r.json({ tables: tables.size, players: players.size }));
const srv = http.createServer(app);
const io = new Server(srv, { cors: { origin: '*' } });

const BOOT = 20, TURN_MS = 10000, NEXT_MS = 6000, START_BAL = 125430, MIN_P = 3, MAX_P = 6;
const tables = new Map(), open = new Set(), players = new Map();
let seq = 1;
// ---------- database: JSON file store (players + balances), debounced atomic writes ----------
const fs = require('fs'), DBF = process.env.DB_FILE || __dirname + '/data.json'; let dbT = null;
try { for (const p of JSON.parse(fs.readFileSync(DBF, 'utf8'))) players.set(p.token, { ...p, table: null, sock: null }); } catch {}
function saveDB() { clearTimeout(dbT); dbT = setTimeout(() => { try {
  const o = [...players.values()].map(({ token, name, bal, email, salt, pw }) => ({ token, name, bal }));
  fs.writeFileSync(DBF + '.tmp', JSON.stringify(o)); fs.renameSync(DBF + '.tmp', DBF);
} catch (e) { console.error('db', e.message); } }, 1000); }

// ---------- CASINO KING accounts: email + password (scrypt hash), shared by both games ----------
app.use(express.json({ limit: '2kb' }));
const byEmail = new Map(); for (const p of players.values()) if (p.email) byEmail.set(p.email, p);
const hits = new Map();
const limited = ip => { const n = Date.now(), a = (hits.get(ip) || []).filter(t => n - t < 60000); a.push(n); hits.set(ip, a); return a.length > 10; };
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32);
const sess = p => ({ token: p.token, name: p.name, bal: p.bal });
app.post('/api/signup', (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  const { email, password, name } = req.body || {}, e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return res.status(400).json({ error: 'Enter a valid email' });
  if (String(password || '').length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (byEmail.has(e)) return res.status(409).json({ error: 'This email is already registered. Log in instead.' });
  const salt = crypto.randomBytes(16).toString('hex'), token = crypto.randomUUID();
  const p = { token, name: String(name || e.split('@')[0]).trim().slice(0, 14) || 'Player', bal: START_BAL, email: e, salt, pw: hashPw(String(password), salt).toString('hex'), table: null, sock: null };
  players.set(token, p); byEmail.set(e, p); saveDB(); res.json(sess(p));
});
app.post('/api/login', (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  const { email, password } = req.body || {}, p = byEmail.get(String(email || '').trim().toLowerCase());
  const good = p && crypto.timingSafeEqual(hashPw(String(password || ''), p.salt), Buffer.from(p.pw, 'hex'));
  if (!good) return res.status(401).json({ error: 'Wrong email or password' });
  res.json(sess(p));
});
app.post('/api/me', (req, res) => { const p = players.get((req.body || {}).token); p && p.email ? res.json(sess(p)) : res.status(401).json({ error: 'Session expired' }); });

// ---------- hand ranking: Trail > Pure Seq > Seq > Color > Pair > High (AAA highest) ----------
function score(cards) {
  let v = cards.map(c => c.r).sort((a, b) => b - a);
  const col = cards.every(c => c.s === cards[0].s), trail = v[0] === v[2];
  const a23 = v.join() === '14,3,2';
  const seq = (v[0] - v[1] === 1 && v[1] - v[2] === 1) || a23;
  if (a23) v = [3, 2, 1];
  const cat = trail ? 6 : seq && col ? 5 : seq ? 4 : col ? 3 : (v[0] === v[1] || v[1] === v[2]) ? 2 : 1;
  if (cat === 2) { const p = v[0] === v[1] ? v[0] : v[1], k = v[0] === v[1] ? v[2] : v[0]; v = [p, k, 0]; }
  return cat * 1e6 + v[0] * 1e4 + v[1] * 100 + v[2];
}
const HAND = ['', 'High Card', 'Pair', 'Color', 'Sequence', 'Pure Sequence', 'Trail'];
const handName = c => HAND[Math.floor(score(c) / 1e6)];

function newDeck() {
  const d = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ r, s });
  for (let i = 51; i > 0; i--) { const j = crypto.randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

// ---------- tables ----------
function createTable() {
  const t = { id: 'T' + seq++, seats: [], phase: 'wait', pot: 0, chaal: BOOT, turn: 0, dealer: -1,
    deadline: 0, timer: null, startT: null, reveal: false, result: null };
  tables.set(t.id, t); return t;
}
function updateOpen(t) { t.seats.length < MAX_P ? open.add(t.id) : open.delete(t.id); }
function findTable() {
  for (const id of open) return tables.get(id);
  return createTable();
}
const active = t => t.seats.filter(s => s.in && s.active);

function view(t, me) {
  return {
    table: t.id, phase: t.phase, pot: t.pot, chaal: t.chaal, boot: BOOT, deadline: t.deadline,
    now: Date.now(), turn: t.phase === 'play' ? t.turn : -1, dealer: t.dealer, result: t.result,
    seats: t.seats.map(s => ({
      token: s.token === me ? s.token : undefined, id: s.id, name: s.name, bal: s.p.bal, in: s.in, active: s.active,
      seen: s.seen, bet: s.bet, connected: s.connected, me: s.token === me,
      cards: s.in && ((s.token === me && (s.seen || t.reveal)) || (t.reveal && s.active)) ? s.cards : null
    }))
  };
}
function send(t) { for (const s of t.seats) if (s.connected && s.p.sock) s.p.sock.emit('state', view(t, s.token)); }
function say(t, msg) { for (const s of t.seats) if (s.connected && s.p.sock) s.p.sock.emit('toast', msg); }

function maybeStart(t) {
  if (t.phase === 'wait' && !t.startT && t.seats.filter(s => s.connected).length >= MIN_P)
    t.startT = setTimeout(() => startRound(t), 4000);
}
function startRound(t) {
  t.startT = null; t.result = null; t.reveal = false;
  t.seats = t.seats.filter(s => {
    const keep = !s.left && s.connected && s.p.bal >= BOOT;
    if (!keep) s.p.table = null;
    return keep;
  });
  updateOpen(t);
  if (t.seats.length < MIN_P) { t.phase = 'wait'; send(t); if (!t.seats.length) { tables.delete(t.id); open.delete(t.id); } return; }
  const d = newDeck();
  t.pot = 0; t.chaal = BOOT; t.phase = 'play';
  t.seats.forEach((s, i) => {
    s.cards = d.slice(i * 3, i * 3 + 3); s.in = true; s.active = true; s.seen = false; s.bet = 0;
    pay(s, BOOT, t);
  });
  t.dealer = (t.dealer + 1) % t.seats.length;
  t.turn = (t.dealer + 1) % t.seats.length;
  arm(t);
}
function pay(s, amt, t) { s.p.bal -= amt; s.bet += amt; t.pot += amt; saveDB(); }
function arm(t) {
  clearTimeout(t.timer);
  const s = t.seats[t.turn], ms = s.connected ? TURN_MS : 1000;
  t.deadline = Date.now() + ms;
  t.timer = setTimeout(() => act(t, s, { type: 'pack' }, true), ms);
  send(t);
}
function advance(t) {
  const a = active(t);
  if (a.length === 1) return finish(t, a[0], false);
  do { t.turn = (t.turn + 1) % t.seats.length; } while (!t.seats[t.turn].in || !t.seats[t.turn].active);
  arm(t);
}
function finish(t, w, reveal) {
  clearTimeout(t.timer);
  w.p.bal += t.pot; saveDB();
  t.result = { winner: w.name, pot: t.pot, hand: handName(w.cards) };
  t.reveal = reveal; t.phase = 'wait';
  t.seats.forEach(s => { s.in = s.in; });
  send(t);
  t.startT = setTimeout(() => startRound(t), NEXT_MS);
}
function prevActive(t, idx) {
  let i = idx;
  do { i = (i - 1 + t.seats.length) % t.seats.length; } while (!t.seats[i].in || !t.seats[i].active);
  return t.seats[i];
}

// ---------- player actions (all validated here) ----------
function act(t, s, a, auto) {
  if (t.phase !== 'play' || !s.in || !s.active) return;
  if (a.type === 'see') { s.seen = true; return send(t); }
  if (t.side) return s.p.sock?.emit('err', 'Side show pending');
  if (t.seats[t.turn] !== s) return s.p.sock?.emit('err', 'Not your turn');
  const bad = m => s.p.sock?.emit('err', m);
  switch (a.type) {
    case 'blind': if (s.seen) return bad('You already saw your cards');
    case 'chaal':
      if (s.p.bal < t.chaal) return bad('Not enough balance');
      pay(s, t.chaal, t); break;
    case 'double':
      if (s.p.bal < t.chaal * 2) return bad('Not enough balance');
      t.chaal *= 2; pay(s, t.chaal, t); break;
    case 'custom': {
      const amt = Math.floor(Number(a.amount));
      if (!(amt >= t.chaal)) return bad('Bet is below current chaal');
      if (amt > s.p.bal) return bad('Not enough balance');
      t.chaal = amt; pay(s, amt, t); break;
    }
    case 'pack': s.active = false; say(t, s.name + (auto ? ' timed out and packed' : ' packed')); break;
    case 'show': {
      if (active(t).length !== 2) return bad('SHOW needs exactly 2 players');
      if (s.p.bal < t.chaal) return bad('Not enough balance');
      pay(s, t.chaal, t);
      ev(t, s.name, 'show');
      const [x, y] = active(t);
      return finish(t, score(x.cards) > score(y.cards) ? x : y, true); // tie: second player (the one who did not call) loses
    }
    case 'side': {
      if (!s.seen || active(t).length < 3) return bad('Side show not allowed now');
      const p = prevActive(t, t.turn);
      if (!p.seen) return bad('Previous player has not seen cards');
      if (s.p.bal < t.chaal) return bad('Not enough balance');
      pay(s, t.chaal, t);
      t.side = { from: s, to: p };              // cards are compared ONLY if the other player allows
      clearTimeout(t.timer);
      const ms = p.connected ? TURN_MS : 500;
      t.deadline = Date.now() + ms;
      t.timer = setTimeout(() => sideAns(t, p, false), ms);
      p.p.sock?.emit('sideReq', { from: s.name });
      say(t, `${s.name} asked ${p.name} for a side show`);
      ev(t, s.name, 'side');
      return send(t);
    }
    default: return bad('Unknown action');
  }
  ev(t, s.name, a.type);
  advance(t);
}

function ev(t, n, type) { for (const s of t.seats) if (s.connected && s.p.sock) s.p.sock.emit('ev', { n, t: type }); }
function sideAns(t, p, ok) {
  if (!t.side || t.side.to !== p) return;
  clearTimeout(t.timer); const s = t.side.from; t.side = null;
  if (!ok) { say(t, p.name + ' declined the side show'); return arm(t); }
  const win = score(s.cards) > score(p.cards);   // tie: requester loses
  s.p.sock?.emit('sideShow', { mine: s.cards, theirs: p.cards, win });
  p.p.sock?.emit('sideShow', { mine: p.cards, theirs: s.cards, win: !win });
  (win ? p : s).active = false;
  say(t, win ? `Side show: ${s.name} beat ${p.name}` : `Side show: ${p.name} won, ${s.name} packed`);
  advance(t);
}
// ---------- sockets ----------
io.on('connection', sock => {
  sock.on('join', ({ token, name } = {}) => {
    let p = token && players.get(token);
    if (!p || !p.email) return sock.emit('authfail');          // must be logged in to CASINO KING
    p.sock = sock; sock.data.token = token;
    if (p.bal < BOOT * 10) p.bal = START_BAL; saveDB();
    sock.emit('joined', { token, bal: p.bal });
    let t = p.table && tables.get(p.table);
    let s = t && t.seats.find(x => x.token === token);
    if (s) { s.connected = true; s.left = false; return send(t); }          // reconnect
    t = findTable();
    s = { token, id: t.seats.length, name: p.name, p, cards: [], in: false, active: false, seen: false, bet: 0, connected: true, left: false };
    t.seats.push(s); p.table = t.id; updateOpen(t);
    send(t); maybeStart(t);
  });
  sock.on('action', a => {
    const p = players.get(sock.data.token), t = p && tables.get(p.table);
    const s = t && t.seats.find(x => x.token === p.token);
    if (s && a && typeof a.type === 'string') act(t, s, a);
  });
  sock.on('sideAns', ok => {
    const p = players.get(sock.data.token), t = p && tables.get(p.table);
    const s = t && t.seats.find(x => x.token === p.token); if (s) sideAns(t, s, ok === true);
  });
  sock.on('leave', () => leave(sock, true));
  sock.on('disconnect', () => leave(sock, false));
});
function leave(sock, voluntary) {
  const p = players.get(sock.data.token); if (!p || p.sock !== sock) return;
  const t = tables.get(p.table), s = t && t.seats.find(x => x.token === p.token);
  if (!s) return;
  s.connected = false; if (voluntary) s.left = true;
  if (t.phase === 'wait' && !s.in) { t.seats = t.seats.filter(x => x !== s); p.table = null; updateOpen(t); if (!t.seats.length) { tables.delete(t.id); open.delete(t.id); } }
  else if (t.phase === 'play' && t.seats[t.turn] === s) { clearTimeout(t.timer); arm(t); }   // auto-pack quickly
  if (tables.has(t.id)) send(t);
}

require('./mang')(io, players, saveDB, START_BAL);   // Mang game on namespace /mang
const PORT = process.env.PORT || 3000;
srv.listen(PORT, () => console.log('3 IKKE server on :' + PORT));
