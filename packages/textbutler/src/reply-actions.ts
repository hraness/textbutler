import { parseActionIntent, type ActionIntent } from "../../transport/src/index.ts";
import { disclose, disclosureMarkers, type Disclosure } from "./config.ts";

/** Resolve the outgoing batch before review or grant budgeting. Rich actions
 * need an attributed lead while the owner keeps disclosure enabled. */
export function discloseReplyActions(actions: readonly ActionIntent[], summary: string, disclosure: Disclosure): readonly ActionIntent[] {
  const disclosed: ActionIntent[] = actions.map(action => action.kind === "text" ? { ...action, text: disclose(action.text, disclosure) } : action);
  if (disclosureMarkers(disclosure) !== null && actions[0]?.kind !== "text") {
    disclosed.unshift({ kind: "text", text: disclose(summary, disclosure) });
  }
  if (disclosed.length < 1 || disclosed.length > 8) throw new Error("Disclosure must fit within the action limit");
  return Object.freeze(disclosed.map(action => Object.freeze(parseActionIntent(action))));
}
