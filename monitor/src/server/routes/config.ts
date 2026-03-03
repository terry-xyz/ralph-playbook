/**
 * REST API — Config endpoints (Spec 06 H4).
 * GET /api/config — current config
 * PUT /api/config — update config
 */

import type { FastifyInstance } from 'fastify';
import { loadConfig, writeConfig } from '@lib/config.js';
import type { Config } from '@shared/types.js';

export function registerConfigRoutes(fastify: FastifyInstance) {
  // GET /api/config — current config
  fastify.get('/api/config', async () => {
    const configPath = (fastify as any).configPath as string;
    const config = loadConfig(configPath);
    return config;
  });

  // PUT /api/config — update config
  fastify.put('/api/config', async (request, reply) => {
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
  });
}
