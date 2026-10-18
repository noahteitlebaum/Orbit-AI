import Link from "next/link";
import { Wordmark, OrbitBackdrop } from "./brand";
import { ProviderLogo } from "./provider-logo";
import { primaryButtonClass } from "./auth-ui";

const providers = [["openai", "OpenAI"], ["anthropic", "Anthropic"], ["google", "Google"], ["xai", "xAI"]] as const;
const benefits = [
  { title: "Choose your AI", body: "Chat with supported models from four providers, with your conversations saved in one workspace." },
  { title: "Keep courses organized", body: "Bring syllabi, notes, and assignments together. Review deadlines and ask questions with relevant course context." },
  { title: "Get another perspective", body: "Try Orbit mode: four AIs vote on a lead, with a specialist contributing when the vote calls for it." },
];

export function LandingPage() {
  return (
    <div className="orbit-landing min-h-dvh bg-surface-000 text-ink">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand focus:p-3 focus:text-on-brand">Skip to content</a>
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-8">
          <Link href="/" aria-label="Orbit AI home"><Wordmark className="text-xl" markSize={30} /></Link>
          <nav aria-label="Main navigation" className="flex items-center gap-4 text-sm">
            <Link href="/login" className="rounded-lg px-2 py-3 text-ink-muted hover:text-ink">Log In</Link>
            <Link href="/signup" className={`${primaryButtonClass} !w-auto !px-4 !py-2.5`}>Get Started</Link>
          </nav>
        </div>
      </header>
      <main id="main">
        <OrbitBackdrop className="landing-hero relative overflow-hidden">
          <section className="relative mx-auto max-w-4xl px-5 py-16 text-center sm:px-8 sm:py-24">
            <p className="text-xs font-medium uppercase tracking-[.18em] text-brand">Built by students, for students</p>
            <h1 className="mt-6 text-[clamp(2.5rem,6vw,4.5rem)] font-medium leading-[1.08] tracking-tight">Your AIs. Your courses.<br />One place to learn.</h1>
            <p className="mx-auto mt-6 max-w-xl text-base leading-7 text-ink-muted sm:text-lg">Spend less time switching tabs. Bring your favourite AI models, course materials, and deadlines into one workspace.</p>
            <Link href="/signup" className={`${primaryButtonClass} mt-8 !w-auto !px-8`}>Get Started <span aria-hidden="true">→</span></Link>
            <p className="mt-4 text-xs leading-5 text-ink-subtle">Western students can create an account. Other Canadian institutions can join the waitlist.</p>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-4">
              {providers.map(([id, name]) => <div key={id} className="flex items-center gap-2 text-sm text-ink-muted"><ProviderLogo provider={id} size={22} /><span>{name}</span></div>)}
            </div>
          </section>
        </OrbitBackdrop>
        <section aria-label="Why Orbit AI" className="mx-auto max-w-6xl px-5 pb-16 sm:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            {benefits.map((benefit) => <article key={benefit.title} className="rounded-2xl border border-line bg-surface-100 p-6"><h2 className="text-lg font-medium">{benefit.title}</h2><p className="mt-3 text-sm leading-6 text-ink-muted">{benefit.body}</p></article>)}
          </div>
          <p className="mt-5 text-xs leading-5 text-ink-subtle">Model availability and features vary. AI can make mistakes; review generated answers and deadlines.</p>
        </section>
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-6 text-xs text-ink-muted sm:px-8">
          <p>© 2026 Orbit AI</p>
          <nav aria-label="Footer" className="flex flex-wrap gap-5"><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/contact">Contact</Link></nav>
        </div>
      </footer>
    </div>
  );
}
