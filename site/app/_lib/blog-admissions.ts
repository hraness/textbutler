import type { ArticleAdmission, ArticleIsoDate, ArticleSourceRecord } from '@hraness/design-kit';

// Editorial review records for every post under /blog, validated by
// assertArticleAdmissions() in scripts/blog.test.tsx. A quarantined post is
// readable but noindex and stays out of the sitemap, feed, llms.txt, and the
// blog index. The review is a disclosed AI review; humanReview stays null.

const REVIEWED_ON: ArticleIsoDate = '2026-09-24';
const REASSESS_ON: ArticleIsoDate = '2026-11-05';
const REVIEW = {
  reviewer: 'Claude Opus 5.5 (claude-opus-5-5) editorial review',
  reviewerType: 'ai',
  reviewedOn: REVIEWED_ON,
} as const;

type Repository = 'textbutler' | 'ghostget' | 'algal' | 'xcb' | 'design-kit';

function source(title: string, repository: Repository, path: string): ArticleSourceRecord {
  const kind = path.endsWith('/') ? 'tree' : 'blob';
  return {
    title,
    url: `https://github.com/hraness/${repository}/${kind}/main/${path.replace(/\/$/u, '')}`,
    checkedOn: REVIEWED_ON,
  };
}

export const BLOG_ADMISSIONS = [
  {
    href: '/blog/introducing-textbutler',
    lifecycle: 'indexable',
    readerJob: 'Decide whether Textbutler fits how I want help with personal messages on my Mac, what it will send without me, and how to start.',
    nonObviousAnswer: 'A draft sends only when you pass back the digest of the exact review you read, and it is refused if the conversation moved on, disclosure changed or fifteen minutes passed; a per-conversation habitat plan is style data that cannot change recipients, provider or disclosure, and code rejects a candidate that alters your tool switches or fixed core text.',
    originalContribution: 'Explains the reply flow and the habitat direction from the source code, including the digest-bound send, draft expiry, and which plan fields code refuses to change.',
    hostFit: 'The product introduction on the product host. It links the three integration posts and PeopleBlade along the registered shared-bundle relation.',
    nearestUrls: [
      { url: 'https://textbutler.app/', distinction: 'The home page lists features; this post explains why the product works this way and walks through one day of use.' },
      { url: 'https://textbutler.app/docs', distinction: 'The docs page is the full README; this post is the short narrative a new reader starts with.' },
    ],
    sources: [
      source('Textbutler architecture: contact data, owner reply triage, contact habitats', 'textbutler', 'docs/textbutler/architecture.md'),
      source('Textbutler status sentence (SITE_STATUS)', 'textbutler', 'site/app/_lib/site.ts'),
      source('Habitat program instructions and limits', 'textbutler', 'packages/textbutler/src/habitat-program.ts'),
      source('xcb client: tool-free generation contract', 'textbutler', 'packages/textbutler/src/xcb-client.ts'),
      source('Getting started', 'textbutler', 'docs/textbutler/getting-started.md'),
      source('messagelikeme.com permanent redirects', 'textbutler', 'site/next.config.ts'),
      source('Portfolio relation: Textbutler and PeopleBlade shared bundle format', 'design-kit', 'src/portfolio.generated.json'),
    ],
    observations: [
      'Draft expiry is fifteen minutes (DRAFT_TTL_MS in owner-replies.ts), and a stale or expired draft is refused at send time rather than resent.',
      'A new contact starts disabled with a 300-second cooldown and a 12-per-hour cap in config.ts, and a new install starts paused.',
    ],
    scores: { readerUtility: 2, originalEvidence: 2, factualConfidence: 2, hostFit: 1, voiceIntegrity: 2, maintenanceValue: 1 },
    owner: 'Hraness',
    drafting: 'ai-from-source',
    review: REVIEW,
    humanReview: null,
    reassessOn: REASSESS_ON,
    harmIfWrong: 'A reader could expect Textbutler to send nothing without approval when a contact they switched on can reply on its own, or trust a disclosure marker they have cleared.',
    refreshTriggers: [
      'Textbutler release tag bump or change to SITE_STATUS',
      'Change to draft expiry, digest send, auto-reply cooldown, hourly cap or contact limit (owner-replies.ts, config.ts)',
      'Change to history import cap or media handling (enrollment.ts)',
      'Change to habitat plan, promotion rule or protected fields (contact-habitat.ts, habitat-program.ts)',
      'Change to the default disclosure marker',
      'Registration or change of the Textbutler relations to xcb, ALGAL, Ghostget or PeopleBlade',
      'Ghostget live link verification completes or a signed app ships',
      'Bun version pin changes in package.json',
    ],
  },
  {
    // runtime:message-like-me:xcb:drafts-replies-through is registered in the
    // portfolio facts since @hraness/design-kit v0.18.2.
    href: '/blog/how-textbutler-uses-xcb',
    lifecycle: 'indexable',
    readerJob: 'Decide whether to connect an existing Claude Code or Codex subscription to Textbutler through xcb, and know what each side holds before setting it up.',
    nonObviousAnswer: 'xcb holds the login and runs a tool-free model; Textbutler pins the xcb executable by SHA-256, sends prompts on stdin, rejects replies whose account, model or JSON keys do not match, and carries out every contact action itself. A failed subscription call waits and never falls through to the billed Claude API.',
    originalContribution: 'Traces the xcb call path from Textbutler source: hash pin, stdin prompt, duplicate-key rejection, step limits, and the separate API route.',
    hostFit: 'A "How Textbutler uses xcb" post on the consumer host. The registered runtime:message-like-me:xcb:drafts-replies-through relation carries the detail sentence this post explains.',
    nearestUrls: [
      { url: 'https://xcb.sh/blog/introducing-xcb', distinction: 'The xcb introduction covers xcb itself; this post covers only how Textbutler calls it.' },
      { url: 'https://textbutler.app/blog/introducing-textbutler', distinction: 'The introduction mentions xcb in one paragraph and links here for the details.' },
    ],
    sources: [
      source('Textbutler xcb client: capability and result parsing, executable hash check, prompt on stdin', 'textbutler', 'packages/textbutler/src/xcb-client.ts'),
      source('Textbutler build record for the xcb route: classify and respond profiles, source hashes', 'textbutler', 'qualification/xcb-textbutler-v1.json'),
      source('Textbutler architecture: xcb application contract, subscription and API routes', 'textbutler', 'docs/textbutler/architecture.md'),
      source('AI subscriptions through xcb: setup, step limits, recovery', 'textbutler', 'docs/textbutler/native-subscription.md'),
      source('Agent account setup: Claude Code, Codex and the separately billed Claude API', 'textbutler', 'packages/textbutler/PROVIDERS.md'),
      source('Accepted xcb account providers (claude, codex)', 'textbutler', 'packages/textbutler/src/host-config.ts'),
      source('Pinned AgentMixer compatibility library', 'textbutler', 'package.json'),
      source('Textbutler status sentence', 'textbutler', 'site/app/_lib/site.ts'),
      source('xcb application API: tool-free generation for applications', 'xcb', 'docs/application-api.md'),
    ],
    observations: [
      'Textbutler host config accepts only claude and codex xcb accounts, although xcb itself lists Devin as a candidate provider.',
      'The disclosure marker is on by default but clearable: config.ts returns no marker once the owner clears all three symbols.',
    ],
    scores: { readerUtility: 2, originalEvidence: 1, factualConfidence: 2, hostFit: 2, voiceIntegrity: 2, maintenanceValue: 1 },
    owner: 'Hraness',
    drafting: 'ai-from-source',
    review: REVIEW,
    humanReview: null,
    reassessOn: REASSESS_ON,
    harmIfWrong: 'A reader could assume a failed subscription call falls back to paid API use, or that xcb gives the model file or messaging tools.',
    refreshTriggers: [
      'Change to XCB_LIMITS, stdin input, duplicate-key parsing or verifyXcbExecutable in packages/textbutler/src/xcb-client.ts',
      'Change to accepted xcb providers in packages/textbutler/src/host-config.ts (for example Devin accepted)',
      'xcb README readiness change for Devin, or xcb application API change',
      'Change to step or operation limits, setup flags or recovery in docs/textbutler/native-subscription.md',
      'Change to API route defaults, maximum or price expiry in packages/textbutler/PROVIDERS.md',
      'New or changed drafting profiles in qualification/xcb-textbutler-v1.json',
      'Disclosure marker default change in config.ts, or replies show/send CLI change',
      'SITE_STATUS change in site/app/_lib/site.ts',
      'AgentMixer pin change in package.json',
      'Relation runtime:message-like-me:xcb:drafts-replies-through registered, renamed or removed',
    ],
  },
  {
    // runtime:message-like-me:algal:runs-reply-habitats-on is registered in the
    // portfolio facts since @hraness/design-kit v0.18.2.
    href: '/blog/how-textbutler-uses-algal',
    lifecycle: 'indexable',
    readerJob: 'Decide whether to turn on Textbutler\'s per-contact habitats, and know what the learning can change, what it cannot, and how to undo it.',
    nonObviousAnswer: 'The plan schema has no field for recipient, provider, permissions or disclosure, so no learned plan can express a change to them; a candidate plan wins only if a blinded judge marks it safe on both replayed cases, scores it no lower on either, and finds an average gain of at least 0.1, and replays run no tools, so tool choice is never measured.',
    originalContribution: 'Lays out the habitat plan schema, run limits, and promotion rule from Textbutler source, and states what the replay does not measure.',
    hostFit: 'A "How Textbutler uses ALGAL" post on the consumer host. The registered runtime:message-like-me:algal:runs-reply-habitats-on relation carries the detail sentence this post explains.',
    nearestUrls: [
      { url: 'https://algal.computer/blog/built-on-algal/', distinction: 'The ALGAL hub lists every product built on it; this post explains Textbutler\'s use only.' },
      { url: 'https://textbutler.app/blog/introducing-textbutler', distinction: 'The introduction describes habitats as the product direction and links here for how they run.' },
    ],
    sources: [
      source('Habitat programs: respond, reflect and judge phases run as ALGAL organisms with fixed budgets', 'textbutler', 'packages/textbutler/src/habitat-program.ts'),
      source('Contact habitats: opt-in via host.json, per-conversation isolation, promotion rule, owner controls', 'textbutler', 'docs/textbutler/architecture.md'),
      source('Habitat plan schema, default plan and promotion checks', 'textbutler', 'packages/textbutler/src/contact-habitat.ts'),
      source('Habitat host configuration (habitat.enabled)', 'textbutler', 'packages/textbutler/src/host-config.ts'),
      source('Tool-free, non-replayable evolution call', 'textbutler', 'packages/textbutler/src/habitat-evolution.ts'),
      source('Live reply runs, blinded replay, judge and run records', 'textbutler', 'packages/textbutler/src/habitat-agent.ts'),
      source('habitats CLI and the pause requirement', 'textbutler', 'packages/textbutler/src/owner-cli.ts'),
      source('ALGAL dependency pinned by commit', 'textbutler', 'package.json'),
      source('Textbutler status label', 'textbutler', 'site/app/_lib/site.ts'),
      source('ALGAL README: organisms, budgets, host-decided selection, the open question', 'algal', 'README.md'),
    ],
    observations: [
      'Replay order is set per case from a hash rather than shuffled, and only the two most recent episodes with follow-ups are replayed.',
      'Only the latest 32 habitat runs per contact are kept in full, so tracing a plan change back to its runs works for recent promotions only.',
    ],
    scores: { readerUtility: 2, originalEvidence: 1, factualConfidence: 2, hostFit: 1, voiceIntegrity: 2, maintenanceValue: 1 },
    owner: 'Hraness',
    drafting: 'ai-from-source',
    review: REVIEW,
    humanReview: null,
    reassessOn: REASSESS_ON,
    harmIfWrong: 'A reader could believe learned plans can change who receives messages or which tools run, or that the replay proves replies got better.',
    refreshTriggers: [
      '@hraness/algal pin change in package.json or ALGAL README change to how organisms, budgets or the open question are described',
      'Budget, step or model-call limit change for respond, reflect or judge in packages/textbutler/src/habitat-program.ts',
      'Plan schema change in packages/textbutler/src/contact-habitat.ts',
      'Promotion rule change: replay case count, safety check, per-case or average margin, citation, rollback or ancestor handling',
      'Journal retention change from 32 full run records per contact',
      'habitats CLI rename or argument change in packages/textbutler/src/owner-cli.ts, or change to the pause requirement',
      'Default reply route or learning route change',
      'Relation runtime:message-like-me:algal:runs-reply-habitats-on registered, changed or removed',
      'SITE_STATUS_LABEL change in site/app/_lib/site.ts',
    ],
  },
  {
    // Quarantined: the registered relation detail names Beeper bundles only,
    // while the post also covers the WhatsApp v2 bundle. Widen the relation's
    // detail sentence to mention WhatsApp, or cut the WhatsApp sections, before
    // indexing.
    href: '/blog/how-textbutler-uses-ghostget',
    lifecycle: 'quarantined',
    readerJob: 'Get my Beeper and WhatsApp history into Textbutler without giving Textbutler my messaging logins, and know what the import checks and keeps.',
    nonObviousAnswer: 'Textbutler owns the bundle format and Ghostget checks every record with Textbutler\'s own code at a pinned commit, so the import is a folder handoff: Textbutler verifies all hashes before one database transaction, keeps messages a later export omits, and makes you name the overlapping Beeper source before it imports a native WhatsApp export.',
    originalContribution: 'Shows the folder handoff from both repositories: the shared checking module, the golden sample folder both test suites use, and the re-import rules.',
    hostFit: 'A "How Textbutler uses Ghostget" post for a registered relation whose detail sentence covers Beeper bundles only; the WhatsApp sections go beyond it until the relation is widened.',
    nearestUrls: [
      { url: 'https://ghostget.com/blog/built-on-ghostget', distinction: 'The Ghostget hub lists every product built on it; this post covers the Textbutler import only.' },
      { url: 'https://textbutler.app/sources', distinction: 'The sources page catalogs supported history sources; this post explains how the Ghostget handoff works.' },
    ],
    sources: [
      source('Ghostget Beeper bundle parser built on Textbutler\'s contract module', 'ghostget', 'src/beeper-message-bundle-v1.ts'),
      source('Ghostget WhatsApp bundle parser built on Textbutler\'s v2 contract module', 'ghostget', 'src/whatsapp-message-bundle-v2.ts'),
      source('Ghostget pins @hraness/message-like-me to a fixed Textbutler commit', 'ghostget', 'package.json'),
      source('Golden bundle generator', 'ghostget', 'scripts/generate-beeper-message-like-me-golden.ts'),
      source('Ghostget test: regenerate the golden bundle byte for byte', 'ghostget', 'src/beeper-message-like-me-export.test.ts'),
      source('Textbutler test: import the exact bundle Ghostget emits', 'textbutler', 'src/bundle.test.ts'),
      source('Golden bundle files (identical blobs in both repositories)', 'textbutler', 'src/fixtures/beeper-message-like-me-v1/'),
      source('Bundle format v1 (Beeper)', 'textbutler', 'docs/local-message-bundle-v1.md'),
      source('Bundle format v2 (WhatsApp)', 'textbutler', 'docs/local-message-bundle-v2.md'),
      source('Bundle import checks and what they do not prove', 'textbutler', 'SECURITY.md'),
      source('Export commands and coverage warnings', 'ghostget', 'README.md'),
      source('Textbutler status sentence', 'textbutler', 'site/app/_lib/site.ts'),
    ],
    observations: [
      'All seven golden fixture files have identical Git blob IDs in the Textbutler and Ghostget repositories, kept in step by hand rather than by a shared check.',
      'The Ghostget pin of @hraness/message-like-me is a commit that is not an ancestor of Textbutler main, so the two can drift until the pin is updated.',
    ],
    scores: { readerUtility: 2, originalEvidence: 2, factualConfidence: 2, hostFit: 1, voiceIntegrity: 2, maintenanceValue: 1 },
    owner: 'Hraness',
    drafting: 'ai-from-source',
    review: REVIEW,
    humanReview: null,
    reassessOn: REASSESS_ON,
    harmIfWrong: 'A reader could treat an export as complete history, or store a bundle that holds names, numbers and message text somewhere shared.',
    refreshTriggers: [
      'Change to the detail sentence of contract:wrench:message-like-me:exports-private-bundles, or registration of a WhatsApp relation',
      'Ghostget updates its @hraness/message-like-me pin (package.json)',
      'Change to docs/local-message-bundle-v1.md or v2.md, or a new bundle version',
      'Rename of the messagelikeme command or the ghostget export-message-like-me commands',
      'Change to Textbutler\'s re-import, overlap or rejection rules (src/command-program.ts, src/store.ts, SECURITY.md)',
      'Textbutler status label change or a Textbutler release tag',
      'Ghostget or Textbutler product rename',
    ],
  },
] as const satisfies readonly ArticleAdmission[];

export function blogAdmission(href: string): ArticleAdmission | undefined {
  return (BLOG_ADMISSIONS as readonly ArticleAdmission[]).find((admission) => admission.href === href);
}
