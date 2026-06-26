import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "声裁 | 自动化播客精剪",
  description: "从两小时原始录音到可审核、可交付的播客成片。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

