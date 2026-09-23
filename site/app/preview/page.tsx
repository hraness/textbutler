import type { Metadata } from 'next';

export const metadata: Metadata = { title: { absolute: 'Textbutler — Preview' }, robots: { follow: false, index: false } };

export default function PreviewPage() {
  return <main id="main-content"><section className="hero" aria-labelledby="textbutler-preview-heading">
    <div className="hero-copy"><h1 id="textbutler-preview-heading">Your agent in your messaging apps</h1><p className="lede">Textbutler is a local Mac message butler: your coding agent reads selected iMessage, WhatsApp and Beeper conversations, keeps each contact’s context in editable files, and answers with visible disclosure when you let it.</p><p className="lede">Source pilot. Start with replies you write yourself. AI replies remain unavailable in the source CLI. A verified installed bundle adds them through xcb. The native menu uses a prebuilt runner. There is no windowed app download.</p></div>
    <div className="hero-visual" aria-label="Synthetic illustration of a disclosed butler reply"><div className="message-stage"><p className="stage-label">Synthetic example · no message sent</p><div className="bubble bubble-in">butler, can you help me make a packing list?</div><p className="stage-label stage-label--draft">Butler reply · illustration</p><div className="bubble bubble-out">{'🤖{ Happy to help. Where are you headed, and for how long? }'}</div><p className="butler-disclosure-note">A clearly identified assistant, with you in control.</p></div></div>
  </section></main>;
}
