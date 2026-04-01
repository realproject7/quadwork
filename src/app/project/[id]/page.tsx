import ProjectPageClient from "./ProjectPageClient";

export function generateStaticParams() {
  // Return a placeholder; SPA fallback handles real project IDs at runtime
  return [{ id: "_" }];
}

export default function ProjectPage() {
  return <ProjectPageClient />;
}
