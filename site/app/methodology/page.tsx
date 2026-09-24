import { DocumentPage } from '../_components/document-page';
import { GITHUB_URL, pageMetadata } from '../_lib/site';
import { methodologyHtml } from '../methodology.generated';

const description =
  'Legacy evidence methodology: how Message Like Me measures local messaging behavior, bounds private evidence, separates deterministic metrics from judgment, and evaluates unsent drafts.';

export const metadata = pageMetadata({
  title: 'Methodology',
  description,
  path: '/methodology',
});

export default function MethodologyPage() {
  return (
    <DocumentPage
      eyebrow="Methodology"
      title="Methodology"
      summary={description}
      path="/methodology"
      html={methodologyHtml}
      sourceUrl={`${GITHUB_URL}/blob/main/docs/methodology.md`}
      dateModified="2026-08-27"
      legacyNote="This page comes from Message Like Me, Textbutler’s predecessor. It covers analyzing message history and drafting unsent replies, not Textbutler’s live messaging."
      sourceOwnsHeading
    />
  );
}
