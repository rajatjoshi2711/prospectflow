import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ProspectFlow",
  description:
    "Turn every employee's LinkedIn network into a shared, queryable asset.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
