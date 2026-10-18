import type { Metadata } from "next";
import { JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

import { ThemeProvider } from "@/components/theme/ThemeProvider";

// Same type system as the whatspoppin design: Plus Jakarta Sans for the interface,
// JetBrains Mono only for machine values (designators, measurements, step numbers, Cypher).
const sans = Plus_Jakarta_Sans({ variable: "--font-sans", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const mono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"], weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: "Kaizen",
  description: "Circuit boards from plain English, designed by agents that share one graph memory.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-theme="soft-pixel-finance"
      data-mode="dark"
      suppressHydrationWarning
      className={`${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-void text-ink">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
