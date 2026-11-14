import { AdminShell } from "@/components/admin";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
