// Admin panel API. Roles: owner (env ADMIN_USER/ADMIN_PASS) > manager > support (staff accounts made by the owner).
module.exports = c => {
  const { app, crypto, players, byUid, tables, io, config, saveCfg, promos, staff, audit, hist, stats, hashPw, limited, led, bump, notify, saveDB, auth, kick, logA, mang, A_USER, A_PASS, startedAt } = c;
  const LV = { support: 1, manager: 2, owner: 3 }, sessions = new Map();
  const h = s => crypto.createHash('sha256').update(String(s)).digest(), eq = (a, b) => crypto.timingSafeEqual(h(a), h(b));
  const dk = (off = 0) => new Date(Date.now() + 19800000 - off * 86400000).toISOString().slice(0, 10);   // India-time day
  const need = min => (q, r, n) => {
    const s = sessions.get(q.get('x-admin') || '');
    if (!s || s.exp < Date.now()) return r.status(401).json({ error: 'Admin login required' });
    if (LV[s.role] < LV[min]) return r.status(403).json({ error: 'Your role cannot do this' });
    q.adm = s; n();
  };
  const num = (v, lo, hi) => { const x = Math.trunc(Number(v)); return Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
  const real = () => [...byUid.values()].filter(p => p.email);

  app.post('/api/admin/login', (q, r) => {
    if (limited(q.ip)) return r.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
    const { user, password } = q.body || {}, name = String(user || '').trim();
    let role = null;
    if (A_USER && A_PASS && eq(name, A_USER) && eq(password, A_PASS)) role = 'owner';
    else { const s = staff.data.find(x => x.user === name.toLowerCase());
      if (s && crypto.timingSafeEqual(hashPw(String(password || ''), s.salt), Buffer.from(s.pw, 'hex'))) role = s.role; }
    if (!role) return r.status(A_USER && A_PASS || staff.data.length ? 401 : 503).json({ error: A_USER && A_PASS || staff.data.length ? 'Wrong admin user or password' : 'Admin is not set up on the server yet' });
    const k = crypto.randomBytes(24).toString('hex'), u = role === 'owner' ? name : name.toLowerCase();
    sessions.set(k, { user: u, role, exp: Date.now() + 12 * 3600e3 }); logA(u, 'login', role); r.json({ admin: k, role, user: u });
  });
  app.get('/api/admin/me', need('support'), (q, r) => r.json({ user: q.adm.user, role: q.adm.role, limits: { manager: config.managerLimit } }));

  // ----- dashboard -----
  function fin(n) {
    const o = { ikkeBet: 0, ikkePaid: 0, rake: 0, mangBet: 0, mangAndar: 0, mangBhaar: 0, mangPaid: 0, added: 0, cut: 0, promo: 0, bonus: 0 }, days = [];
    for (let i = 0; i < n; i++) { const k = dk(i), d = stats[k] || {}, a = d.ikke || {}, m = d.mang || {}, ad = d.admin || {}, pr = d.promo || {}, bn = d.bonus || {};
      const x = { day: k, ikkeBet: a.bet || 0, ikkePaid: a.paid || 0, ikkeRounds: a.rounds || 0, rake: a.rake || 0, mangBet: m.bet || 0, mangAndar: m.andar || 0, mangBhaar: m.bhaar || 0, mangPaid: m.paid || 0, added: ad.added || 0, cut: ad.cut || 0, promo: pr.paid || 0, bonus: bn.paid || 0 };
      x.revenue = (x.mangBet - x.mangPaid) + x.rake; days.push(x); for (const f in o) o[f] += x[f]; }
    o.revenue = (o.mangBet - o.mangPaid) + o.rake; return { total: o, days };
  }
  function retention() {
    const today = Date.parse(dk(0)), N = [1, 3, 7, 14, 30], rows = N.map(n => ({ n, eligible: 0, retained: 0 })); let tot = 0, cnt = 0;
    for (const p of real()) { if (!p.created) continue;
      const cd = new Date(p.created + 19800000).toISOString().slice(0, 10), age = Math.floor((today - Date.parse(cd)) / 86400000), set = new Set(p.days || []); tot += set.size; cnt++;
      rows.forEach(o => { if (age >= o.n) { o.eligible++; if (set.has(new Date(Date.parse(cd) + o.n * 86400000).toISOString().slice(0, 10))) o.retained++; } }); }
    return { rows: rows.map(o => ({ n: o.n, eligible: o.eligible, retained: o.retained, pct: o.eligible ? Math.round(100 * o.retained / o.eligible) : null })), avgDays: cnt ? +(tot / cnt).toFixed(1) : 0, players: cnt };
  }
  const liveTables = () => [...tables.values()].map(t => ({ id: t.id, players: t.seats.filter(s => s.connected).length, phase: t.phase, pot: t.pot }));
  app.get('/api/admin/overview', need('manager'), (q, r) => {
    const n = Math.min(90, Math.max(1, parseInt(q.query.days) || 30)), f = fin(n), ps = real(), win = new Set(Array.from({ length: n }, (_, i) => dk(i))), m30 = new Set(Array.from({ length: 30 }, (_, i) => dk(i)));
    const dau = ps.filter(p => (p.days || []).includes(dk(0))).length, mau = ps.filter(p => (p.days || []).some(d => m30.has(d))).length, act = ps.filter(p => (p.days || []).some(d => win.has(d))).length;
    const lt = liveTables(), mem = process.memoryUsage().rss;
    r.json({ status: { uptimeMin: Math.round(process.uptime() / 60), memMB: Math.round(mem / 1048576), node: process.version, startedAt, tables: lt.length, persistent: !!process.env.DB_FILE },
      live: { ikke: lt.reduce((a, t) => a + t.players, 0), mang: mang() ? mang().online() : 0, tables: lt },
      users: { total: ps.length, dau, mau, newToday: ps.filter(p => p.created && new Date(p.created + 19800000).toISOString().slice(0, 10) === dk(0)).length, blocked: ps.filter(p => p.blocked).length, activeInPeriod: act },
      fin: { period: n, ...f.total, today: f.days[0].revenue, arpu: act ? Math.round(f.total.revenue / act) : 0 }, days: f.days, retention: retention() });
  });
  app.get('/api/admin/stats', need('manager'), (q, r) => r.json(fin(Math.min(365, Math.max(1, parseInt(q.query.days) || 30))).days));

  // ----- players -----
  app.get('/api/admin/users', need('support'), (q, r) => r.json(real().map(p => ({ uid: p.uid, name: p.name, email: p.email, phone: p.phone || '', bal: p.bal, blocked: !!p.blocked, online: !!p.table, created: p.created || 0, last: (p.days || []).slice(-1)[0] || '', ref: p.refBy || '' }))));
  app.post('/api/admin/statement', need('support'), (q, r) => { const p = byUid.get((q.body || {}).uid); if (!p) return r.status(404).json({ error: 'No such user' }); r.json({ name: p.name, bal: p.bal, items: (p.ledger || []).slice(-200).reverse() }); });
  app.post('/api/admin/coins', need('manager'), (q, r) => {
    const { uid, amount, note } = q.body || {}, p = byUid.get(uid), a = Math.trunc(Number(amount));
    if (!p || !a || Math.abs(a) > 1e9) return r.status(400).json({ error: 'Enter a valid user and amount' });
    if (q.adm.role === 'manager' && Math.abs(a) > config.managerLimit) return r.status(403).json({ error: 'Managers can change at most ' + config.managerLimit + ' coins at a time' });
    if (p.bal + a < 0) return r.status(400).json({ error: 'Balance cannot go below zero' });
    p.bal += a; led(p, a > 0 ? 'admin_add' : 'admin_cut', 'Admin', a, String(note || '').slice(0, 60)); bump(a > 0 ? 'admin.added' : 'admin.cut', Math.abs(a)); saveDB(); notify(p);
    logA(q.adm.user, a > 0 ? 'coins added' : 'coins cut', p.name + ' (' + p.uid + ') ' + a + ' ' + String(note || '').slice(0, 60)); r.json({ bal: p.bal });
  });
  app.post('/api/admin/password', need('manager'), (q, r) => {
    const { uid, password } = q.body || {}, p = byUid.get(uid);
    if (!p || String(password || '').length < 8) return r.status(400).json({ error: 'Pick a user and a password of 8+ characters' });
    p.sv = (p.sv | 0) + 1; p.salt = crypto.randomBytes(16).toString('hex'); p.pw = hashPw(String(password), p.salt).toString('hex'); saveDB();
    logA(q.adm.user, 'player password changed', p.name + ' (' + p.uid + ')'); r.json({ ok: 1 });
  });
  app.post('/api/admin/block', need('manager'), (q, r) => {
    const { uid, blocked } = q.body || {}, p = byUid.get(uid); if (!p) return r.status(404).json({ error: 'No such user' });
    p.blocked = !!blocked; p.sv = (p.sv | 0) + 1; saveDB(); if (p.blocked) kick(p);
    logA(q.adm.user, p.blocked ? 'player blocked' : 'player unblocked', p.name + ' (' + p.uid + ')'); r.json({ blocked: p.blocked });
  });
  app.post('/api/admin/phone', need('manager'), (q, r) => {
    const { uid, phone } = q.body || {}, p = byUid.get(uid); if (!p) return r.status(404).json({ error: 'No such user' });
    p.phone = String(phone || '').replace(/[^0-9+]/g, '').slice(0, 15); saveDB(); logA(q.adm.user, 'phone saved', p.name + ' (' + p.uid + ')'); r.json({ phone: p.phone });
  });

  // ----- games -----
  app.get('/api/admin/history', need('manager'), (q, r) => { const g = String(q.query.game || ''), n = Math.min(500, parseInt(q.query.limit) || 200); r.json(hist.data.filter(x => !g || x.game === g).slice(-n).reverse()); });
  app.get('/api/admin/config', need('manager'), (q, r) => r.json(config));
  app.post('/api/admin/config', need('owner'), (q, r) => {
    const b = q.body || {}, nx = {};
    const set = (k, lo, hi) => { if (b[k] !== undefined) { const v = num(b[k], lo, hi); if (v === null) throw new Error(k + ' must be between ' + lo + ' and ' + hi); nx[k] = v; } };
    try { set('minBet', 1, 1e6); set('maxBet', 1, 1e9); set('ikkeMax', 20, 1e9); set('rake', 0, 10); set('signupBonus', 0, 1e6); set('referrer', 0, 1e6); set('referee', 0, 1e6); set('managerLimit', 0, 1e9); }
    catch (e) { return r.status(400).json({ error: e.message }); }
    const m = { ...config, ...nx }; if (m.maxBet < m.minBet) return r.status(400).json({ error: 'maxBet must be at least minBet' });
    const before = JSON.stringify(Object.keys(nx).map(k => [k, config[k]])); Object.assign(config, nx); saveCfg();
    logA(q.adm.user, 'settings changed', before + ' -> ' + JSON.stringify(nx)); r.json(config);
  });
  app.get('/api/admin/tables', need('manager'), (q, r) => r.json(liveTables()));

  // ----- marketing -----
  app.get('/api/admin/promos', need('manager'), (q, r) => r.json(promos.data.map(({ usedBy, ...x }) => x)));
  app.post('/api/admin/promo', need('manager'), (q, r) => {
    const b = q.body || {}, code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16), coins = num(b.coins, 1, 1e6), uses = num(b.maxUses || 100, 1, 1e5), days = num(b.days || 0, 0, 365);
    if (code.length < 3 || coins === null || uses === null || days === null) return r.status(400).json({ error: 'Code (3+ letters/numbers), coins, uses and days are needed' });
    if (promos.data.some(x => x.code === code)) return r.status(409).json({ error: 'That code already exists' });
    promos.data.push({ code, coins, maxUses: uses, used: 0, exp: days ? Date.now() + days * 86400000 : 0, usedBy: [], created: Date.now() }); promos.save();
    logA(q.adm.user, 'promo created', code + ' ' + coins + ' coins x' + uses); r.json({ ok: 1 });
  });
  app.post('/api/admin/promo/delete', need('manager'), (q, r) => { const code = String((q.body || {}).code || ''); const n = promos.data.length; promos.data = promos.data.filter(x => x.code !== code); promos.save(); logA(q.adm.user, 'promo deleted', code); r.json({ removed: n - promos.data.length }); });
  app.post('/api/admin/announce', need('manager'), (q, r) => {
    const text = String((q.body || {}).text || '').replace(/[<>]/g, '').trim().slice(0, 200); config.announce = text; saveCfg();
    io.emit('ann', text); io.of('/mang').emit('ann', text); logA(q.adm.user, 'announcement', text || '(cleared)'); r.json({ ok: 1 });
  });
  app.get('/api/announcement', (q, r) => r.json({ text: config.announce || '' }));
  app.post('/api/promo', (q, r) => {                       // a player redeems a code
    const p = auth((q.body || {}).token); if (!p) return r.status(401).json({ error: 'Login again' });
    if (limited(q.ip)) return r.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
    const code = String((q.body || {}).code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), x = promos.data.find(y => y.code === code);
    if (!x || (x.exp && x.exp < Date.now()) || x.used >= x.maxUses) return r.status(400).json({ error: 'Invalid or expired code' });
    if (x.usedBy.includes(p.uid)) return r.status(400).json({ error: 'You already used this code' });
    x.used++; x.usedBy.push(p.uid); promos.save(); p.bal += x.coins; led(p, 'bonus', 'Promo', x.coins, x.code); bump('promo.paid', x.coins); saveDB(); notify(p);
    r.json({ added: x.coins, bal: p.bal });
  });

  // ----- staff and activity log (owner only) -----
  app.get('/api/admin/staff', need('owner'), (q, r) => r.json(staff.data.map(({ user, role, created }) => ({ user, role, created }))));
  app.post('/api/admin/staff', need('owner'), (q, r) => {
    const b = q.body || {}, user = String(b.user || '').toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(user) || String(b.password || '').length < 10 || !['manager', 'support'].includes(b.role)) return r.status(400).json({ error: 'User: 3-20 letters/numbers/underscore. Password: 10+ characters. Role: manager or support.' });
    if (staff.data.some(x => x.user === user) || (A_USER && user === String(A_USER).toLowerCase())) return r.status(409).json({ error: 'That user name is taken' });
    const salt = crypto.randomBytes(16).toString('hex'); staff.data.push({ user, role: b.role, salt, pw: hashPw(String(b.password), salt).toString('hex'), created: Date.now() }); staff.save();
    logA(q.adm.user, 'staff created', user + ' (' + b.role + ')'); r.json({ ok: 1 });
  });
  app.post('/api/admin/staff/delete', need('owner'), (q, r) => {
    const user = String((q.body || {}).user || '').toLowerCase(); staff.data = staff.data.filter(x => x.user !== user); staff.save();
    for (const [k, s] of sessions) if (s.user === user && s.role !== 'owner') sessions.delete(k);
    logA(q.adm.user, 'staff deleted', user); r.json({ ok: 1 });
  });
  app.get('/api/admin/audit', need('owner'), (q, r) => r.json(audit.data.slice(-300).reverse()));
};
