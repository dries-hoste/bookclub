require('dotenv').config();
const express = require('express');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Password protection ────────────────────────────────────────────────────

const password = process.env.BOOKCLUB_PASSWORD;
if (!password) {
  console.warn('⚠️  BOOKCLUB_PASSWORD not set — using default password "changeme".');
  console.warn('   Set it in .env before sharing with others.\n');
}

const members = (process.env.BOOKCLUB_MEMBERS || '')
  .split(',').map(m => m.trim()).filter(Boolean);

if (!members.length) {
  console.warn('⚠️  BOOKCLUB_MEMBERS not set — falling back to single "bookclub" user.\n');
}

const authUsers = members.length
  ? Object.fromEntries(members.map(m => [m, password || 'changeme']))
  : { bookclub: password || 'changeme' };

// ── Session cookies ────────────────────────────────────────────────────────

const SESSION_COOKIE = 'bc_session';
const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

const sessionSecret = process.env.BOOKCLUB_SESSION_SECRET
  || crypto.createHash('sha256').update('bc-session:' + (password || 'changeme')).digest('hex');
if (!process.env.BOOKCLUB_SESSION_SECRET) {
  console.warn('⚠️  BOOKCLUB_SESSION_SECRET not set — derived from BOOKCLUB_PASSWORD.');
  console.warn('   Set a stable random value so sessions survive password changes.\n');
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('base64url');
}

function createSessionToken(user) {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = `${encodeURIComponent(user)}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const lastDot = token.lastIndexOf('.');
  if (lastDot < 0) return null;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  const expected = sign(payload);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  const sep = payload.indexOf('.');
  if (sep < 0) return null;
  const expires = parseInt(payload.slice(sep + 1), 10);
  if (!expires || expires < Date.now()) return null;
  let user;
  try { user = decodeURIComponent(payload.slice(0, sep)); } catch { return null; }
  if (!authUsers[user]) return null;
  return { user };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(p => {
    const idx = p.indexOf('=');
    if (idx < 0) return;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  });
  return out;
}

function setSessionCookie(res, user) {
  res.cookie(SESSION_COOKIE, createSessionToken(user), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const session = verifySessionToken(cookies[SESSION_COOKIE]);
  if (session) {
    req.auth = { user: session.user };
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/login');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const loginForm = (errorMsg) => `<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Inloggen — Read Between The Wines</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Inter:wght@400;500&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', system-ui, sans-serif; background: #faf7f0; color: #2c1810; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
  .card { background: #fff; border: 1px solid #ddd3c0; border-radius: 12px; padding: 2rem 2rem 1.75rem; box-shadow: 0 4px 20px rgba(44,24,16,0.11); width: 100%; max-width: 360px; }
  h1 { font-family: 'Playfair Display', Georgia, serif; font-size: 1.35rem; margin-bottom: 0.35rem; font-weight: 700; }
  .subtitle { color: #7a6655; font-size: 0.9rem; margin-bottom: 1.5rem; }
  label { display: block; font-size: 0.85rem; color: #5c3d2e; margin-bottom: 0.35rem; }
  input { width: 100%; padding: 0.65rem 0.75rem; border: 1px solid #ddd3c0; border-radius: 6px; font-family: inherit; font-size: 0.95rem; margin-bottom: 1rem; background: #faf7f0; color: #2c1810; }
  input:focus { outline: none; border-color: #c9973a; }
  button { width: 100%; padding: 0.75rem; background: #2c1810; color: #f0e0b0; border: none; border-radius: 6px; font-family: inherit; font-size: 0.95rem; font-weight: 500; cursor: pointer; letter-spacing: 0.02em; margin-top: 0.25rem; }
  button:hover { background: #3d2215; }
  .error { background: #fde8e8; border: 1px solid #f5b5b5; color: #8a2020; padding: 0.6rem 0.75rem; border-radius: 6px; font-size: 0.85rem; margin-bottom: 1rem; }
</style></head>
<body>
  <form class="card" method="POST" action="/login" autocomplete="on">
    <h1>📚 Read Between The Wines</h1>
    <div class="subtitle">Log in om verder te gaan</div>
    ${errorMsg ? `<div class="error">${escapeHtml(errorMsg)}</div>` : ''}
    <label for="username">Naam</label>
    <input id="username" name="username" type="text" autocomplete="username" autofocus required />
    <label for="password">Wachtwoord</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required />
    <button type="submit">Inloggen</button>
  </form>
</body></html>`;

app.get('/login', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (verifySessionToken(cookies[SESSION_COOKIE])) return res.redirect('/');
  res.type('html').send(loginForm(req.query.error ? 'Onjuiste naam of wachtwoord.' : ''));
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const username = (req.body.username || '').trim();
  const pwd = req.body.password || '';
  const expected = authUsers[username];
  if (!expected || expected !== pwd) return res.redirect('/login?error=1');
  setSessionCookie(res, username);
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ success: true });
});

// Everything below requires a valid session
app.use(requireAuth);
app.use(express.json());
app.use(express.static('public'));

// ── Storage ────────────────────────────────────────────────────────────────

function defaultState() {
  return { books: [], expectedVoters: 0, votes: {}, alreadyRead: {}, phase: 'setup', organizer: null, wishlist: [], history: [], concludedAt: null, tieResolved: false, chosenBook: null, meeting: null, revealed: false };
}

function migrate(data) {
  if (!data.alreadyRead) data.alreadyRead = {};
  if (!data.wishlist) data.wishlist = [];
  if (!data.history) data.history = [];
  if (!('concludedAt' in data)) data.concludedAt = null;
  if (!('tieResolved' in data)) data.tieResolved = false;
  if (!('chosenBook' in data)) data.chosenBook = null;
  if (!('meeting' in data)) data.meeting = null;
  if (!('revealed' in data)) data.revealed = false;
  data.history.forEach(e => { if (!e.ratings) e.ratings = {}; });
  return data;
}

let storage;

if (process.env.DATABASE_URL) {
  // PostgreSQL — used in production (Railway, Render, etc.)
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  storage = {
    async load() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_state (
          id    INTEGER PRIMARY KEY,
          data  JSONB NOT NULL
        )
      `);
      const { rows } = await pool.query('SELECT data FROM app_state WHERE id = 1');
      return rows.length ? migrate(rows[0].data) : defaultState();
    },
    async save(s) {
      await pool.query(`
        INSERT INTO app_state (id, data) VALUES (1, $1)
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
      `, [s]);
    },
  };
  console.log('Storage: PostgreSQL');
} else {
  const DATA_FILE = process.env.DATA_FILE || './data.json';
  storage = {
    async load() {
      try {
        if (fs.existsSync(DATA_FILE)) {
          const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
          return migrate(data);
        }
      } catch (e) {
        console.error('Failed to load data file:', e.message);
      }
      return defaultState();
    },
    async save(s) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(s, null, 2));
    },
  };
  console.log(`Storage: file (${DATA_FILE})`);
  if (process.env.NODE_ENV === 'production') {
    console.warn('⚠️  Running in production without DATABASE_URL — data will be lost on restart.');
    console.warn('   Set DATABASE_URL to a PostgreSQL connection string, or set DATA_FILE to a');
    console.warn('   path on a persistent volume (e.g. DATA_FILE=/data/data.json).\n');
  }
}

let state;
async function saveState() { await storage.save(state); }

function todayLocal() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in server-local TZ
}

// ── Book lookup ────────────────────────────────────────────────────────────

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'bookclub-app/1.0' } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject);
  });
}

async function fetchOpenLibrary(title, author) {
  const params = new URLSearchParams({ title, limit: '3' });
  if (author) params.set('author', author);
  const search = await fetchJson(`https://openlibrary.org/search.json?${params}`);
  const doc = search.docs?.[0];
  if (!doc) return null;

  let description = null;
  if (doc.key) {
    try {
      const work = await fetchJson(`https://openlibrary.org${doc.key}.json`);
      const desc = work.description;
      description = desc ? (typeof desc === 'string' ? desc : desc.value || null) : null;
    } catch {}
  }

  return {
    title: doc.title,
    author: doc.author_name?.[0] || '',
    pageCount: doc.number_of_pages_median || null,
    coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null,
    description,
  };
}

app.get('/api/me', (req, res) => {
  res.json({ name: req.auth.user });
});

app.get('/api/lookup', async (req, res) => {
  const { title, author } = req.query;
  if (!title) return res.status(400).json({ error: 'Title required' });
  try {
    const parts = [`intitle:${title}`, author ? `inauthor:${author}` : ''].filter(Boolean);
    const q = encodeURIComponent(parts.join(' '));
    const apiKey = process.env.GOOGLE_BOOKS_API_KEY ? `&key=${process.env.GOOGLE_BOOKS_API_KEY}` : '';
    const data = await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=10&printType=books${apiKey}`);

    if (data.items?.length) {
      const norm = s => (s || '').toLowerCase().trim();
      const wantTitle = norm(title);
      const wantAuthor = norm(author);

      // Relevance score for title/author match (used as a tiebreaker).
      const score = it => {
        const vi = it.volumeInfo || {};
        const t = norm(vi.title);
        const a = norm(vi.authors?.[0]);
        let s = 0;
        if (t === wantTitle) s += 100;
        else if (t.startsWith(wantTitle)) s += 50;
        else if (t.includes(wantTitle)) s += 25;
        if (wantAuthor && a.includes(wantAuthor)) s += 20;
        return s;
      };
      // Exact title match (case/space-insensitive). Highest priority: if the
      // user's title matches a result exactly, surface it first regardless of
      // pageCount/language. The loose `intitle:` query still finds it.
      const exactTitle = it => (norm(it.volumeInfo?.title) === wantTitle ? 1 : 0);
      const hasPages = it => (it.volumeInfo?.pageCount ? 1 : 0);

      // Prefer English/Dutch editions (readable for the bookclub) over other
      // languages, e.g. transliterated foreign editions that happen to be an
      // exact title match.
      const preferredLang = it => {
        const lang = (it.volumeInfo?.language || '').toLowerCase();
        return (lang === 'en' || lang === 'nl') ? 1 : 0;
      };

      // Rank by: exact title match; then edition has a pageCount; then an
      // English/Dutch edition; then partial title/author relevance; then
      // stable volume id. Google's ordering isn't stable across calls, so we
      // return the top few and let the user pick.
      const ranked = data.items
        .slice()
        .sort((x, y) =>
          exactTitle(y) - exactTitle(x) ||
          hasPages(y) - hasPages(x) ||
          preferredLang(y) - preferredLang(x) ||
          score(y) - score(x) ||
          (x.id < y.id ? -1 : 1)
        );

      const results = ranked.slice(0, 5).map(it => {
        const vi = it.volumeInfo || {};
        return {
          title: vi.title,
          author: vi.authors?.[0] || '',
          pageCount: vi.pageCount || null,
          coverUrl: vi.imageLinks?.thumbnail?.replace('http:', 'https:') || null,
          description: vi.description || null,
        };
      });

      // Top-level fields describe the best match (used by the book-detail
      // modal); `results` carries the choices for the lookup picker.
      const best = results[0];
      let description = best.description;
      if (!description) {
        try { description = (await fetchOpenLibrary(best.title, best.author))?.description || null; } catch {}
      }
      return res.json({ found: true, ...best, description, results });
    }

    // Google Books found nothing — fall back to Open Library entirely
    const ol = await fetchOpenLibrary(title, author);
    if (!ol) return res.json({ found: false });
    return res.json({ found: true, ...ol, results: [ol] });
  } catch (e) {
    console.error('Lookup error:', e.message);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// ── API ───────────────────────────────────────────────────────────────────

app.get('/api/state', (req, res) => {
  const voterNames = Object.keys(state.votes);
  const voteCount  = voterNames.length;
  const allVoted   = state.phase === 'voting' && state.expectedVoters > 0 && voteCount >= state.expectedVoters;

  const alreadyReadCounts = {};
  const alreadyReadNames  = {};
  state.books.forEach(b => { alreadyReadCounts[b.title] = 0; alreadyReadNames[b.title] = []; });
  Object.entries(state.alreadyRead || {}).forEach(([name, titles]) => {
    titles.forEach(title => {
      if (alreadyReadCounts[title] !== undefined) {
        alreadyReadCounts[title]++;
        alreadyReadNames[title].push(name);
      }
    });
  });

  const me = req.auth?.user;
  const myVote = me && state.votes[me] ? state.votes[me] : null;
  const myAlreadyRead = me && state.alreadyRead[me] ? state.alreadyRead[me] : [];

  const response = { phase: state.phase, books: state.books, expectedVoters: state.expectedVoters, voteCount, voterNames, allVoted, alreadyReadCounts, alreadyReadNames, organizer: state.organizer || null, wishlist: state.wishlist || [], history: state.history || [], members, tieResolved: state.tieResolved, chosenBook: state.chosenBook, concludedAt: state.concludedAt, meeting: state.meeting || null, myVote, myAlreadyRead, revealed: !!state.revealed };

  if (allVoted && state.revealed) {
    const voteCounts = {};
    state.books.forEach(b => { voteCounts[b.title] = 0; });
    Object.values(state.votes).forEach(t => { voteCounts[t] = (voteCounts[t] || 0) + 1; });
    response.voteCounts  = voteCounts;
    response.voteDetails = state.votes;
  }

  res.json(response);
});

function cleanBooks(books) {
  return books
    .filter(b => b?.title?.trim())
    .map(b => ({ title: b.title.trim(), author: (b.author || '').trim(), pageCount: b.pageCount || null, coverUrl: b.coverUrl || null }));
}

app.post('/api/setup', async (req, res) => {
  const { books } = req.body;
  if (!Array.isArray(books) || books.length < 2) return res.status(400).json({ error: 'Please provide at least 2 books.' });
  const clean = cleanBooks(books);
  if (clean.length < 2) return res.status(400).json({ error: 'Please provide at least 2 valid book titles.' });
  const expectedVoters = Math.max(1, members.length - 1);
  state = { books: clean, expectedVoters, votes: {}, alreadyRead: {}, phase: 'voting', organizer: state.organizer, wishlist: state.wishlist, history: state.history || [], concludedAt: null, tieResolved: false, chosenBook: null, revealed: false };
  await saveState();
  res.json({ success: true });
});

app.post('/api/edit-books', async (req, res) => {
  const { books } = req.body;
  if (!Array.isArray(books) || books.length < 2) return res.status(400).json({ error: 'Please provide at least 2 books.' });
  const clean = cleanBooks(books);
  if (clean.length < 2) return res.status(400).json({ error: 'Please provide at least 2 valid book titles.' });
  state.books = clean;
  state.votes = {};
  state.alreadyRead = {};
  state.revealed = false;
  await saveState();
  res.json({ success: true });
});

app.post('/api/vote', async (req, res) => {
  const { name, bookTitle, alreadyRead } = req.body;
  if (!name?.trim())  return res.status(400).json({ error: 'Please enter your name.' });
  if (!bookTitle)     return res.status(400).json({ error: 'Please select a book.' });
  if (state.phase !== 'voting') return res.status(400).json({ error: 'Voting is not open.' });

  const normalizedName = name.trim();
  const wasAllVoted = state.expectedVoters > 0 && Object.keys(state.votes).length >= state.expectedVoters;
  if (wasAllVoted) return res.status(400).json({ error: 'Voting is closed — everyone has voted.' });
  if (!state.books.some(b => b.title === bookTitle)) return res.status(400).json({ error: 'Invalid book selection.' });

  state.votes[normalizedName] = bookTitle;
  if (Array.isArray(alreadyRead)) {
    const valid = alreadyRead.filter(t => state.books.some(b => b.title === t));
    if (valid.length > 0) state.alreadyRead[normalizedName] = valid;
    else delete state.alreadyRead[normalizedName];
  }

  const allVoted = Object.keys(state.votes).length >= state.expectedVoters;
  if (allVoted) {
    const voteCounts = {};
    state.books.forEach(b => { voteCounts[b.title] = 0; });
    Object.values(state.votes).forEach(t => { voteCounts[t] = (voteCounts[t] || 0) + 1; });
    const maxVotes = Math.max(...Object.values(voteCounts));
    const winners = state.books.filter(b => voteCounts[b.title] === maxVotes);
    winners.forEach(winner => {
      if (!state.wishlist.some(w => w.title === winner.title)) {
        state.wishlist.push({ title: winner.title, author: winner.author, pageCount: winner.pageCount, coverUrl: winner.coverUrl, addedBy: null, fromVote: true });
      }
    });
    state.concludedAt = new Date().toISOString().split('T')[0];
    if (winners.length === 1) {
      if (!state.history) state.history = [];
      const winner = winners[0];
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      state.history.push({ id, date: state.concludedAt, organizer: state.organizer || '', book: { title: winner.title, author: winner.author, pageCount: winner.pageCount, coverUrl: winner.coverUrl } });
    }
  }

  await saveState();
  res.json({ success: true, allVoted });
});

app.post('/api/report-read', async (req, res) => {
  const { name, alreadyRead } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Please enter your name.' });
  if (state.phase !== 'voting') return res.status(400).json({ error: 'Voting is not open.' });
  if (!Array.isArray(alreadyRead)) return res.status(400).json({ error: 'Invalid selection.' });

  const wasAllVoted = state.expectedVoters > 0 && Object.keys(state.votes).length >= state.expectedVoters;
  if (wasAllVoted) return res.status(400).json({ error: 'Voting is closed — everyone has voted.' });

  const normalizedName = name.trim();
  const valid = alreadyRead.filter(t => state.books.some(b => b.title === t));
  if (valid.length > 0) state.alreadyRead[normalizedName] = valid;
  else delete state.alreadyRead[normalizedName];
  await saveState();
  res.json({ success: true });
});

app.post('/api/reveal', async (req, res) => {
  if (req.auth.user !== state.organizer) return res.status(403).json({ error: 'Alleen de organisator kan het resultaat onthullen.' });
  if (state.phase !== 'voting') return res.status(400).json({ error: 'Voting is not open.' });
  const voteCount = Object.keys(state.votes).length;
  if (!(state.expectedVoters > 0 && voteCount >= state.expectedVoters)) {
    return res.status(400).json({ error: 'Nog niet iedereen heeft gestemd.' });
  }
  state.revealed = true;
  await saveState();
  res.json({ success: true });
});

app.delete('/api/wishlist', async (req, res) => {
  const title = req.query.title;
  if (!title) return res.status(400).json({ error: 'Title required.' });
  const before = state.wishlist.length;
  state.wishlist = state.wishlist.filter(w => w.title !== title);
  if (state.wishlist.length === before) return res.status(404).json({ error: 'Not found.' });
  await saveState();
  res.json({ success: true });
});

app.post('/api/wishlist', async (req, res) => {
  const { title, author, pageCount, coverUrl } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Please enter a title.' });
  if (state.wishlist.some(w => w.title.toLowerCase() === title.trim().toLowerCase())) {
    return res.status(409).json({ error: 'This book is already on the wishlist.' });
  }
  state.wishlist.push({ title: title.trim(), author: (author || '').trim(), pageCount: pageCount || null, coverUrl: coverUrl || null, addedBy: req.auth.user, fromVote: false });
  await saveState();
  res.json({ success: true });
});

app.post('/api/resolve-tie', async (req, res) => {
  if (req.auth.user !== state.organizer) return res.status(403).json({ error: 'Alleen de organisator kan een gelijkspel oplossen.' });
  const { bookTitle } = req.body;
  if (!bookTitle) return res.status(400).json({ error: 'Boektitel vereist.' });

  const voteCounts = {};
  state.books.forEach(b => { voteCounts[b.title] = 0; });
  Object.values(state.votes).forEach(t => { voteCounts[t] = (voteCounts[t] || 0) + 1; });
  const maxVotes = Math.max(...Object.values(voteCounts));
  const tiedBooks = state.books.filter(b => voteCounts[b.title] === maxVotes);

  if (tiedBooks.length <= 1) return res.status(400).json({ error: 'Er is geen gelijkspel.' });
  const chosen = tiedBooks.find(b => b.title === bookTitle);
  if (!chosen) return res.status(400).json({ error: 'Ongeldig boek.' });

  state.tieResolved = true;
  state.chosenBook = { title: chosen.title, author: chosen.author, pageCount: chosen.pageCount, coverUrl: chosen.coverUrl };
  if (!state.history) state.history = [];
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  state.history.push({ id, date: state.concludedAt || new Date().toISOString().split('T')[0], organizer: state.organizer || '', book: state.chosenBook });
  await saveState();
  res.json({ success: true });
});

app.post('/api/history', async (req, res) => {
  const { date, organizer, book } = req.body;
  if (!date) return res.status(400).json({ error: 'Date is required.' });
  if (!organizer?.trim()) return res.status(400).json({ error: 'Organizer is required.' });
  if (!book?.title?.trim()) return res.status(400).json({ error: 'Book title is required.' });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const entry = { id, date, organizer: organizer.trim(), book: { title: book.title.trim(), author: (book.author || '').trim(), pageCount: book.pageCount || null, coverUrl: book.coverUrl || null } };
  if (!state.history) state.history = [];
  state.history.push(entry);
  await saveState();
  res.json({ success: true, entry });
});

app.put('/api/history/:id', async (req, res) => {
  const { id } = req.params;
  const { date, organizer, book } = req.body;
  if (!state.history) return res.status(404).json({ error: 'Not found.' });
  const idx = state.history.findIndex(h => h.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found.' });
  if (!date) return res.status(400).json({ error: 'Date is required.' });
  if (!organizer?.trim()) return res.status(400).json({ error: 'Organizer is required.' });
  if (!book?.title?.trim()) return res.status(400).json({ error: 'Book title is required.' });
  const existingRatings = state.history[idx].ratings || {};
  state.history[idx] = { id, date, organizer: organizer.trim(), book: { title: book.title.trim(), author: (book.author || '').trim(), pageCount: book.pageCount || null, coverUrl: book.coverUrl || null }, ratings: existingRatings };
  await saveState();
  res.json({ success: true });
});

app.delete('/api/history/:id', async (req, res) => {
  const { id } = req.params;
  if (!state.history) return res.status(404).json({ error: 'Not found.' });
  const before = state.history.length;
  state.history = state.history.filter(h => h.id !== id);
  if (state.history.length === before) return res.status(404).json({ error: 'Not found.' });
  await saveState();
  res.json({ success: true });
});

app.post('/api/history/:id/rate', async (req, res) => {
  const { id } = req.params;
  const { stars } = req.body;
  if (!state.history) return res.status(404).json({ error: 'Not found.' });
  const entry = state.history.find(h => h.id === id);
  if (!entry) return res.status(404).json({ error: 'Not found.' });
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return res.status(400).json({ error: 'Geef 1 tot 5 sterren.' });
  if (!entry.ratings) entry.ratings = {};
  entry.ratings[req.auth.user] = stars;
  await saveState();
  res.json({ success: true });
});

app.post('/api/claim-organizer', async (req, res) => {
  if (state.organizer && state.organizer !== req.auth.user) {
    return res.status(409).json({ error: 'An organizer is already assigned.' });
  }
  state.organizer = req.auth.user;
  await saveState();
  res.json({ success: true });
});

app.post('/api/take-organizer', async (req, res) => {
  const { wishlist, history } = state;
  state = defaultState();
  state.organizer = req.auth.user;
  state.wishlist = wishlist;
  state.history = history;
  await saveState();
  res.json({ success: true });
});

app.post('/api/reset', async (req, res) => {
  const { organizer, wishlist, history } = state;
  state = defaultState();
  state.organizer = organizer;
  state.wishlist = wishlist;
  state.history = history;
  await saveState();
  res.json({ success: true });
});

// ── Meeting ───────────────────────────────────────────────────────────────

app.post('/api/meeting', async (req, res) => {
  const { place, datetime } = req.body;
  if (datetime && datetime.slice(0, 10) < todayLocal()) {
    return res.status(400).json({ error: 'De meetingdatum kan niet in het verleden liggen.' });
  }
  state.meeting = { place: (place || '').trim(), datetime: datetime || null };
  await saveState();
  res.json({ success: true });
});

// ── Export / import ───────────────────────────────────────────────────────

app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="bookclub-backup.json"');
  res.json(state);
});

app.post('/api/import', async (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Invalid data' });
  state = migrate(data);
  await saveState();
  res.json({ success: true });
});

// ── Start ─────────────────────────────────────────────────────────────────

async function start() {
  state = await storage.load();
  const historyCount = state.history?.length ?? 0;
  const wishlistCount = state.wishlist?.length ?? 0;
  console.log(`State loaded: phase=${state.phase}, history=${historyCount}, wishlist=${wishlistCount}`);
  app.listen(PORT, () => {
    console.log(`\nBookclub app → http://localhost:${PORT}`);
    if (members.length) {
      console.log(`Members: ${members.join(', ')}`);
    } else {
      console.log(`Username: bookclub`);
    }
    console.log(`Password: ${password || 'changeme'}\n`);
  });
}

start().catch(err => { console.error('Failed to start:', err); process.exit(1); });
