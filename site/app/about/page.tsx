import Link from 'next/link';
import { SiteFooter, SiteHeader } from '../_components/site-chrome';
import { absoluteUrl, ARCHITECTURE_URL, GITHUB_URL, pageMetadata, serializeJsonLd, SITE_DESCRIPTION, SITE_NAME } from '../_lib/site';

export const metadata = pageMetadata({ title: 'About', description: 'Why Textbutler gives each relationship its own context, makes the assistant visible, and keeps control on your Mac.', path: '/about' });
const aboutJsonLd = { '@context': 'https://schema.org', '@type': 'AboutPage', name: `About ${SITE_NAME}`, url: absoluteUrl('/about'), description: SITE_DESCRIPTION, mainEntity: { '@id': `${absoluteUrl('/')}#application` }, isPartOf: { '@id': `${absoluteUrl('/')}#website` } };

export default function AboutPage() {
  return <><SiteHeader /><main className="document-page" id="main-content" tabIndex={-1}>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(aboutJsonLd) }} />
    <header className="document-hero"><h1>A helpful presence in your conversations</h1><p>{SITE_DESCRIPTION}</p><a href={GITHUB_URL}>View the open-source project</a></header>
    <section className="about-grid" aria-label="Product principles">
      <article><h2>Let the butler be itself.</h2><p>It should help as an assistant that people can recognize. Text replies always carry a configurable disclosure, starting with {'🤖{ hello this is my response }'}.</p></article>
      <article><h2>Give each relationship its own context.</h2><p>A contact folder holds guidance, dated memories, preferences, and sources. You can inspect and edit the files. Settings and permission grants live outside the agent’s editable context.</p></article>
      <article><h2>Keep the decision with you.</h2><p>Choose the contacts it may help, set the active limit, and pause it globally or per contact. Smart response is designed to yield while you are talking; keyword-only mode waits for a direct invitation.</p></article>
    </section>
    <section className="about-sources" aria-labelledby="about-build-title"><div><h2 id="about-build-title">Building from clear boundaries</h2></div><div><p>The CLI, menu companion, and daemon are in source, with iMessage and WhatsApp connections through Ghostget. Replies require explicit messaging permissions, a ready Claude API account, and contact activation. Claude Code and Codex remain unavailable while their execution boundaries are qualified. New installations start paused, live delivery needs account-specific verification, and there is no windowed app download; install the CLI and build the menu companion explicitly.</p><a href={ARCHITECTURE_URL}>Read the architecture</a></div></section>
    <section className="about-sources" aria-labelledby="about-history-title"><div><h2 id="about-history-title">What we are carrying forward</h2></div><div><p>Textbutler grew out of the unused Message Like Me experiment. Its history readers and evidence methodology remain available as legacy tools. They inform contact memory, but their read-only import contracts do not establish live messaging support for the menu companion.</p><Link href="/sources">Explore the legacy history tools</Link></div></section>
    <nav className="document-next" aria-label="Learn more"><Link href="/docs">Read the project docs</Link><Link href="/methodology">Legacy methodology</Link><Link href="/research">Legacy research</Link></nav>
  </main><SiteFooter path="/about" /></>;
}
