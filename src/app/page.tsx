import Link from "next/link";

const plannedFeatures = [
  {
    title: "Usage ingestion",
    body: "Record token usage per request via an authenticated API endpoint.",
  },
  {
    title: "Versioned pricing",
    body: "Per-model prices with effective dates, so history keeps the price that applied.",
  },
  {
    title: "Spend dashboard",
    body: "Daily and monthly spend broken down by project, provider, and model.",
  },
  {
    title: "Budgets",
    body: "Monthly budgets per project with alerts as spend approaches the limit.",
  },
];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-10 px-4 py-16 sm:px-8">
      <header className="flex flex-col gap-3">
        <p className="font-mono text-sm text-foreground/60">
          v0.1 · early development
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">
          AI API Cost Tracker
        </h1>
        <p className="max-w-2xl text-lg text-foreground/70">
          Track token usage and spend across AI API providers, models, and
          projects in one place.
        </p>
        <Link
          href="/projects"
          className="w-fit rounded-md bg-foreground px-4 py-2 font-medium text-background"
        >
          Manage projects
        </Link>
      </header>

      <section aria-labelledby="planned" className="flex flex-col gap-4">
        <h2 id="planned" className="text-xl font-medium">
          Planned features
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2">
          {plannedFeatures.map((feature) => (
            <li
              key={feature.title}
              className="rounded-lg border border-foreground/10 p-5"
            >
              <h3 className="font-medium">{feature.title}</h3>
              <p className="mt-1 text-sm text-foreground/70">{feature.body}</p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
