import Link from "next/link";
import Image from "next/image";
import { CartBadge } from "./CartBadge";
import { SearchBox } from "./SearchBox";

const NAV_LINKS = [
  { label: "Team", href: "/shop?category=team" },
  { label: "Coach", href: "/shop?category=coach" },
  { label: "Equipment", href: "/shop?category=equipment" },
  { label: "Shop All", href: "/shop" },
  { label: "Contact", href: "/contact" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-paper">
      <div className="mx-auto grid max-w-7xl grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/logo.webp" alt="Kelme" width={32} height={32} className="h-8 w-8" />
          <span className="font-display hidden text-base uppercase tracking-wide text-ink sm:inline">
            Kelme Team Store
          </span>
        </Link>

        <nav className="flex items-center gap-5 justify-self-center overflow-x-auto">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="font-display whitespace-nowrap text-xs uppercase tracking-wide text-ink transition-colors hover:text-kit-600 sm:text-sm"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center justify-end gap-4">
          <SearchBox />
          <CartBadge />
        </div>
      </div>
    </header>
  );
}
