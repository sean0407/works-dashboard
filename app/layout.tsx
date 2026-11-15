import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "沃克思｜營運總覽",
  description: "沃克思私人營運工作台，掌握案件、成交、開票與追案進度。",
  robots: {index:false,follow:false},
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body className="antialiased">{children}</body>
    </html>
  );
}
