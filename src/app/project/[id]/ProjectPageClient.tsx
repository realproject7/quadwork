"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const ProjectDashboard = dynamic(() => import("@/components/ProjectDashboard"), { ssr: false });

export default function ProjectPageClient() {
  const pathname = usePathname();
  // #1067: `output: "export"` prerenders this route once, for the placeholder
  // id "_", and Express serves that one document for every /project/<id>. The
  // server HTML is therefore always the "_" render (nothing), while the browser
  // hydrates it at /project/<real-id> — so deriving the rendered tree straight
  // from usePathname() guaranteed React #418 and made React throw away and
  // re-render the whole dashboard subtree. Same mounted-gate remedy as #372 in
  // TopHeader: the first client render matches the server exactly, and the real
  // id is applied in the render that follows mount. usePathname() is still the
  // source, so switching projects client-side keeps working.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Extract project ID from URL path: /project/<id>
  const segments = pathname.split("/");
  const id = segments[2] || "";

  if (!mounted || !id || id === "_") {
    return null;
  }

  return (
    <div className="w-full h-full">
      <ProjectDashboard projectId={id} />
    </div>
  );
}
