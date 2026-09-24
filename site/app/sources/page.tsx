import Link from 'next/link';

import { SiteFooter, SiteHeader } from '../_components/site-chrome';
import { SourceCard } from '../_components/source-card';
import {
  BEEPER_COMPATIBILITY,
  MESSAGING_HISTORY_SOURCES,
  SUPPORTED_SOURCES,
  WHATSAPP_COMPATIBILITY,
} from '../_lib/sources';
import {
  GETTING_STARTED_URL,
  GITHUB_URL,
  pageMetadata,
  SOFTWARE_VERSION,
} from '../_lib/site';

export const metadata = pageMetadata({
  title: 'Legacy history sources',
  description:
    'The message histories that Message Like Me, Textbutler’s predecessor, can import, and the tool and format versions each history reader accepts.',
  path: '/sources',
});

const beeperProducerSummary =
  `Verified producer Ghostget v${BEEPER_COMPATIBILITY.producerVersion} uses ` +
  `${BEEPER_COMPATIBILITY.adapterId} adapter v${BEEPER_COMPATIBILITY.adapterVersion}. ` +
  `Its ${BEEPER_COMPATIBILITY.reviewedOperationCount} reviewed Beeper operations comprise ` +
  `${BEEPER_COMPATIBILITY.pinnedCliOperationCount} through one pinned Beeper CLI ` +
  `${BEEPER_COMPATIBILITY.providerCliVersion} executable, including supported actions and ` +
  `writes, plus ${BEEPER_COMPATIBILITY.fixedDesktopReadOperationCount} fixed Desktop loopback reads.`;

const beeperProvenanceSummary =
  `The pinned executable reports v${BEEPER_COMPATIBILITY.providerCliVersion} and is ` +
  `runtime authority. At the upstream tag, ` +
  `${BEEPER_COMPATIBILITY.providerCliSourcePackagePath} declares ` +
  `v${BEEPER_COMPATIBILITY.providerCliSourceDeclaredVersion}; that source-package value is ` +
  'provenance only and never overrides the executable runtime identity.';

const whatsappProducerSummary =
  `Ghostget v${WHATSAPP_COMPATIBILITY.producerVersion} owns official ` +
  `${WHATSAPP_COMPATIBILITY.providerCli} v${WHATSAPP_COMPATIBILITY.providerCliVersion}, ` +
  'linked-device authentication, synchronization, and the bounded local export. ' +
  `It omits reaction-shaped rows with ${WHATSAPP_COMPATIBILITY.reactionWarning} ` +
  'when current state cannot be proved.';

export default function SourcesPage() {
  return (
    <>
      <SiteHeader />
      <main className="document-page sources-page" id="main-content" tabIndex={-1}>
        <header className="document-hero sources-hero">
          <h1>Legacy history sources</h1>
          <p className="legacy-note">These are the published Message Like Me history readers. They only import old messages and are separate from Textbutler’s live iMessage, WhatsApp, and Beeper connections, which the <a href={GETTING_STARTED_URL}>setup guide</a> covers.</p>
          <p>
            Message Like Me supports {MESSAGING_HISTORY_SOURCES.length} messaging-history
            inputs and one optional Contacts enrichment source. The messaging inputs
            normalize into one private local corpus; Contacts adds exact labels in the
            same private local store. Every ingest path is read-only with respect to its
            source and bounded by its source contract.
          </p>
        </header>

        <section className="source-directory" aria-labelledby="source-directory-title">
          <div className="section-heading">
            <p className="eyebrow">Legacy reader support in v{SOFTWARE_VERSION}</p>
            <h2 id="source-directory-title">The source is part of the evidence.</h2>
            <p>
              “Supported” means Message Like Me can import that source. It doesn’t
              connect to the account, promise a complete history, or send anything.
            </p>
          </div>
          <div className="source-grid source-grid-full">
            {SUPPORTED_SOURCES.map((source) => (
              <SourceCard key={source.id} source={source} />
            ))}
          </div>
        </section>

        <section className="beeper-workflow" aria-labelledby="beeper-workflow-title">
          <div className="beeper-workflow-intro">
            <p className="eyebrow">Beeper via Ghostget</p>
            <h2 id="beeper-workflow-title">Bring Beeper history into the same private evidence corpus.</h2>
            <p>
              Ghostget turns bounded Beeper reads into a finished private bundle. Message
              Like Me verifies that bundle into the same local corpus as its other
              read-only sources. The two tools do not share credentials or a live session.
            </p>
          </div>
          <ol className="workflow-steps">
            <li>
              <span aria-hidden="true">01</span>
              <div>
                <h3>Ghostget writes the private bundle.</h3>
                <p>{beeperProducerSummary}</p>
                <p>{beeperProvenanceSummary}</p>
                <code className="workflow-command">ghostget beeper export-message-like-me --auth &lt;id&gt; --output /absolute/private/path/beeper-bundle</code>
              </div>
            </li>
            <li>
              <span aria-hidden="true">02</span>
              <div>
                <h3>Message Like Me verifies before ingest.</h3>
                <p>
                  It accepts bundle schema {BEEPER_COMPATIBILITY.bundleSchemaVersion}, source{' '}
                  <code>{BEEPER_COMPATIBILITY.sourceId}</code>, and transform{' '}
                  <code>{BEEPER_COMPATIBILITY.sourceTransformVersion}</code>. Package age
                  never overrides those manifest coordinates.
                </p>
                <code className="workflow-command">messagelikeme ingest bundle --input &lt;private-directory&gt;</code>
              </div>
            </li>
          </ol>
          <aside className="beeper-boundary" aria-label="Beeper operation boundary">
            <strong>What this does not mean:</strong> Message Like Me receives no provider
            credential or live session, never calls Ghostget or a Beeper operation, and never
            sends. It owns zero of Ghostget’s {BEEPER_COMPATIBILITY.reviewedOperationCount}{' '}
            reviewed Beeper operations and receives only the finished bundle. The command above
            enters Ghostget’s separate internal bounded export; it does not expose Beeper’s
            raw export arguments or establish complete-history coverage.
          </aside>
          <div className="source-links">
            <a href="https://ghostget.com/providers/beeper/">Inspect Ghostget’s Beeper surface ↗</a>
            <a href={`${GITHUB_URL}/blob/v${SOFTWARE_VERSION}/docs/local-message-bundle-v1.md`}>Read the versioned bundle contract ↗</a>
            <Link href="/docs">Open the project docs →</Link>
          </div>
        </section>

        <section className="beeper-workflow" aria-labelledby="whatsapp-workflow-title">
          <div className="beeper-workflow-intro">
            <p className="eyebrow">Native WhatsApp via Ghostget</p>
            <h2 id="whatsapp-workflow-title">Exact JIDs in. No provider session crosses over.</h2>
            <p>
              Ghostget owns Wacli and the live linked-device boundary. Message Like Me
              receives only one finished private v2 directory and performs no process,
              authentication, synchronization, network, preview, or send operation.
            </p>
          </div>
          <ol className="workflow-steps">
            <li>
              <span aria-hidden="true">01</span>
              <div>
                <h3>Ghostget writes one native account observation.</h3>
                <p>{whatsappProducerSummary}</p>
                <code className="workflow-command">ghostget whatsapp export-message-like-me --auth &lt;id&gt; --output /absolute/private/path/whatsapp-bundle</code>
              </div>
            </li>
            <li>
              <span aria-hidden="true">02</span>
              <div>
                <h3>Message Like Me proves the v2 coordinates.</h3>
                <p>
                  It accepts schema {WHATSAPP_COMPATIBILITY.bundleSchemaVersion}, source{' '}
                  <code>{WHATSAPP_COMPATIBILITY.sourceId}@{WHATSAPP_COMPATIBILITY.sourceTransformVersion}</code>,
                  provider <code>{WHATSAPP_COMPATIBILITY.providerId}@{WHATSAPP_COMPATIBILITY.providerCliVersion}</code>,
                  and exact canonical WhatsApp JIDs.
                </p>
                <code className="workflow-command">messagelikeme ingest bundle --input &lt;private-whatsapp-directory&gt;</code>
              </div>
            </li>
          </ol>
          <aside className="beeper-boundary" aria-label="WhatsApp operation boundary">
            <strong>What this does not mean:</strong> Message Like Me does not install or
            start Wacli, receive a WhatsApp credential or session database, synchronize
            a linked device, call a provider network, or send. Existing Beeper overlap
            requires explicit exact account, peer, and shared-message proof. An empty
            native reaction artifact is unavailable evidence, not evidence of no
            reactions.
          </aside>
          <div className="source-links">
            <a href="https://ghostget.com/providers/whatsapp/">Inspect Ghostget’s WhatsApp surface ↗</a>
            <a href={`${GITHUB_URL}/blob/v${SOFTWARE_VERSION}/docs/local-message-bundle-v2.md`}>Read the native bundle contract ↗</a>
            <Link href="/docs">Open the project docs →</Link>
          </div>
        </section>

        <section className="source-privacy" aria-labelledby="source-privacy-title">
          <p className="eyebrow">Local is a process boundary</p>
          <h2 id="source-privacy-title">You choose when an agent sees a packet.</h2>
          <p>
            Deterministic storage and measurement stay in Message Like Me’s private local
            data root. A study packet leaves that root only at an explicit path. Opening
            one makes its bounded excerpts visible to the agent environment you chose;
            the CLI cannot make a hosted agent local.
          </p>
        </section>
      </main>
      <SiteFooter path="/sources" />
    </>
  );
}
