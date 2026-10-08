// 3 IKKE multiplayer server — Node.js + Express + Socket.IO
// Server shuffles/deals, validates every move, keeps cards private per player.
const express = require('express'), http = require('http'), crypto = require('crypto');
const { Server } = require('socket.io');
const app = express();
app.disable('x-powered-by'); app.set('trust proxy', 1);      // behind Render's proxy: real client IP for rate limits
app.use((q, r, n) => { r.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Strict-Transport-Security': 'max-age=15552000',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; media-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" }); n(); });
app.use(express.static(__dirname + '/public'));
app.use('/cards', express.static(require('path').join(__dirname, 'cards'), { maxAge: '7d' }));   // real card pictures
app.use('/cards', express.static(require('path').join(__dirname, 'png cards'), { maxAge: '7d' }));   // the downloaded public-domain set, uploaded as-is
// Pages also work if uploaded flat next to server.js (phone upload): safe whitelist, nothing else is exposed
const sendPage = f => (q, r) => { const p = require('path').join(__dirname, 'public', f); r.sendFile(require('fs').existsSync(p) ? p : require('path').join(__dirname, f)); };
app.get(['/', '/index.html'], sendPage('index.html'));
app.get('/ikke.html', sendPage('ikke.html'));
app.get('/mang.html', sendPage('mang.html'));
for (const f of ['admin.html', 'statement.html', 'cards.js', 'logo.jpg', 'manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png']) app.get('/' + f, sendPage(f));
// Android app file: upload casino-king.apk next to server.js (or in public) and it becomes downloadable
// Digital Asset Links: lets the Android app open full screen without a browser address bar. Upload assetlinks.json (from the PWABuilder zip) next to server.js.
app.get('/.well-known/assetlinks.json', (q, r) => { const P = require('path'), F = require('fs'); const p = [P.join(__dirname, 'public', 'assetlinks.json'), P.join(__dirname, 'assetlinks.json')].find(x => F.existsSync(x)); p ? r.type('application/json').sendFile(p) : r.sendStatus(404); });
app.get('/casino-king.apk', (q, r) => { const P = require('path'), F = require('fs'); const p = [P.join(__dirname, 'public', 'casino-king.apk'), P.join(__dirname, 'casino-king.apk')].find(x => F.existsSync(x)); p ? r.download(p, 'casino-king.apk') : r.sendStatus(404); });
app.get('/health', (_, r) => r.send('ok'));
const srv = http.createServer(app);
const io = new Server(srv, { allowRequest: (req, cb) => { const o = req.headers.origin; cb(null, !o || o === 'https://' + req.headers.host || o === 'http://' + req.headers.host); } });   // only our own site may connect

const BOOT = 20, TURN_MS = 30000, SIDE_MS = 10000, NEXT_MS = 6000, START_BAL = 0, GRACE_MS = 120000, MIN_P = 3, MAX_P = 6;
const tables = new Map(), open = new Set(), players = new Map();
let seq = 1;
// ---------- database: JSON file store (players + balances), debounced atomic writes ----------
const fs = require('fs'), DBF = process.env.DB_FILE || __dirname + '/data.json'; let dbT = null;
try { for (const p of JSON.parse(fs.readFileSync(DBF, 'utf8'))) players.set(p.token, { ...p, table: null, sock: null }); } catch {}
for (const p of players.values()) p.uid ||= crypto.randomBytes(4).toString('hex');
let mangApi = null;
function led(p, type, game, amt, note) {          // statement entry for a player
  (p.ledger ||= []).push({ t: Date.now(), type, game, amt, bal: p.bal, note: note || '' });
  if (p.ledger.length > 400) p.ledger.splice(0, p.ledger.length - 400);
}
// ---------- daily statistics for the admin panel (day boundary = India time) ----------
const STF = DBF + '.stats.json'; let stats = {}, stT = null;
try { stats = JSON.parse(fs.readFileSync(STF, 'utf8')); } catch {}
const dayKey = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);
function bump(path, amt) {                                   // bump('mang.andar', 100)
  const [g, f] = path.split('.'), d = (stats[dayKey()] ||= {}), o = (d[g] ||= {});
  o[f] = (o[f] || 0) + amt; clearTimeout(stT);
  stT = setTimeout(() => { try { fs.writeFileSync(STF + '.tmp', JSON.stringify(stats)); fs.renameSync(STF + '.tmp', STF); } catch (e) { console.error('stats', e.message); } }, 1500);
}
function saveDB() { clearTimeout(dbT); dbT = setTimeout(() => { try {
  const o = [...players.values()].map(({ token, name, bal, email, salt, pw, uid, avatar, ledger, sv }) => ({ token, name, bal }));
  fs.writeFileSync(DBF + '.tmp', JSON.stringify(o)); fs.renameSync(DBF + '.tmp', DBF);
} catch (e) { console.error('db', e.message); } }, 1000); }

// ---------- CASINO KING accounts: email + password (scrypt hash), shared by both games ----------
const small = express.json({ limit: '2kb' });
app.use((q, r, n) => q.path === '/api/avatar' ? n() : small(q, r, n));
const byEmail = new Map(), byUid = new Map(); for (const p of players.values()) { if (p.email) byEmail.set(p.email, p); byUid.set(p.uid, p); }
const hits = new Map();
const limited = ip => { const n = Date.now(), a = (hits.get(ip) || []).filter(t => n - t < 60000); a.push(n); hits.set(ip, a); return a.length > 10; };
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32);
// Login tokens are signed (HMAC), expire after 30 days, and die when sv changes (log out everywhere / admin password change).
const SECRET = process.env.SESSION_SECRET || (() => { const f = DBF + '.secret'; try { return fs.readFileSync(f, 'utf8').trim(); } catch { const s = crypto.randomBytes(32).toString('hex'); try { fs.writeFileSync(f, s, { mode: 0o600 }); } catch {} return s; } })();
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const mkToken = p => { const b = p.uid + '.' + (Date.now() + 30 * 24 * 3600e3) + '.' + (p.sv | 0); return b + '.' + sign(b); };
function auth(t) {
  if (typeof t !== 'string' || t.length > 200) return null;
  const a = t.split('.'); if (a.length !== 4) return null;
  const g = sign(a.slice(0, 3).join('.'));
  if (a[3].length !== g.length || !crypto.timingSafeEqual(Buffer.from(a[3]), Buffer.from(g))) return null;
  const p = byUid.get(a[0]);
  return p && p.email && Date.now() < +a[1] && (p.sv | 0) === +a[2] ? p : null;
}
const cleanName = n => String(n || '').replace(/[<>&"'`\\\x00-\x1f]/g, '').trim().slice(0, 14);
const fails = new Map();                                    // wrong-password counter per account
const sess = p => ({ token: mkToken(p), name: p.name, bal: p.bal, uid: p.uid, av: p.avatar ? 1 : 0 });
app.post('/api/signup', (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  const { email, password, name } = req.body || {}, e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return res.status(400).json({ error: 'Enter a valid email' });
  if (String(password || '').length < 8 || String(password).toLowerCase() === e) return res.status(400).json({ error: 'Password must be at least 8 characters and different from your email' });
  if (byEmail.has(e)) return res.status(409).json({ error: 'This email is already registered. Log in instead.' });
  const salt = crypto.randomBytes(16).toString('hex'), token = crypto.randomUUID();
  const p = { token, name: cleanName(name || e.split('@')[0]) || 'Player', bal: START_BAL, email: e, salt, uid: crypto.randomBytes(4).toString('hex'), ledger: [], pw: hashPw(String(password), salt).toString('hex'), table: null, sock: null };
  players.set(token, p); byEmail.set(e, p); byUid.set(p.uid, p); saveDB(); res.json(sess(p));
});
app.post('/api/login', (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  const { email, password } = req.body || {}, p = byEmail.get(String(email || '').trim().toLowerCase());
  const lk = p && fails.get(p.uid); if (lk && lk.until > Date.now()) return res.status(429).json({ error: 'Too many wrong passwords. Try again in 10 minutes.' });
  const good = p && crypto.timingSafeEqual(hashPw(String(password || ''), p.salt), Buffer.from(p.pw, 'hex'));
  if (p && !good) { const f = fails.get(p.uid) || { n: 0, until: 0 }; if (++f.n >= 8) { f.until = Date.now() + 600000; f.n = 0; } fails.set(p.uid, f); } else if (p) fails.delete(p.uid);
  if (!good) return res.status(401).json({ error: 'Wrong email or password' });
  if (p.blocked) return res.status(403).json({ error: 'This account is blocked' });
  res.json(sess(p));
});
app.post('/api/me', (req, res) => { const p = auth((req.body || {}).token); p ? res.json(sess(p)) : res.status(401).json({ error: 'Session expired' }); });

const who = (q) => auth((q.body || {}).token);
app.post('/api/logout-all', (q, r) => { const p = who(q); if (!p) return r.status(401).json({ error: 'Login again' }); p.sv = (p.sv | 0) + 1; saveDB(); try { p.sock && p.sock.disconnect(true); } catch {} r.json({ ok: 1 }); });
function notify(p) { if (p.table) { const t = tables.get(p.table); if (t) send(t); } if (mangApi) mangApi.notify(p.token); }
app.post('/api/avatar', express.json({ limit: '120kb' }), (q, r) => {
  const p = who(q), img = String((q.body || {}).image || '');
  if (!p) return r.status(401).json({ error: 'Login again' });
  const hd = img.length > 40 ? Buffer.from(img.slice(23, 31), 'base64') : Buffer.alloc(3);
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > 100000 || !(hd[0] === 0xff && hd[1] === 0xd8 && hd[2] === 0xff)) return r.status(400).json({ error: 'Use a JPEG photo (it is resized automatically)' });
  p.avatar = img.split(',')[1]; saveDB(); r.json({ ok: 1 });
});
app.get('/api/avatar/:uid', (q, r) => {
  const p = byUid.get(q.params.uid); if (!p || !p.avatar) return r.sendStatus(404);
  r.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' }).send(Buffer.from(p.avatar, 'base64'));
});
app.post('/api/statement', (q, r) => { const p = who(q); if (!p) return r.status(401).json({ error: 'Login again' }); r.json({ bal: p.bal, items: (p.ledger || []).slice(-200).reverse() }); });

// ---------- admin panel (one for both games). Set ADMIN_USER and ADMIN_PASS in the server environment ----------
const adm = new Map(), A_USER = process.env.ADMIN_USER, A_PASS = process.env.ADMIN_PASS;
const eq = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const needAdmin = (q, r, n) => { const k = q.get('x-admin'); if (k && adm.get(k) > Date.now()) return n(); r.status(401).json({ error: 'Admin login required' }); };
app.post('/api/admin/login', (q, r) => {
  if (limited(q.ip)) return r.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  if (!A_USER || !A_PASS) return r.status(503).json({ error: 'Admin is not set up on the server yet' });
  const { user, password } = q.body || {};
  if (!eq(user, A_USER) || !eq(password, A_PASS)) return r.status(401).json({ error: 'Wrong admin user or password' });
  const k = crypto.randomBytes(24).toString('hex'); adm.set(k, Date.now() + 12 * 3600e3); r.json({ admin: k });
});
app.get('/api/admin/users', needAdmin, (q, r) => r.json([...players.values()].filter(p => p.email).map(p => ({ uid: p.uid, name: p.name, email: p.email, bal: p.bal, online: !!p.table }))));
app.post('/api/admin/coins', needAdmin, (q, r) => {
  const { uid, amount, note } = q.body || {}, p = byUid.get(uid), a = Math.trunc(Number(amount));
  if (!p || !a || Math.abs(a) > 1e9) return r.status(400).json({ error: 'Enter a valid user and amount' });
  if (p.bal + a < 0) return r.status(400).json({ error: 'Balance cannot go below zero' });
  p.bal += a; led(p, a > 0 ? 'admin_add' : 'admin_cut', 'Admin', a, String(note || '').slice(0, 60)); bump(a > 0 ? 'admin.added' : 'admin.cut', Math.abs(a)); saveDB(); notify(p); r.json({ bal: p.bal });
});
app.post('/api/admin/password', needAdmin, (q, r) => {
  const { uid, password } = q.body || {}, p = byUid.get(uid);
  if (!p || String(password || '').length < 8) return r.status(400).json({ error: 'Pick a user and a password of 8+ characters' });
  p.sv = (p.sv | 0) + 1;                                     // old logins stop working
  p.salt = crypto.randomBytes(16).toString('hex'); p.pw = hashPw(String(password), p.salt).toString('hex'); saveDB(); r.json({ ok: 1 });
});
app.get('/api/admin/stats', needAdmin, (q, r) => {
  const n = Math.min(365, Math.max(1, parseInt(q.query.days) || 30)), out = [];
  for (let i = 0; i < n; i++) { const k = new Date(Date.now() + 19800000 - i * 86400000).toISOString().slice(0, 10), d = stats[k] || {}, i1 = d.ikke || {}, m = d.mang || {}, a = d.admin || {};
    out.push({ day: k, ikkeBet: i1.bet || 0, ikkePaid: i1.paid || 0, ikkeRounds: i1.rounds || 0, mangBet: m.bet || 0, mangAndar: m.andar || 0, mangBhaar: m.bhaar || 0, mangPaid: m.paid || 0, added: a.added || 0, cut: a.cut || 0 }); }
  r.json(out);
});
app.post('/api/admin/statement', needAdmin, (q, r) => { const p = byUid.get((q.body || {}).uid); if (!p) return r.status(404).json({ error: 'No such user' }); r.json({ name: p.name, bal: p.bal, items: (p.ledger || []).slice(-200).reverse() }); });

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
      token: s.token === me ? s.token : undefined, id: s.id, uid: s.p.uid, av: s.p.avatar ? 1 : 0, grace: s.grace ? Math.max(0, s.grace - Date.now()) : 0, name: s.name, bal: s.p.bal, in: s.in, active: s.active,
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
  const now = Date.now();
  t.seats = t.seats.filter(s => {
    if (s.p.bal >= BOOT) s.grace = 0; else if (!s.grace) s.grace = now + GRACE_MS;   // out of coins: 2 minutes to get coins added
    const keep = !s.left && s.connected && (s.p.bal >= BOOT || now < s.grace);
    if (!keep) { s.p.table = null; s.p.sock?.emit('kicked'); }
    return keep;
  });
  updateOpen(t);
  if (t.seats.filter(s => s.p.bal >= BOOT).length < MIN_P) {
    t.phase = 'wait'; t.seats.forEach(s => { s.in = false; s.active = false; }); send(t);
    if (!t.seats.length) { tables.delete(t.id); open.delete(t.id); } else t.startT = setTimeout(() => startRound(t), 5000);
    return;
  }
  const d = newDeck();
  t.pot = 0; t.chaal = BOOT; t.phase = 'play';
  t.seats.forEach((s, i) => {
    s.cards = d.slice(i * 3, i * 3 + 3); s.in = s.p.bal >= BOOT; s.active = s.in; s.seen = false; s.bet = 0;
    if (s.in) pay(s, BOOT, t);
  });
  t.dealer = (t.dealer + 1) % t.seats.length;
  t.turn = t.dealer;
  do { t.turn = (t.turn + 1) % t.seats.length; } while (!t.seats[t.turn].in);
  arm(t);
}
function pay(s, amt, t) { s.p.bal -= amt; s.bet += amt; t.pot += amt; led(s.p, 'bet', '3 IKKE', -amt); bump('ikke.bet', amt); saveDB(); }
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
  w.p.bal += t.pot; led(w.p, 'win', '3 IKKE', t.pot); bump('ikke.paid', t.pot); bump('ikke.rounds', 1); saveDB();
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
      const ms = p.connected ? SIDE_MS : 500;
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
const flood = (sock, n = 25, ms = 5000) => { const t = Date.now(), a = (sock.data.fl || []).filter(x => t - x < ms); a.push(t); sock.data.fl = a; return a.length > n; };   // spam guard per connection
// ---------- sockets ----------
io.on('connection', sock => {
  sock.on('join', ({ token, name } = {}) => {
    if (flood(sock)) return;
    const p = auth(token);
    if (!p) return sock.emit('authfail');          // must be logged in to CASINO KING
    token = p.token;
    p.sock = sock; sock.data.token = token;
    saveDB();
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
    if (flood(sock)) return;
    const p = players.get(sock.data.token), t = p && tables.get(p.table);
    const s = t && t.seats.find(x => x.token === p.token);
    if (s && a && typeof a.type === 'string') act(t, s, a);
  });
  sock.on('sideAns', ok => {
    if (flood(sock)) return;
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

mangApi = require('./mang')(io, players, saveDB, START_BAL, led, auth, bump);   // Mang game on namespace /mang
const PORT = process.env.PORT || 3000;
srv.listen(PORT, () => console.log('3 IKKE server on :' + PORT));
