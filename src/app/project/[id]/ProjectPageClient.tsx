"use client";

import { usePathname } from "next/navigation";
import ProjectDashboard from "@/components/ProjectDashboard";

export default function ProjectPageClient() {
  const pathname = usePathname();
  // Extract project ID from URL path: /project/<id>
  const segments = pathname.split("/");
  const id = segments[2] || "";

  if (!id || id === "_") {
    return null;
  }

  return (
    <div className="w-full h-full">
      <ProjectDashboard projectId={id} />
    </div>
  );
}
