// Connectors bring things from apps students already use into Orbit (Jake's integration memo, Oct 12 2026).
// Pattern for every connector: the student signs in with the app's own consent screen (OAuth, smallest read-only
// permission), picks what they want, and it enters Orbit through the same path as a normal upload — so it is read,
// searchable, cited and usable by all four AIs. The same sign-ins power Plugins (lib/plugins), where the AI calls the
// apps itself. Sign-ins stay in the student's browser (never stored on our server); Disconnect (Plugins → settings)
// or revoking access in the app's account settings removes them.
export type ConnectorId = "google-drive" | "onedrive";

export type Connector = {
  id: ConnectorId;
  name: string;
  hint: string; // one line in the + menu
  configured: boolean; // the team set the app's client ID (see .env.example)
};

export class ConnectorError extends Error {}

/** Cloud files bigger than this aren't brought in (same spirit as the upload limits). */
export const MAX_CLOUD_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_CLOUD_FILES = 10;
