import { Card } from '@tremor/react';

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-100">Dashboard</h1>
      <Card className="bg-gray-800 ring-gray-700">
        <p className="text-gray-300">
          Overview of all active Claude Code sessions, cost summaries, and recent activity.
        </p>
      </Card>
    </div>
  );
}
