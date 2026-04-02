"use client";

import { usePathname } from "next/navigation";
import QueueManager from "@/components/QueueManager";

export default function QueuePageClient() {
  const pathname = usePathname();
  const segments = pathname.split("/");
  const id = segments[2] || "";

  if (!id || id === "_") {
    return null;
  }

  return <QueueManager projectId={id} />;
}
