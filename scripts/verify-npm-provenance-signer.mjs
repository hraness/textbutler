import { pathToFileURL } from "node:url";

const PACKAGE_REPOSITORY = "hraness/textbutler";
const REPOSITORY_ID = "1342143606";
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const SHA = /^[0-9a-f]{40}$/u;
const STABLE_TAG = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const WORKFLOW_PATH = /^\.github\/workflows\/[a-z0-9][a-z0-9-]{0,63}\.yml$/u;
const RUN_INVOCATION =
  /^https:\/\/github\.com\/hraness\/textbutler\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/u;
const OWNER_ID = "307125679";
const MAXIMUM_BUNDLE_BYTES = 4 * 1_024 * 1_024;

// Fulcio encodes every extension from 1.8 upward as a DER UTF8String inside the
// extension octet string, and sigstore-js compares policy values byte for byte.
// The deprecated 1.1 through 1.6 extensions stay raw strings.
function derUtf8String(value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > 127) {
    throw new Error("Sigstore release signer extension exceeds short-form DER length.");
  }
  return Buffer.concat([Buffer.from([0x0c, bytes.byteLength]), bytes]);
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function releaseSignerIdentity(tag, sha, invocation, workflowPath) {
  if (
    !STABLE_TAG.test(tag)
    || !SHA.test(sha)
    || !RUN_INVOCATION.test(invocation)
    || !WORKFLOW_PATH.test(workflowPath)
  ) {
    throw new Error("Sigstore release signer coordinates are invalid.");
  }
  const ref = `refs/tags/${tag}`;
  const identity =
    `https://github.com/${PACKAGE_REPOSITORY}/${workflowPath}@${ref}`;
  return Object.freeze({
    identity,
    options: Object.freeze({
      certificateIdentityURI: `^${escapeRegularExpression(identity)}$`,
      certificateIssuer: GITHUB_OIDC_ISSUER,
      certificateOIDs: Object.freeze({
        "1.3.6.1.4.1.57264.1.2": "push",
        "1.3.6.1.4.1.57264.1.3": sha,
        "1.3.6.1.4.1.57264.1.5": PACKAGE_REPOSITORY,
        "1.3.6.1.4.1.57264.1.6": ref,
        "1.3.6.1.4.1.57264.1.11": derUtf8String("github-hosted"),
        "1.3.6.1.4.1.57264.1.12": derUtf8String(`https://github.com/${PACKAGE_REPOSITORY}`),
        "1.3.6.1.4.1.57264.1.13": derUtf8String(sha),
        "1.3.6.1.4.1.57264.1.14": derUtf8String(ref),
        "1.3.6.1.4.1.57264.1.15": derUtf8String(REPOSITORY_ID),
        "1.3.6.1.4.1.57264.1.18": derUtf8String(identity),
        "1.3.6.1.4.1.57264.1.19": derUtf8String(sha),
        "1.3.6.1.4.1.57264.1.20": derUtf8String("push"),
        "1.3.6.1.4.1.57264.1.21": derUtf8String(invocation),
        "1.3.6.1.4.1.57264.1.22": derUtf8String("public"),
        "1.3.6.1.4.1.57264.1.24": derUtf8String(
          `repo:hraness@${OWNER_ID}/textbutler@${REPOSITORY_ID}:ref:${ref}`,
        ),
      }),
      ctLogThreshold: 1,
      tlogThreshold: 1,
      timeout: 10_000,
    }),
  });
}

async function readBoundedStandardInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.byteLength;
    if (length > MAXIMUM_BUNDLE_BYTES) {
      throw new Error("Sigstore bundle input exceeded its bound.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

async function main() {
  const [tag, sha, invocation, cachePath, workflowPath, extra] = process.argv.slice(2);
  if (
    tag === undefined
    || sha === undefined
    || invocation === undefined
    || cachePath === undefined
    || cachePath.length === 0
    || workflowPath === undefined
    || extra !== undefined
  ) {
    throw new Error("Usage: verify-npm-provenance-signer.mjs TAG SHA INVOCATION CACHE_PATH WORKFLOW_PATH");
  }
  const policy = releaseSignerIdentity(tag, sha, invocation, workflowPath);
  const bytes = await readBoundedStandardInput();
  let bundle;
  try {
    bundle = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Sigstore bundle input is not JSON.");
  }
  const { verify } = await import("sigstore");
  const signer = await verify(bundle, {
    ...policy.options,
    tufCachePath: cachePath,
    tufForceCache: true,
  });
  if (
    signer.identity?.subjectAlternativeName !== policy.identity
    || signer.identity?.extensions?.issuer !== GITHUB_OIDC_ISSUER
  ) {
    throw new Error("Sigstore verified the wrong release signer identity.");
  }
  process.stdout.write("verified\n");
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    await main();
  } catch {
    process.stderr.write("Sigstore release signer verification failed.\n");
    process.exitCode = 1;
  }
}
