"use client";

import { usePathname, useRouter } from "next/navigation";

export function LogoutButton() {
  const pathname = usePathname();
  const router = useRouter();

  if (pathname === "/admin/login") return null;

  async function handleLogout() {
    await fetch("/api/admin/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      className="text-sm text-neutral-400 hover:text-ink"
    >
      Log out
    </button>
  );
}
