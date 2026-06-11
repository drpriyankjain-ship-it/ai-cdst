/**
 * CDST Node.js Server — Entry Point
 * ===================================
 * Express server with WebSocket support, REST routes, and clinical pipeline.
 */

import 'dotenv/config';
import express from 'express';
import expressWs from 'express-ws';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { initPool } from './lib/db.js';
import { mountWebSocket } from './orchestrator.js';

// Routes
import authRoutes from './routes/auth.js';
import audioRoutes from './routes/audio.js';
import dashboardRoutes from './routes/dashboard.js';
import transcriptRoutes from './routes/transcripts.js';
import sessionRoutes from './routes/session.js';
import adminRoutes from './routes/admin.js';

const app = express();
expressWs(app);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve web app static files if they exist
import fs from 'fs';
const webDir = fs.existsSync(path.join(__dirname, 'web'))
  ? path.join(__dirname, 'web')
  : path.join(__dirname, '..', 'web');
const hasWebApp = fs.existsSync(path.join(webDir, 'index.html'));
if (hasWebApp) app.use(express.static(webDir));

// Health check (also serves as root for ELB)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'cdst-server', timestamp: new Date().toISOString() });
});
app.get('/', (req, res) => {
  if (hasWebApp) return res.sendFile(path.join(webDir, 'index.html'));
  res.json({ status: 'ok', service: 'cdst-server', timestamp: new Date().toISOString() });
});

// REST routes
app.use('/api/auth', authRoutes);
app.use('/api/audio', audioRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/transcripts', transcriptRoutes);
app.use('/api/session', sessionRoutes);
app.use('/api/admin', adminRoutes);

// WebSocket
mountWebSocket(app);

// SPA catch-all — serve index.html for non-API routes (only if web app exists)
if (hasWebApp) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/session') || req.path.startsWith('/health')) return next();
    res.sendFile(path.join(webDir, 'index.html'));
  });
}

// Start
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await initPool();
    app.listen(PORT, () => {
      console.log(`\n  CDST Server running on port ${PORT}`);
      console.log(`  Health: http://localhost:${PORT}/health`);
      console.log(`  WebSocket: ws://localhost:${PORT}/session/ws\n`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
