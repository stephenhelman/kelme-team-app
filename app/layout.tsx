import type { Metadata } from "next";
import { Anton, Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const anton = Anton({
  variable: "--font-display",
  weight: "400",
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--font-body",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Kelme Inventory",
  description: "Browse live Kelme dealer inventory as a catalog.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${anton.variable} ${inter.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-pitch-950 text-neutral-100">
        <header className="border-b border-white/10 bg-pitch-900/60 backdrop-blur sticky top-0 z-20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 py-4 flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2 group">
              <span className="h-8 w-8 rounded-full bg-kit-500 flex items-center justify-center font-display text-pitch-950 text-sm">
                K
              </span>
              <span className="font-display tracking-wide text-xl sm:text-2xl uppercase text-neutral-50 group-hover:text-kit-400 transition-colors">
                Kelme Inventory
              </span>
            </Link>
          </div>
        </header>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
