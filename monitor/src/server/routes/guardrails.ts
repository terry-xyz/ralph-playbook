/**
 * REST API — Guardrail log endpoint (Spec 06 H8a — Phase 3 scaffold).
 * GET /api/guardrails/log — paginated, filterable guardrail activations.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from 'sql.js';

export function registerGuardrailRoutes(fastify: FastifyInstance) {
  fastify.get('/api/guardrails/log', async (request) => {
    const db = (fastify as any).db as Database;
    const query = request.query as Record<string, string>;

    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '50', 10) || 50));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.rule_name) {
      conditions.push('rule_name = ?');
      params.push(query.rule_name);
    }
    if (query.session_id) {
      conditions.push('session_id = ?');
      params.push(query.session_id);
    }
    if (query.action) {
      conditions.push('action = ?');
      params.push(query.action);
    }
    if (query.from) {
      conditions.push('timestamp >= ?');
      params.push(query.from);
    }
    if (query.to) {
      conditions.push('timestamp <= ?');
      params.push(query.to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = db.exec(
      `SELECT COUNT(*) FROM guardrail_log ${where};`,
      params
    );
    const total = countResult.length > 0 ? countResult[0].values[0][0] as number : 0;

    const allParams = [...params, limit, offset];
    const result = db.exec(
      `SELECT id, session_id, rule_name, action, timestamp, payload
       FROM guardrail_log ${where}
       ORDER BY timestamp DESC
       LIMIT ? OFFSET ?;`,
      allParams
    );

    const entries = result.length > 0 ? result[0].values.map((row: unknown[]) => ({
      id: row[0],
      sessionId: row[1],
      ruleName: row[2],
      action: row[3],
      timestamp: row[4],
      payload: JSON.parse(row[5] as string || '{}'),
    })) : [];

    return { entries, total, page, limit };
  });
}
