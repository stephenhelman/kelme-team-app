const STATS = [
  { value: "50", label: "Years" },
  { value: "5", label: "Continents" },
  { value: "50", label: "Countries" },
];

export function BrandBand() {
  return (
    <section className="border-y border-line bg-ink py-14">
      <div className="mx-auto grid max-w-4xl grid-cols-3 gap-4 px-4 text-center sm:px-6">
        {STATS.map((stat) => (
          <div key={stat.label}>
            <p className="font-display text-4xl font-bold text-white sm:text-5xl">{stat.value}</p>
            <p className="font-display mt-2 text-xs uppercase tracking-widest text-neutral-400 sm:text-sm">
              {stat.label}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
