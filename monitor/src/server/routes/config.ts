/**
 * REST API — Config endpoints (Spec 06 H4).
 * GET /api/config — current config
 * PUT/PATCH /api/config — update config
 * POST /api/data/purge — purge old data
 */

import type { FastifyInstance } from 'fastify';
import { loadConfig, writeConfig } from '@lib/config.js';
import type { Database } from 'sql.js';

export function registerConfigRoutes(fastify: FastifyInstance) {
  // GET /api/config — current config
  fastify.get('/api/config', async () => {
    const configPath = (fastify as any).configPath as string;
    const config = loadConfig(configPath);
    return config;
  });

  // Shared handler for config update (both PUT and PATCH)
  async function handleConfigUpdate(request: any, reply: any) {
    const configPath = (fastify as any).configPath as string;
    const body = request.body as Record<string, unknown>;

    if (!body || typeof body !== 'object') {
      reply.status(400).send({ error: 'Request body must be a JSON object' });
      return;
    }

    try {
      writeConfig(configPath, body);
      const updated = loadConfig(configPath);
      return updated;
    } catch (err) {
      fastify.log.error(err);
      reply.status(500).send({ error: 'Failed to save configuration' });
    }
  }

  // PUT /api/config — update config
  fastify.put('/api/config', handleConfigUpdate);

  // PATCH /api/config — partial update config (used by client)
  fastify.patch('/api/config', handleConfigUpdate);

  // POST /api/data/purge — purge data older than retention period
  fastify.post('/api/data/purge', async (request, reply) => {
    const configPath = (fastify as any).configPath as string;
    const db = (fastify as any).db as Database;
    const config = loadConfig(configPath);
    const retentionDays = config.general.retentionDays;

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    try {
      db.run('BEGIN TRANSACTION;');
      try {
        // Delete children before parents (foreign key constraints)
        db.run('DELETE FROM guardrail_log WHERE timestamp < ?;', [cutoff]);
        db.run('DELETE FROM events WHERE timestamp < ?;', [cutoff]);
        db.run(`
          DELETE FROM metrics WHERE session_id IN (
            SELECT session_id FROM sessions WHERE start_time < ?
          );
        `, [cutoff]);
        db.run('DELETE FROM sessions WHERE start_time < ?;', [cutoff]);
        db.run('COMMIT;');
      } catch (txErr) {
        db.run('ROLLBACK;');
        throw txErr;
      }

      // VACUUM must be outside transaction
      db.run('VACUUM;');

      return {
        success: true,
        retentionDays,
        cutoffDate: cutoff,
      };
    } catch (err) {
      fastify.log.error(err);
      reply.status(500).send({ error: 'Failed to purge data' });
    }
  });
}
