"use client";

import { useParams } from "next/navigation";
import QueueManager from "@/components/QueueManager";

export default function QueuePageClient() {
  const { id } = useParams<{ id: string }>();

  if (!id || id === "_") {
    return null;
  }

  return <QueueManager projectId={id} />;
}
