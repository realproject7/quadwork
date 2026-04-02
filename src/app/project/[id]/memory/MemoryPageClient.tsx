"use client";

import { useParams } from "next/navigation";
import MemoryDashboard from "@/components/MemoryDashboard";

export default function MemoryPageClient() {
  const { id } = useParams<{ id: string }>();

  if (!id || id === "_") {
    return null;
  }

  return <MemoryDashboard projectId={id} />;
}
