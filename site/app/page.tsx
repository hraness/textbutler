import {
  MarketingCallToAction,
  MarketingFlow,
  MarketingPage,
  MarketingProofFrame,
  MarketingQuestionList,
  MarketingSection,
  MarketingTrustBoundary,
  ProductHero,
} from '@hraness/design-kit/react/server';
import Link from 'next/link';

import { SiteFooter, SiteHeader } from './_components/site-chrome';
import {
  ARCHITECTURE_URL,
  GITHUB_URL,
  pageMetadata,
  RELEASE_URL,
  serializeJsonLd,
  SITE_DESCRIPTION,
  SOFTWARE_VERSION,
} from './_lib/site';

function TopicIcon({ slug }: Readonly<{ slug: string }>) {
  // Decorative local SVG; next/image cannot optimize vector sources.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="textbutler-topic-icon" src={`/icons/${slug}.svg`} alt="" aria-hidden="true" width="88" height="88" loading="lazy" decoding="async" />
  );
}

export const metadata = pageMetadata({
  title: 'Textbutler — Your personal message butler for Mac',
  description: SITE_DESCRIPTION,
  path: '/',
});

const HERO_FOOTNOTE = 'In development · macOS · iMessage + WhatsApp';
const HOME_QUESTIONS = [
  {
    question: 'Can I use Textbutler today?',
    answer: 'You can build the menu companion from source. It includes the daemon, conversation picker, editable memory, hooks, and guarded reply loop. Replies need a configured Ghostget connection, an explicitly selected ready agent account, an enabled contact, and global resume. New installations start paused. No windowed app download is provided.',
  },
  {
    question: 'Will it interrupt my conversations?',
    answer: 'Smart mode waits through message bursts and uses a cheap classifier to decide whether help is welcome. A recent message from you starts a cooldown, and the butler checks conversation activity again before sending. Pause, contact settings, and rate limits take precedence. The current connections do not expose typing activity; keyword-only mode is also available.',
  },
  {
    question: 'Will people know the butler is responding?',
    answer: 'Yes. The butler speaks as an assistant, with every text reply wrapped in a visible disclosure. The default is 🤖{ hello this is my response }. You can change the character, opening symbol, and closing symbol separately for each contact.',
  },
  {
    question: 'What can the agent access?',
    answer: 'The available Claude API route receives brokered access to one contact folder, bounded public web requests, and proposed actions for that conversation. Trusted code checks and sends those actions. Shell commands, other contact folders, credentials, and permission changes are excluded. Claude Code and Codex remain unavailable while their execution boundaries are being qualified.',
  },
  {
    question: 'Which agent can I use?',
    answer: 'Claude API is the current explicit account option in the packaged runtime. It is billed separately from a Claude Code subscription, and account and model checks must pass before use. Claude Code and Codex are planned choices, currently unavailable. Textbutler never silently switches between them or borrows a subscription credential.',
  },
  {
    question: 'Does this website receive my messages?',
    answer: 'No. textbutler.app is informational and has no message upload, contact import, account, or drafting form. The Mac stores contact context locally. When you choose a hosted AI provider, it handles the context it receives under its own data policies.',
  },
  {
    question: 'Which rich message features will work?',
    answer: 'The menu companion and daemon expose text, files, reactions, stickers, links, and polls according to the connection’s current capabilities and permissions. iMessage rich actions require a separately configured Messages bridge that needs System Integrity Protection disabled; Textbutler never changes that setting. App Clips and mini apps remain unavailable. No Linq integration is included.',
  },
  {
    question: 'What happened to Message Like Me?',
    answer: `Textbutler is the new product direction. Message Like Me’s history readers, evidence methodology, and published v${SOFTWARE_VERSION} artifacts remain available as legacy tools. Installing that package does not install the Textbutler menu companion or enable automatic replies.`,
  },
] as const;

function ButlerFrame() {
  return (
    <MarketingProofFrame
      className="hraness-material-pane"
      caption="Synthetic illustration of the intended experience. No real messages, live agent run, or sent reply is shown."
      credit="Contact context → a clearly identified assistant"
    >
      <div className="butler-frame" aria-label="Synthetic contact context and disclosed reply">
        <div className="butler-context">
          <div className="butler-context-heading"><span className="contact-initials">AM</span><div><strong>Alex Morgan</strong><span>Example contact folder</span></div></div>
          <dl className="context-files">
            <div><dt>ABOUT.md</dt><dd>What matters in this relationship.</dd></div>
            <div><dt>MEMORY.md</dt><dd>Useful context, with sources and dates.</dd></div>
            <div><dt>STYLE.md</dt><dd>How to help in this conversation.</dd></div>
            <div><dt>AGENTS.md</dt><dd>Guidance the butler can read and revise.</dd></div>
          </dl>
          <p>You can open and edit every note.</p>
        </div>
        <div className="message-stage">
          <p className="stage-label">Example conversation</p>
          <div className="bubble bubble-in">butler, can you help me make a packing list?</div>
          <p className="stage-label stage-label--draft">Butler reply · illustration</p>
          <div className="bubble bubble-out">{'🤖{ Happy to help. Where are you headed, and for how long? }'}</div>
          <p className="butler-disclosure-note">Always recognizable. Never pretending to be you.</p>
        </div>
      </div>
    </MarketingProofFrame>
  );
}

export default function Home() {
  const faq = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: HOME_QUESTIONS.map(({ question, answer }) => ({ '@type': 'Question', name: question, acceptedAnswer: { '@type': 'Answer', text: answer } })) };
  return (
    <div className="textbutler-marketing" data-hraness-marketing-preset="editorial" data-hraness-material="lantern">
      <SiteHeader lantern />
      <main id="main-content" tabIndex={-1}>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(faq) }} />
        <MarketingPage className="mlm-page textbutler-page">
          <div className="hraness-material-wall">
          <ProductHero
            actions={[{ href: '#development', label: 'See what’s ready' }, { href: ARCHITECTURE_URL, label: 'Explore the architecture' }]}
            boundary={HERO_FOOTNOTE}
            className="mlm-marketing-hero"
            eyebrow=""
            frame={<ButlerFrame />}
            heading="A little help in your conversations"
            headingId="textbutler-title"
            name="Textbutler"
            summary="A personal assistant for selected iMessage and WhatsApp conversations. Give each contact a folder of context, decide when it can step in, and stay in control from your Mac."
          />
          </div>

          <MarketingSection heading="A butler for each relationship" headingId="contacts-title" id="how-it-works" label="" summary="Choose the contacts it can help. Keep their context separate. Pause one conversation or every conversation whenever you need.">
            <TopicIcon slug="butler" />
            <MarketingFlow ariaLabel="How contact-based assistance is designed to work" steps={[
              { label: 'Choose a contact', detail: 'Choose one direct conversation from a configured connection. New contacts start disabled; the default active limit is five.' },
              { label: 'Give it context', detail: 'Optionally import recent history as context. Guidance, preferences, and dated memories live in an ordinary folder you can read and edit.' },
              { label: 'Let it know when', detail: 'Smart mode is the default. The keyword “butler” can summon it directly; keyword-only mode keeps it waiting for that invitation.' },
              { label: 'Keep the conversation yours', detail: 'Enable a contact only with a ready agent and messaging connection. The butler identifies itself, checks your recent activity, and stops new replies when paused.' },
            ]} />
          </MarketingSection>

          <MarketingSection heading="Memory you can read and change" headingId="memory-title" id="memory" label="" layout="split" summary="The butler’s context belongs in ordinary files. Add what it should know, correct an assumption, or remove a stale note. It is designed to learn from conversation without turning its guesses into facts.">
            <TopicIcon slug="memory" />
            <div className="workspace-example"><pre aria-label="Example contact workspace"><code>{`contact/\n├── AGENTS.md\n├── ABOUT.md\n├── MEMORY.md\n├── STYLE.md\n├── history/\n├── notes/\n├── attachments/\n└── outbox/`}</code></pre><p>One contact workspace. Settings, credentials, and permission grants stay outside the agent’s files.</p><Link href="/methodology">Read the legacy evidence methodology</Link></div>
          </MarketingSection>

          <MarketingSection heading="Small parts with clear jobs" headingId="architecture-title" id="architecture" label="" summary="A local daemon handles the work while the menu companion gives you the controls. Hooks and adapters provide room to extend the experience without handing an agent unrestricted access.">
            <TopicIcon slug="architecture" />
            <dl className="architecture-rows">
              <div><dt>Textbutler</dt><dd>Contacts, response timing, visible disclosure, scoped memory, pause, and action policy.</dd></div>
              <div><dt>Ghostget</dt><dd>iMessage and WhatsApp connections, account permissions, conversation identity, and available message actions.</dd></div>
              <div><dt>Agentrouter</dt><dd>Scoped agent tools and explicit account selection. Claude API is available after setup; native Claude Code and Codex remain under qualification.</dd></div>
              <div><dt>Your hooks</dt><dd>Developer-authored extensions for context and response decisions. Trusted executable hooks stay separate from the agent’s editable memory.</dd></div>
            </dl>
            <p className="mlm-section-link"><a href={ARCHITECTURE_URL}>Read the architecture and capability limits</a></p>
          </MarketingSection>

          <MarketingTrustBoundary className="mlm-marketing-trust" heading="Keep the useful boundaries visible" headingId="boundaries-title" id="boundaries" label="" summary="The contact folder is local. Your selected AI provider still receives the context needed for its work. Textbutler’s website has no access to that information." items={[
            { label: 'A recognizable assistant', detail: 'Every text reply has a configurable character, begin symbol, and end symbol. The default is 🤖{ hello this is my response }.' },
            { label: 'One conversation at a time', detail: 'The agent boundary is one contact workspace, public web requests, and that conversation’s supported message actions. No shell tools.' },
            { label: 'Capabilities, not promises', detail: 'Rich actions depend on the selected connection and its permissions. Unsupported features, including mini apps, stay visible as unavailable.' },
          ]} />

          <MarketingSection heading="Build it. Set it up. Keep control." headingId="development-title" id="development" label="" summary="The CLI, menu companion, and daemon are implemented in source. Setup is explicit, and no windowed app download is provided.">
            <TopicIcon slug="control" />
            <div className="development-status"><div><h3>Ready to inspect and build</h3><p>Mac controls, background service, iMessage and WhatsApp enrollment, optional history import, editable memory, hooks, and a guarded reply loop. New installations start paused.</p><a href={`${GITHUB_URL}/tree/main/apps/macos`}>Inspect the menu companion source</a></div><div><h3>Setup before replies</h3><p>Configure Ghostget and its permissions, check an explicit Claude API account, then enable a contact and resume. Native Claude Code and Codex remain unavailable. Live delivery and rich actions still need verification on your account.</p><a href={ARCHITECTURE_URL}>See the integration boundaries</a></div></div>
            <p className="legacy-note">Looking for the original history tools? <a href={RELEASE_URL}>Message Like Me v{SOFTWARE_VERSION}</a> remains available as a legacy release. It does not install Textbutler or enable automatic replies. <Link href="/sources">View legacy history sources.</Link></p>
          </MarketingSection>

          <MarketingQuestionList className="mlm-marketing-questions" heading="A few things to know" headingId="questions-title" id="questions" label="" questions={HOME_QUESTIONS.map(({ answer, question }) => ({ answer: <p>{answer}</p>, question }))} />
          <MarketingCallToAction actions={[{ href: GITHUB_URL, label: 'Explore the source' }, { href: '/docs', label: 'Read the docs' }]} className="mlm-marketing-cta" footnote={HERO_FOOTNOTE} heading="Make room for a little help" headingId="closing-title" id="closing" summary="Follow the build, read the design, and help shape a butler that knows when to speak—and when to stay quiet." />
        </MarketingPage>
      </main>
      <SiteFooter path="/" />
    </div>
  );
}
