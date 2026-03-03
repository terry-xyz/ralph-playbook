/**
 * REST API — Analytics & Top Stats endpoints (Spec 06 H3).
 * GET /api/analytics/overview — top stats
 * GET /api/analytics/costs — cost by dimension
 * GET /api/analytics/errors — error data
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from 'sql.js';

export function registerAnalyticsRoutes(fastify: FastifyInstance) {
  // GET /api/analytics/overview — Top stats
  fastify.get('/api/analytics/overview', async (request) => {
    const db = (fastify as any).db as Database;
    const query = request.query as Record<string, string>;

    // Time window: today, this week, this month
    const range = query.range ?? 'today';
    const now = new Date();
    let fromDate: string;

    if (range === 'this week') {
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());
      weekStart.setHours(0, 0, 0, 0);
      fromDate = weekStart.toISOString();
    } else if (range === 'this month') {
      fromDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    } else {
      // today
      fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    }

    // Active sessions
    const activeResult = db.exec("SELECT COUNT(*) FROM sessions WHERE status = 'running';");
    const activeSessions = activeResult.length > 0 ? activeResult[0].values[0][0] as number : 0;

    // Total sessions in time window
    const totalSessionsResult = db.exec(
      'SELECT COUNT(*) FROM sessions WHERE start_time >= ?;',
      [fromDate]
    );
    const totalSessions = totalSessionsResult.length > 0 ? totalSessionsResult[0].values[0][0] as number : 0;

    // Total cost in time window
    const costResult = db.exec(
      'SELECT COALESCE(SUM(total_cost), 0) FROM sessions WHERE start_time >= ?;',
      [fromDate]
    );
    const totalCost = costResult.length > 0 ? costResult[0].values[0][0] as number : 0;

    // Total tokens in time window (sum from sessions table token_counts JSON)
    const tokenResult = db.exec(
      'SELECT token_counts FROM sessions WHERE start_time >= ?;',
      [fromDate]
    );
    let totalTokens = 0;
    if (tokenResult.length > 0) {
      for (const row of tokenResult[0].values) {
        try {
          const tc = JSON.parse(row[0] as string || '{}');
          totalTokens += (tc.input ?? 0) + (tc.output ?? 0) + (tc.cacheCreation ?? 0) + (tc.cacheRead ?? 0);
        } catch { /* skip unparseable */ }
      }
    }

    // Error count and rate
    const errorCountResult = db.exec(
      "SELECT COUNT(*) FROM events WHERE type = 'PostToolUseFailure' AND timestamp >= ?;",
      [fromDate]
    );
    const totalErrors = errorCountResult.length > 0 ? errorCountResult[0].values[0][0] as number : 0;

    const totalToolCallsResult = db.exec(
      "SELECT COUNT(*) FROM events WHERE type IN ('PostToolUse', 'PostToolUseFailure') AND timestamp >= ?;",
      [fromDate]
    );
    const totalToolCalls = totalToolCallsResult.length > 0 ? totalToolCallsResult[0].values[0][0] as number : 0;
    const errorRate = totalToolCalls > 0 ? totalErrors / totalToolCalls : 0;

    // Rate limit incidents in last hour
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const rateLimitResult = db.exec(
      "SELECT COUNT(*) FROM events WHERE payload LIKE '%rate_limit%' AND timestamp >= ?;",
      [oneHourAgo]
    );
    const rateLimitIncidents = rateLimitResult.length > 0 ? rateLimitResult[0].values[0][0] as number : 0;

    // Tool calls per minute (last 10 minutes as time series)
    const toolCallsPerMin: number[] = [];
    for (let i = 9; i >= 0; i--) {
      const start = new Date(Date.now() - (i + 1) * 60000).toISOString();
      const end = new Date(Date.now() - i * 60000).toISOString();
      const result = db.exec(
        "SELECT COUNT(*) FROM events WHERE type IN ('PreToolUse', 'PostToolUse') AND timestamp >= ? AND timestamp < ?;",
        [start, end]
      );
      toolCallsPerMin.push(result.length > 0 ? result[0].values[0][0] as number : 0);
    }

    return {
      activeSessions,
      totalSessions,
      totalCost,
      totalTokens,
      totalErrors,
      errorRate,
      rateLimitIncidents,
      toolCallsPerMin,
    };
  });

  // GET /api/analytics/costs — Cost by dimension
  fastify.get('/api/analytics/costs', async (request) => {
    const db = (fastify as any).db as Database;
    const query = request.query as Record<string, string>;

    const dimension = query.dimension ?? 'project'; // project | model | agent
    const fromDate = query.from ?? new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).toISOString();
    const toDate = query.to ?? new Date().toISOString();

    const groupByCol = dimension === 'model' ? 'model' : 'project';

    // Cost by dimension
    const result = db.exec(
      `SELECT ${groupByCol}, COALESCE(SUM(total_cost), 0) as cost
       FROM sessions WHERE start_time >= ? AND start_time <= ?
       GROUP BY ${groupByCol}
       ORDER BY cost DESC;`,
      [fromDate, toDate]
    );

    const breakdown = result.length > 0 ? result[0].values.map((row: unknown[]) => ({
      name: row[0] ?? 'Unknown',
      cost: row[1] as number,
    })) : [];

    const totalCost = breakdown.reduce((sum: number, b: { name: unknown; cost: number }) => sum + b.cost, 0);

    // Cache efficiency from metrics
    const cacheResult = db.exec(
      `SELECT token_breakdown FROM metrics m
       JOIN sessions s ON m.session_id = s.session_id
       WHERE s.start_time >= ? AND s.start_time <= ?;`,
      [fromDate, toDate]
    );

    let cacheRead = 0;
    let totalInput = 0;
    if (cacheResult.length > 0) {
      for (const row of cacheResult[0].values) {
        const tokens = JSON.parse(row[0] as string || '{}');
        cacheRead += tokens.cacheRead ?? 0;
        totalInput += (tokens.input ?? 0) + (tokens.cacheRead ?? 0);
      }
    }
    const cacheHitRate = totalInput > 0 ? cacheRead / totalInput : 0;

    return {
      breakdown,
      totalCost,
      cacheHitRate,
      tokensSaved: cacheRead,
    };
  });

  // GET /api/analytics/errors — Error data from all 3 error sources
  fastify.get('/api/analytics/errors', async (request) => {
    const db = (fastify as any).db as Database;
    const query = request.query as Record<string, string>;

    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '50', 10) || 50));
    const offset = (page - 1) * limit;

    // Query all error sources: PostToolUseFailure + Stop events with error payload
    const conditions: string[] = [
      "(e.type = 'PostToolUseFailure' OR (e.type = 'Stop' AND (e.payload LIKE '%\"error\"%' OR e.payload LIKE '%\"is_error\"%')))"
    ];
    const params: unknown[] = [];

    if (query.session) {
      conditions.push('e.session_id = ?');
      params.push(query.session);
    }
    if (query.project) {
      conditions.push('s.project = ?');
      params.push(query.project);
    }
    if (query.from) {
      conditions.push('e.timestamp >= ?');
      params.push(query.from);
    }
    if (query.to) {
      conditions.push('e.timestamp <= ?');
      params.push(query.to);
    }

    const where = conditions.join(' AND ');

    const countResult = db.exec(
      `SELECT COUNT(*) FROM events e JOIN sessions s ON e.session_id = s.session_id WHERE ${where};`,
      params
    );
    const total = countResult.length > 0 ? countResult[0].values[0][0] as number : 0;

    const allParams = [...params, limit, offset];
    const result = db.exec(
      `SELECT e.event_id, e.session_id, e.timestamp, e.type, e.tool_name, e.payload, s.project
       FROM events e
       JOIN sessions s ON e.session_id = s.session_id
       WHERE ${where}
       ORDER BY e.timestamp DESC
       LIMIT ? OFFSET ?;`,
      allParams
    );

    const errors = result.length > 0 ? result[0].values.map((row: unknown[]) => {
      const eventType = row[3] as string;
      const payloadStr = row[5] as string || '{}';
      const payload = JSON.parse(payloadStr);
      const toolName = row[4] as string | null;

      // Categorize error using keyword matching (mirrors session-lifecycle.ts categorizeError)
      let category = 'tool_failure';
      if (eventType === 'PostToolUseFailure') {
        category = 'tool_failure';
      } else {
        const lower = payloadStr.toLowerCase();
        if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests')) {
          category = 'rate_limit';
        } else if (lower.includes('auth') || lower.includes('401') || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('403')) {
          category = 'auth_error';
        } else if (lower.includes('billing') || lower.includes('payment') || lower.includes('quota') || lower.includes('credit')) {
          category = 'billing_error';
        } else if (lower.includes('500') || lower.includes('502') || lower.includes('503') || lower.includes('internal server error') || lower.includes('service unavailable')) {
          category = 'server_error';
        } else {
          category = 'server_error'; // Default for Stop errors
        }
      }

      // Extract a human-readable message from the payload
      const message = payload.error || payload.message || payload.output || `${eventType} event`;

      return {
        id: row[0],
        sessionId: row[1],
        timestamp: row[2],
        category,
        message: typeof message === 'string' ? message : JSON.stringify(message),
        tool: toolName,
        project: row[6],
      };
    }) : [];

    // Apply category filter client-side if specified (after query)
    const filteredErrors = query.category
      ? errors.filter((e: { category: string }) => e.category === query.category)
      : errors;

    return {
      data: filteredErrors,
      total: query.category ? filteredErrors.length : total,
      page,
      limit,
    };
  });
}
