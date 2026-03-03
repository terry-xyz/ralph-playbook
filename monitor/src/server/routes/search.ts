/**
 * REST API — Search endpoint (Spec 06 H5).
 * GET /api/search?q=... — full-text search across events (LIKE fallback since FTS5 unavailable).
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from 'sql.js';

export function registerSearchRoutes(fastify: FastifyInstance) {
  fastify.get('/api/search', async (request, reply) => {
    const db = (fastify as any).db as Database;
    const query = request.query as Record<string, string>;
    const q = query.q?.trim();

    if (!q) {
      reply.status(400).send({ error: 'Search query "q" is required' });
      return;
    }

    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '50', 10) || 50));
    const searchPattern = `%${q}%`;

    const result = db.exec(
      `SELECT e.event_id, e.session_id, e.timestamp, e.type, e.tool_name, e.payload, s.project
       FROM events e
       JOIN sessions s ON e.session_id = s.session_id
       WHERE e.payload LIKE ?
       ORDER BY e.timestamp DESC
       LIMIT ?;`,
      [searchPattern, limit]
    );

    const events = result.length > 0 ? result[0].values.map((row: unknown[]) => ({
      eventId: row[0],
      sessionId: row[1],
      timestamp: row[2],
      type: row[3],
      toolName: row[4],
      payload: JSON.parse(row[5] as string || '{}'),
      project: row[6],
    })) : [];

    return { events, query: q };
  });
}
