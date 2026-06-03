import type { Metadata } from "next";
import { Inter, Roboto_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const robotoMono = Roboto_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ViralScope Dashboard",
  description: "Short Video Trend Analytics",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${robotoMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex bg-zinc-950 text-zinc-50 overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden h-screen">
          <main className="flex-1 overflow-y-auto scroll-smooth bg-zinc-950/50">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
