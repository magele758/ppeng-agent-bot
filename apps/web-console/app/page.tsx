import { AgentLabApp } from '@/components/AgentLabApp';

// The entry document must always reference chunks from the running release.
export const dynamic = 'force-dynamic';

export default function Home() {
  return <AgentLabApp />;
}
