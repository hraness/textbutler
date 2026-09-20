import { contactCapabilityIdentity, type ButlerPurpose } from "./contact-capabilities.ts";
import type { CapabilityProfileIdentity } from "@hraness/agentmixer";

export interface XcbIntegrationAdmission {
  version: 1;
  evidenceDigest: string;
  sourceDigest: string;
  profiles: Readonly<Record<ButlerPurpose, CapabilityProfileIdentity>>;
}
// Only the verified distribution builder supplies this constant after checking
// the independently reviewed source/evidence receipt. Owner settings and XCB's
// own inference qualification cannot attest Textbutler's contact composition.
declare const __TEXTBUTLER_XCB_ADMISSION: XcbIntegrationAdmission | undefined;
export function bundledXcbIntegrationAdmission(): XcbIntegrationAdmission | undefined {
  return typeof __TEXTBUTLER_XCB_ADMISSION === "undefined" ? undefined : __TEXTBUTLER_XCB_ADMISSION;
}
export function validXcbIntegrationAdmission(value: XcbIntegrationAdmission | undefined): value is XcbIntegrationAdmission {
  return value !== undefined && value.version === 1 && /^[a-f0-9]{64}$/u.test(value.evidenceDigest)
    && /^[a-f0-9]{64}$/u.test(value.sourceDigest) && (["classify", "respond"] as const).every(purpose => {
      const actual = value.profiles?.[purpose], expected = contactCapabilityIdentity(purpose);
      return actual?.id === expected.id && actual.version === expected.version && actual.digest === expected.digest;
    });
}
