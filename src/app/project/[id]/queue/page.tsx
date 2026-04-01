import QueuePageClient from "./QueuePageClient";

export function generateStaticParams() {
  return [{ id: "_" }];
}

export default function QueuePage() {
  return <QueuePageClient />;
}
