import { Card } from '@tremor/react';

export default function LiveFeedPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-100">Live Feed</h1>
      <Card className="bg-gray-800 ring-gray-700">
        <p className="text-gray-300">
          Real-time stream of events from all active Claude Code sessions.
        </p>
      </Card>
    </div>
  );
}
