Textbutler can keep a separate reply plan for each conversation and let it change only when a blinded comparison shows the change made no case worse and helped on average. It runs that learning, which it calls a habitat, as a set of ALGAL programs. Your brother answers in four words and hates small talk; your oldest friend sends paragraphs and expects a joke back. One style for everyone gets at least one of them wrong, and an assistant free to rewrite its own rules could learn something you never wanted.

## Replies that fit each person

Textbutler answers as a disclosed assistant, not as you. Someone using it wants those replies to suit the person on the other end and to improve as the conversation goes on. They also need some things to stay fixed. Whatever the assistant learns about tone, it must never learn its way into writing to a different person, switching to a different AI provider, turning on a tool the owner left off, or dropping the marker that shows a reply came from the butler.

Textbutler separates the part that may change, the reply style, from the part that may not, and runs the changing part inside programs that record each run.

## What ALGAL does

[ALGAL](https://algal.computer) is a language and application VM for agent programs that run within set limits. An ALGAL program, which ALGAL calls an organism, is written as data: a list of steps, how they connect, and the limits each step must respect, such as how much context a model may read, how long a step may take, and how many model calls the whole run may make. The host application decides which tools exist and what is allowed, and the program cannot grant itself more.

Each run leaves a record of every step and its result, so someone can see later what happened without calling the model again. ALGAL's README states its larger bet, that a computer can keep tested ways of acting and get better at later work, and calls whether this beats equally resourced alternatives an open question.

## How Textbutler runs a habitat on ALGAL

Textbutler is {{SITE_STATUS_LABEL}} and runs from source. Habitats are an opt-in part of it and stay off unless the owner turns them on in Textbutler's host settings. Once they are on, each enrolled conversation gets its own habitat, stored in Textbutler's private journal on the Mac. Habitats share nothing, even two threads with the same person.

A habitat does its model work in three kinds of runs. Each is a small ALGAL program with a single model step and limits fixed in code:

- **Respond** decides whether a reply is wanted and, if so, proposes one for this conversation. It gets up to 32 KiB of context and 25 seconds. When the plan allows a tool such as meme or memory search, a reply can take up to three respond runs, with the host running the tool in between.
- **Reflect** looks at a reply that went out and what the contact said afterward, then proposes a revised plan. It gets up to 96 KiB of context and two minutes.
- **Judge** scores the current plan and the candidate plan side by side on the same past cases. It has the same limits as reflect.

Every run allows at most one model call and four steps. Reflect and judge use the Claude Code subscription you connect through xcb, with no tools at all: the model returns JSON and Textbutler checks it. Learning runs only when the owner has also named a model for it in the habitat settings. Those calls are not cached or retried, so a failed learning step keeps the current plan instead of running twice.

### A plan is data with a short list of fields

What learns is the contact's plan, which holds style and strategy and nothing else. A plan looks like this:

```json
{
  "version": 1,
  "guidance": "Short answers. Ask before making plans for both of us.",
  "personality": { "tone": "warm", "formality": "casual" },
  "humor": "light",
  "contextMessages": 12,
  "maxReplyCharacters": 400,
  "webSearch": false,
  "memeSearch": true,
  "javascript": false,
  "memorySearch": true
}
```

Tone is one of neutral, warm, playful or direct. Formality is casual, balanced or formal. Reply length and context size have fixed minimums and maximums. The schema is strict, so a plan with any other field is rejected before it is used.

The main guarantee comes from that strictness. The plan has no field for the recipient, the AI provider, permissions or disclosure, so no plan, learned or hand-written, can express a change to them. The program's instructions say the same in words, and the plan reaches the model labeled as untrusted strategy data, separate from the host's instructions.

The owner can also write a fixed core for a contact: the voice to use, relationship context, shared history and boundaries. The learning step must keep that core word for word and leave the owner's tool switches (web search, meme search, JavaScript and memory search) alone.

### When a new plan replaces the old one

After a reply goes out and the contact responds, the reflect run may propose a candidate plan. Textbutler then reruns the respond program with each plan on the two most recent past cases that drew a follow-up. It sets which answer appears first from a hash of the case, so the judge cannot rely on position, and asks the judge to score the anonymized pair. The candidate replaces the current plan only when all of these hold:

```text
the owner has not edited the habitat or its memory since the comparison started
the candidate differs from the current plan and is not one the owner rolled back
the candidate cites at least one real follow-up message from each case
the judge marks the candidate safe on every case
candidate score >= current score on every case
average(candidate - current) >= 0.1
tool switches and the owner's core text are unchanged
```

If any line fails, the current plan stays. Silence from the contact counts as unknown, and the instructions tell the reflect step not to optimize for dependency, message volume, provocation or guilt. When a candidate wins, the previous plan is kept as an ancestor so the owner can roll back to it. An evaluation that fails partway leaves the current plan in place and is not retried.

Every habitat run, from live replies to reflections, replays and judge runs, leaves an ALGAL record in Textbutler's private journal. Each evaluation stores the digests of the runs behind it, and Textbutler keeps the full records of the most recent 32 runs per contact, so you can trace a recent plan change back to the runs that produced it.

## What changes for a Textbutler user

Each conversation gets a reply plan that can move toward what works with that person, one checked step at a time, with a record of why recent changes happened. Learning starts only after a reply was sent, so a draft you threw away never becomes a lesson.

The owner controls the plan. `show` works at any time. The other three commands require automatic replies to be paused and take the habitat revision that `show` reports, so they fail if the habitat changed in the meantime:

```sh
textbutler habitats show <contact>                         # plan, memory, learning history and budget
textbutler habitats configure <contact> <revision> <json>  # set a starting plan
textbutler habitats rollback <contact> <revision>          # return to the previous plan
textbutler habitats memory-clear <contact> <revision>      # clear learned excerpts
```

A rollback steps back one saved plan at a time and cannot reach past the owner's last `configure`, so it never brings back a tool the owner switched off. Clearing memory empties the learned excerpts, and older run records stay in the journal.

A habitat never decides who receives a message and has no way to send one. The model returns proposed actions, such as a text or a reaction, and Textbutler checks them against what the conversation allows. Whether and how anything is sent stays with Textbutler's normal send path and your settings for that contact, which [Introducing Textbutler](/blog/introducing-textbutler) walks through.

## What the comparison does not measure

Replays generate text only and run no tools, so the rule does not measure whether a candidate would choose better searches or memes. Two past cases are a small sample, and the judge is itself a model reading untrusted text. No published measurement yet shows that habitats make replies better for real contacts over time.

Habitat runs send conversation context to a model. Replies default to a hosted Qwen model through Vercel AI Gateway, capped by a daily budget you set, or go to a local OpenAI-compatible model server if you choose one. Learning runs through the Claude Code subscription you connect with xcb.

Other products that run on ALGAL are listed on [Built on ALGAL](https://algal.computer/blog/built-on-algal/).
