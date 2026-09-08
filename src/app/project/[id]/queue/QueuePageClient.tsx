"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const QueueManager = dynamic(() => import("@/components/QueueManager"), { ssr: false });

export default function QueuePageClient() {
  const pathname = usePathname();
  // #1067: same static-export hydration hazard as ProjectPageClient — the one
  // prerendered document for this route is the "_" render, served for every
  // /project/<id>/queue. Gate the pathname-derived tree on mount so the
  // hydrating render matches the server HTML.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const segments = pathname.split("/");
  const id = segments[2] || "";

  if (!mounted || !id || id === "_") {
    return null;
  }

  return <QueueManager projectId={id} />;
}
