import "@xyflow/react/dist/style.css";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AstraFlow Image Studio",
  description:
    "Professional AI image generation studio with secure Google authentication, visual workflows, GCP-hosted models, and BYOK routing.",
  applicationName: "AstraFlow Image Studio"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
