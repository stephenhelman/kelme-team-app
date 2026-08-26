import Link from "next/link";

const POLICY_LINKS = ["Shipping Info", "Returns", "Privacy Policy", "Terms"];

export function SiteFooter() {
  return (
    <footer className="bg-ink text-neutral-400">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 py-12 sm:px-6 sm:flex-row sm:justify-between">
        <div>
          <p className="font-display text-lg uppercase tracking-wide text-paper">Kelme Team Store</p>
          <p className="mt-2 max-w-xs text-sm">
            Official Kelme teamwear and equipment for clubs — bulk team orders, coach kits, and training gear.
          </p>
          <p className="mt-4 text-sm">
            <a href="mailto:orders@kelmeteamstore.com" className="hover:text-paper">
              orders@kelmeteamstore.com
            </a>
          </p>
        </div>

        <div className="flex flex-col gap-2 text-sm">
          {POLICY_LINKS.map((label) => (
            <span key={label} className="text-neutral-400">
              {label}
            </span>
          ))}
          <Link href="/contact" className="hover:text-paper">
            Contact
          </Link>
        </div>
      </div>

      <div className="border-t border-white/10 px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-7xl items-center justify-between text-xs text-neutral-500">
          <span>© {new Date().getFullYear()} Kelme Team Store</span>
          <Link href="/admin" className="hover:text-neutral-300">
            Admin
          </Link>
        </div>
      </div>
    </footer>
  );
}
