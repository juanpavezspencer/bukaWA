import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "BukuWA", description: "Pembukuan usaha kamu, langsung dari WhatsApp." };
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
