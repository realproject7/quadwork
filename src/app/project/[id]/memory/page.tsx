import MemoryPageClient from "./MemoryPageClient";

export function generateStaticParams() {
  return [{ id: "_" }];
}

export default function MemoryPage() {
  return <div suppressHydrationWarning><MemoryPageClient /></div>;
}
