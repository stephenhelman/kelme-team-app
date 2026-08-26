export default function ContactPage() {
  return (
    <div className="mx-auto max-w-lg px-4 py-16 sm:px-6">
      <h1 className="font-display font-bold text-3xl uppercase tracking-wide text-ink">Contact</h1>
      <p className="mt-4 text-sm text-neutral-500">
        Questions about a team order, coach kit, or bulk pricing? Reach out and we&apos;ll get back to
        you.
      </p>
      <a
        href="mailto:orders@kelmeteamstore.com"
        className="font-display mt-6 inline-block rounded-full bg-ink px-6 py-3 text-sm uppercase tracking-wide text-paper transition-colors hover:bg-neutral-800"
      >
        orders@kelmeteamstore.com
      </a>
    </div>
  );
}
