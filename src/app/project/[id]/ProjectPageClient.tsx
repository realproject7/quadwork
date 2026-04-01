"use client";

import { useParams } from "next/navigation";
import ProjectDashboard from "@/components/ProjectDashboard";

export default function ProjectPageClient() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="w-full h-full">
      <ProjectDashboard projectId={id} />
    </div>
  );
}
