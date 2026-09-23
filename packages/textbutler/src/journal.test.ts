import { expect, test } from "bun:test";
import type { AutomationGrant } from "../../transport/src/automation.ts";
import { RunJournal } from "./journal.ts";

const grant = (id: string, enrollmentId: string, bindingDigest: string): AutomationGrant =>
  ({ id, enrollmentId, expectedBindingDigest: bindingDigest, actions: ["text"], expiresAt: new Date(100_000_000).toISOString(), maximumActions: 10, minimumIntervalMs: 0, revoked: false, consumedActions: 0 });

test("uncertain runs reconcile once and release the contact", () => {
  const journal = RunJournal.memory();
  journal.claim("run-1", "contact-1", "event-1", 1000);
  journal.transition("run-1", "running", "dispatching", "intent-recorded", 1000);
  journal.recover(2000);
  expect(journal.hasUncertainSend("contact-1")).toBe(true);
  expect(journal.uncertainRuns("contact-1").map(run => run.id)).toEqual(["run-1"]);
  expect(journal.recent("contact-1")[0]?.state).toBe("indeterminate");
  journal.reconcile("run-1", "submitted", "reconciled: observed in history", 3000);
  expect(journal.hasUncertainSend("contact-1")).toBe(false);
  expect(journal.uncertainRuns("contact-1")).toHaveLength(0);
  expect(journal.recent("contact-1")[0]).toMatchObject({ state: "submitted", reason: "reconciled: observed in history" });
  // Reconciliation is single-shot: a settled run cannot be moved again.
  expect(() => journal.reconcile("run-1", "failed", "second attempt", 4000)).toThrow("Run state changed");
  journal.close();
});

test("retention prunes old settled runs but never uncertain ones", () => {
  const journal = RunJournal.memory();
  journal.claim("old-settled", "contact-1", "event-1", 1000);
  journal.transition("old-settled", "running", "submitted", "done", 1000);
  journal.claim("old-uncertain", "contact-2", "event-2", 1000);
  journal.transition("old-uncertain", "running", "dispatching", "intent-recorded", 1000);
  journal.recover(2000);
  // The next claim carries the retention sweep (90 days of settled runs kept).
  const later = 2000 + 90 * 86_400_000 + 1000;
  expect(journal.claim("new-run", "contact-3", "event-3", later)).toBe(true);
  expect(journal.recent("contact-1")).toHaveLength(0);
  expect(journal.recent("contact-2")[0]?.state).toBe("indeterminate");
  expect(journal.hasUncertainSend("contact-2")).toBe(true);
  journal.close();
});

test("contact-scoped grant queries never cross contacts", () => {
  const journal = RunJournal.memory();
  const digest = "a".repeat(64);
  journal.recordGrantIntent({ id: "intent-1", contactId: "contact-1", enrollmentId: "enr-1", bindingDigest: digest });
  journal.recordGrantIntent({ id: "intent-2", contactId: "contact-2", enrollmentId: "enr-2", bindingDigest: digest });
  expect(journal.grantIntents("contact-1").map(row => row.id)).toEqual(["intent-1"]);
  expect(journal.grantIntents()).toHaveLength(2);
  journal.recordPendingGrant("contact-1", grant("grant-1", "enr-1", digest));
  journal.recordPendingGrant("contact-2", grant("grant-2", "enr-2", digest));
  expect(journal.pendingGrants("contact-1").map(row => row.grant.id)).toEqual(["grant-1"]);
  expect(journal.pendingGrants()).toHaveLength(2);
  journal.close();
});
