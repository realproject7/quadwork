import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import TopHeader from "@/components/TopHeader";
import GlobalNotificationListener from "@/components/GlobalNotificationListener";
import { LocaleProvider } from "@/components/LocaleProvider";

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
      <body className="h-full flex flex-col">
        <LocaleProvider>
          <GlobalNotificationListener />
          <TopHeader />
          <div className="flex flex-1 min-h-0">
            {/* Desktop: permanent sidebar. Mobile: hidden (hamburger overlay in Sidebar). */}
            <Sidebar />
            <main className="flex-1 min-w-0 overflow-auto">{children}</main>
          </div>
        </LocaleProvider>
      </body>
    </html>
  );
}
