"use client";

import { useParams } from "next/navigation";
import ProjectDashboard from "@/components/ProjectDashboard";

export default function ProjectPageClient() {
  const { id } = useParams<{ id: string }>();

  // Static export pre-renders with placeholder "_". Wait for hydration
  // to resolve the real project ID before rendering child components
  // that issue API/WebSocket requests.
  if (!id || id === "_") {
    return null;
  }

  return (
    <div className="w-full h-full">
      <ProjectDashboard projectId={id} />
    </div>
  );
}
