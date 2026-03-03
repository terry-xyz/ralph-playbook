/**
 * REST API — Sessions endpoints (Spec 06 H2).
 * GET /api/sessions — paginated list with filters
 * GET /api/sessions/:id — session detail with metrics
 * GET /api/sessions/:id/events — paginated event list
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from 'sql.js';

export function registerSessionRoutes(fastify: FastifyInstance) {
  // GET /api/sessions — Session listing with filters
  fastify.get('/api/sessions', async (request, reply) => {
    const db = (fastify as any).db as Database;
    const query = request.query as Record<string, string>;

    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '50', 10) || 50));
    const offset = (page - 1) * limit;

    // Build WHERE clause from filters
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.status) {
      conditions.push('status = ?');
      params.push(query.status);
    }
    if (query.project) {
      conditions.push('project = ?');
      params.push(query.project);
    }
    if (query.model) {
      conditions.push('model = ?');
      params.push(query.model);
    }
    if (query.from) {
      conditions.push('start_time >= ?');
      params.push(query.from);
    }
    if (query.to) {
      conditions.push('start_time <= ?');
      params.push(query.to);
    }
    if (query.minCost) {
      conditions.push('total_cost >= ?');
      params.push(parseFloat(query.minCost));
    }
    if (query.maxCost) {
      conditions.push('total_cost <= ?');
      params.push(parseFloat(query.maxCost));
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Sorting
    const validSortFields = ['session_id', 'project', 'model', 'status', 'total_cost', 'start_time', 'end_time', 'turn_count', 'error_count'];
    const sortBy = validSortFields.includes(query.sortBy ?? '') ? query.sortBy : 'start_time';
    const order = query.order === 'asc' ? 'ASC' : 'DESC';

    // Count total
    const countResult = db.exec(`SELECT COUNT(*) FROM sessions ${where};`, params);
    const total = countResult.length > 0 ? countResult[0].values[0][0] as number : 0;

    // Fetch page
    const allParams = [...params, limit, offset];
    const result = db.exec(
      `SELECT session_id, project, workspace, model, status, start_time, end_time,
              total_cost, token_counts, turn_count, inferred_phase, last_seen, error_count
       FROM sessions ${where}
       ORDER BY ${sortBy} ${order}
       LIMIT ? OFFSET ?;`,
      allParams
    );

    const sessions = result.length > 0 ? result[0].values.map((row: unknown[]) => ({
      sessionId: row[0],
      project: row[1],
      workspace: row[2],
      model: row[3],
      status: row[4],
      startTime: row[5],
      endTime: row[6],
      totalCost: row[7],
      tokenCounts: JSON.parse(row[8] as string || '{}'),
      turnCount: row[9],
      inferredPhase: row[10],
      lastSeen: row[11],
      errorCount: row[12],
    })) : [];

    return { sessions, total, page, limit };
  });

  // GET /api/sessions/:id — Session detail
  fastify.get('/api/sessions/:id', async (request, reply) => {
    const db = (fastify as any).db as Database;
    const { id } = request.params as { id: string };

    const result = db.exec(
      `SELECT session_id, project, workspace, model, status, start_time, end_time,
              total_cost, token_counts, turn_count, inferred_phase, last_seen, error_count
       FROM sessions WHERE session_id = ?;`,
      [id]
    );

    if (result.length === 0 || result[0].values.length === 0) {
      reply.status(404).send({ error: 'Session not found' });
      return;
    }

    const row = result[0].values[0];
    const session = {
      sessionId: row[0],
      project: row[1],
      workspace: row[2],
      model: row[3],
      status: row[4],
      startTime: row[5],
      endTime: row[6],
      totalCost: row[7],
      tokenCounts: JSON.parse(row[8] as string || '{}'),
      turnCount: row[9],
      inferredPhase: row[10],
      lastSeen: row[11],
      errorCount: row[12],
    };

    // Get metrics if available
    const metricsResult = db.exec(
      `SELECT cost_breakdown, token_breakdown, model, wall_clock_duration, api_duration, turn_count
       FROM metrics WHERE session_id = ?;`,
      [id]
    );

    let metrics = null;
    if (metricsResult.length > 0 && metricsResult[0].values.length > 0) {
      const m = metricsResult[0].values[0];
      metrics = {
        costBreakdown: JSON.parse(m[0] as string || '{}'),
        tokenBreakdown: JSON.parse(m[1] as string || '{}'),
        model: m[2],
        wallClockDuration: m[3],
        apiDuration: m[4],
        turnCount: m[5],
      };
    }

    // Get tool call breakdown
    const toolBreakdown = db.exec(
      `SELECT tool_name, COUNT(*) as call_count,
              SUM(CASE WHEN type = 'PostToolUse' THEN 1 ELSE 0 END) as success_count,
              SUM(CASE WHEN type = 'PostToolUseFailure' THEN 1 ELSE 0 END) as failure_count,
              AVG(duration) as avg_duration
       FROM events WHERE session_id = ? AND tool_name IS NOT NULL
       GROUP BY tool_name;`,
      [id]
    );

    const tools = toolBreakdown.length > 0 ? toolBreakdown[0].values.map((t: unknown[]) => ({
      toolName: t[0],
      callCount: t[1],
      successCount: t[2],
      failureCount: t[3],
      avgDuration: t[4],
    })) : [];

    return { session, metrics, tools };
  });

  // GET /api/sessions/:id/events — Paginated events for a session
  fastify.get('/api/sessions/:id/events', async (request, reply) => {
    const db = (fastify as any).db as Database;
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, string>;

    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit ?? '100', 10) || 100));
    const offset = (page - 1) * limit;

    // Count total events for this session
    const countResult = db.exec(
      'SELECT COUNT(*) FROM events WHERE session_id = ?;',
      [id]
    );
    const total = countResult.length > 0 ? countResult[0].values[0][0] as number : 0;

    const result = db.exec(
      `SELECT event_id, session_id, timestamp, type, tool_name, payload, duration, tool_use_id
       FROM events WHERE session_id = ?
       ORDER BY timestamp ASC
       LIMIT ? OFFSET ?;`,
      [id, limit, offset]
    );

    const events = result.length > 0 ? result[0].values.map((row: unknown[]) => ({
      eventId: row[0],
      sessionId: row[1],
      timestamp: row[2],
      type: row[3],
      toolName: row[4],
      payload: JSON.parse(row[5] as string || '{}'),
      duration: row[6],
      toolUseId: row[7],
    })) : [];

    return { events, total, page, limit };
  });
}
