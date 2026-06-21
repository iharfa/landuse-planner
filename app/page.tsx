"use client";

import dynamic from "next/dynamic";

// The planner is fully client-side (MapLibre, Terra Draw, localStorage).
const PlannerApp = dynamic(() => import("@/components/PlannerApp"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen w-screen items-center justify-center bg-slate-900 text-slate-300">
      Loading planner…
    </div>
  ),
});

export default function Page() {
  return <PlannerApp />;
}
