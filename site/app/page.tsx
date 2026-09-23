import {
  MarketingCallToAction,
  MarketingFlow,
  MarketingPage,
  MarketingProofFrame,
  MarketingQuestionList,
  MarketingRelated,
  MarketingSection,
  MarketingTrustBoundary,
  ProductHero,
} from '@hraness/design-kit/react/server';
import Link from 'next/link';

import { SiteFooter, SiteHeader } from './_components/site-chrome';
import {
  ARCHITECTURE_URL,
  GITHUB_URL,
  GETTING_STARTED_URL,
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

const HERO_FOOTNOTE = 'Source pilot · macOS · iMessage + WhatsApp + Beeper';
const HOME_QUESTIONS = [
  {
    question: 'Can I use Textbutler today?',
    answer: 'You can try the source pilot on your Mac. The guided terminal helps you configure messaging, add a conversation, review your inbox and send replies you write yourself. That path needs a ready Ghostget connection but no AI account. New installations start paused. The native menu companion uses a verified prebuilt runner; no local Rust build is needed. No windowed app download is provided.',
  },
  {
    question: 'Can Textbutler draft a message for me?',
    answer: 'You draft replies yourself in the guided inbox, review the complete text, and choose when to send; that path needs no AI account. A verified installed bundle with an admitted Claude Code or Codex subscription can let the butler compose disclosed replies on its own once you enable the contact and resume globally. The source daemon keeps AI replies unavailable.',
  },
  {
    question: 'Will it interrupt my conversations?',
    answer: 'Manual replies send only after your explicit choice. Automatic replies require a verified installed Textbutler bundle, current xcb and application admission, an enabled contact and global resume. They wait through message bursts, yield after a recent message from you, and recheck the conversation before sending. The current connections do not expose typing activity.',
  },
  {
    question: 'Will people know the butler is responding?',
    answer: 'By default, replies carry a visible disclosure: 🤖{ hello this is my response }. You can change or clear the character, opening symbol and closing symbol for each contact. Clearing all three sends plain text. The terminal shows the complete outgoing text before you choose to send it.',
  },
  {
    question: 'What can the agent access?',
    answer: 'xcb provides subscription inference with no provider tools. Textbutler interprets proposals through its broker for one contact folder, bounded public web requests and staged conversation actions. Trusted Textbutler code checks and sends those actions. Provider credentials and process custody stay in xcb; adding credentials alone cannot admit this route.',
  },
  {
    question: 'Which agent can I use?',
    answer: 'A verified installed Textbutler bundle can connect Claude Code or Codex subscriptions through xcb. It requires reviewed composition evidence for Textbutler, current xcb provider/runtime admission and explicit account/model checks. The source daemon has no composition admission and keeps AI replies unavailable. Claude API requires its own reviewed compiled runtime. It is billed separately from a Claude Code subscription. Textbutler never silently substitutes an API account for a subscription.',
  },
  {
    question: 'Does this website receive my messages?',
    answer: 'No. textbutler.app is informational and has no message upload, contact import, account, or drafting form. The Mac stores contact context locally. When you choose a hosted AI provider, it handles the context it receives under its own data policies.',
  },
  {
    question: 'Which rich message features will work?',
    answer: 'Start with text replies. iMessage and WhatsApp use native Ghostget connections; Beeper brings linked apps such as Signal, Telegram and Instagram through its current text-only automation adapter. Other actions depend on the connection and permissions. Some iMessage rich actions require a separately configured Messages bridge with System Integrity Protection disabled; Textbutler never changes that setting. App Clips and mini apps remain unavailable. No Linq integration is included.',
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
          <p className="butler-disclosure-note">Identified by default. Reviewed before sending.</p>
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
            actions={[{ href: '#development', label: 'See what’s ready' }, { href: GETTING_STARTED_URL, label: 'Start guided setup' }]}
            boundary={HERO_FOOTNOTE}
            className="mlm-marketing-hero"
            eyebrow=""
            frame={<ButlerFrame />}
            heading="A little help in your conversations"
            headingId="textbutler-title"
            name="Textbutler"
            summary="Bring selected iMessage, WhatsApp and Beeper conversations into a local inbox. Draft a reply, review it, and stay in control from your Mac."
          />
          </div>

          <MarketingSection heading="A butler for each relationship" headingId="contacts-title" id="how-it-works" label="" summary="Choose the contacts it can help. Keep their context separate. Pause one conversation or every conversation whenever you need.">
            <TopicIcon slug="butler" />
            <MarketingFlow ariaLabel="How contact-based assistance is designed to work" steps={[
              { label: 'Choose a contact', detail: 'Choose one direct conversation from a configured connection. New contacts start disabled; the default active limit is five.' },
              { label: 'Give it context', detail: 'Optionally import recent history as context. Guidance, preferences, and dated memories live in an ordinary folder you can read and edit.' },
              { label: 'Draft your reply', detail: 'Use the inbox to find unanswered messages. Draft a reply and review the complete text before sending. No AI account is needed.' },
              { label: 'Keep the conversation yours', detail: 'Automatic replies remain a separate choice, requiring a qualified agent, an enabled contact and global resume. The source CLI has no ready AI engine.' },
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
              <div><dt>Ghostget</dt><dd>iMessage, WhatsApp and Beeper connections, account permissions, conversation identity, and available message actions.</dd></div>
              <div><dt><a href="https://github.com/hraness/xcb">xcb</a></dt><dd>Subscription inference with no provider tools, separate credential storage and provider custody. Textbutler is an MIT-licensed reference application; both installations require current admission evidence.</dd></div>
              <div><dt>Your hooks</dt><dd>Developer-authored extensions for context and response decisions. Trusted executable hooks stay separate from the agent’s editable memory.</dd></div>
            </dl>
            <p className="mlm-section-link"><a href={ARCHITECTURE_URL}>Read the architecture and capability limits</a></p>
          </MarketingSection>

          <MarketingTrustBoundary className="mlm-marketing-trust" heading="Keep the useful boundaries visible" headingId="boundaries-title" id="boundaries" label="" summary="The contact folder is local. Your selected AI provider still receives the context needed for its work. Textbutler’s website has no access to that information." items={[
            { label: 'Review what gets sent', detail: 'The default disclosure is 🤖{ hello this is my response }. Its three symbols can be changed or cleared. You review the complete outgoing text.' },
            { label: 'One conversation at a time', detail: 'The agent boundary is one contact workspace, public web requests, and that conversation’s supported message actions. No shell tools.' },
            { label: 'Capabilities, not promises', detail: 'Rich actions depend on the selected connection and its permissions. Unsupported features, including mini apps, stay visible as unavailable.' },
          ]} />

          <MarketingSection heading="Start with a reply you review" headingId="development-title" id="development" label="" summary="Try the source pilot for messaging setup, inbox review and replies you write. AI replies require a verified installed bundle and a separately configured xcb subscription connection.">
            <TopicIcon slug="control" />
            <div className="development-status"><div><h3>Start in the guided terminal</h3><p>Run <code>bun run textbutler tui</code> from your checkout. Set up Ghostget, add one conversation and try a reply you write yourself. The optional native menu uses a prebuilt runner. New installations start paused.</p><a href={GETTING_STARTED_URL}>Follow the setup guide</a></div><div><h3>Connect AI through xcb</h3><p>Install a verified Textbutler bundle with reviewed composition evidence, then connect an admitted xcb runtime and an explicit Claude Code or Codex account. The source daemon remains unadmitted. A successful setup alone does not prove live inference. Live delivery and rich actions still need verification on your account.</p><a href={`${GITHUB_URL}/blob/main/docs/textbutler/native-subscription.md`}>Read the subscription connection guide</a></div></div>
            <p className="legacy-note">Looking for the original history tools? <a href={RELEASE_URL}>Message Like Me v{SOFTWARE_VERSION}</a> remains available as a legacy release. It does not install Textbutler or enable automatic replies. <Link href="/sources">View legacy history sources.</Link></p>
          </MarketingSection>

          <MarketingQuestionList className="mlm-marketing-questions" heading="A few things to know" headingId="questions-title" id="questions" label="" questions={HOME_QUESTIONS.map(({ answer, question }) => ({ answer: <p>{answer}</p>, question }))} />
          <MarketingRelated heading="From the same workshop" headingId="related-title" label="Related" summary="Each Hraness product owns one private domain and gives your agent the same kind of access: local, bounded, and inspectable." groups={[
            {
              heading: "The personal apps",
              headingId: "related-apps",
              items: [
                {
                  name: "PeopleBlade",
                  href: "https://peopleblade.com",
                  role: "A private contact book for you and your agent",
                  relationship: "Textbutler drafts what you'd say; PeopleBlade keeps who they are — a unified local book with notes, history, and reviewable identity.",
                },
                {
                  name: "Soulscrape",
                  href: "https://soulscrape.com",
                  role: "A dated, cited dossier on a person",
                  relationship: "When a reply needs more than memory, a Soulscrape dossier gives the conversation a cited, bounded model of the person.",
                },
                {
                  name: "Wordcell",
                  href: "https://wordcell.io",
                  role: "A Markdown knowledge base for agents",
                  relationship: "The butler's memory lives in ordinary files; Wordcell is the same idea grown into a full queryable vault your agent can search.",
                },
              ],
            },
            {
              heading: "The agent platform",
              headingId: "related-tools",
              summary: "The layer your agent runs through — sessions, accounts, web reads, and the models behind them.",
              items: [
                {
                  name: "Ghostget",
                  href: "https://ghostget.com",
                  role: "A bounded bridge to provider data",
                  relationship: "Ghostget gives an agent bounded, attested reads on the accounts and pages a draft might reference — never a driven browser.",
                },
                {
                  name: "Gobstopper",
                  href: "https://gobstopper.sh",
                  role: "Automatic context compaction for agent sessions",
                  relationship: "Threads run long; Gobstopper compacts the session context so studying a whole conversation stays cheap.",
                },
                {
                  name: "xcb",
                  href: "https://xcb.sh",
                  role: "A metaharness for agent subscriptions",
                  relationship: "xcb runs the agents the butler hands drafts to — one workspace with account custody and visible token spend.",
                },
                {
                  name: "Aicharts",
                  href: "https://aicharts.io",
                  role: "AI model benchmarks and usage inspection",
                  relationship: "Aicharts compares the models your drafts run on — and shows what a reply actually cost.",
                },
              ],
            },
          ]} />
          <MarketingCallToAction actions={[{ href: GETTING_STARTED_URL, label: 'Start guided setup' }, { href: '/docs', label: 'Read the docs' }]} className="mlm-marketing-cta" footnote={HERO_FOOTNOTE} heading="Try one conversation" headingId="closing-title" id="closing" summary="Connect an app, choose a conversation and review a reply. Enable automatic replies only after account checks and a live test with your chosen recipient." />
        </MarketingPage>
      </main>
      <SiteFooter path="/" />
    </div>
  );
}
