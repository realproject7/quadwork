interface ProjectPageProps {
  params: Promise<{ id: string }>;
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { id } = await params;

  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight text-text">
          {id}
        </h1>
        <p className="text-sm text-text-muted">
          Project dashboard — panels coming in #7
        </p>
      </div>
    </div>
  );
}
