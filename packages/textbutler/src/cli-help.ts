import { TEXTBUTLER_VERSION } from "./version.ts";

/** Registry one-line description (portfolio registry, packages/textbutler/package.json). */
export const TEXTBUTLER_DESCRIPTION = "Textbutler is an AI butler for the iMessage, WhatsApp, and Beeper chats\nyou choose.";

/** Bare invocation without a terminal: at most 25 lines (SPEC § D2). */
export const BARE_INTRO = `${TEXTBUTLER_DESCRIPTION}
It runs on your Mac and answers as a clearly marked assistant.

Start here
  textbutler setup           Create private settings, paused
  textbutler tui             Connect apps and choose chats, step by step
  textbutler doctor          See what's ready and what to do next

Everyday
  textbutler status          See what Textbutler is doing
  textbutler inbox           Find chats waiting for your reply
  textbutler pause           Pause automatic replies

All commands: textbutler --help · Topics: textbutler help <topic>
textbutler ${TEXTBUTLER_VERSION}`;

/** Root help: at most 60 lines, grouped; advanced verbs live in help advanced. */
export const ROOT_HELP = `${TEXTBUTLER_DESCRIPTION}

Usage: textbutler <command> [options]

Start here
  setup                      Create private settings; replies start paused
  tui                        Guided terminal: connect apps, choose chats
  doctor                     Check what's ready and what to do next

Everyday
  status                     Show what the background service is doing
  pause | resume             Pause or resume automatic replies
  inbox                      Find chats waiting for your reply
  replies <command>          Suggest, review and send replies

Chats and contacts
  conversations list         List recent one-to-one chats you can add
  contacts <command>         Add chats and choose how Textbutler answers
  messaging list | start     Show or connect iMessage, WhatsApp or Beeper

AI accounts
  providers list             Show connected AI accounts
  providers check <account>  Check that one account is ready

Background service
  daemon install | status    Start at login, or see whether it's running
  menubar [start | install]  Show Textbutler in the menu bar

Options
  -h, --help                 Show help (also: textbutler help <topic>)
  -V, --version              Show the version
  --json                     Print machine-readable output
  --data-dir <path>          Use another private data folder (absolute path)

Topics: setup, contacts, replies, messaging, providers, daemon, menubar,
advanced. Most commands print JSON so agents can read them.

Optional support: textbutler support · Turn off: HRANESS_SUPPORT=off`;

interface Topic { usage: string; summary: string; body?: string; example?: string }

/** Per-command help. Every entry fits in 80 columns and glosses its terms. */
const TOPICS: Record<string, Topic> = {
  setup: { usage: "textbutler setup [options]",
    summary: "Create your private settings, or add a messaging app or AI account.\nAutomatic replies start paused. Setup never reads or sends messages.",
    body: `Options
  --ghostget <path>          Ghostget executable that connects your apps
  --runtime <path>           Bun, when Ghostget is a .ts file
  --state-home <path>        Ghostget's private state folder
  --account <app>:<id>       Account to use, e.g. imessage:messages (repeat)
  --xcb <path>               xcb executable for your AI subscription
  --xcb-state <path>         xcb's private state folder
  --xcb-account <ai>:<id>    Signed-in xcb account: claude, codex or devin
  --xcb-model <ai>/<model>[/<effort>]
                             Model for that account

Use absolute paths. Sign in with Ghostget and xcb first; Textbutler stores
only references and pins the xcb file's checksum. Stop the service before
adding a connection, then start it again.`,
    example: "textbutler setup --ghostget /Users/me/bin/ghostget --account imessage:messages" },
  tui: { usage: "textbutler tui", summary: "Open the guided terminal. It walks through setup, connecting apps,\nadding chats and reviewing replies. Quitting leaves the service running." },
  doctor: { usage: "textbutler doctor [--json]", summary: "Check each setup step and show the one thing to do next.\nDoctor only reads local settings; it never reads messages or spends credits.",
    body: `Options
  --json                     Print the full readiness report as JSON` },
  status: { usage: "textbutler status", summary: "Print the background service's current state as JSON." },
  pause: { usage: "textbutler pause", summary: "Pause automatic replies for every chat. Replies you send yourself still work." },
  resume: { usage: "textbutler resume", summary: "Resume automatic replies. Chats that are off stay off." },
  inbox: { usage: "textbutler inbox", summary: "Check the chats you added and list the ones waiting for your reply." },
  replies: { usage: "textbutler replies <command>", summary: "Suggest, review and send replies. Nothing is sent until you run send.",
    body: `Commands
  replies suggest <contact>          Write a suggestion without sending it
  replies show <draft>               Show every action in a suggestion
  replies send <draft> <check>       Send exactly what you reviewed; <check>
                                     is the digest that replies show prints
  replies send <contact> <text...>   Send your own reply
  replies discard <draft>            Throw a suggestion away
  replies reconcile <contact> [--sent | --failed]
                                     Record whether an uncertain send arrived

A contact is an exact ID or a unique name from textbutler contacts list.`,
    example: "textbutler replies suggest Alex" },
  contacts: { usage: "textbutler contacts <command>", summary: "Choose which chats Textbutler answers and how. New chats start off.",
    body: `Commands
  contacts list                          Show chats and their settings
  contacts add <candidate> [--history]   Add a chat from conversations list;
                                         --history imports recent messages
  contacts enable <contact>              Turn on automatic replies
  contacts disable <contact>             Turn them off and remove send access
  contacts account <contact> <account>   Choose the AI account for a chat
  contacts mode <contact> smart|keyword [--keyword <word>]
                                         Answer everything, or only when a
                                         message includes the keyword
  contacts self <contact> on|off         Mark a chat with yourself, so your
                                         own echoed texts aren't answered

Choosing an account never turns a chat on, and resume never does either.`,
    example: "textbutler contacts mode Alex keyword --keyword butler" },
  conversations: { usage: "textbutler conversations list", summary: "List recent one-to-one chats from your connected apps. Add one with\ntextbutler contacts add <candidate>. The list expires after five minutes." },
  messaging: { usage: "textbutler messaging list | start <app>", summary: "Show configured messaging apps, or connect one: imessage, whatsapp\nor beeper. Sign-in and permissions for each app happen in Ghostget.",
    example: "textbutler messaging start imessage" },
  providers: { usage: "textbutler providers list | check <account>", summary: "Show your AI accounts, or check that one is signed in and ready.\nSubscription accounts are native-claude-code, native-codex and native-devin.",
    example: "textbutler providers check native-codex" },
  daemon: { usage: "textbutler daemon install | uninstall | status | run", summary: "Manage the background service that watches your chats.",
    body: `Commands
  daemon install             Start it now and at login
  daemon uninstall           Stop it and remove it from login
  daemon status              Show whether it's running
  daemon run                 Run it in this terminal instead

macOS shows a "Background Items Added" notice when you install it.` },
  menubar: { usage: "textbutler menubar [start | stop | status | install | uninstall]", summary: "Show Textbutler in the menu bar. Quitting the menu doesn't stop replies.",
    body: `Commands
  menubar start              Open the menu now
  menubar install            Open it at login too
  menubar stop | uninstall   Close it, or remove it from login
  menubar status | doctor    Check the menu helper` },
  support: { usage: "textbutler support", summary: "See optional ways to support Textbutler. Turn off: HRANESS_SUPPORT=off." },
  init: { usage: "textbutler init", summary: "Create private settings, paused, without the readiness checklist." },
  jobs: { usage: "textbutler jobs show <job>", summary: "Read the result of a long operation that was still running. Don't repeat\nthe original command: it may already have happened." },
  habitats: { usage: "textbutler habitats <command>", summary: "A habitat is a chat's reply style, memory and daily budget.",
    body: `Commands
  habitats show <contact>                     Show it as JSON
  habitats configure <contact> <rev> <json>   Replace it (replies paused)
  habitats rollback <contact> <rev>           Go back to revision <rev>
  habitats memory-clear <contact> <rev>       Forget learned excerpts

<rev> is the revision that habitats show prints.` },
  messages: { usage: "textbutler messages <command>", summary: "JSON commands for agents that read and draft in one chat.",
    body: `Commands
  messages history <contact> [--limit 1..200]
  messages summarize <contact> [--limit 1..200]
  messages capabilities <contact>
  messages compose <contact> --text <text>
  messages compose <contact> --actions <absolute path to actions.json>
  messages react <contact> <message> <emoji> [--remove]
  messages attach <contact> <absolute path> [--caption <text>]
  messages send <contact> --text <text>

Compose, react and attach create drafts; send one with replies send.
See docs/textbutler/agent-cli.md.` },
  advanced: { usage: "textbutler <command>", summary: "Commands for agents and for fixing unusual states.",
    body: `Commands
  init                       Create private settings without the checklist
  jobs show <job>            Read the result of a long operation
  habitats <command>         A chat's reply style, memory and budget
  messages <command>         JSON commands for agents (help messages)
  daemon run                 Run the service in this terminal
  support                    Optional ways to support Textbutler` },
};
TOPICS.suggest = TOPICS.replies!;
TOPICS.version = { usage: "textbutler --version", summary: "Show the version." };
TOPICS.help = { usage: "textbutler help [<topic>]", summary: "Show help for a command or topic." };

export const HELP_TOPICS: readonly string[] = Object.keys(TOPICS);

export function topicHelp(name: string): string | undefined {
  const topic = Object.hasOwn(TOPICS, name) ? TOPICS[name] : undefined;
  if (!topic) return undefined;
  return [`Usage: ${topic.usage}`, "", topic.summary, ...(topic.body ? ["", topic.body] : []), ...(topic.example ? ["", "Example", `  ${topic.example}`] : [])].join("\n");
}

/** The known command words, for "did you mean" and help routing. */
export const COMMANDS: readonly string[] = ["setup", "tui", "doctor", "status", "pause", "resume", "inbox", "replies", "contacts", "conversations",
  "messaging", "providers", "daemon", "menubar", "support", "init", "jobs", "habitats", "messages", "help", "version"];
