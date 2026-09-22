import { createCapabilityBroker, createCapabilityProfile } from "@hraness/agentmixer";
import type { Executor, JsonValue } from "@hraness/algal";
import type { ContactSettings } from "./config.ts";
import type { ProviderHost } from "./provider-host.ts";
import { contactCapabilityIdentity } from "./contact-capabilities.ts";
import { selectButlerModel } from "./routed-agent.ts";
import { parseXcbJson } from "./xcb-client.ts";

export async function createHabitatEvolutionExecutor(options: { contact: ContactSettings; providers: ProviderHost; model: string; runId: string; now?: () => number }): Promise<Executor> {
  const contact = { ...options.contact, classifierModel: options.model }, now = options.now ?? Date.now;
  const selection = await options.providers.selection(contact, "classify");
  if (selection.kind !== "managed") throw Error("Habitat evolution requires an admitted subscription route");
  const model = selectButlerModel(selection, contact, "classify", now(), true);
  let used = false;
  return { id: "textbutler-native-evolution", capabilities: { effects: ["agent"] }, cacheable: false, retryable: false,
    async execute(request, external) {
      if (used || request.kind !== "agent") throw Error("Evolution operation cannot be replayed"); used = true;
      const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(external ? [external] : [])]); signal.throwIfAborted();
      const profile = createCapabilityProfile({ id: "textbutler.classify", version: 1, tools: [] }), expected = contactCapabilityIdentity("classify");
      if (profile.digest !== expected.digest) throw Error("Evolution tool-free profile mismatch");
      const broker = createCapabilityBroker({ profile, workspaceId: contact.id, runId: options.runId, signal, isActive: () => !signal.aborted });
      try {
        const result = await options.providers.runManagedTask({ route: selection.route, accountId: contact.accountId, workspaceId: contact.id, runId: options.runId,
          profile: expected, model: { id: model, reasoningEffort: null, serviceTier: null }, purpose: "classify", signal,
          limits: { maxRunMs: 120_000, maxCleanupMs: 15_000, maxOutputBytes: 16_384 },
          prompt: `${request.prompt}\nReturn one JSON object matching this output requirement. You have no tools.\n${JSON.stringify({ context: request.context, output: request.output })}` }, broker);
        signal.throwIfAborted();
        if (result.outcome.status !== "completed" || result.custody !== "released" || result.brokerJoined !== true || typeof result.output !== "string") throw Error("Evolution did not settle");
        return parseXcbJson(result.output) as JsonValue;
      } finally { await broker.close(); }
    },
  };
}
