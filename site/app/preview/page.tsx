import type { Metadata } from 'next';

import { SITE_STATUS } from '../_lib/site';

export const metadata: Metadata = { title: { absolute: 'Textbutler | Preview' }, robots: { follow: false, index: false } };

export default function PreviewPage() {
  return <main id="main-content"><section className="hero" aria-labelledby="textbutler-preview-heading">
    <div className="hero-copy"><h1 id="textbutler-preview-heading">Your agent in your messaging apps</h1><p className="lede">Textbutler is a message butler for your Mac. Your coding agent reads the iMessage, WhatsApp, and Beeper conversations you choose, keeps each contact’s context in files you can edit, and answers when you let it, with its replies marked. Its optional menu bar companion uses a prebuilt runner.</p><p className="lede">{SITE_STATUS}</p></div>
    <div className="hero-visual" aria-label="Synthetic illustration of a disclosed butler reply"><div className="message-stage"><p className="stage-label">Synthetic example · no message sent</p><div className="bubble bubble-in">butler, can you help me make a packing list?</div><p className="stage-label stage-label--draft">Butler reply · illustration</p><div className="bubble bubble-out">{'🤖{ Where are you headed, and for how long? }'}</div><p className="butler-disclosure-note">The 🤖{'{ }'} wrapper marks the butler’s words.</p></div></div>
  </section></main>;
}
