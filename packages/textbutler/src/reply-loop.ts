import { join } from "node:path";
import { automationContextId, createGhostgetAutomationTransport, type AutomationEnrollment, type AutomationEvent, type AutomationMessage, type GhostgetAutomationClient } from "../../transport/src/automation.ts";
import { assertAutomationBinding, type AutomationBinding } from "./automation-owner.ts";
import { messageAuthor, pendingCluster, type MessageAuthor } from "./attribution.ts";
import type { OwnerRuntimeState, TextbutlerControlService } from "./control-service.ts";
import { boundedHistory } from "./enrollment.ts";
import type { RunJournal } from "./journal.ts";
import type { ContactSettings, Settings } from "./config.ts";
import { keywordPresent, type MessageEvent } from "./decision.ts";
import type { Hooks } from "./hooks.ts";
import { ButlerRuntime, type ButlerAgent, type ConversationSnapshot } from "./runtime.ts";
import { createRoutedButlerAgent } from "./routed-agent.ts";
import { ContactWorkspace } from "./workspace.ts";
import { createHabitatAgent } from "./habitat-agent.ts";
import { createHabitatEvolutionExecutor } from "./habitat-evolution.ts";
import { boundHabitatObservation } from "./contact-habitat.ts";
import type { HabitatHostConfig } from "./host-config.ts";
import type { FastDriver } from "./fast-driver.ts";
import { createRepoShelf, type RepoShelf } from "./contact-repos.ts";
import { parseRepoUrl } from "./config.ts";
import type { JsonValue } from "@hraness/algal";

type LoopService = Pick<TextbutlerControlService, "dataDir" | "providers" | "runtimeState" | "runJournal" | "delegatedGrant" | "onSettingsChanged" | "onHabitatChanged" | "notePending" | "allowContactRepo" | "notifySelfChat"> & { setReplyAgent?: (agent: ButlerAgent) => void };
type ContactLoop = { binding: AutomationBinding; settingsRevision: number; initialized: boolean; runtime: ButlerRuntime; pending?: MessageEvent; pendingFirstAt: number | null; blocked?: string; running: boolean; runningPinned: boolean; lastOwnerAt: number | null; lastEnrollment: AutomationEnrollment | null; historyRevision: number | null; syncFailures: number; runFailures: number };
const RECONCILE_DETAIL = "A previous send needs reconciliation. Check Messages, then run `textbutler replies reconcile`.";
const SYNC_FAILURE_THRESHOLD = 3;
export interface ReplyLoopOptions {
  service: LoopService;
  client: GhostgetAutomationClient;
  hooks: Hooks;
  /** Synthetic tests may supply a broker-compatible agent without credentials. */
  agent?: ButlerAgent;
  now?: () => number;
  automatic?: boolean;
  habitat?: { config: HabitatHostConfig; driver: FastDriver };
  /** Synthetic tests inject a repo shelf so approval never spawns real git. */
  repos?: RepoShelf;
  onStatus?: (value: { state: "running" | "paused" | "unavailable"; detail: string }) => void;
}

/** Self-chat owner intents resolve repo requests without the driver: the model
 * never sees or rewrites an approval decision. An intent that does not match
 * returns null and the ordinary agent path answers instead. */
export function createRepoOwnerIntents(ports: { journal: RunJournal; contacts(): readonly ContactSettings[];
  allow(contactId: string, url: string): Promise<"added" | "full" | "skipped">; sync(contactId: string, url: string): void; now(): number }) {
  const show = (rows: ReturnType<RunJournal["repoRequests"]>, label: (id: string) => string) => rows.slice(0, 16).map(row => `- ${row.url} (${label(row.contactId)})`).join("\n")
    + (rows.length > 16 ? `\n… and ${rows.length - 16} more` : "");
  return async (contact: ContactSettings, text: string): Promise<string | null> => {
    const intent = new RegExp(`^\\s*${contact.keyword.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s+(allow|deny|approvals?|pending)\\b`, "iu").exec(text);
    if (intent === null) return null;
    const verb = intent[1]!.toLocaleLowerCase("en-US"), arg = text.slice(intent.index + intent[0].length).trim().split(/\s+/u)[0] ?? "";
    const pending = ports.journal.repoRequests("pending"), label = (id: string) => ports.contacts().find(value => value.id === id)?.label ?? id;
    if (verb === "approvals" || verb === "approval" || verb === "pending") {
      if (!pending.length) return "No pending repository approvals.";
      return `Pending repository approvals:\n${show(pending, label)}`;
    }
    if (!pending.length) return "No pending repository approvals.";
    if (arg === "" && pending.length > 1) return `${pending.length} requests pending; reply with more of the URL or the contact name:\n${show(pending, label)}`;
    const matches = pending.filter(row => arg === "" || row.url.includes(arg) || label(row.contactId).toLocaleLowerCase("en-US").includes(arg.toLocaleLowerCase("en-US")));
    if (!matches.length) return `No pending repository request matches "${arg || "that"}". Reply "${contact.keyword} approvals" for the list.`;
    if (matches.length > 1) return `${matches.length} requests match; reply with more of the URL or the contact name:\n${show(matches, label)}`;
    const row = matches[0]!;
    if (verb === "deny") { ports.journal.resolveRepoRequest(row.id, "denied", ports.now()); return `Denied ${row.url} for ${label(row.contactId)}.`; }
    const outcome = await ports.allow(row.contactId, row.url);
    if (outcome === "full") return `The repo allowlist for ${label(row.contactId)} is full — remove one first, then allow ${row.url} again.`;
    if (!ports.journal.resolveRepoRequest(row.id, "approved", ports.now())) return "That request was already decided.";
    ports.sync(row.contactId, row.url);
    return outcome === "skipped" ? `${row.url} was already allowed for ${label(row.contactId)}; refreshing it now.` : `Approved ${row.url} for ${label(row.contactId)}; syncing it now.`;
  };
}

/** Polling schedules only current inbound messages. Initialization, downtime and
 * enablement each establish a silent event boundary before new replies begin. */
export async function createDaemonReplyLoop(options: ReplyLoopOptions) {
  const { service, client, hooks } = options, now = options.now ?? Date.now;
  const journal = service.runJournal();
  const author = (message: AutomationMessage, contact: ContactSettings): MessageAuthor => messageAuthor(message, contact, journal);
  const effective = (value: Settings): Settings => options.habitat?.config.enabled ? { ...value, contacts: value.contacts.map(contact => ({ ...contact, debounceMs: Math.min(contact.debounceMs, options.habitat!.config.debounceMs) })) } : value;
  let owner: OwnerRuntimeState = await service.runtimeState(), settings: Settings = effective(owner.settings);
  let closed = false, settingsEpoch = 0, timer: ReturnType<typeof setTimeout> | undefined, ticking: Promise<void> | undefined;
  const contacts = new Map<string, ContactLoop>(), work = new Set<Promise<unknown>>();
  const workspaces = new Map<string, Promise<ContactWorkspace>>();
  const workspace = (id: string) => {
    let cached = workspaces.get(id);
    if (!cached) { cached = ContactWorkspace.create(join(service.dataDir, "contacts", id)); cached.catch(() => workspaces.delete(id)); workspaces.set(id, cached); }
    return cached;
  };
  let setCursor: string | null = null, lastSetKey = "";
  const active = (id: string, revision: number) => !closed && !settings.paused && settings.contacts.some(contact => contact.id === id && contact.enabled && contact.revision === revision && contact.pausedUntil <= now());
  const shelf = options.repos ?? createRepoShelf({ dataDir: service.dataDir, now });
  /** Repo requests the agent could not resolve locally ask the owner through
   * the self conversation; a repeated pending request never re-notifies. */
  const requestRepo = async (contact: ContactSettings, url: string, signal: AbortSignal): Promise<JsonValue> => {
    signal.throwIfAborted();
    const normalized = parseRepoUrl(url);
    if (normalized === null) throw Error("Invalid repository URL");
    if (contact.repos.includes(normalized)) return await shelf.sync(contact.id, normalized);
    const state = journal.requestRepoApproval(contact.id, normalized, now());
    // The live allowlist outranks journal history: a past approval whose URL
    // was removed from the contact's settings is decided, not approved.
    if (state === "approved") return { denied: true, url: normalized, note: "The owner approved this before but removed it; adding it back is their decision." };
    if (state === "denied") return { denied: true, url: normalized };
    if (state === "created") {
      const keyword = settings.contacts.find(value => value.selfChat)?.keyword ?? "butler";
      void service.notifySelfChat(`The butler in your chat with ${contact.label} wants to sync ${normalized}. Reply "${keyword} allow ${normalized}" or "${keyword} deny ${normalized}"; "${keyword} approvals" lists pending.`).catch(() => {});
    }
    return { pending: true, url: normalized, note: "The owner was asked in their self chat; this repo works after they allow it." };
  };
  // The live allowlist gates every shelf operation, not just sync: removing a
  // URL revokes read/search/list even though the checkout may linger on disk.
  const approvedEntry = async (contact: ContactSettings, repo: string) => {
    const entry = (await shelf.list(contact.id)).find(value => value.name === repo);
    if (entry === undefined || !contact.repos.includes(entry.url)) throw new Error("Repository is not owner-approved");
    return entry;
  };
  const resolveOwnerIntent = createRepoOwnerIntents({ journal, contacts: () => settings.contacts, allow: (contactId, url) => service.allowContactRepo(contactId, url), sync: (contactId, url) => void shelf.sync(contactId, url).catch(() => {}), now });
  const habitat = options.habitat?.config.enabled ? createHabitatAgent({ journal, driver: options.habitat.driver, getWorkspace: workspace, now,
    repos: {
      sync: (contact, url, signal) => requestRepo(contact, url, signal),
      read: async (contact, repo, path) => { await approvedEntry(contact, repo); return await shelf.read(contact.id, repo, path); },
      search: async (contact, repo, query) => { await approvedEntry(contact, repo); return await shelf.search(contact.id, repo, query); },
      list: async contact => (await shelf.list(contact.id)).filter(entry => contact.repos.includes(entry.url)) as JsonValue[],
    },
    resolveOwnerIntent,
    active: contact => active(contact.id, contact.revision),
    async capabilities(contact) {
      const binding = owner.bindings[contact.id]; if (binding?.version !== 2) throw Error("Habitat conversation is unavailable");
      const transport = createGhostgetAutomationTransport({ client, enrollmentId: binding.enrollmentId, admitAsset: async path => (await workspace(contact.id)).admitAsset(path), now });
      const result = await transport.capabilities(); if (!result.ok) throw Error("Habitat messaging capabilities are unavailable");
      return result.value.capabilities.filter(value => value.available).map(value => value.capability);
    },
    ...(options.habitat.config.evolutionModel === null || !service.providers ? {} : { evolution: (contact: ContactSettings, runId: string) =>
      createHabitatEvolutionExecutor({ contact: { ...contact, provider: "claude", accountId: "native-claude-code" }, providers: service.providers!, model: options.habitat!.config.evolutionModel!, runId, now }) }),
  }) : undefined;
  if (habitat) service.setReplyAgent?.(habitat.agent);
  const agent = options.agent ?? habitat?.agent ?? (service.providers ? createRoutedButlerAgent({ router: service.providers.router,
    selection: (contact, purpose) => service.providers!.selection(contact, purpose),
    runManagedTask: (request, broker) => service.providers!.runManagedTask(request, broker),
    getWorkspace: workspace, hooks, isActive: active, now }) : {
    async qualified() { return false; }, async classify() { throw new Error("Agent setup required"); }, async compose() { throw new Error("Agent setup required"); },
  });
  const changed = (next: Settings) => {
    settings = effective(next);
    habitat?.reconcile();
    for (const [id, state] of contacts) {
      if (!active(id, state.settingsRevision)) { state.runtime.cancelContact(id); delete state.pending; state.pendingFirstAt = null; state.initialized = false; state.lastEnrollment = null; state.syncFailures = 0; state.runFailures = 0; }
    }
  };
  const unsubscribe = service.onSettingsChanged(next => { settingsEpoch++; changed(next); habitat?.settingsChanged(); });
  const unsubscribeHabitat = service.onHabitatChanged(id => {
    contacts.get(id)?.runtime.cancelContact(id);
    habitat?.invalidateContact(id);
  });
  async function snapshot(contact: ContactSettings, state: ContactLoop, current?: AutomationEnrollment): Promise<ConversationSnapshot> {
    // The intake refresh reuses the set-poll's enrollment instead of spending a
    // second provider session; history still re-reads and re-asserts the live row.
    const enrollment = current ?? state.lastEnrollment ?? await client.poll(state.binding.enrollmentId); assertAutomationBinding(state.binding, enrollment);
    const page = await client.history(state.binding.enrollmentId, 200); assertAutomationBinding(state.binding, page.enrollment);
    for (const message of page.messages) if (author(message, contact) === "owner" && !(message.kind === "message" && message.text !== null && keywordPresent(message.text, contact.keyword))) state.lastOwnerAt = Math.max(state.lastOwnerAt ?? 0, Date.parse(message.occurredAt));
    if (state.historyRevision !== page.enrollment.revision) {
      const history = boundedHistory(page.messages.filter(message => message.kind === "message" && message.direction !== "unknown").flatMap(message => {
        const who = author(message, contact);
        return who === "self" ? [] : [{ id: message.id, text: message.text ?? "", at: Date.parse(message.occurredAt), author: who as "owner" | "contact" | "butler" }];
      }));
      await (await workspace(contact.id)).write("history/recent.json", JSON.stringify({ schemaVersion: 1, purpose: "context-only-never-trigger", messages: history }));
      state.historyRevision = page.enrollment.revision;
    }
    const cluster = pendingCluster(page.messages, contact, journal);
    service.notePending(contact.id, cluster === null ? null : { count: cluster.count, lastAt: cluster.latestAt, preview: cluster.preview, ready: page.enrollment.ready, observedAt: now() });
    return { contextId: automationContextId(page.enrollment), messageIds: page.messages.filter(message => message.kind === "message").map(message => message.id), state: { latestRevision: String(page.enrollment.revision), lastOwnerAt: state.lastOwnerAt, ownerTyping: "unknown", synchronizedAt: page.enrollment.ready ? now() : 0, repliesInLastHour: service.runJournal().repliesSince(contact.id, now() - 3600000) } };
  }
  /** Settles a wedged send only from positive provider evidence. A terminal
   * upstream row is a receipt; no reply row beside a settled ack row proves
   * the reply intent never dispatched (the runtime awaits the ack before
   * preparing the reply). Absence alone, unreachable transport, and
   * non-terminal rows all leave the run blocked. */
  async function reconcileFromEvidence(contact: ContactSettings, state: ContactLoop): Promise<void> {
    const journal = service.runJournal();
    const byIntent = (intentId: string) => Promise.resolve().then(() => client.runByIntent(intentId, AbortSignal.timeout(10_000))).catch(() => undefined);
    for (const run of journal.uncertainRuns(contact.id)) {
      const reply = await byIntent(run.id);
      if (reply !== undefined && reply !== null && reply.enrollmentId === state.binding.enrollmentId) {
        if (reply.state === "accepted") {
          journal.recordSentMessages(contact.id, run.id, reply.accepted.map(part => part.messageId), now());
          journal.reconcile(run.id, "submitted", "reconciled: provider recorded delivery", now());
          continue;
        }
        if (reply.state === "failed") { journal.reconcile(run.id, "failed", "reconciled: provider recorded the send failed", now()); continue; }
      }
      if (run.reason !== "ack-dispatch-unknown") continue;
      const ack = await byIntent(`${run.id}:ack`);
      if (ack === undefined || ack === null || ack.enrollmentId !== state.binding.enrollmentId) continue;
      if (ack.state === "accepted") {
        journal.recordSentMessages(contact.id, `${run.id}:ack`, ack.accepted.map(part => part.messageId), now());
        journal.reconcile(run.id, "failed", "reconciled: ack delivered; reply never dispatched", now());
      } else if (ack.state === "failed") journal.reconcile(run.id, "failed", "reconciled: provider recorded the send failed", now());
    }
  }
  function contactLoop(contact: ContactSettings, binding: AutomationBinding): ContactLoop {
    const previous = contacts.get(contact.id);
    if (previous && previous.binding.bindingDigest === binding.bindingDigest && previous.binding.enrollmentId === binding.enrollmentId && previous.settingsRevision === contact.revision) return previous;
    previous?.runtime.cancelContact(contact.id);
    const state = { binding, settingsRevision: contact.revision, initialized: false, running: false, runningPinned: false, lastOwnerAt: null, lastEnrollment: null, historyRevision: null, pendingFirstAt: null, syncFailures: 0, runFailures: 0 } as unknown as ContactLoop;
    state.runtime = new ButlerRuntime({ settings: () => settings, refresh: currentContact => snapshot(currentContact, state), agent,
      transport: createGhostgetAutomationTransport({ client, enrollmentId: binding.enrollmentId, admitAsset: async path => (await workspace(contact.id)).admitAsset(path), now }),
      journal: service.runJournal(), hooks, delegatedGrant: current => service.delegatedGrant(current),
      ...(habitat === undefined ? {} : { onSubmitted: habitat.submitted }),
      validateFile: async (_contact, path) => { await (await workspace(contact.id)).admitAsset(path); }, clock: now });
    contacts.set(contact.id, state); return state;
  }
  function receive(contact: ContactSettings, state: ContactLoop, event: AutomationEvent): void {
    const who = author(event.message, contact);
    if (habitat && (who === "owner" || who === "contact") && (event.message.kind === "message" || event.message.kind === "reaction")) {
      try { habitat.observe(contact.id, boundHabitatObservation({ id: event.message.id, at: Date.parse(event.message.occurredAt), author: who, kind: event.message.kind,
        text: event.message.text ?? "", relatedMessageId: event.message.relatedMessageId })); } catch {}
    }
    if (who === "self" || who === "butler") {
      if (state.pending && Number(event.revision) > Number(state.pending.revision)) state.pending = { ...state.pending, revision: String(event.revision) };
      return;
    }
    const invoked = who === "owner" && event.message.kind === "message" && keywordPresent(event.message.text ?? "", contact.keyword);
    if (who === "owner" && !invoked) state.lastOwnerAt = Math.max(state.lastOwnerAt ?? 0, Date.parse(event.message.occurredAt));
    // Reactions, edits, deletes and deliveries never answer a pending inbound or
    // revoke work in flight; only a fresh text supersedes it. The revision still
    // advances so the pre-dispatch check observes conversation movement.
    if (event.message.kind !== "message") {
      if (state.pending && Number(event.revision) > Number(state.pending.revision)) state.pending = { ...state.pending, revision: String(event.revision) };
      return;
    }
    // A pinned run already absorbed the stream cap: fresh contact texts queue
    // behind it instead of aborting it. Owner activity always cancels in-flight
    // work so the human can take the conversation back.
    if (who !== "contact" || !state.runningPinned) state.runtime.cancelContact(contact.id);
    if (who !== "contact" && !invoked) { delete state.pending; state.pendingFirstAt = null; return; }
    // Oversized/invalid events are refused by policy instead of silently changing
    // the text the person asked the butler to interpret.
    // A continuous inbound stream coalesces to one reply: observedAt is clamped
    // so debounce resolves within a bounded wait of the first message. A run
    // started from a clamped event is pinned so later messages cannot starve it.
    const firstAt = who === "contact" && state.pending?.author === "contact" && state.pendingFirstAt !== null ? state.pendingFirstAt : now();
    const capBound = firstAt + Math.max(contact.debounceMs * 2, 30_000) - contact.debounceMs;
    const observedAt = Math.min(now(), capBound), pinned = now() > capBound;
    state.pending = { id: event.message.id, contactId: contact.id, routeId: bindingRoute(state), revision: String(event.revision), occurredAt: Date.parse(event.message.occurredAt), observedAt, pinned, author: invoked ? "owner" : "contact", kind: "message", text: event.message.text ?? "", historical: false, group: false };
    state.pendingFirstAt = firstAt;
  }
  const bindingRoute = (state: ContactLoop) => state.binding.enrollmentId;
  async function tickOnce(): Promise<void> {
    const epoch = settingsEpoch, observed = await service.runtimeState();
    if (settingsEpoch !== epoch) return;
    owner = observed; changed(owner.settings);
    if (closed) return;
    if (settings.paused) { options.onStatus?.({ state: "paused", detail: "Automatic replies are paused." }); return; }
    const actives: { contact: ContactSettings; binding: AutomationBinding; state: ContactLoop }[] = [];
    for (const contact of settings.contacts) {
      if (closed || !active(contact.id, contact.revision)) continue;
      const binding = owner.bindings[contact.id]; if (binding?.version !== 2) continue;
      actives.push({ contact, binding, state: contactLoop(contact, binding) });
    }
    // One set-poll keeps per-contact liveness, readiness and binding evidence;
    // a single events drain then serves the whole set through a shared cursor.
    const ready = new Map<string, boolean>(), pollFailed = new Set<string>(), drain = new Map<string, { contact: ContactSettings; state: ContactLoop }>(), fresh = new Map<string, AutomationEnrollment>();
    // One set-poll covers every contact: the host shares a provider session
    // across enrollments and a lane already running reports its current row.
    // A failed call-level poll fails every contact exactly like the per-contact
    // failures it replaces.
    let results: Awaited<ReturnType<typeof client.pollSet>> | null = null;
    try { results = await client.pollSet(actives.map(item => item.binding.enrollmentId)); }
    catch { results = null; }
    for (const { contact, binding, state } of actives) {
      const result = results?.get(binding.enrollmentId);
      try {
        if (result === undefined || result.error !== null || result.enrollment === null) throw new Error(result?.error ?? "Poll result missing");
        assertAutomationBinding(binding, result.enrollment);
        ready.set(contact.id, result.enrollment.ready); drain.set(binding.enrollmentId, { contact, state }); fresh.set(contact.id, result.enrollment); state.lastEnrollment = result.enrollment;
      } catch { state.runtime.cancelContact(contact.id); state.initialized = false; state.lastEnrollment = null; pollFailed.add(contact.id); }
    }
    // The drain cursor belongs to the enrollment set, not one contact. A
    // membership change re-establishes the cursor; replayed events only re-
    // observe what receive() already deduplicated.
    const setKey = [...drain.keys()].sort().join("|");
    if (setKey !== lastSetKey) { setCursor = null; lastSetKey = setKey; }
    let caughtUp = drain.size === 0, drainFailed = false;
    if (drain.size) {
      try {
        // A finite drain leaves a busy stream deferred, never falsely current.
        for (let page = 0; page < 4 && !caughtUp; page++) {
          const result = await client.events({ enrollmentIds: [...drain.keys()], cursor: setCursor, limit: 200 });
          for (const event of result.events) { const target = drain.get(event.enrollmentId); if (target?.state.initialized) receive(target.contact, target.state, event); }
          setCursor = result.nextCursor; caughtUp = result.caughtUp;
        }
      } catch { drainFailed = true; for (const { contact, state } of drain.values()) { state.initialized = false; state.lastEnrollment = null; state.runtime.cancelContact(contact.id); } }
    }
    for (const { contact, state } of actives) {
      if (closed) break;
      // Pending messages survive a degraded tick: snapshot refresh supersedes a
      // stale event, so keeping it is both safe and what the sender expects.
      const healthy = !pollFailed.has(contact.id) && ready.get(contact.id) === true;
      if (healthy && caughtUp && !drainFailed) state.syncFailures = 0; else state.syncFailures++;
      if (!healthy) continue;
      if (!state.initialized) { state.initialized = true; await snapshot(contact, state, fresh.get(contact.id)); continue; }
      if (service.runJournal().hasUncertainSend(contact.id)) {
        await reconcileFromEvidence(contact, state);
        if (service.runJournal().hasUncertainSend(contact.id)) state.blocked = RECONCILE_DETAIL;
        else delete state.blocked;
      } else if (state.blocked === RECONCILE_DETAIL) delete state.blocked;
      const event = state.pending;
      if (!event && !state.running && !state.blocked) habitat?.schedule(contact);
      if (!event || state.running || !active(contact.id, contact.revision) || now() < event.observedAt + contact.debounceMs) continue;
      state.running = true; state.runningPinned = event.pinned === true;
      const task = state.runtime.process(event).then(outcome => {
        if (outcome.status !== "deferred" && state.pending?.id === event.id) { delete state.pending; state.pendingFirstAt = null; }
        // Messages queued behind a finished run form a new stream with its own
        // debounce window, so a flood earns at most one reply per window.
        else if (outcome.status !== "deferred" && state.pending && state.pendingFirstAt !== null) {
          const { pinned: _pinned, ...queued } = state.pending;
          state.pendingFirstAt = now(); state.pending = { ...queued, observedAt: now() };
        }
        if (outcome.status === "submitted" || outcome.status === "ignored" || outcome.status === "cancelled") { state.runFailures = 0; if (outcome.status === "submitted") delete state.blocked; }
        else if (outcome.status === "blocked" || outcome.status === "indeterminate" || outcome.status === "partial") {
          state.blocked = outcome.reason === "reconcile-previous-send" || outcome.status === "indeterminate" || outcome.status === "partial" ? RECONCILE_DETAIL
            : `Automatic reply needs attention: ${outcome.reason}.`;
          options.onStatus?.({ state: "unavailable", detail: state.blocked });
        } else if (outcome.status === "failed") {
          state.runFailures++;
          const detail = outcome.reason === "run-failed:driver-budget" ? "The daily AI budget is exhausted. Automatic replies resume when it resets."
            : outcome.reason === "run-failed:driver-unavailable" ? "The reply provider is unreachable. Automatic replies pause until it recovers."
            : outcome.reason === "run-failed:driver-output" ? "The reply provider returned unusable output. Automatic replies pause until it recovers."
            : outcome.reason === "run-failed:hook" ? "A reply extension timed out. Check installed extensions."
            : `Automatic reply failed: ${outcome.reason}.`;
          if (outcome.reason === "run-failed:driver-budget" || state.runFailures >= SYNC_FAILURE_THRESHOLD) { state.blocked = detail; options.onStatus?.({ state: "unavailable", detail }); }
        }
      }).catch(() => { state.runtime.cancelContact(contact.id); delete state.pending; state.pendingFirstAt = null; state.blocked = "Automatic reply state could not be verified. Check activity before resuming."; options.onStatus?.({ state: "unavailable", detail: state.blocked }); })
        .finally(() => { state.running = false; state.runningPinned = false; work.delete(task); });
      work.add(task);
    }
    const blocked = [...contacts.entries()].find(([id, state]) => active(id, state.settingsRevision) && state.blocked)?.[1].blocked;
    const failing = [...contacts.entries()].filter(([id, state]) => active(id, state.settingsRevision) && state.syncFailures >= SYNC_FAILURE_THRESHOLD)
      .map(([id]) => settings.contacts.find(contact => contact.id === id)?.label ?? id);
    options.onStatus?.({ state: blocked || failing.length ? "unavailable" : "running",
      detail: blocked ?? (failing.length ? `Messaging synchronization needs attention for ${failing.join(", ")}. Pending messages are kept; sync retries every second.`
        : "Monitoring enabled conversations. Provider account and contact grants are checked before each reply.") });
  }
  const tick = (): Promise<void> => {
    if (closed) return Promise.resolve();
    ticking ??= tickOnce().catch(() => { for (const state of contacts.values()) { state.initialized = false; state.lastEnrollment = null; } options.onStatus?.({ state: "unavailable", detail: "Owner settings or messaging state could not be verified." }); }).finally(() => { ticking = undefined; });
    return ticking;
  };
  const schedule = () => { if (!closed) timer = setTimeout(() => { void tick().finally(schedule); }, 1000); };
  if (options.automatic !== false) schedule();
  return { tick, async idle() { await ticking; await Promise.allSettled([...work]); }, async close() {
    if (closed) return; closed = true; if (timer) clearTimeout(timer); unsubscribe(); unsubscribeHabitat();
    await ticking;
    // In-flight dispatches settle while the transport is still alive; pause
    // only covers whatever the bounded grace cannot wait out.
    await Promise.race([Promise.allSettled([...work]), new Promise(resolve => setTimeout(resolve, 10_000))]);
    for (const state of contacts.values()) state.runtime.pause();
    await Promise.allSettled([...work]); await habitat?.close();
  } };
}
