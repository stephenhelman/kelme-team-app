import Image from "next/image";
import Link from "next/link";

const CATEGORIES = [
  { label: "Team", href: "/contact", image: "/team.webp" },
  { label: "Coach", href: "/contact", image: "/coach.webp" },
  { label: "Equipment", href: "/contact", image: "/equipment.webp" },
];

export function GetStarted() {
  return (
    <section className="bg-surface py-16">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <h2 className="font-display text-center text-xl uppercase tracking-wide text-ink sm:text-2xl">
          Get Started
        </h2>

        <div className="mt-10 flex flex-col items-center gap-10 sm:flex-row sm:justify-center sm:gap-16">
          {CATEGORIES.map((cat) => (
            <Link key={cat.label} href={cat.href} className="group flex flex-col items-center gap-3">
              <span className="relative block h-36 w-36 overflow-hidden rounded-full ring-1 ring-line transition-transform group-hover:scale-[1.03] sm:h-44 sm:w-44">
                <Image
                  src={cat.image}
                  alt={cat.label}
                  fill
                  className="object-cover"
                  sizes="176px"
                />
              </span>
              <span className="font-display text-sm uppercase tracking-wide text-ink group-hover:text-kit-600">
                {cat.label}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
