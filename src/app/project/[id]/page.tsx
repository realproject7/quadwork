import ProjectDashboard from "@/components/ProjectDashboard";

interface ProjectPageProps {
  params: Promise<{ id: string }>;
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { id } = await params;

  return (
    <div className="w-full h-full">
      <ProjectDashboard projectId={id} />
    </div>
  );
}
