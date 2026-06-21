import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Island Land-Use Planner",
  description: "Browser-based land-use planning tool",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="text-slate-100 antialiased">{children}</body>
    </html>
  );
}
