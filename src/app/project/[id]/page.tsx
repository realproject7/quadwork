import TerminalGrid from "@/components/TerminalGrid";

interface ProjectPageProps {
  params: Promise<{ id: string }>;
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { id } = await params;

  return (
    <div className="w-full h-full">
      <TerminalGrid projectId={id} />
    </div>
  );
}
