// MANG — one continuous global room (unlimited players), Andar/Bahar card bets.
// The shuffled deck stays on the server; clients only ever receive cards that were already dealt.
const crypto = require('crypto');
module.exports = (io, players, saveDB, START_BAL, led, auth) => {
  const flood = (sock, n = 25, ms = 5000) => { const t = Date.now(), a = (sock.data.fl || []).filter(x => t - x < ms); a.push(t); sock.data.fl = a; return a.length > n; };
  const nsp = io.of('/mang');
  const BREAK = +(process.env.MANG_BREAK_MS ?? 20000), ROUND = +(process.env.MANG_ROUND_MS ?? 240000), HOLD = +(process.env.MANG_HOLD_MS ?? 20000);
  const CARD = (ROUND - 3 * BREAK) / 52, LIM = [17, 35, 52], MINB = 10, WIN = 2;   // win pays 2x stake
  let R = null;
  const key = c => c.r + '-' + c.s;
  const SUI = ['♠', '♥', '♣', '♦'], RKL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const lab = k => { const [r, s] = k.split('-').map(Number); return (RKL[r] || r) + SUI[s]; };
  function deck() {
    const d = []; for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ r, s });
    for (let i = 51; i > 0; i--) { const j = crypto.randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
    return d;
  }
  const pub = () => ({ phase: R.phase, until: R.until, now: Date.now(), id: R.id, log: R.log.map(x => ({ r: x.c.r, s: x.c.s, side: x.side })) });
  const me = t => { const p = players.get(t); return { bal: p ? p.bal : 0, bets: (R.by.get(t) || []).map(b => ({ k: b.k, side: b.side, amt: b.amt, done: b.done, won: b.won })) }; };
  const pushState = () => nsp.emit('state', pub());
  function pushMe(set) { for (const s of nsp.sockets.values()) if (!set || set.has(s.data.token)) s.emit('me', me(s.data.token)); }

  function startRound() {
    R = { id: crypto.randomUUID(), deck: deck(), log: [], dealtSet: new Set(), by: new Map(), seg: 0, phase: 'bet', until: 0 };
    pushMe(); openBet();
  }
  function openBet() {                       // betting window (start of round + two breaks)
    R.phase = 'bet'; R.until = Date.now() + BREAK; pushState();
    setTimeout(() => { R.phase = 'deal'; R.until = 0; step(); }, BREAK);
  }
  function step() {
    dealOne();
    if (R.log.length >= LIM[R.seg]) { R.seg++; return R.seg >= 3 ? endRound() : openBet(); }
    setTimeout(step, CARD);
  }
  function dealOne() {                       // 1st card BHAAR, 2nd ANDAR, 3rd BHAAR ...
    const n = R.log.length, c = R.deck[n], side = n % 2 === 0 ? 'bhaar' : 'andar', k = key(c), t = new Set();
    R.log.push({ c, side }); R.dealtSet.add(k);
    for (const [tok, arr] of R.by) for (const b of arr) if (!b.done && b.k === k) {
      b.done = true; t.add(tok);
      if (b.side === side) { b.won = true; const pp = players.get(tok); pp.bal += b.amt * WIN; led(pp, 'win', 'Mang', b.amt * WIN, lab(k) + ' ' + side); }
    }
    if (t.size) saveDB();
    pushState(); if (t.size) pushMe(t);
  }
  function endRound() {                      // no start button: hold, then next round begins by itself
    R.phase = 'hold'; R.until = Date.now() + HOLD; pushState();
    setTimeout(startRound, HOLD);
  }

  nsp.on('connection', sock => {
    sock.on('join', ({ token, name } = {}) => {
      if (flood(sock)) return;
      const p = auth(token);
      if (!p) return sock.emit('authfail');          // must be logged in to CASINO KING
      token = p.token;
      saveDB(); sock.data.token = token;
      sock.emit('joined', { token }); sock.emit('state', pub()); sock.emit('me', me(token));
    });
    sock.on('bet', d => {
      if (flood(sock)) return;
      const p = players.get(sock.data.token), err = m => sock.emit('err', m);
      if (!p || !d) return;
      const amt = Math.floor(Number(d.amount)), side = d.side === 'bahar' ? 'bhaar' : d.side, k = String(d.card);   // the page says BAHAR/BHAAR, the dealer uses 'bhaar': store one spelling so Bahar bets can win
      if (R.phase !== 'bet') return err('Betting is closed. Wait for the next break.');
      if (!/^\d{1,2}-[0-3]$/.test(k) || +k.split('-')[0] < 2 || +k.split('-')[0] > 14 || (side !== 'andar' && side !== 'bhaar')) return err('Pick a card and a side');
      if (R.dealtSet.has(k)) return err('That card was already dealt');
      if (!(amt >= MINB)) return err('Minimum bet is ' + MINB);
      if (amt > p.bal) return err('Not enough balance');
      const arr = R.by.get(p.token) || [];
      const ex = arr.find(b => b.k === k && b.side === side && !b.done);
      if (!ex && arr.length >= 60) return err('Too many bets this round');
      p.bal -= amt; led(p, 'bet', 'Mang', -amt, lab(k) + ' ' + side);
      if (ex) ex.amt += amt; else arr.push({ k, side, amt, done: false, won: false });
      R.by.set(p.token, arr); saveDB(); sock.emit('me', me(p.token));
    });
  });
  startRound();
  return { notify: tok => pushMe(new Set([tok])) };
};
