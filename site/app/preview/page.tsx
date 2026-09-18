import type { Metadata } from 'next';

export const metadata: Metadata = { title: { absolute: 'Textbutler — Preview' }, robots: { follow: false, index: false } };

export default function PreviewPage() {
  return <main id="main-content"><section className="hero" aria-labelledby="textbutler-preview-heading">
    <div className="hero-copy"><h1 id="textbutler-preview-heading">A little help in your conversations</h1><p className="lede">Textbutler is a macOS CLI and menu-bar message butler. A folder of context for each contact, guarded iMessage and WhatsApp connections, and replies people can recognize.</p><p className="lede">In development. Explicit messaging and agent setup required; no windowed app download; install the CLI and menu companion.</p></div>
    <div className="hero-visual" aria-label="Synthetic illustration of a disclosed butler reply"><div className="message-stage"><p className="stage-label">Synthetic example · no message sent</p><div className="bubble bubble-in">butler, can you help me make a packing list?</div><p className="stage-label stage-label--draft">Butler reply · illustration</p><div className="bubble bubble-out">{'🤖{ Happy to help. Where are you headed, and for how long? }'}</div><p className="butler-disclosure-note">A clearly identified assistant, with you in control.</p></div></div>
  </section></main>;
}
