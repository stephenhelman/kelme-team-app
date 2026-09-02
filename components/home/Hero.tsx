import Image from "next/image";
import Link from "next/link";

export function Hero() {
  return (
    <section className="relative flex h-[70vh] min-h-[420px] w-full items-end overflow-hidden bg-ink sm:items-center">
      <Image
        src="/hero.webp"
        alt="Kelme kit, worn by club teams across La Liga"
        fill
        priority
        className="object-cover object-top opacity-90"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-black/10 sm:bg-gradient-to-r sm:from-black/75 sm:via-black/35 sm:to-transparent" />

      <div className="relative mx-auto w-full max-w-7xl px-4 pb-10 sm:px-6 sm:pb-0">
        <div className="max-w-md">
          <p className="font-display text-xs uppercase tracking-widest text-kit-400">
            Official Kelme Dealer
          </p>
          <h1 className="font-display mt-2 text-4xl font-bold uppercase leading-[0.95] tracking-wide text-white sm:text-5xl">
            Outfit Your Team
          </h1>
          <p className="mt-4 text-sm text-neutral-200 sm:text-base">
            Real Kelme kit, colorways, and sizing for your club — order in bulk, get a payment link,
            and gear up.
          </p>
          <Link
            href="/contact"
            className="font-display mt-6 inline-block rounded-full bg-white px-6 py-3 text-sm uppercase tracking-wide text-ink transition-colors hover:bg-kit-400"
          >
            Get a Quote
          </Link>
        </div>
      </div>
    </section>
  );
}
