import { join } from "node:path";
import { automationContextId, createGhostgetAutomationTransport, type AutomationEvent, type AutomationMessage, type GhostgetAutomationClient } from "../../transport/src/automation.ts";
import { assertAutomationBinding, type AutomationBinding } from "./automation-owner.ts";
import { messageAuthor, pendingCluster, type MessageAuthor } from "./attribution.ts";
import type { OwnerRuntimeState, TextbutlerControlService } from "./control-service.ts";
import { boundedHistory } from "./enrollment.ts";
import type { ContactSettings, Settings } from "./config.ts";
import { keywordPresent, type MessageEvent } from "./decision.ts";
import type { Hooks } from "./hooks.ts";
import { ButlerRuntime, type ButlerAgent, type ConversationSnapshot } from "./runtime.ts";
import { createRoutedButlerAgent } from "./routed-agent.ts";
import { ContactWorkspace } from "./workspace.ts";
import { createHabitatAgent } from "./habitat-agent.ts";
import { createHabitatEvolutionExecutor } from "./habitat-evolution.ts";
import type { HabitatHostConfig } from "./host-config.ts";
import type { FastDriver } from "./fast-driver.ts";

type LoopService = Pick<TextbutlerControlService, "dataDir" | "providers" | "runtimeState" | "runJournal" | "delegatedGrant" | "onSettingsChanged" | "notePending"> & { setReplyAgent?: (agent: ButlerAgent) => void };
type ContactLoop = { binding: AutomationBinding; settingsRevision: number; cursor: string | null; initialized: boolean; runtime: ButlerRuntime; pending?: MessageEvent; blocked?: string; running: boolean; lastOwnerAt: number | null; historyRevision: number | null };
export interface ReplyLoopOptions {
  service: LoopService;
  client: GhostgetAutomationClient;
  hooks: Hooks;
  /** Synthetic tests may supply a broker-compatible agent without credentials. */
  agent?: ButlerAgent;
  now?: () => number;
  automatic?: boolean;
  habitat?: { config: HabitatHostConfig; driver: FastDriver };
  onStatus?: (value: { state: "running" | "paused" | "unavailable"; detail: string }) => void;
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
  const workspace = (id: string) => ContactWorkspace.create(join(service.dataDir, "contacts", id));
  const active = (id: string, revision: number) => !closed && !settings.paused && settings.contacts.some(contact => contact.id === id && contact.enabled && contact.revision === revision && contact.pausedUntil <= now());
  const habitat = options.habitat?.config.enabled ? createHabitatAgent({ journal, driver: options.habitat.driver, getWorkspace: workspace, now,
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
      if (!active(id, state.settingsRevision)) { state.runtime.cancelContact(id); delete state.pending; state.initialized = false; }
    }
  };
  const unsubscribe = service.onSettingsChanged(next => { settingsEpoch++; changed(next); habitat?.settingsChanged(); });
  async function snapshot(contact: ContactSettings, state: ContactLoop): Promise<ConversationSnapshot> {
    const enrollment = await client.poll(state.binding.enrollmentId); assertAutomationBinding(state.binding, enrollment);
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
    service.notePending(contact.id, cluster === null ? null : { count: cluster.count, lastAt: cluster.latestAt, preview: cluster.preview, ready: page.enrollment.ready });
    return { contextId: automationContextId(page.enrollment), messageIds: page.messages.filter(message => message.kind === "message").map(message => message.id), state: { latestRevision: String(page.enrollment.revision), lastOwnerAt: state.lastOwnerAt, ownerTyping: "unknown", synchronizedAt: page.enrollment.ready ? now() : 0, repliesInLastHour: service.runJournal().repliesSince(contact.id, now() - 3600000) } };
  }
  function contactLoop(contact: ContactSettings, binding: AutomationBinding): ContactLoop {
    const previous = contacts.get(contact.id);
    if (previous && previous.binding.bindingDigest === binding.bindingDigest && previous.binding.enrollmentId === binding.enrollmentId && previous.settingsRevision === contact.revision) return previous;
    previous?.runtime.cancelContact(contact.id);
    const state = { binding, settingsRevision: contact.revision, cursor: null, initialized: false, running: false, lastOwnerAt: null, historyRevision: null } as unknown as ContactLoop;
    state.runtime = new ButlerRuntime({ settings: () => settings, refresh: current => snapshot(current, state), agent,
      transport: createGhostgetAutomationTransport({ client, enrollmentId: binding.enrollmentId, admitAsset: async path => (await workspace(contact.id)).admitAsset(path), now }),
      journal: service.runJournal(), hooks, delegatedGrant: current => service.delegatedGrant(current),
      ...(habitat === undefined ? {} : { onSubmitted: habitat.submitted }),
      validateFile: async (_contact, path) => { await (await workspace(contact.id)).admitAsset(path); }, clock: now });
    contacts.set(contact.id, state); return state;
  }
  function receive(contact: ContactSettings, state: ContactLoop, event: AutomationEvent): void {
    const who = author(event.message, contact);
    if (habitat && (who === "owner" || who === "contact") && (event.message.kind === "message" || event.message.kind === "reaction")) {
      try { habitat.observe(contact.id, { id: event.message.id, at: Date.parse(event.message.occurredAt), author: who, kind: event.message.kind,
        text: [...(event.message.text ?? "")].slice(0, 512).join(""), relatedMessageId: event.message.relatedMessageId }); } catch {}
    }
    if (who === "self" || who === "butler") {
      if (state.pending && Number(event.revision) > Number(state.pending.revision)) state.pending = { ...state.pending, revision: String(event.revision) };
      return;
    }
    const invoked = who === "owner" && event.message.kind === "message" && keywordPresent(event.message.text ?? "", contact.keyword);
    if (who === "owner" && !invoked) state.lastOwnerAt = Math.max(state.lastOwnerAt ?? 0, Date.parse(event.message.occurredAt));
    state.runtime.cancelContact(contact.id);
    if (event.message.kind !== "message" || (who !== "contact" && !invoked)) { delete state.pending; return; }
    // Oversized/invalid events are refused by policy instead of silently changing
    // the text the person asked the butler to interpret.
    state.pending = { id: event.message.id, contactId: contact.id, routeId: bindingRoute(state), revision: String(event.revision), occurredAt: Date.parse(event.message.occurredAt), observedAt: now(), author: invoked ? "owner" : "contact", kind: "message", text: event.message.text ?? "", historical: false, group: false };
  }
  const bindingRoute = (state: ContactLoop) => state.binding.enrollmentId;
  async function tickOnce(): Promise<void> {
    const epoch = settingsEpoch, observed = await service.runtimeState();
    if (settingsEpoch !== epoch) return;
    owner = observed; changed(owner.settings);
    if (closed) return;
    if (settings.paused) { options.onStatus?.({ state: "paused", detail: "Automatic replies are paused." }); return; }
    let unavailable = false;
    for (const contact of settings.contacts) {
      if (closed || !active(contact.id, contact.revision)) continue;
      const binding = owner.bindings[contact.id]; if (binding?.version !== 2) continue;
      const state = contactLoop(contact, binding);
      try {
        const current = await client.poll(binding.enrollmentId); assertAutomationBinding(binding, current);
        let caughtUp = false;
        // A finite drain leaves a busy stream deferred, never falsely current.
        for (let pageNumber = 0; pageNumber < 4 && !caughtUp; pageNumber++) {
          const page = await client.events({ enrollmentIds: [binding.enrollmentId], cursor: state.cursor, limit: 200 });
          if (state.initialized) for (const event of page.events) receive(contact, state, event);
          state.cursor = page.nextCursor; caughtUp = page.caughtUp;
        }
        if (!caughtUp || !current.ready) { state.runtime.cancelContact(contact.id); delete state.pending; unavailable = true; continue; }
        if (!state.initialized) { state.initialized = true; delete state.pending; await snapshot(contact, state); continue; }
        if (service.runJournal().hasUncertainSend(contact.id)) state.blocked = "A previous send needs reconciliation.";
        const event = state.pending;
        if (!event && !state.running && !state.blocked) habitat?.schedule(contact);
        if (!event || state.running || !active(contact.id, contact.revision) || now() < event.observedAt + contact.debounceMs) continue;
        state.running = true;
        const task = state.runtime.process(event).then(outcome => {
          if (outcome.status !== "deferred" && state.pending?.id === event.id) delete state.pending;
          if (outcome.status === "blocked" || outcome.status === "indeterminate" || outcome.status === "partial") { state.blocked = `Automatic reply needs attention: ${outcome.reason}.`; options.onStatus?.({ state: "unavailable", detail: state.blocked }); }
          else if (outcome.status === "submitted") delete state.blocked;
        }).catch(() => { state.runtime.cancelContact(contact.id); delete state.pending; state.blocked = "Automatic reply state could not be verified. Check activity before resuming."; options.onStatus?.({ state: "unavailable", detail: state.blocked }); })
          .finally(() => { state.running = false; work.delete(task); });
        work.add(task);
      } catch {
        state.runtime.cancelContact(contact.id); delete state.pending; state.initialized = false; unavailable = true;
      }
    }
    const blocked = [...contacts.entries()].find(([id, state]) => active(id, state.settingsRevision) && state.blocked)?.[1].blocked;
    options.onStatus?.({ state: unavailable || blocked ? "unavailable" : "running", detail: blocked ?? (unavailable ? "Messaging synchronization needs attention. Affected contacts are paused until their exact context is current." : "Monitoring enabled conversations. Provider account and contact grants are checked before each reply.") });
  }
  const tick = (): Promise<void> => {
    if (closed) return Promise.resolve();
    ticking ??= tickOnce().catch(() => { for (const state of contacts.values()) { state.runtime.pause(); state.initialized = false; delete state.pending; } options.onStatus?.({ state: "unavailable", detail: "Owner settings or messaging state could not be verified." }); }).finally(() => { ticking = undefined; });
    return ticking;
  };
  const schedule = () => { if (!closed) timer = setTimeout(() => { void tick().finally(schedule); }, 1000); };
  if (options.automatic !== false) schedule();
  return { tick, async idle() { await ticking; await Promise.allSettled([...work]); }, async close() {
    if (closed) return; closed = true; if (timer) clearTimeout(timer); unsubscribe();
    for (const state of contacts.values()) state.runtime.pause();
    await ticking; await Promise.allSettled([...work]); await habitat?.close();
  } };
}
