import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "QuadWork",
  description: "Unified dashboard for multi-agent coding teams",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistMono.variable} h-full`}>
      <body className="h-full flex">
        {/* Sidebar placeholder — 64px, will be built out in #4 */}
        <aside className="w-16 shrink-0 border-r border-border bg-bg-surface" />
        <main className="flex-1 min-w-0 overflow-auto">{children}</main>
      </body>
    </html>
  );
}
