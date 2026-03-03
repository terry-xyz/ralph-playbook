/**
 * Dashboard Server (Spec 06).
 * Fastify server binding to localhost:9100, serving the React SPA and API endpoints.
 *
 * Responsibilities:
 * - Serve the built React SPA from dist/client
 * - REST API for sessions, analytics, config, search
 * - WebSocket for live event streaming
 * - On startup: ingest accumulated JSONL if no daemon running
 * - Graceful shutdown: flush DB, stop ingester, close connections
 */

import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from '@lib/config.js';
import { Storage } from '@lib/storage.js';
import { Ingester, processAllFiles } from './ingester.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerWebSocket } from './routes/websocket.js';
import { registerGuardrailRoutes } from './routes/guardrails.js';

export async function createServer(monitorRoot?: string) {
  const root = monitorRoot ?? path.resolve(import.meta.dirname ?? '.', '..', '..');
  const configPath = path.join(root, 'ralph-monitor.config.json');
  const config = loadConfig(configPath);

  const dataDir = path.resolve(root, config.general.dataDir);
  const dbFilePath = path.join(dataDir, 'ralph-monitor.db');
  const eventsDir = path.join(dataDir, 'events');

  // Ensure data directories exist
  fs.mkdirSync(eventsDir, { recursive: true });

  // Initialize storage
  const storage = new Storage(dbFilePath);
  await storage.init();

  // Ingest accumulated events on startup
  processAllFiles(storage.getDb(), eventsDir, config);

  // Start periodic flush
  storage.startPeriodicFlush(5000);

  // Start ingester (will watch for new events, triggers post-session scraping)
  const ingester = new Ingester(storage.getDb(), eventsDir, {
    batchIntervalMs: config.ingestion.batchIntervalMs,
    batchSize: config.ingestion.batchSize,
    staleTimeoutMinutes: config.general.staleTimeoutMinutes,
    config,
  });

  // Create Fastify instance
  const fastify = Fastify({
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss' },
      },
    },
  });

  // Register WebSocket plugin
  await fastify.register(fastifyWebsocket);

  // Register static file serving for the built SPA
  const clientDistPath = path.join(root, 'dist', 'client');
  if (fs.existsSync(clientDistPath)) {
    await fastify.register(fastifyStatic, {
      root: clientDistPath,
      prefix: '/',
      decorateReply: true,
    });
  }

  // Provide storage and config to route handlers via decoration
  fastify.decorate('storage', storage);
  fastify.decorate('db', storage.getDb());
  fastify.decorate('config', config);
  fastify.decorate('configPath', configPath);
  fastify.decorate('ingester', ingester);
  fastify.decorate('eventsDir', eventsDir);

  // Register API routes
  registerSessionRoutes(fastify);
  registerAnalyticsRoutes(fastify);
  registerConfigRoutes(fastify);
  registerSearchRoutes(fastify);
  registerGuardrailRoutes(fastify);
  registerWebSocket(fastify);

  // SPA fallback (H7) — serve index.html for non-API routes
  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
      reply.status(404).send({ error: 'Not found' });
      return;
    }
    const indexPath = path.join(clientDistPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      reply.type('text/html').send(fs.readFileSync(indexPath));
    } else {
      reply.status(404).send({ error: 'Dashboard not built. Run: npm run build' });
    }
  });

  // Global error handler — never leak internals (Spec 06 AC 59)
  fastify.setErrorHandler((error, _request, reply) => {
    fastify.log.error(error);
    reply.status(500).send({ error: 'Internal server error' });
  });

  // Graceful shutdown
  const shutdown = async () => {
    fastify.log.info('Shutting down...');
    await ingester.shutdown();
    await storage.shutdown();
    await fastify.close();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { fastify, storage, ingester, config, shutdown };
}

// Start server if run directly
const isMainModule = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`;
if (isMainModule) {
  const { fastify, config } = await createServer();
  try {
    await fastify.listen({
      port: config.general.port,
      host: '127.0.0.1',
    });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}
