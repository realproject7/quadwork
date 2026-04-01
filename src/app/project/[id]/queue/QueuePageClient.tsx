"use client";

import { useParams } from "next/navigation";
import QueueManager from "@/components/QueueManager";

export default function QueuePageClient() {
  const { id } = useParams<{ id: string }>();
  return <QueueManager projectId={id} />;
}
