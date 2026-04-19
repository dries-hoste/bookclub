require('dotenv').config();
const express = require('express');
const fs = require('fs');
const https = require('https');
const basicAuth = require('express-basic-auth');

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

app.use(basicAuth({
  users: authUsers,
  challenge: true,
  realm: 'Book Club',
}));

app.use(express.json());
app.use(express.static('public'));

// ── Storage ────────────────────────────────────────────────────────────────

function defaultState() {
  return { books: [], expectedVoters: 0, votes: {}, alreadyRead: {}, phase: 'setup', organizer: null };
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
      return rows.length ? rows[0].data : defaultState();
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
  // File — used locally
  const DATA_FILE = './data.json';
  storage = {
    async load() {
      try {
        if (fs.existsSync(DATA_FILE)) {
          const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
          if (!data.alreadyRead) data.alreadyRead = {};
          return data;
        }
      } catch (e) {
        console.error('Failed to load data.json:', e.message);
      }
      return defaultState();
    },
    async save(s) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(s, null, 2));
    },
  };
  console.log('Storage: data.json (local)');
}

let state;
async function saveState() { await storage.save(state); }

// ── Book lookup (Google Books proxy) ──────────────────────────────────────

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

app.get('/api/me', (req, res) => {
  res.json({ name: req.auth.user });
});

app.get('/api/lookup', async (req, res) => {
  const { title, author } = req.query;
  if (!title) return res.status(400).json({ error: 'Title required' });
  try {
    const parts = [`intitle:${title}`, author ? `inauthor:${author}` : ''].filter(Boolean);
    const q = encodeURIComponent(parts.join(' '));
    const data = await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=5&printType=books`);
    if (!data.items?.length) return res.json({ found: false });
    const item = data.items.find(i => i.volumeInfo?.pageCount) || data.items[0];
    const info = item.volumeInfo;
    res.json({
      found: true,
      title: info.title,
      author: info.authors?.[0] || '',
      pageCount: info.pageCount || null,
      coverUrl: info.imageLinks?.thumbnail?.replace('http:', 'https:') || null,
    });
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

  const response = { phase: state.phase, books: state.books, expectedVoters: state.expectedVoters, voteCount, voterNames, allVoted, alreadyReadCounts, alreadyReadNames, organizer: state.organizer || null };

  if (allVoted) {
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
  state = { books: clean, expectedVoters, votes: {}, alreadyRead: {}, phase: 'voting', organizer: state.organizer };
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
  await saveState();
  res.json({ success: true });
});

app.post('/api/vote', async (req, res) => {
  const { name, bookTitle, alreadyRead } = req.body;
  if (!name?.trim())  return res.status(400).json({ error: 'Please enter your name.' });
  if (!bookTitle)     return res.status(400).json({ error: 'Please select a book.' });
  if (state.phase !== 'voting') return res.status(400).json({ error: 'Voting is not open.' });

  const normalizedName = name.trim();
  if (state.votes[normalizedName]) return res.status(400).json({ error: 'You have already voted.' });
  if (!state.books.some(b => b.title === bookTitle)) return res.status(400).json({ error: 'Invalid book selection.' });

  state.votes[normalizedName] = bookTitle;
  if (Array.isArray(alreadyRead) && alreadyRead.length > 0) {
    const valid = alreadyRead.filter(t => state.books.some(b => b.title === t));
    if (valid.length > 0) state.alreadyRead[normalizedName] = valid;
  }
  await saveState();
  res.json({ success: true, allVoted: Object.keys(state.votes).length >= state.expectedVoters });
});

app.post('/api/report-read', async (req, res) => {
  const { name, alreadyRead } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Please enter your name.' });
  if (state.phase !== 'voting') return res.status(400).json({ error: 'Voting is not open.' });
  if (!Array.isArray(alreadyRead) || alreadyRead.length === 0) return res.status(400).json({ error: 'Please select at least one book.' });

  const normalizedName = name.trim();
  const valid = alreadyRead.filter(t => state.books.some(b => b.title === t));
  if (valid.length === 0) return res.status(400).json({ error: 'No valid books selected.' });

  state.alreadyRead[normalizedName] = valid;
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
  state = defaultState();
  state.organizer = req.auth.user;
  await saveState();
  res.json({ success: true });
});

app.post('/api/reset', async (req, res) => {
  const organizer = state.organizer;
  state = defaultState();
  state.organizer = organizer;
  await saveState();
  res.json({ success: true });
});

// ── Start ─────────────────────────────────────────────────────────────────

async function start() {
  state = await storage.load();
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
