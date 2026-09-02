import Link from "next/link";
import { LogoutButton } from "@/components/admin/LogoutButton";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center gap-4 border-b border-line pb-4">
        <h1 className="font-display font-bold text-2xl uppercase tracking-wide text-ink">Admin</h1>
        <Link href="/" className="ml-auto text-sm text-neutral-400 hover:text-ink">
          ← Home
        </Link>
        <LogoutButton />
      </div>
      {children}
    </div>
  );
}
