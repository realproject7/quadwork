import { Suspense } from "react";
import SettingsPage from "@/components/SettingsPage";

export default function Settings() {
  return (
    <Suspense fallback={<div className="p-6 text-text-muted text-xs">Loading...</div>}>
      <SettingsPage />
    </Suspense>
  );
}
