import { Card } from '@tremor/react';

export default function SessionsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-100">Sessions</h1>
      <Card className="bg-gray-800 ring-gray-700">
        <p className="text-gray-300">
          Browse and filter all Claude Code sessions with status, cost, and duration details.
        </p>
      </Card>
    </div>
  );
}
