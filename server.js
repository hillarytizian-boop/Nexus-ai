'use strict';
// ─────────────────────────────────────────────────────────────
//  NEXUS AGENT  –  server.js
//  One file. Everything lives here.
//  Run:  node server.js
// ─────────────────────────────────────────────────────────────
require('dotenv').config();

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const fs        = require('fs');
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');
const { v4: uuidv4 }     = require('uuid');
const rateLimit = require('express-rate-limit');
const Database  = require('better-sqlite3');
const OpenAI    = require('openai');

// ── Config ───────────────────────────────────────────────────
const PORT    = parseInt(process.env.PORT || '3001', 10);
const SECRET  = process.env.JWT_SECRET || 'nexus-dev-secret-CHANGE-IN-PRODUCTION';
const DB_PATH = process.env.DB_PATH    || path.join(__dirname, 'data', 'nexus.db');

// ── Database ─────────────────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name          TEXT NOT NULL,
    role          TEXT    DEFAULT 'user',
    plan          TEXT    DEFAULT 'free',
    agents_limit  INTEGER DEFAULT 3,
    tasks_used    INTEGER DEFAULT 0,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS agents (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    name              TEXT NOT NULL,
    goal              TEXT NOT NULL,
    status            TEXT    DEFAULT 'idle',
    model             TEXT    DEFAULT 'gpt-4o-mini',
    max_iterations    INTEGER DEFAULT 10,
    current_iteration INTEGER DEFAULT 0,
    result            TEXT,
    error             TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at   DATETIME,
    completed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS agent_logs (
    id        TEXT PRIMARY KEY,
    agent_id  TEXT NOT NULL,
    type      TEXT NOT NULL,
    content   TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL,
    description TEXT NOT NULL,
    status      TEXT    DEFAULT 'pending',
    result      TEXT,
    sort_order  INTEGER DEFAULT 0,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  );
`);

// ── OpenAI client (optional) ─────────────────────────────────
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1' })
  : null;

async function aiChat(messages, model = 'gpt-4o-mini', maxTokens = 600) {
  if (!openai) return null;
  try {
    const r = await openai.chat.completions.create({ model, max_tokens: maxTokens, messages });
    return r.choices[0].message.content.trim();
  } catch { return null; }
}

// ── AI helpers ────────────────────────────────────────────────
async function generateTasks(goal, model) {
  const reply = await aiChat([
    { role: 'system', content: 'Break the goal into 4-6 short actionable tasks. Return ONLY a JSON array of strings. No markdown.' },
    { role: 'user',   content: goal }
  ], model, 500);
  if (reply) {
    try { const a = JSON.parse(reply.replace(/```json|```/g,'')); if (Array.isArray(a)) return a; } catch {}
  }
  return [
    'Research and gather relevant information',
    'Identify key patterns and insights',
    'Develop a structured action plan',
    'Execute the core steps',
    'Compile and summarise results',
  ];
}

async function generateThought(task, goal, model) {
  return await aiChat([
    { role: 'system', content: 'You are an AI agent thinking out loud. Write 1-2 sentences of reasoning about how you will approach the task.' },
    { role: 'user',   content: `Goal: ${goal}\nTask: ${task}` }
  ], model, 120) || `Preparing to execute: "${task}"`;
}

async function executeTask(task, memory, goal, model) {
  const ctx = memory.slice(-3).join('\n') || 'No prior context.';
  return await aiChat([
    { role: 'system', content: `You are an autonomous AI agent. Execute the task and return a clear, specific result.\nContext:\n${ctx}` },
    { role: 'user',   content: `Goal: ${goal}\nTask: ${task}` }
  ], model, 500) || `[Demo] Task "${task}" processed. Add OPENAI_API_KEY for real AI output.`;
}

async function synthesise(goal, done, model) {
  const summary = done.map((t,i) => `${i+1}. ${t.desc}: ${t.result}`).join('\n');
  return await aiChat([
    { role: 'system', content: 'Synthesise the completed tasks into a concise final report.' },
    { role: 'user',   content: `Goal: ${goal}\n\n${summary}` }
  ], model, 500) || `All ${done.length} tasks completed for: "${goal}"`;
}

// ── WebSocket broadcast map ───────────────────────────────────
const wsClients    = new Map(); // agentId → Set<ws>
const agentControl = new Map(); // agentId → { paused, stopped }

function wsRegister(agentId, ws) {
  if (!wsClients.has(agentId)) wsClients.set(agentId, new Set());
  wsClients.get(agentId).add(ws);
  ws.on('close', () => {
    const s = wsClients.get(agentId);
    if (s) { s.delete(ws); if (!s.size) wsClients.delete(agentId); }
  });
}

function wsBroadcast(agentId, data) {
  const clients = wsClients.get(agentId);
  if (!clients) return;
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    try { if (ws.readyState === 1) ws.send(msg); } catch {}
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function addLog(agentId, type, content) {
  const id  = uuidv4();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO agent_logs (id,agent_id,type,content,timestamp) VALUES (?,?,?,?,?)').run(id, agentId, type, content, now);
  wsBroadcast(agentId, { event: 'log', data: { id, type, content, timestamp: now } });
}

function setStatus(agentId, fields) {
  const sets = Object.keys(fields).map(k => `${k}=?`).join(',');
  db.prepare(`UPDATE agents SET ${sets},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...Object.values(fields), agentId);
  wsBroadcast(agentId, { event: 'status', data: { agentId, ...fields } });
}

// ── Agent runner ──────────────────────────────────────────────
async function runAgent(agentId) {
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(agentId);
  if (!agent) return;

  const ctrl = { paused: false, stopped: false };
  agentControl.set(agentId, ctrl);

  try {
    setStatus(agentId, { status: 'planning', started_at: new Date().toISOString() });
    addLog(agentId, 'system',  `Agent "${agent.name}" started.`);
    addLog(agentId, 'thought', `Analysing goal: "${agent.goal}"`);
    await sleep(600);

    const taskList    = await generateTasks(agent.goal, agent.model);
    const taskRecords = taskList.map((desc, i) => {
      const id = uuidv4();
      db.prepare('INSERT INTO tasks (id,agent_id,description,sort_order) VALUES (?,?,?,?)').run(id, agentId, desc, i);
      return { id, description: desc, status: 'pending' };
    });

    setStatus(agentId, { status: 'running' });
    addLog(agentId, 'action', `${taskList.length} tasks created.`);
    wsBroadcast(agentId, { event: 'tasks', data: taskRecords });
    await sleep(400);

    const memory = [], done = [];
    let iter = 0;

    for (const task of taskRecords) {
      if (ctrl.stopped) break;
      while (ctrl.paused && !ctrl.stopped) await sleep(400);
      if (ctrl.stopped) break;

      iter++;
      setStatus(agentId, { current_iteration: iter });
      db.prepare('UPDATE tasks SET status=? WHERE id=?').run('running', task.id);
      wsBroadcast(agentId, { event: 'taskUpdate', data: { id: task.id, status: 'running' } });

      const thought = await generateThought(task.description, agent.goal, agent.model);
      addLog(agentId, 'thought', thought);
      await sleep(300);

      addLog(agentId, 'action', `Executing: ${task.description}`);
      const result = await executeTask(task.description, memory, agent.goal, agent.model);
      addLog(agentId, 'result', result);

      memory.push(`${task.description}: ${result.slice(0, 100)}`);
      db.prepare('UPDATE tasks SET status=?,result=? WHERE id=?').run('completed', result, task.id);
      wsBroadcast(agentId, { event: 'taskUpdate', data: { id: task.id, status: 'completed', result } });
      done.push({ desc: task.description, result });
      await sleep(200);
    }

    if (ctrl.stopped) {
      setStatus(agentId, { status: 'stopped' });
      addLog(agentId, 'system', 'Agent stopped by user.');
      return;
    }

    setStatus(agentId, { status: 'synthesizing' });
    addLog(agentId, 'system', 'Synthesising final result…');
    await sleep(500);

    const finalResult = await synthesise(agent.goal, done, agent.model);
    setStatus(agentId, { status: 'completed', result: finalResult, completed_at: new Date().toISOString() });
    addLog(agentId, 'result', finalResult);
    addLog(agentId, 'system', `✓ Completed in ${iter} steps.`);
    db.prepare('UPDATE users SET tasks_used=tasks_used+? WHERE id=?').run(iter, agent.user_id);

  } catch (err) {
    setStatus(agentId, { status: 'error', error: err.message });
    addLog(agentId, 'error', `Error: ${err.message}`);
  } finally {
    agentControl.delete(agentId);
  }
}

// ── JWT helpers ───────────────────────────────────────────────
const signToken  = (id)    => jwt.sign({ userId: id }, SECRET, { expiresIn: '7d' });
const verifyUser = (token) => {
  const p    = jwt.verify(token, SECRET);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(p.userId);
  if (!user) throw new Error('User not found');
  return user;
};

// ── Express app ───────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// WebSocket
const wss = new WebSocket.Server({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const qs      = (req.url.split('?')[1] || '');
  const params  = new URLSearchParams(qs);
  try {
    jwt.verify(params.get('token') || '', SECRET);
    wsRegister(params.get('agentId') || '', ws);
    ws.send(JSON.stringify({ event: 'connected' }));
  } catch { ws.close(1008, 'Unauthorized'); }
});

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiters
const authLim  = rateLimit({ windowMs: 15*60*1000, max: 15, message: { error: 'Too many attempts' } });
const apiLim   = rateLimit({ windowMs:    60*1000, max: 100, message: { error: 'Rate limit hit' } });

// Auth middleware
function auth(req, res, next) {
  try {
    req.user = verifyUser((req.headers.authorization || '').replace('Bearer ', ''));
    next();
  } catch { res.status(401).json({ error: 'Not authenticated' }); }
}
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

const safe = (u) => { const { password_hash, ...s } = u; return s; };

// ── Auth routes ──────────────────────────────────────────────
app.post('/api/auth/register', authLim, async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'email, password, name required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase().trim()))
    return res.status(409).json({ error: 'Email already registered' });
  const id   = uuidv4();
  const hash = await bcrypt.hash(password, 12);
  db.prepare('INSERT INTO users (id,email,password_hash,name) VALUES (?,?,?,?)').run(id, email.toLowerCase().trim(), hash, name.trim());
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  res.status(201).json({ token: signToken(id), user: safe(user) });
});

app.post('/api/auth/login', authLim, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email=?').get((email||'').toLowerCase().trim());
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ token: signToken(user.id), user: safe(user) });
});

app.get('/api/auth/me', auth, (req, res) => res.json({ user: safe(req.user) }));

// ── Agent routes ─────────────────────────────────────────────
app.get('/api/agents', auth, apiLim, (req, res) => {
  const agents = db.prepare('SELECT * FROM agents WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
  res.json({ agents });
});

app.get('/api/agents/:id', auth, apiLim, (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!agent) return res.status(404).json({ error: 'Not found' });
  const logs  = db.prepare('SELECT * FROM agent_logs WHERE agent_id=? ORDER BY timestamp ASC').all(req.params.id);
  const tasks = db.prepare('SELECT * FROM tasks WHERE agent_id=? ORDER BY sort_order ASC').all(req.params.id);
  res.json({ agent, logs, tasks });
});

app.post('/api/agents', auth, apiLim, (req, res) => {
  const { name, goal, model = 'gpt-4o-mini', maxIterations = 10 } = req.body || {};
  if (!name || name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters' });
  if (!goal || goal.length < 10) return res.status(400).json({ error: 'Goal must be at least 10 characters' });
  const active = db.prepare("SELECT COUNT(*) c FROM agents WHERE user_id=? AND status NOT IN ('completed','stopped','error')").get(req.user.id);
  if (active.c >= req.user.agents_limit) return res.status(403).json({ error: `Plan limit: max ${req.user.agents_limit} active agents` });
  const id = uuidv4();
  db.prepare('INSERT INTO agents (id,user_id,name,goal,model,max_iterations) VALUES (?,?,?,?,?,?)').run(id, req.user.id, name.trim(), goal.trim(), model, maxIterations);
  res.status(201).json({ agent: db.prepare('SELECT * FROM agents WHERE id=?').get(id) });
});

app.post('/api/agents/:id/start', auth, (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!agent) return res.status(404).json({ error: 'Not found' });
  if (['running','planning','synthesizing','paused'].includes(agent.status))
    return res.status(409).json({ error: 'Already running' });
  db.prepare('DELETE FROM agent_logs WHERE agent_id=?').run(agent.id);
  db.prepare('DELETE FROM tasks WHERE agent_id=?').run(agent.id);
  db.prepare("UPDATE agents SET status='idle',current_iteration=0,result=NULL,error=NULL WHERE id=?").run(agent.id);
  runAgent(agent.id).catch(console.error);
  res.json({ ok: true });
});

app.post('/api/agents/:id/pause', auth, (req, res) => {
  const ctrl = agentControl.get(req.params.id);
  if (ctrl) { ctrl.paused = true; setStatus(req.params.id, { status: 'paused' }); addLog(req.params.id, 'system', 'Paused.'); }
  res.json({ ok: true });
});

app.post('/api/agents/:id/resume', auth, (req, res) => {
  const ctrl = agentControl.get(req.params.id);
  if (ctrl) { ctrl.paused = false; setStatus(req.params.id, { status: 'running' }); addLog(req.params.id, 'system', 'Resumed.'); }
  res.json({ ok: true });
});

app.post('/api/agents/:id/stop', auth, (req, res) => {
  const ctrl = agentControl.get(req.params.id);
  if (ctrl) { ctrl.stopped = true; ctrl.paused = false; }
  res.json({ ok: true });
});

app.delete('/api/agents/:id', auth, (req, res) => {
  const agent = db.prepare('SELECT id FROM agents WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!agent) return res.status(404).json({ error: 'Not found' });
  const ctrl = agentControl.get(req.params.id);
  if (ctrl) { ctrl.stopped = true; ctrl.paused = false; }
  db.prepare('DELETE FROM agents WHERE id=?').run(agent.id);
  res.json({ ok: true });
});

// ── Admin routes ─────────────────────────────────────────────
app.get('/api/admin/stats', auth, adminOnly, (req, res) => {
  res.json({
    totalUsers:  db.prepare('SELECT COUNT(*) c FROM users').get().c,
    totalAgents: db.prepare('SELECT COUNT(*) c FROM agents').get().c,
    running:     agentControl.size,
    completed:   db.prepare("SELECT COUNT(*) c FROM agents WHERE status='completed'").get().c,
    users:       db.prepare('SELECT id,email,name,plan,tasks_used,created_at FROM users ORDER BY created_at DESC').all(),
  });
});

app.put('/api/admin/users/:id/plan', auth, adminOnly, (req, res) => {
  const limits = { free: 3, pro: 10, enterprise: 50 };
  const plan   = req.body.plan || 'free';
  db.prepare('UPDATE users SET plan=?,agents_limit=? WHERE id=?').run(plan, limits[plan] || 3, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', auth, adminOnly, (req, res) => {
  db.prepare("DELETE FROM users WHERE id=? AND role!='admin'").run(req.params.id);
  res.json({ ok: true });
});

// ── Health ─────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Fallback → serve the UI ───────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ─────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀  Nexus Agent running → http://localhost:${PORT}`);
  console.log(`🤖  AI mode: ${openai ? 'OpenAI connected' : 'Demo (add OPENAI_API_KEY for real AI)'}\n`);
});
