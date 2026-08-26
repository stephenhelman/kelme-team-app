const STEPS = [
  {
    n: "1",
    title: "Browse the Catalog",
    body: "Real Kelme inventory — live colorways, sizing, and stock, pulled straight from the dealer catalog.",
  },
  {
    n: "2",
    title: "Pick Your Kit",
    body: "Choose a colorway and build a size run for your roster, right down to the last player.",
  },
  {
    n: "3",
    title: "Hit the Minimum",
    body: "Build out a team order of 25 units or more — the cart tracks it for you as you go.",
  },
  {
    n: "4",
    title: "Checkout & Confirm",
    body: "Submit the order and get a confirmation with a payment link — no back-and-forth required.",
  },
];

export function HowItWorks() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
      <h2 className="font-display text-center text-xl uppercase tracking-wide text-ink sm:text-2xl">
        How It Works
      </h2>

      <div className="mt-10 grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((step) => (
          <div key={step.n} className="flex flex-col items-center text-center">
            <span className="font-display flex h-12 w-12 items-center justify-center rounded-full border-2 border-ink text-lg text-ink">
              {step.n}
            </span>
            <p className="font-display mt-4 text-sm uppercase tracking-wide text-ink">{step.title}</p>
            <p className="mt-2 text-sm text-neutral-500">{step.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
