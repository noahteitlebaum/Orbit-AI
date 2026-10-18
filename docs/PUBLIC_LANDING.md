# Public landing page — October 17, 2026

Signed-out `/` renders the public Orbit landing page; eligible signed-in students retain their workspace and existing waitlisted accounts retain `/waitlist`. Existing server eligibility remains exact verified @uwo.ca. The landing header and school grid distinguish Orbit password login from joining the public interest list. No university SSO, affiliation, or automatic app eligibility is claimed.

Design uses existing Wordmark, provider logos, OrbitBackdrop, typography, surfaces, focus and button tokens. Decorative orbit artwork is subdued behind the hero. The interactive preview switches between illustrative course and Orbit layouts, clearly labelled sample data. Both exact requested headlines are included. Layout and navigation reflow on phone; reduced-motion preferences are respected.

Pricing derives from config/economics.ts: free C$0 waitlist; proposed C$30 monthly student subscription with C$20 monthly AI allowance; proposed seven-day trial with C$2.50 usage credit, not a confirmed purchase price. Payments remain disabled. Taxes, trial pricing, subscription lifecycle and final prices require owner confirmation.

Initial institutions: Western, Toronto, Waterloo, McMaster, Queen’s, Ottawa, York, TMU. Official website assets and provenance are in INSTITUTION_ASSETS.json. “My school isn’t listed” accepts another Ontario university name. Final school coverage and production brand-asset approvals remain to confirm. Logo names/buttons have accessible labels, selected text, aria-pressed, visible focus, and search by aliases/city. Only Western exposes an Orbit login link; other schools show waitlist-only copy.

Public waitlist registration is separate from accounts, billing, and app access. It collects email, school and explicit consent version into a private RLS table through a service-only RPC. Email duplicates return the same outcome; no account enumeration. A keyed IP digest provides an atomic eight-attempt/hour limit; raw IPs and emails are not logged. Hosting must overwrite forwarded IP headers. Deploy behind the host’s network/bot controls before high-volume promotion. No email verification or automated invitation sender is implemented; success means interest stored, not an email sent or an access date promised.

Apply migration0016 before collecting interest. The service key and Supabase URL must be configured; failures produce a real unavailable message, never fake success. New users are not created by this endpoint. Contact email and approved legal URLs are not supplied: /privacy, /terms, /contact are honest pending/status pages. Configure NEXT_PUBLIC_CONTACT_EMAIL, NEXT_PUBLIC_PRIVACY_URL, NEXT_PUBLIC_TERMS_URL after owner approval and revise pending copy before public launch. No policy text or support address was invented.

Validation uses synthetic requests and local database role/rate-limit tests. Browser checks cover desktop/375px, search, loaded logos, selection, Western login versus non-Western waitlist. Screenshots show UI state; no real email was registered. Public production deployment and collection were not performed.

Final local verification: lint, typecheck, production webpack build, and 398 tests across 53 files passed. Backend integration still needs staging credentials and migrations0015/0016.
