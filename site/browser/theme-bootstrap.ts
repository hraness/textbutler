import { initDesignPalette } from "@hraness/design-kit/browser";

// Saved reader preferences take precedence over the family default.
initDesignPalette({
  defaultPreference: { palette: "gruvbox", mode: "system" },
  legacyStorageKey: "hraness-design-theme-v1",
});
