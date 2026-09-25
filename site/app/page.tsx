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

import { ConversationField } from './_components/conversation-field';
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
    answer: 'Yes, from source on a Mac. The guided terminal helps you connect your messaging apps through Ghostget, add a conversation, check your inbox, and send replies you write yourself. That needs no AI account, and new installations start paused. A local build with a connected AI account adds the butler: it reads the conversations you turn on, drafts replies, and can send them on its own. There is no app to download; you start the menu bar companion from the terminal.',
  },
  {
    question: 'Can it answer messages for me?',
    answer: 'Yes, with some setup. With a local build and a Claude Code or Codex subscription connected through xcb, the butler writes and sends replies, marked by default, to the contacts you turn on, once you resume it. It can also suggest replies for you to review. Without an AI account, you draft each reply yourself in the guided inbox, read the complete text, and choose when to send. Running from source never writes AI replies.',
  },
  {
    question: 'Can my agent use it directly?',
    answer: 'Yes. The JSON CLI is built for agents. It can list conversations, read and summarize history, write drafts, and send messages you have explicitly authorized. These are the same staged actions the butler uses, and they stay within what each contact you turn on allows.',
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
            <div><dt>AGENTS.md</dt><dd>Standing instructions it reads but can’t change.</dd></div>
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
            backdrop={<ConversationField />}
            actions={[{ href: GETTING_STARTED_URL, label: 'Set up on your Mac' }, { href: '#replies', label: 'How replies stay off' }]}
            boundary={HERO_FOOTNOTE}
            className="mlm-marketing-hero"
            eyebrow="Messaging assistant for Mac"
            frame={<ButlerFrame />}
            heading="Your AI butler replies in the chats you choose."
            headingId="textbutler-title"
            name="Textbutler"
            summary="Turn it on for one person on iMessage, WhatsApp, or Beeper, and it replies as a clearly marked assistant that knows your history with them."
          />
          </div>

          <MarketingSection heading="A butler for each relationship" headingId="contacts-title" id="how-it-works" label="" summary="You choose which contacts your agent can help, and each one gets its own notes. You can pause one conversation or all of them at any time.">
            <TopicIcon slug="butler" />
            <MarketingFlow ariaLabel="How contact-based assistance is designed to work" steps={[
              { label: 'Choose a contact', detail: 'Pick one direct conversation from a connected app. New contacts start with the butler off, and by default up to five contacts can have it on at once.' },
              { label: 'Give it context', detail: 'Optionally import recent history as context. Guidance, preferences, and dated memories live in an ordinary folder you can read and edit.' },
              { label: 'Let your agent work', detail: 'It reads new messages, sums up what needs an answer, and drafts replies within what that contact allows. You can review everything in the inbox.' },
              { label: 'Turn on automatic replies later', detail: 'Automatic replies stay off until you connect an AI account that passes its check, turn replies on for this contact, and resume the butler. They need a local build. Running from source never writes AI replies.' },
            ]} />
          </MarketingSection>

          <MarketingSection heading="It answers when you let it" headingId="replies-title" id="replies" label="" summary="With a local build and a connected subscription, the butler can answer the contacts you turn on by itself. Its replies are marked, paced, and kept within limits you set.">
            <TopicIcon slug="control" />
            <dl className="architecture-rows">
              <div><dt>Identified by default</dt><dd>Every automatic reply is wrapped in the contact’s disclosure symbols, shown as 🤖{'{ … }'}. You can change or clear each symbol per contact.</dd></div>
              <div><dt>Paced, not instant</dt><dd>Replies wait through bursts of messages, hold back after you’ve just written, and check the conversation again right before sending.</dd></div>
              <div><dt>Limits it can’t raise</dt><dd>You turn each contact on separately, a cap limits how many are on at once, and hourly reply limits and a confidence threshold apply. The butler can choose to stay silent; it can’t raise its own limits.</dd></div>
              <div><dt>A pause that is always yours</dt><dd>Pause one conversation or the whole butler at any time. New installations and new contacts start paused.</dd></div>
            </dl>
          </MarketingSection>

          <MarketingSection heading="It learns each relationship" headingId="memory-title" id="memory" label="" layout="split" summary="The butler keeps each contact’s context in ordinary files it maintains itself: guidance it can read and revise, dated memories with sources, and the corrections you make. It is designed to learn from conversation without turning its guesses into facts.">
            <TopicIcon slug="memory" />
            <div className="workspace-example"><pre aria-label="Example contact workspace"><code>{`contact/\n├── AGENTS.md\n├── ABOUT.md\n├── MEMORY.md\n├── STYLE.md\n├── history/\n├── notes/\n├── attachments/\n└── outbox/`}</code></pre><p>Each contact gets a folder like this. Your settings, sign-ins, and permissions live elsewhere, where the butler can’t edit them.</p><a href={`${ARCHITECTURE_URL}#contact-data`}>How contact folders work</a></div>
          </MarketingSection>

          <MarketingSection heading="Small parts with clear jobs" headingId="architecture-title" id="architecture" label="" summary="A background service on your Mac does the work, and the menu bar companion gives you the controls. Developers can extend it with hooks and adapters without handing the AI model unrestricted access.">
            <TopicIcon slug="architecture" />
            <dl className="architecture-rows">
              <div><dt>Textbutler</dt><dd>Contacts, response timing, visible disclosure, evolving memory, pause, action policy, and the send journal.</dd></div>
              <div><dt>Ghostget</dt><dd>iMessage, WhatsApp and Beeper connections, account permissions, conversation identity, and available message actions.</dd></div>
              <div><dt><a href="https://github.com/hraness/xcb">xcb</a></dt><dd>Runs the butler’s replies on your own Claude Code or Codex subscription and keeps that sign-in out of Textbutler. The model gets no tools of its own; it proposes actions for Textbutler to check. Textbutler’s MIT-licensed source also serves as an example app for developers building on xcb.</dd></div>
              <div><dt>Your hooks</dt><dd>Developer-authored extensions for context and response decisions. Trusted executable hooks stay separate from the agent’s editable memory.</dd></div>
            </dl>
            <p className="mlm-section-link"><a href={ARCHITECTURE_URL}>Read the architecture and capability limits</a></p>
          </MarketingSection>

          <MarketingTrustBoundary className="mlm-marketing-trust" heading="What the butler can see and send" headingId="boundaries-title" id="boundaries" label="" summary="Contact folders stay on your Mac. The AI provider you connect sees the context it needs to write a reply. This website has no access to any of it." items={[
            { label: 'Marked replies', detail: 'By default the butler’s replies look like 🤖{ hello this is my response }. You can change or clear the three symbols. When you send or approve a reply yourself, you see its complete text first.' },
            { label: 'One conversation at a time', detail: 'The butler can read and edit one contact’s folder, fetch public web pages, and propose messages for that conversation. It can’t run commands on your Mac, and your sign-ins and permissions live outside its files.' },
            { label: 'Every send is recorded', detail: 'The background service logs each send with the messaging app’s confirmation. A send whose outcome is unclear stays blocked until it is resolved, and it is never retried silently.' },
            { label: 'Only what the connection supports', detail: 'Anything beyond text depends on the messaging app and its permissions. Features Textbutler can’t use, such as mini apps, show as unavailable.' },
          ]} />

          <MarketingSection heading="Start with a reply you review" headingId="development-title" id="development" label="" summary={SITE_STATUS}>
            <TopicIcon slug="control" />
            <div className="development-status"><div><h3>Start in the guided terminal</h3><p>Run <code>bun run textbutler tui</code> from your checkout. It walks you through connecting Ghostget, adding one conversation, and sending a reply you write yourself. New installations start paused. The optional menu bar companion downloads a prebuilt runner, so there is nothing extra to build.</p><a href={GETTING_STARTED_URL}>Follow the setup guide</a></div><div><h3>Connect AI through xcb</h3><p>Build a local copy with <code>bun run textbutler:install</code>. It refuses to build if the source files it checks differ from the last reviewed version. Then connect xcb, choose a Claude Code or Codex account, and run <code>providers check</code>. Running from source never writes AI replies. A finished setup doesn’t show that replies work, so test delivery and rich actions on your own account before you rely on them.</p><a href={`${GITHUB_URL}/blob/main/docs/textbutler/native-subscription.md`}>Read the subscription connection guide</a></div></div>
            <p className="legacy-note">Looking for the original history tools? <a href={RELEASE_URL}>Message Like Me v{SOFTWARE_VERSION}</a> remains available as a legacy release. It does not install Textbutler or enable automatic replies. <Link href="/sources">View legacy history sources.</Link></p>
          </MarketingSection>

          <MarketingQuestionList className="mlm-marketing-questions" heading="A few things to know" headingId="questions-title" id="questions" label="" questions={HOME_QUESTIONS.map(({ answer, question }) => ({ answer: <p>{answer}</p>, question }))} />
          <MarketingRelated heading="From the same workshop" headingId="related-title" label="Related" summary="More Hraness tools that work on your Mac and keep the agent’s access limited." groups={[
            {
              heading: "The personal apps",
              headingId: "related-apps",
              items: [
                {
                  name: "PeopleBlade",
                  href: "https://peopleblade.com",
                  role: "Local personal CRM for everyone you know, built for your agent",
                  relationship: "PeopleBlade keeps the people. Textbutler’s legacy history tools write the same private message-bundle format, so an export made for one reads in the other.",
                },
                {
                  name: "Soulscrape",
                  href: "https://soulscrape.com",
                  role: "Free agent skill that writes dated dossiers on people, sources cited",
                  relationship: "Textbutler’s legacy history tools can export your messages with a person as evidence for a Soulscrape profile.",
                },
                {
                  name: "Wordcell",
                  href: "https://wordcell.io",
                  role: "Markdown knowledge base that gives agents the decisions behind code",
                  relationship: "The butler's memory lives in ordinary files; Wordcell is the same idea grown into a full queryable vault your agent can search.",
                },
              ],
            },
            {
              heading: "The agent platform",
              headingId: "related-tools",
              summary: "The connections, subscription, and model comparisons around the butler.",
              items: [
                {
                  name: "Ghostget",
                  href: "https://ghostget.com",
                  role: "Named web actions for AI agents: read pages, save media, use connected accounts",
                  relationship: "Ghostget connects Textbutler to iMessage, WhatsApp, and Beeper.",
                },
                {
                  name: "xcb",
                  href: "https://xcb.sh",
                  role: "Routes coding tasks across the Claude, Codex, and Devin plans you have",
                  relationship: "xcb runs the butler’s replies on your Claude Code or Codex subscription and keeps that sign-in out of Textbutler.",
                },
                {
                  name: "AI Charts",
                  href: "https://aicharts.io",
                  role: "Model benchmark scores plotted against cost and tokens per task",
                  relationship: "Textbutler’s replies run on Claude or Codex models; AI Charts compares published benchmarks for them.",
                },
              ],
            },
          ]} />
          <MarketingCallToAction actions={[{ href: GETTING_STARTED_URL, label: 'Start guided setup' }, { href: '/docs', label: 'Read the docs' }]} className="mlm-marketing-cta" footnote={HERO_FOOTNOTE} heading="Try one conversation" headingId="closing-title" id="closing" summary="Connect an app, choose a conversation, and watch your agent work. Turn on automatic replies only after your account passes its check and you’ve tested with the person you chose." />
        </MarketingPage>
      </main>
      <SiteFooter path="/" />
    </div>
  );
}
