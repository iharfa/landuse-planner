"use client";

import { useState } from "react";

const SEEN_KEY = "land-use-planner-tutorial-seen-v2";

export function hasSeenTutorial(): boolean {
  if (typeof window === "undefined") return true;
  return localStorage.getItem(SEEN_KEY) === "1";
}

interface Step {
  icon: string;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    icon: "🏝️",
    title: "Welcome to the Land-Use Planner",
    body: "Plan land use for an island right in your browser — no login, no backend. This quick tour shows the workflow. Everything you do is saved locally on your machine.",
  },
  {
    icon: "📍",
    title: "1 · Pick an island",
    body: "Use the “Island” dropdown in the left toolbar. The map zooms to it over a satellite basemap. This sets the geographic context for your plan.",
  },
  {
    icon: "✏️",
    title: "2 · Draw the planning boundary",
    body: "Click “Draw Boundary”, then click on the map to place corners. Close the shape (double-click or click the first point) to finish. The boundary’s area in m² and hectares appears in the bottom bar.",
  },
  {
    icon: "🎚️",
    title: "3 · Set land-use allocation",
    body: "In the right panel, drag the sliders for Residential, Roads, Green Space, etc. They always total 100% — move one and the unlocked others adjust proportionally. Click 🔓 to lock a category in place. Each shows its target area.",
  },
  {
    icon: "⚡",
    title: "4 · Auto-generate the plot layout",
    body: "In “Auto-Plan”, set your plot size in sq ft (and a minimum size), the road lanes and lane width, and how many plots sit between roads. Click ⚡ Generate Plan: the app lays a road grid, subdivides the boundary into plots, and assigns each to a land use per your sliders. Re-generate any time you change a setting.",
  },
  {
    icon: "🌳",
    title: "5 · Parameters drive the plan",
    body: "Set Residential FAR, unit size, household size, green m²/person target, and industrial buffer. With “Green space from parameters” on, green is sized to meet the per-person target. The panel derives floor area, housing units, population, road-area %, and flags industrial-buffer conflicts. Prefer drawing by hand? Use “Manual parcel drawing” in the toolbar.",
  },
  {
    icon: "📊",
    title: "6 · Compare target vs. drawn",
    body: "The bottom bar compares each category’s target area against what you’ve actually drawn — showing surplus/shortfall and % achieved, so you can balance the plan.",
  },
  {
    icon: "💾",
    title: "7 · Save & export",
    body: "Use the Project buttons to Save/Load in your browser, export or import the project as JSON, or export GeoJSON (boundary + parcels) and a CSV summary. You’re all set — happy planning!",
  },
];

export default function Tutorial({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [dontShow, setDontShow] = useState(false);
  const isLast = step === STEPS.length - 1;
  const s = STEPS[step];

  function finish() {
    if (dontShow) localStorage.setItem(SEEN_KEY, "1");
    onClose();
  }

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Tutorial"
    >
      <div className="w-full max-w-md rounded-2xl bg-slate-900 p-6 shadow-2xl ring-1 ring-white/10">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div className="text-4xl">{s.icon}</div>
          <button
            onClick={finish}
            className="text-slate-400 hover:text-slate-200"
            aria-label="Close tutorial"
            title="Close"
          >
            ✕
          </button>
        </div>

        <h2 className="mb-2 text-lg font-semibold text-sky-300">{s.title}</h2>
        <p className="mb-5 text-sm leading-relaxed text-slate-300">{s.body}</p>

        {/* progress dots */}
        <div className="mb-5 flex justify-center gap-1.5">
          {STEPS.map((_, i) => (
            <button
              key={i}
              onClick={() => setStep(i)}
              aria-label={`Go to step ${i + 1}`}
              className={`h-2 rounded-full transition-all ${
                i === step ? "w-6 bg-sky-400" : "w-2 bg-slate-600 hover:bg-slate-500"
              }`}
            />
          ))}
        </div>

        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={dontShow}
              onChange={(e) => setDontShow(e.target.checked)}
              className="accent-sky-500"
            />
            Don’t show on startup
          </label>

          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((v) => v - 1)}
                className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium hover:bg-slate-700"
              >
                Back
              </button>
            )}
            {!isLast ? (
              <button
                onClick={() => setStep((v) => v + 1)}
                className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-sky-400"
              >
                Next
              </button>
            ) : (
              <button
                onClick={finish}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-emerald-400"
              >
                Get started
              </button>
            )}
          </div>
        </div>

        <div className="mt-3 text-center text-[11px] text-slate-500">
          Step {step + 1} of {STEPS.length}
        </div>
      </div>
    </div>
  );
}
