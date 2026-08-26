import Link from "next/link";
import Image from "next/image";
import { CartBadge } from "./CartBadge";
import { SearchBox } from "./SearchBox";
import { MobileNav } from "./MobileNav";

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
      <div className="mx-auto grid max-w-7xl grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-6 sm:py-4">
        <div className="flex items-center gap-3">
          <MobileNav links={NAV_LINKS} />
          <Link href="/" className="hidden items-center gap-2 sm:flex">
            <Image src="/logo.webp" alt="Kelme" width={32} height={32} className="h-8 w-8" />
            <span className="font-display text-base uppercase tracking-wide text-ink">Kelme Team Store</span>
          </Link>
        </div>

        <nav className="col-start-2 hidden items-center gap-5 justify-self-center sm:flex">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="font-display whitespace-nowrap text-sm uppercase tracking-wide text-ink transition-colors hover:text-kit-600"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <Link href="/" className="col-start-2 flex items-center justify-self-center sm:hidden">
          <Image src="/logo.webp" alt="Kelme" width={36} height={36} className="h-9 w-9" />
        </Link>

        <div className="flex items-center justify-end gap-3 sm:gap-4">
          <SearchBox />
          <CartBadge />
        </div>
      </div>
    </header>
  );
}
