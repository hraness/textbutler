import { BROKER_TOOL_NAMES, type ToolBroker } from "@hraness/agentmixer";
import { brokerDescriptors } from "@hraness/agentmixer";
import { createCapabilityBroker, createCapabilityProfile, type CapabilityBroker, type CapabilityContext, type CapabilityJson,
  type CapabilityProfileIdentity } from "@hraness/agentmixer";

export type ButlerPurpose = "classify" | "respond";
function profile(purpose: ButlerPurpose, execute: (name: string, input: CapabilityJson, context: CapabilityContext) => Promise<unknown>) {
  return createCapabilityProfile({ id: `textbutler.${purpose}`, version: 1,
    tools: brokerDescriptors(purpose === "classify" ? [] : BROKER_TOOL_NAMES).map(descriptor => ({ ...descriptor,
      // The generic broker bounds JSON and closes the outer record. The existing
      // ToolBroker parses paths, URLs, revisions and proposals before effects.
      parseInput: input => input,
      execute: (input, context) => execute(descriptor.name, input, context),
    })) });
}
const identities = Object.freeze(Object.fromEntries((["classify", "respond"] as const).map(purpose => {
  const value = profile(purpose, async () => { throw Error("CONTACT_PROFILE_HAS_NO_RUN"); });
  return [purpose, Object.freeze({ id: value.id, version: value.version, digest: value.digest })];
})) as Record<ButlerPurpose, CapabilityProfileIdentity>);
export const contactCapabilityIdentity = (purpose: ButlerPurpose): CapabilityProfileIdentity => identities[purpose];

/** Every managed tool call passes through the existing contact-bound handlers.
 * The model cannot supply a contact, recipient, account, callback or executable. */
export function createContactCapabilityBroker(options: { purpose: ButlerPurpose; broker: ToolBroker; signal: AbortSignal; isActive(): boolean }): CapabilityBroker {
  const { broker } = options, names = options.purpose === "classify" ? [] : BROKER_TOOL_NAMES;
  if (JSON.stringify(broker.tools) !== JSON.stringify(names)) throw Error("CONTACT_CAPABILITY_TOOL_MISMATCH");
  const capabilities = createCapabilityBroker({ profile: profile(options.purpose, async (name, input, context) => {
    context.assertActive();
    if (context.workspaceId !== broker.workspaceId || context.runId !== broker.runId) throw Error("CONTACT_CAPABILITY_BINDING_MISMATCH");
    const result = await broker.invoke(name, input); context.assertActive(); return result;
  }), workspaceId: broker.workspaceId, runId: broker.runId, signal: options.signal, isActive: options.isActive });
  const revoke = () => { capabilities.revoke(); broker.revoke(); };
  return Object.freeze({ ...capabilities, revoke, async close() { revoke(); await capabilities.close(); } });
}
