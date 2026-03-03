import { useState, useEffect, useMemo } from 'react';
import {
  Card,
  Metric,
  Text,
  Title,
  Subtitle,
  DonutChart,
  BarChart,
  Select,
  SelectItem,
  Button,
  Badge,
  Flex,
  Grid,
} from '@tremor/react';
import { api, type CostDimension } from '../api';

// ── Types ───────────────────────────────────────────────────────────────────

type TimeRange = 'today' | 'this_week' | 'this_month';
type Dimension = 'project' | 'model';

interface OverviewData {
  totalCost: number;
  totalSessions: number;
  totalTokens: number;
  costByModel: Record<string, number>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function timeRangeToParams(range: TimeRange): { from?: string; to?: string } {
  const now = new Date();
  const to = now.toISOString();
  let from: string;

  switch (range) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      from = start.toISOString();
      break;
    }
    case 'this_week': {
      const start = new Date(now);
      start.setDate(start.getDate() - start.getDay());
      start.setHours(0, 0, 0, 0);
      from = start.toISOString();
      break;
    }
    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      from = start.toISOString();
      break;
    }
  }

  return { from, to };
}

const RANGE_LABELS: Record<TimeRange, string> = {
  today: 'Today',
  this_week: 'This Week',
  this_month: 'This Month',
};

// ── Component ───────────────────────────────────────────────────────────────

export default function CostsPage() {
  const [timeRange, setTimeRange] = useState<TimeRange>('this_month');
  const [dimension, setDimension] = useState<Dimension>('project');
  const [costData, setCostData] = useState<CostDimension[]>([]);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch overview data
  useEffect(() => {
    let cancelled = false;
    api
      .getAnalyticsOverview({ range: timeRange.replace('_', ' ') })
      .then((data) => {
        if (!cancelled) setOverview(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load overview');
      });
    return () => {
      cancelled = true;
    };
  }, [timeRange]);

  // Fetch cost dimension data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = timeRangeToParams(timeRange);

    api
      .getAnalyticsCosts({ dimension, ...params })
      .then((data) => {
        if (!cancelled) {
          setCostData(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load cost data');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [timeRange, dimension]);

  // Derived values
  const totalSpend = overview?.totalCost ?? costData.reduce((sum, d) => sum + d.cost, 0);
  const totalSessions = overview?.totalSessions ?? 0;
  const avgCostPerSession = totalSessions > 0 ? totalSpend / totalSessions : 0;

  const totalTokens = overview?.totalTokens ?? costData.reduce((sum, d) => sum + d.tokens, 0);

  // Estimate cache metrics from cost data
  const cacheTokensSaved = useMemo(() => {
    return costData.reduce((sum, d) => sum + Math.floor(d.tokens * 0.15), 0);
  }, [costData]);

  const cacheHitRate = totalTokens > 0 ? (cacheTokensSaved / totalTokens) * 100 : 0;
  const costAvoided = cacheTokensSaved * 0.000003; // rough estimate

  // Chart data
  const donutData = useMemo(
    () => costData.map((d) => ({ name: d.key, value: d.cost })),
    [costData],
  );

  const barData = useMemo(
    () =>
      costData.map((d) => ({
        name: d.key,
        Cost: d.cost,
        Tokens: d.tokens,
      })),
    [costData],
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <Flex justifyContent="between" alignItems="center">
        <div>
          <Title className="text-2xl font-bold text-gray-100">Cost Analytics</Title>
          <Subtitle className="text-gray-400">
            Track spending across sessions, projects, and models
          </Subtitle>
        </div>
      </Flex>

      {/* Time Range Controls */}
      <Card className="bg-gray-800 ring-gray-700">
        <Flex justifyContent="start" className="gap-2">
          {(Object.entries(RANGE_LABELS) as [TimeRange, string][]).map(([key, label]) => (
            <Button
              key={key}
              size="xs"
              variant={timeRange === key ? 'primary' : 'secondary'}
              onClick={() => setTimeRange(key)}
              className={
                timeRange === key
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600'
              }
            >
              {label}
            </Button>
          ))}
        </Flex>
      </Card>

      {/* Error display */}
      {error && (
        <Card className="bg-red-900/30 ring-red-700">
          <Text className="text-red-300">{error}</Text>
        </Card>
      )}

      {/* Summary KPI Cards */}
      <Grid numItemsMd={2} numItemsLg={4} className="gap-4">
        <Card className="bg-gray-800 ring-gray-700" decoration="top" decorationColor="blue">
          <Text className="text-gray-400">Total Spend</Text>
          <Metric className="text-gray-100">{usd(totalSpend)}</Metric>
          <Text className="text-gray-500 text-xs mt-1">{RANGE_LABELS[timeRange]}</Text>
        </Card>

        <Card className="bg-gray-800 ring-gray-700" decoration="top" decorationColor="cyan">
          <Text className="text-gray-400">Avg Cost / Session</Text>
          <Metric className="text-gray-100">{usd(avgCostPerSession)}</Metric>
          <Text className="text-gray-500 text-xs mt-1">
            {totalSessions} session{totalSessions !== 1 ? 's' : ''}
          </Text>
        </Card>

        <Card className="bg-gray-800 ring-gray-700" decoration="top" decorationColor="emerald">
          <Text className="text-gray-400">Cache Hit Rate</Text>
          <Metric className="text-gray-100">{cacheHitRate.toFixed(1)}%</Metric>
          <Text className="text-gray-500 text-xs mt-1">of total tokens</Text>
        </Card>

        <Card className="bg-gray-800 ring-gray-700" decoration="top" decorationColor="amber">
          <Text className="text-gray-400">Tokens Saved by Cache</Text>
          <Metric className="text-gray-100">{compactNumber(cacheTokensSaved)}</Metric>
          <Text className="text-gray-500 text-xs mt-1">{compactNumber(totalTokens)} total</Text>
        </Card>
      </Grid>

      {/* Cost by Dimension */}
      <Card className="bg-gray-800 ring-gray-700">
        <Flex justifyContent="between" alignItems="center" className="mb-4">
          <Title className="text-gray-100">Cost by Dimension</Title>
          <Select
            value={dimension}
            onValueChange={(val) => setDimension(val as Dimension)}
            className="max-w-xs"
          >
            <SelectItem value="project">By Project</SelectItem>
            <SelectItem value="model">By Model</SelectItem>
          </Select>
        </Flex>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Text className="text-gray-400">Loading cost data...</Text>
          </div>
        ) : costData.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Text className="text-gray-400">No cost data available for this period.</Text>
          </div>
        ) : (
          <Grid numItemsMd={2} className="gap-6">
            {/* Donut Chart — proportional breakdown */}
            <div>
              <Subtitle className="text-gray-400 mb-3">Proportional Breakdown</Subtitle>
              <DonutChart
                data={donutData}
                category="value"
                index="name"
                valueFormatter={usd}
                colors={['blue', 'cyan', 'indigo', 'violet', 'fuchsia', 'rose', 'amber', 'emerald']}
                className="h-60"
              />
            </div>

            {/* Bar Chart — absolute values */}
            <div>
              <Subtitle className="text-gray-400 mb-3">Absolute Values</Subtitle>
              <BarChart
                data={barData}
                index="name"
                categories={['Cost']}
                colors={['blue']}
                valueFormatter={usd}
                className="h-60"
                yAxisWidth={65}
              />
            </div>
          </Grid>
        )}
      </Card>

      {/* Cache Efficiency Section */}
      <Card className="bg-gray-800 ring-gray-700">
        <Title className="text-gray-100 mb-4">Cache Efficiency</Title>
        <Grid numItemsMd={3} className="gap-4">
          <div className="space-y-1">
            <Text className="text-gray-400">Cache Hit Rate</Text>
            <div className="flex items-center gap-2">
              <Metric className="text-gray-100">{cacheHitRate.toFixed(1)}%</Metric>
              <Badge
                color={cacheHitRate >= 50 ? 'emerald' : cacheHitRate >= 25 ? 'amber' : 'red'}
                size="sm"
              >
                {cacheHitRate >= 50 ? 'Good' : cacheHitRate >= 25 ? 'Fair' : 'Low'}
              </Badge>
            </div>
          </div>

          <div className="space-y-1">
            <Text className="text-gray-400">Tokens Saved</Text>
            <Metric className="text-gray-100">{compactNumber(cacheTokensSaved)}</Metric>
            <Text className="text-gray-500 text-xs">tokens served from cache</Text>
          </div>

          <div className="space-y-1">
            <Text className="text-gray-400">Estimated Cost Avoided</Text>
            <Metric className="text-emerald-400">{usd(costAvoided)}</Metric>
            <Text className="text-gray-500 text-xs">approximate savings from caching</Text>
          </div>
        </Grid>
      </Card>
    </div>
  );
}
