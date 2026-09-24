import {
  createSocialImageResponse,
  socialImageContentType as contentType,
  socialImageSize as size,
} from "@hraness/web-discovery/social-image";

import { SITE_DESCRIPTION, SITE_NAME } from "./_lib/site";

export const alt = `${SITE_NAME} — your personal message butler for Mac.`;
export { contentType, size };

function TextbutlerMark() {
  return (
    <svg aria-label="Textbutler mark" fill="none" height="42" role="img" viewBox="0 0 42 42" width="42">
      <path d="M7 8h28v21H19l-8 7v-7H7z" stroke="currentColor" strokeLinejoin="round" strokeWidth="3" />
      <path d="M14 16h14M14 22h10" stroke="currentColor" strokeLinecap="round" strokeWidth="3" />
    </svg>
  );
}

export default function OpenGraphImage() {
  return createSocialImageResponse({
    description: SITE_DESCRIPTION,
    domain: "textbutler.app",
    eyebrow: SITE_NAME,
    mark: <TextbutlerMark />,
    theme: {
      accent: "#065968",
      background: "#FBF1C7",
      foreground: "#393533",
      muted: "#584F48",
    },
    title: "Your personal message butler for Mac",
  });
}
