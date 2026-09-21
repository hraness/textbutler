import { HranessSiteFooter } from '@hraness/site-footer/react';
import { MarketingSiteFooter, MarketingSiteHeader } from '@hraness/design-kit/react/server';
import { AskAiAboutThis } from '@hraness/ui';

import {
  absoluteUrl,
  type CanonicalPagePath,
  GITHUB_URL,
  ARCHITECTURE_URL,
} from '../_lib/site';

// The shared footer contract pins the canonical generated icon element exactly.
// eslint-disable-next-line @next/next/no-img-element
const productMark = <img alt="" height={20} src="/icon.png" width={20} />;

export function SiteHeader({ lantern = false }: Readonly<{ lantern?: boolean }>) {
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <MarketingSiteHeader
        action={{ href: '/#development', label: 'Development status' }}
        ariaLabel="Primary navigation"
        brand="Textbutler"
        brandLabel="Textbutler home"
        brandMark="/marks/message-like-me.svg"
        className={lantern ? "site-header hraness-material-chrome" : "site-header"}
        links={[
          { href: '/#how-it-works', label: 'How it works' },
          { href: '/docs', label: 'Docs' },
          { href: ARCHITECTURE_URL, label: 'Architecture' },
          { href: GITHUB_URL, label: 'GitHub' },
        ]}
      />
    </>
  );
}

export function SiteFooter({ path }: Readonly<{ path?: CanonicalPagePath }>) {
  return (
    <>
      {path === undefined ? null : (
        <AskAiAboutThis
          className="message-like-me-ask-ai"
          url={absoluteUrl(path)}
        />
      )}
      <MarketingSiteFooter
        ariaLabel="Textbutler"
        brand={productMark}
        brandHref="/"
        brandLabel="Textbutler home"
        links={[
          { href: '/about', label: 'About' },
          { href: '/sources', label: 'Legacy history tools' },
          { href: '/docs', label: 'Docs' },
          { href: GITHUB_URL, label: 'GitHub' },
        ]}
        name="Textbutler"
      >
        <p>Built for Mac · MIT source · in development</p>
      </MarketingSiteFooter>
      <HranessSiteFooter mailingList={{ kind: "none" }} support={{"id": "message-like-me", "name": "Textbutler", "valueProposition": "Support ongoing development of local tools for your messaging workflows.", "updates": false}} />
    </>
  );
}
