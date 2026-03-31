import MemoryDashboard from "@/components/MemoryDashboard";

interface MemoryPageProps {
  params: Promise<{ id: string }>;
}

export default async function MemoryPage({ params }: MemoryPageProps) {
  const { id } = await params;
  return <MemoryDashboard projectId={id} />;
}
