import type { Metadata, Viewport } from "next";
import { Inter, Oswald } from "next/font/google";
import "./globals.css";

// "Game night" theme fonts: Oswald for headings/scores, Inter for body text.
const oswald = Oswald({ subsets: ["latin"], variable: "--font-oswald", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Lawyer Fantasy", template: "%s · Lawyer Fantasy" },
  description: "Fantasy league for mock trial clubs: draft real lawyers, score points from public court records.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0a0e13",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${oswald.variable} ${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
