import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Fraunces, Inter, Oswald, Source_Sans_3 } from "next/font/google";
import "./globals.css";

const oswald = Oswald({ subsets: ["latin"], variable: "--font-oswald", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", display: "swap" });
const sourceSans = Source_Sans_3({ subsets: ["latin"], variable: "--font-source-sans", display: "swap" });

const THEMES = ["gamenight", "courtroom"] as const;
type Theme = (typeof THEMES)[number];
const DEFAULT_THEME: Theme = "gamenight";

export const metadata: Metadata = {
  title: { default: "Lawyer Fantasy", template: "%s · Lawyer Fantasy" },
  description: "Fantasy league for mock trial clubs: draft real lawyers, score points from public court records.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Style preview: the `lf_theme` cookie picks between the two candidate themes.
  const requested = (await cookies()).get("lf_theme")?.value;
  const theme: Theme = THEMES.includes(requested as Theme) ? (requested as Theme) : DEFAULT_THEME;
  return (
    <html
      lang="en"
      data-theme={theme}
      className={`${oswald.variable} ${inter.variable} ${fraunces.variable} ${sourceSans.variable} h-full antialiased`}
    >
      <head>
        <meta name="theme-color" content={theme === "gamenight" ? "#0a0e13" : "#7b1e2b"} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
