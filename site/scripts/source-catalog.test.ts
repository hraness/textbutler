import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import RootLayout from '../app/layout.tsx';
import { GET as getLlmsText } from '../app/llms.txt/route.ts';
import HomePage from '../app/page.tsx';
import sitemap from '../app/sitemap.ts';
import SourcesPage from '../app/sources/page.tsx';
import { SourceIcon } from '../app/_components/source-icon.tsx';
import {
  BEEPER_COMPATIBILITY,
  MESSAGING_HISTORY_SOURCES,
  SUPPORTED_SOURCES,
  WHATSAPP_COMPATIBILITY,
} from '../app/_lib/sources.ts';

const siteRoot = resolve(import.meta.dir, '..');
const repositoryRoot = resolve(siteRoot, '..');

async function source(path: string): Promise<string> {
  return Bun.file(resolve(repositoryRoot, path)).text();
}

describe('supported source presentation', () => {
  test('dates all routes changed by the Textbutler rebrand', () => {
    const routeDates = sitemap().map(({ lastModified, url }) => {
      if (!(lastModified instanceof Date)) {
        throw new Error(`Expected a Date lastModified value for ${url}`);
      }
      return [new URL(url).pathname, lastModified.toISOString()];
    });

    expect(routeDates).toEqual([
      ['/', '2026-09-11T00:00:00.000Z'],
      ['/sources', '2026-09-11T00:00:00.000Z'],
      ['/docs', '2026-09-11T00:00:00.000Z'],
      ['/methodology', '2026-09-11T00:00:00.000Z'],
      ['/research', '2026-09-11T00:00:00.000Z'],
      ['/about', '2026-09-11T00:00:00.000Z'],
    ]);
  });

  test('keeps one exact, source-aware catalog', () => {
    expect(SUPPORTED_SOURCES.map((entry) => entry.id)).toEqual([
      'apple-messages',
      'beeper-via-ghostget',
      'whatsapp-via-ghostget',
      'x-data-archive',
      'macos-contacts',
    ]);
    expect(new Set(SUPPORTED_SOURCES.map((entry) => entry.id)).size).toBe(
      SUPPORTED_SOURCES.length,
    );
    expect(SUPPORTED_SOURCES.every((entry) => entry.status === 'Supported')).toBe(true);
    expect(SUPPORTED_SOURCES.every((entry) => !('icon' in entry))).toBe(true);
    expect(MESSAGING_HISTORY_SOURCES).toHaveLength(4);
    expect(SUPPORTED_SOURCES.find((entry) => entry.id === 'macos-contacts')?.kind).toBe(
      'Label enrichment',
    );
  });

  test('derives five unique decorative marks from the exact source IDs', async () => {
    const sourceIds = SUPPORTED_SOURCES.map((entry) => entry.id);
    const marks = sourceIds.map((sourceId) =>
      renderToStaticMarkup(SourceIcon({ sourceId })),
    );
    const artwork = marks.map((mark) =>
      mark.replace(/^<svg[^>]*>|<\/svg>$/gu, ''),
    );
    expect(sourceIds).toEqual([
      'apple-messages',
      'beeper-via-ghostget',
      'whatsapp-via-ghostget',
      'x-data-archive',
      'macos-contacts',
    ]);
    expect(new Set(artwork).size).toBe(5);

    for (const [index, sourceId] of sourceIds.entries()) {
      const mark = marks[index];
      expect(mark).toContain(`<svg aria-hidden="true" class="source-icon source-icon-${sourceId}"`);
      expect(mark).toContain(`data-source-mark="${sourceId}"`);
      expect(mark).toContain('focusable="false"');
      expect(mark).toContain('stroke="currentColor"');
      expect(mark).not.toContain('<title');
      expect(mark.toLowerCase()).not.toContain('tabindex');
    }

    const beeperMark = marks[sourceIds.indexOf('beeper-via-ghostget')];
    const whatsappMark = marks[sourceIds.indexOf('whatsapp-via-ghostget')];
    expect(beeperMark).toContain('data-mark-provider="beeper"');
    expect(beeperMark).toContain('data-mark-tool="ghostget"');
    expect(beeperMark).not.toContain('data-mark-provider="whatsapp"');
    expect(whatsappMark).toContain('data-mark-provider="whatsapp"');
    expect(whatsappMark).toContain('data-mark-tool="ghostget"');
    expect(whatsappMark).not.toContain('data-mark-provider="beeper"');
    for (const sourceId of ['apple-messages', 'x-data-archive', 'macos-contacts'] as const) {
      expect(marks[sourceIds.indexOf(sourceId)]).not.toContain(
        'data-mark-tool="ghostget"',
      );
    }

    const [card, css] = await Promise.all([
      source('site/app/_components/source-card.tsx'),
      source('site/app/globals.css'),
    ]);
    expect(card).toContain('<SourceIcon sourceId={source.id} />');
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toMatch(
      /\.source-icon\s*\{[^}]*background: Canvas;[^}]*color: CanvasText;[^}]*forced-color-adjust: none;[^}]*outline: 1px solid CanvasText;/u,
    );
  });

  test('pins the native WhatsApp Ghostget/Wacli contract exactly', () => {
    expect(WHATSAPP_COMPATIBILITY).toEqual({
      producer: 'Ghostget',
      producerVersion: '0.17.1',
      providerCli: 'Wacli',
      providerCliVersion: '0.15.0',
      bundleSchemaVersion: '2',
      sourceId: 'wacli-local',
      sourceTransformVersion: '1.0.0',
      providerId: 'whatsapp',
      network: 'whatsapp',
      reactionState: 'unproven-omitted',
      reactionWarning: 'reaction-state-unproven',
    });
    const whatsapp = SUPPORTED_SOURCES.find((entry) => entry.id === 'whatsapp-via-ghostget');
    expect(whatsapp?.name).toBe('WhatsApp via Ghostget');
    expect(whatsapp?.boundary).toContain('omits reaction-shaped rows');
    expect(whatsapp?.boundary).toContain('never operates WhatsApp');
  });

  test('pins the currently verified Beeper producer without widening the manifest contract', () => {
    expect(BEEPER_COMPATIBILITY).toEqual({
      producer: 'Ghostget',
      producerVersion: '0.17.1',
      adapterId: 'beeper-local',
      adapterVersion: '2.4.0',
      reviewedOperationCount: 32,
      pinnedCliOperationCount: 26,
      fixedDesktopReadOperationCount: 6,
      providerCliVersion: '0.6.2',
      providerCliSourcePackagePath: 'packages/cli/package.json',
      providerCliSourceDeclaredVersion: '0.6.1',
      bundleSchemaVersion: '1',
      sourceId: 'beeper-local',
      sourceTransformVersion: '1.1.0',
      exportBoundary: 'internal-bounded',
    });
    expect(
      BEEPER_COMPATIBILITY.pinnedCliOperationCount +
        BEEPER_COMPATIBILITY.fixedDesktopReadOperationCount,
    ).toBe(
      BEEPER_COMPATIBILITY.reviewedOperationCount,
    );

    const beeper = SUPPORTED_SOURCES.find((entry) => entry.id === 'beeper-via-ghostget');
    expect(beeper?.name).toBe('Beeper via Ghostget');
    expect(beeper?.summary).toBe(
      'Adds a finished Beeper bundle from Ghostget v0.17.1 and adapter 2.4.0 to the private local evidence corpus.',
    );
    expect(beeper?.boundary).toContain('All 32 reviewed operations stay in Ghostget');
    expect(beeper?.boundary).toContain('26 through one pinned Beeper CLI 0.6.2 executable');
    expect(beeper?.boundary).toContain('including supported actions and writes');
    expect(beeper?.boundary).toContain('plus six fixed Desktop loopback reads');
    expect(beeper?.boundary).toContain('receives no provider credentials');
    expect(beeper?.boundary).toContain('calls no Ghostget or Beeper operation');
    expect(beeper?.boundary).toContain('never sends');
    expect(beeper?.boundary).toContain('does not claim complete history');
    expect(`${beeper?.summary}\n${beeper?.boundary}`).not.toMatch(/Ghostget v0\.16\.(?:1|5)/u);
  });

  test('publishes the catalog across human and machine discovery surfaces', async () => {
    const renderedHomePage = renderToStaticMarkup(HomePage());
    const renderedSourcesPage = renderToStaticMarkup(SourcesPage());
    const renderedRootLayout = renderToStaticMarkup(RootLayout({ children: null }));
    const modelText = await getLlmsText().text();
    const [
      home,
      sourcesPage,
      chrome,
      sitemap,
      llms,
      readme,
      changelog,
      bundleContract,
      whatsappContract,
      messagingSkill,
      privacyGuide,
    ] =
      await Promise.all([
        source('site/app/page.tsx'),
        source('site/app/sources/page.tsx'),
        source('site/app/_components/site-chrome.tsx'),
        source('site/app/sitemap.ts'),
        source('site/app/llms.txt/route.ts'),
        source('README.md'),
        source('CHANGELOG.md'),
        source('docs/local-message-bundle-v1.md'),
        source('docs/local-message-bundle-v2.md'),
        source('skills/message-like-me/SKILL.md'),
        source('skills/message-like-me/references/privacy.md'),
      ]);

    expect(home).toContain('<ProductHero');
    expect(home).toContain("{ href: '#development', label: 'See what’s ready' }");
    expect(renderedHomePage).toContain('data-hraness-marketing="hero"');
    expect(renderedHomePage).toContain('View legacy history sources.');
    expect(renderedHomePage).not.toContain('messagelikeme ingest');
    expect(renderedSourcesPage).toContain('Legacy history sources');
    expect(renderedSourcesPage).toContain('separate from Textbutler’s planned live Messages transport');
    expect(modelText).toContain('## Current Textbutler development status');
    expect(modelText).toContain('## Legacy Message Like Me history tools');
    expect(sourcesPage).toContain('Beeper via Ghostget');
    expect(sourcesPage).toContain('It owns zero of Ghostget’s');
    expect(renderedSourcesPage).toContain(
      'Ghostget v0.17.1 uses beeper-local adapter v2.4.0',
    );
    expect(renderedSourcesPage).toContain(
      'Bring Beeper history into the same private evidence corpus.',
    );
    expect(renderedSourcesPage).toContain(
      '32 reviewed Beeper operations comprise 26 through one pinned Beeper CLI 0.6.2 executable, including supported actions and writes, plus 6 fixed Desktop loopback reads',
    );
    expect(renderedSourcesPage).toContain(
      'The pinned executable reports v0.6.2 and is runtime authority. At the upstream tag, packages/cli/package.json declares v0.6.1',
    );
    expect(renderedSourcesPage).toContain(
      'that source-package value is provenance only and never overrides the executable runtime identity',
    );
    expect(renderedSourcesPage).toContain(
      'Message Like Me receives no provider credential or live session, never calls Ghostget or a Beeper operation, and never sends',
    );
    expect(renderedSourcesPage).toContain(
      'It owns zero of Ghostget’s 32 reviewed Beeper operations and receives only the finished bundle',
    );
    expect(renderedSourcesPage).toContain(
      'Ghostget’s separate internal bounded export',
    );
    expect(renderedSourcesPage).toContain(
      'does not expose Beeper’s raw export arguments or establish complete-history coverage',
    );
    expect(renderedSourcesPage).toContain('Every ingest path is read-only with respect to its source');
    expect(renderedSourcesPage).toContain('Legacy reader support in v0.8.11');
    expect(renderedSourcesPage).toContain(
      'ghostget beeper export-message-like-me --auth &lt;id&gt; --output /absolute/private/path/beeper-bundle',
    );
    expect(renderedSourcesPage).toContain(
      'https://github.com/hraness/message-like-me/blob/v0.8.11/docs/local-message-bundle-v1.md',
    );
    expect(renderedSourcesPage).toContain(
      'ghostget whatsapp export-message-like-me --auth &lt;id&gt; --output /absolute/private/path/whatsapp-bundle',
    );
    expect(renderedSourcesPage).toContain(
      'https://github.com/hraness/message-like-me/blob/v0.8.11/docs/local-message-bundle-v2.md',
    );
    expect(chrome).toContain("{ href: '/sources', label: 'Legacy history tools' }");
    expect(sitemap).toContain("absoluteUrl('/sources')");
    expect(llms).toContain("absoluteUrl('/sources')");
    expect(readme).toContain('## Supported sources');
    const ghostgetPackageUrl =
      `https://github.com/hraness/ghostget/releases/download/v${BEEPER_COMPATIBILITY.producerVersion}/hraness-ghostget-${BEEPER_COMPATIBILITY.producerVersion}.tgz`;
    const beeperCliReleaseUrl =
      'https://github.com/beeper/cli/releases/tag/v' +
      BEEPER_COMPATIBILITY.providerCliVersion.replaceAll('.', '%2E');
    for (const copy of [readme, bundleContract]) {
      expect(copy).toContain(`](${ghostgetPackageUrl})`);
      expect(copy).toContain(
        `bun add --global ${ghostgetPackageUrl}`,
      );
    }
    expect(readme).toContain(`](${beeperCliReleaseUrl})`);
    expect(readme).toContain(
      '[built-in MCP server](https://developers.beeper.com/desktop-api/mcp/)',
    );
    expect(readme).not.toContain('github.com/beeper/desktop-api-mcp');
    const providerCliPattern = new RegExp(
      `Beeper CLI[^\\n]{0,80}${BEEPER_COMPATIBILITY.providerCliVersion.replaceAll('.', '\\.')}`,
      'u',
    );
    for (const copy of [readme, bundleContract]) {
      expect(copy).toContain(`Ghostget v${BEEPER_COMPATIBILITY.producerVersion}`);
      expect(copy).toMatch(providerCliPattern);
      expect(copy).toContain(`beeper-local@${BEEPER_COMPATIBILITY.adapterVersion}`);
      expect(copy).toContain(`${BEEPER_COMPATIBILITY.reviewedOperationCount} reviewed Beeper operations`);
      expect(copy).toMatch(/26 (?:run )?through one pinned Beeper CLI 0\.6\.2 executable/u);
      expect(copy).toMatch(/including supported actions\s+and writes/u);
      expect(copy).toMatch(/plus\s+six fixed Desktop loopback reads/u);
      expect(copy).toContain(BEEPER_COMPATIBILITY.providerCliSourcePackagePath);
      expect(copy).toContain(`declares \`${BEEPER_COMPATIBILITY.providerCliSourceDeclaredVersion}\``);
      expect(copy).toMatch(/provenance\s+only/u);
      expect(copy).toMatch(/executable\s+runtime identity/u);
      expect(copy).toMatch(/internal\s+bounded\s+export/u);
      expect(copy).toContain(`source ID \`${BEEPER_COMPATIBILITY.sourceId}\``);
      expect(copy).toContain(
        `source-transform version \`${BEEPER_COMPATIBILITY.sourceTransformVersion}\``,
      );
    }
    expect(readme).toContain(
      `bundle schema \`${BEEPER_COMPATIBILITY.bundleSchemaVersion}\``,
    );
    expect(bundleContract).toContain(
      `schema version \`${BEEPER_COMPATIBILITY.bundleSchemaVersion}\``,
    );
    for (const coordinate of [
      `Ghostget v${WHATSAPP_COMPATIBILITY.producerVersion}`,
      `Wacli v${WHATSAPP_COMPATIBILITY.providerCliVersion}`,
      `schema version \`${WHATSAPP_COMPATIBILITY.bundleSchemaVersion}\``,
      WHATSAPP_COMPATIBILITY.sourceId,
      WHATSAPP_COMPATIBILITY.sourceTransformVersion,
      `provider \`${WHATSAPP_COMPATIBILITY.providerId}@${WHATSAPP_COMPATIBILITY.providerCliVersion}\``,
    ]) {
      expect(whatsappContract).toContain(coordinate);
    }
    for (const copy of [
      readme,
      changelog,
      whatsappContract,
      llms,
      messagingSkill,
      privacyGuide,
    ]) {
      expect(copy).toContain(WHATSAPP_COMPATIBILITY.reactionWarning);
    }
    for (const copy of [readme, changelog, whatsappContract, llms, messagingSkill]) {
      expect(copy).toMatch(/unobservable|observability limit/u);
    }
    expect(changelog).toContain('## 0.8.5 (2026-09-06)');
    expect(changelog).toContain('## 0.8.3 (2026-09-06)');
    expect(changelog).not.toContain('## Unreleased');
    expect(changelog.indexOf('## 0.8.5')).toBeLessThan(changelog.indexOf('## 0.8.3'));
    const currentChangelog = changelog.slice(
      changelog.indexOf('## 0.8.3'),
      changelog.indexOf('## 0.8.2'),
    );
    expect(currentChangelog).toContain('`@hraness/wrench@0.16.7`');
    expect(currentChangelog).toContain('`beeper-local@2.4.0`');
    expect(currentChangelog).toContain('32 operations: 26 run through one');
    expect(currentChangelog).toContain('including supported actions and writes');
    expect(currentChangelog).toContain('plus six fixed');
    expect(currentChangelog).toMatch(/0\.6\.1\s+declaration is provenance only/u);
    expect(currentChangelog).toContain('executable 0.6.2 is runtime authority');
    expect(currentChangelog).not.toMatch(/Wrench v0\.16\.(?:1|5)/u);
    expect(changelog).toContain('## 0.8.1');
    expect(changelog).toContain('Wrench v0.16.5');
    expect(changelog).toContain('`beeper-local@2.3.0`');
    expect(changelog).toContain('32 reviewed operations comprise 27 through the pinned');
    expect(changelog).toContain('five fixed Desktop reads');
    expect(changelog).toContain('declaration of 0.6.1 is provenance only');
    expect(changelog).toContain('Message Like Me owns no Beeper operation');
    expect(privacyGuide).toContain('never turn that missing evidence into a');
    expect(renderedSourcesPage).toContain(WHATSAPP_COMPATIBILITY.reactionWarning);
    expect(renderedSourcesPage).toContain('not evidence of no reactions');
    for (const coordinate of [
      `Ghostget v${BEEPER_COMPATIBILITY.producerVersion}`,
      `executable reports v${BEEPER_COMPATIBILITY.providerCliVersion}`,
      `bundle schema ${BEEPER_COMPATIBILITY.bundleSchemaVersion}`,
      BEEPER_COMPATIBILITY.sourceId,
      BEEPER_COMPATIBILITY.sourceTransformVersion,
    ]) {
      expect(renderedSourcesPage).toContain(coordinate);
    }
    for (const exactModelClaim of [
      'Beeper via Ghostget lets users bring a finished private bundle into the same local evidence corpus as other sources.',
      'Ghostget v0.17.1 adapter beeper-local v2.4.0 owns 32 reviewed Beeper operations: 26 run through one pinned Beeper CLI 0.6.2 executable, including supported actions and writes, plus six fixed Desktop loopback reads.',
      'The executable’s reported 0.6.2 is runtime authority; the upstream tagged packages/cli/package.json declaration of 0.6.1 is provenance only.',
      'Message Like Me receives no provider credentials, never calls Ghostget or Beeper operations, and never sends; it does not claim complete history.',
      'Every ingest path is read-only with respect to its source.',
    ]) {
      expect(modelText).toContain(exactModelClaim);
    }
    expect(modelText).not.toMatch(/Ghostget v0\.16\.(?:1|5)/u);

    const jsonLdSource = /<script type="application\/ld\+json">([^<]+)<\/script>/u
      .exec(renderedRootLayout)?.[1];
    expect(jsonLdSource).toBeDefined();
    const jsonLd = JSON.parse(jsonLdSource ?? '{}') as {
      '@graph'?: Array<{ '@type'?: string; featureList?: unknown; softwareVersion?: unknown }>;
    };
    const softwareApplication = jsonLd['@graph']?.find(
      (entry) => entry['@type'] === 'SoftwareApplication',
    );
    expect(softwareApplication?.softwareVersion).toBeUndefined();
    expect(softwareApplication?.featureList).toEqual([
      'macOS menu-bar companion and local daemon controls',
      'Contact-specific guidance and editable memory',
      'Configurable visible assistant disclosure',
      'Smart and keyword-only response controls',
      'Global pause and active contact limits',
    ]);
    expect(renderedRootLayout).not.toContain('downloadUrl');
    expect(renderedRootLayout).toContain('In development; explicit messaging and agent setup required; CLI and menu companion');
    for (const supportedSource of SUPPORTED_SOURCES) {
      expect(readme).toContain(`| ${supportedSource.name} |`);
      expect(llms).toContain(supportedSource.name);
    }
  });

  test('keeps icons decorative and rejects overclaiming copy', async () => {
    const [icons, home, sourcesPage, about, readme, llms, layout] = await Promise.all([
      source('site/app/_components/source-icon.tsx'),
      source('site/app/page.tsx'),
      source('site/app/sources/page.tsx'),
      source('site/app/about/page.tsx'),
      source('README.md'),
      source('site/app/llms.txt/route.ts'),
      source('site/app/layout.tsx'),
    ]);
    expect(icons).toContain('aria-hidden="true"');
    expect(icons).toContain('<svg');
    expect(icons).toContain('focusable="false"');
    expect(icons).toContain('stroke="currentColor"');

    const catalogCopy = SUPPORTED_SOURCES.flatMap((entry) => [
      entry.name,
      entry.kind,
      entry.mode,
      entry.status,
      entry.summary,
      entry.boundary,
      entry.command,
    ]).join('\n');
    const publicCopy = [
      catalogCopy,
      home,
      sourcesPage,
      about,
      readme,
      llms,
      layout,
    ].join('\n').toLowerCase();
    for (const rejected of [
      'all connected accounts',
      'complete beeper history',
      'connect your beeper account',
      'message like me sends',
      'official beeper integration',
      'digital twin',
      'autonomous messaging',
      'local-only',
      'never leaves your device',
    ]) {
      expect(publicCopy).not.toContain(rejected);
    }
  });
});
