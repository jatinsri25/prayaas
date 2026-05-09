import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Prayaas — Society Community Platform",
  description: "AI-powered community problem reporting platform for residential societies. Report issues, get AI-formatted drafts, and find solutions.",
  keywords: "society, community, problems, AI, residential, reporting",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
