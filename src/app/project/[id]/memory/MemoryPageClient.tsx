"use client";

import { usePathname } from "next/navigation";
import MemoryDashboard from "@/components/MemoryDashboard";

export default function MemoryPageClient() {
  const pathname = usePathname();
  const segments = pathname.split("/");
  const id = segments[2] || "";

  if (!id || id === "_") {
    return null;
  }

  return <MemoryDashboard projectId={id} />;
}
