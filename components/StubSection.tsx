export function StubSection({ title }: { title: string }) {
  return (
    <section className="mt-12">
      <h2 className="font-display mb-4 text-xl font-semibold uppercase tracking-wide text-ink">{title}</h2>
      <div className="rounded-xl border border-dashed border-line bg-surface p-10 text-center text-sm text-neutral-400">
        Coming soon
      </div>
    </section>
  );
}
