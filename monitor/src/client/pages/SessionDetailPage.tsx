import { useParams } from 'react-router-dom';
import { Card } from '@tremor/react';

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-100">Session Detail</h1>
      <Card className="bg-gray-800 ring-gray-700">
        <p className="text-gray-300">
          Detailed view for session <code className="text-blue-400">{id}</code> — events timeline,
          token usage, cost breakdown, and tool calls.
        </p>
      </Card>
    </div>
  );
}
