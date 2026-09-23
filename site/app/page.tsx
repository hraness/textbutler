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
  SITE_STATUS,
  SITE_STATUS_LABEL,
  SITE_TITLE,
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
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  path: '/',
});

const HERO_FOOTNOTE = `${SITE_STATUS_LABEL} · macOS · iMessage, WhatsApp, and Beeper`;
const HOME_QUESTIONS = [
  {
    question: 'Can I use Textbutler today?',
    answer: 'Yes, from source on a Mac. The guided terminal helps you connect your messaging apps through Ghostget, add a conversation, check your inbox, and send replies you write yourself. That needs no AI account, and new installations start paused. There is no app to download; you start the menu bar companion from the terminal.',
  },
  {
    question: 'Can Textbutler draft a message for me?',
    answer: 'Yes, with some setup. Out of the box you draft each reply yourself in the guided inbox, read the complete text, and choose when to send, with no AI account. With a local build and a Claude Code or Codex subscription connected through xcb, the butler can also suggest replies for you to review. For contacts you turn on, after you resume it, it can send its own replies, marked by default.',
  },
  {
    question: 'Will it interrupt my conversations?',
    answer: 'Only if you turn automatic replies on. Replies you write send only when you choose. Automatic replies need a local build with an AI account that passes its check, the contact turned on, and the butler resumed. Even then, they wait for a burst of messages to finish, hold back after a recent message from you, and check the conversation again just before sending. The current connections can’t see when you’re typing.',
  },
  {
    question: 'Will people know the butler is responding?',
    answer: 'By default, replies carry a visible disclosure: 🤖{ hello this is my response }. You can change or clear the character, opening symbol, and closing symbol for each contact. Clearing all three sends plain text. The terminal shows the complete outgoing text before you choose to send it.',
  },
  {
    question: 'What can the agent access?',
    answer: 'Through xcb, the AI model gets no tools of its own. It can ask Textbutler to read or edit one contact’s folder, fetch a public web page, or propose a message in that conversation, and Textbutler checks each request before acting on it. Your AI sign-in stays in xcb, and signing in alone doesn’t turn AI replies on.',
  },
  {
    question: 'Which agent can I use?',
    answer: 'Claude Code or Codex, through your own subscription and xcb, once your xcb account and model pass their checks. An optional fast-reply mode, which you turn on in the host.json settings file, has a Qwen model through Vercel AI Gateway or a model server on your Mac write the replies instead; you still need an xcb account that passes its checks to turn a contact on. Both need a local build. The Claude API route isn’t available in any build of this repository; it needs a separately reviewed runtime, and API use is billed separately from a Claude Code subscription. Textbutler never falls back to an API account when you choose a subscription.',
  },
  {
    question: 'Does this website receive my messages?',
    answer: 'No. textbutler.app is informational and has no message upload, contact import, account, or drafting form. The Mac stores contact context locally. When you choose a hosted AI provider, it handles the context it receives under its own data policies.',
  },
  {
    question: 'Which rich message features will work?',
    answer: 'Start with text replies. iMessage and WhatsApp connect directly through Ghostget. Beeper adds linked apps such as Signal, Telegram, and Instagram, for text only. Anything beyond text depends on the connection and its permissions. Some iMessage extras need a separately configured Messages bridge, which requires System Integrity Protection disabled; Textbutler never changes that setting. App Clips, mini apps, and Linq aren’t supported.',
  },
  {
    question: 'What happened to Message Like Me?',
    answer: `Textbutler replaced it. Message Like Me’s history readers, methodology, and published v${SOFTWARE_VERSION} package are still available as legacy tools. Installing that package doesn’t install Textbutler or turn on automatic replies.`,
  },
] as const;

function ButlerFrame() {
  return (
    <MarketingProofFrame
      className="hraness-material-pane"
      caption="Illustration only. The contact, messages, and reply are made up, and nothing was sent."
      credit="A contact’s notes and a reply marked as the butler’s"
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
          <div className="bubble bubble-out">{'🤖{ Where are you headed, and for how long? }'}</div>
          <p className="butler-disclosure-note">The 🤖{'{ }'} wrapper marks the butler’s words. You can change it or clear it.</p>
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
            heading="A message butler for your Mac"
            headingId="textbutler-title"
            name="Textbutler"
            summary="Bring the iMessage, WhatsApp, and Beeper conversations you choose into one inbox on your Mac. Draft a reply, read it through, and send it when you’re ready."
          />
          </div>

          <MarketingSection heading="A butler for each relationship" headingId="contacts-title" id="how-it-works" label="" summary="You choose which contacts the butler can help, and each one gets its own notes. You can pause one conversation or all of them at any time.">
            <TopicIcon slug="butler" />
            <MarketingFlow ariaLabel="How contact-based assistance is designed to work" steps={[
              { label: 'Choose a contact', detail: 'Pick one direct conversation from a connected app. New contacts start with the butler off, and by default up to five contacts can have it on at once.' },
              { label: 'Give it context', detail: 'Optionally import recent history as context. Guidance, preferences, and dated memories live in an ordinary folder you can read and edit.' },
              { label: 'Draft your reply', detail: 'Use the inbox to find unanswered messages. Draft a reply and review the complete text before sending. No AI account is needed.' },
              { label: 'Turn on automatic replies later', detail: 'Automatic replies stay off until you connect an AI account that passes its check, turn replies on for this contact, and resume the butler. They need a local build. Running from source never writes AI replies.' },
            ]} />
          </MarketingSection>

          <MarketingSection heading="Memory you can read and change" headingId="memory-title" id="memory" label="" layout="split" summary="The butler’s context belongs in ordinary files. Add what it should know, correct an assumption, or remove a stale note. It is designed to learn from conversation without turning its guesses into facts.">
            <TopicIcon slug="memory" />
            <div className="workspace-example"><pre aria-label="Example contact workspace"><code>{`contact/\n├── AGENTS.md\n├── ABOUT.md\n├── MEMORY.md\n├── STYLE.md\n├── history/\n├── notes/\n├── attachments/\n└── outbox/`}</code></pre><p>Each contact gets a folder like this. Your settings, sign-ins, and permissions live elsewhere, where the butler can’t edit them.</p><a href={`${ARCHITECTURE_URL}#contact-data`}>How contact folders work</a></div>
          </MarketingSection>

          <MarketingSection heading="Small parts with clear jobs" headingId="architecture-title" id="architecture" label="" summary="A background service on your Mac does the work, and the menu bar companion gives you the controls. Developers can extend it with hooks and adapters without handing the AI model unrestricted access.">
            <TopicIcon slug="architecture" />
            <dl className="architecture-rows">
              <div><dt>Textbutler</dt><dd>Contacts, response timing, visible disclosure, scoped memory, pause, and action policy.</dd></div>
              <div><dt>Ghostget</dt><dd>iMessage, WhatsApp and Beeper connections, account permissions, conversation identity, and available message actions.</dd></div>
              <div><dt><a href="https://github.com/hraness/xcb">xcb</a></dt><dd>Runs the butler’s replies on your own Claude Code or Codex subscription and keeps that sign-in out of Textbutler. The model gets no tools of its own; it proposes actions for Textbutler to check. Textbutler’s MIT-licensed source also serves as an example app for developers building on xcb.</dd></div>
              <div><dt>Your hooks</dt><dd>Developer-authored extensions for context and response decisions. Trusted executable hooks stay separate from the agent’s editable memory.</dd></div>
            </dl>
            <p className="mlm-section-link"><a href={ARCHITECTURE_URL}>Read the architecture and capability limits</a></p>
          </MarketingSection>

          <MarketingTrustBoundary className="mlm-marketing-trust" heading="What the butler can see and send" headingId="boundaries-title" id="boundaries" label="" summary="Contact folders stay on your Mac. The AI provider you connect sees the context it needs to write a reply. This website has no access to any of it." items={[
            { label: 'Marked replies', detail: 'By default the butler’s replies look like 🤖{ hello this is my response }. You can change or clear the three symbols. When you send or approve a reply yourself, you see its complete text first.' },
            { label: 'One conversation at a time', detail: 'The butler can read and edit one contact’s folder, fetch public web pages, and propose messages for that conversation. It can’t run commands on your Mac.' },
            { label: 'Only what the connection supports', detail: 'Anything beyond text depends on the messaging app and its permissions. Features Textbutler can’t use, such as mini apps, show as unavailable.' },
          ]} />

          <MarketingSection heading="Start with a reply you review" headingId="development-title" id="development" label="" summary={SITE_STATUS}>
            <TopicIcon slug="control" />
            <div className="development-status"><div><h3>Start in the guided terminal</h3><p>Run <code>bun run textbutler tui</code> from your checkout. It walks you through connecting Ghostget, adding one conversation, and sending a reply you write yourself. New installations start paused. The optional menu bar companion downloads a prebuilt runner, so there is nothing extra to build.</p><a href={GETTING_STARTED_URL}>Follow the setup guide</a></div><div><h3>Connect AI through xcb</h3><p>Build a local copy with <code>bun run textbutler:install</code>. It refuses to build if the source files it checks differ from the last reviewed version. Then connect xcb, choose a Claude Code or Codex account, and run <code>providers check</code>. Running from source never writes AI replies. A finished setup doesn’t show that replies work, so test delivery and rich actions on your own account before you rely on them.</p><a href={`${GITHUB_URL}/blob/main/docs/textbutler/native-subscription.md`}>Read the subscription connection guide</a></div></div>
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
          <MarketingCallToAction actions={[{ href: GETTING_STARTED_URL, label: 'Start guided setup' }, { href: '/docs', label: 'Read the docs' }]} className="mlm-marketing-cta" footnote={HERO_FOOTNOTE} heading="Try one conversation" headingId="closing-title" id="closing" summary="Connect an app, choose a conversation, and send a reply you’ve read through. Turn on automatic replies only after your account passes its check and you’ve tested with the person you chose." />
        </MarketingPage>
      </main>
      <SiteFooter path="/" />
    </div>
  );
}
