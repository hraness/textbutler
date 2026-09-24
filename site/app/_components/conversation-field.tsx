/** Synthetic memory slips: decorative examples, never real message content. */
export function ConversationField() {
  return (
    <div className="conversation-field">
      <article className="conversation-slip" data-hraness-hero-item="">
        <span>ABOUT.md</span><strong>The person comes first</strong><p>Keep a little context close to the conversation.</p>
      </article>
      <article className="conversation-slip" data-hraness-hero-item="">
        <span>MEMORY.md</span><strong>A useful detail, remembered</strong><p>Plans, preferences and the thread that connects them.</p>
      </article>
      <article className="conversation-slip conversation-slip--message" data-hraness-hero-item="">
        <span>Example message</span><p>Let’s pick this up after the weekend.</p><i>One conversation at a time</i>
      </article>
      <article className="conversation-slip" data-hraness-hero-item="">
        <span>STYLE.md</span><strong>A familiar voice</strong><p>Thoughtful, brief, and clear about who is helping.</p>
      </article>
      <article className="conversation-slip conversation-slip--message" data-hraness-hero-item="">
        <span>Example draft</span><p>That sounds good. I’ll bring the notes.</p><i>Read it before you send</i>
      </article>
      <article className="conversation-slip" data-hraness-hero-item="">
        <span>AGENTS.md</span><strong>Your guidance</strong><p>Boundaries you can read, change and keep.</p>
      </article>
    </div>
  );
}
