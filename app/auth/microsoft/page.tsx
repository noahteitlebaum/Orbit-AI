"use client";

import { useEffect } from "react";

// Microsoft sign-in pop-up lands here and hands the result back to the Orbit tab that opened it (OneDrive connector).
export default function MicrosoftRedirect() {
  useEffect(() => {
    import("@azure/msal-browser/redirect-bridge").then((m) => m.broadcastResponseToMainFrame()).catch(() => window.close());
  }, []);
  return <p className="p-6 text-sm text-ink-muted">Signing in to Microsoft…</p>;
}
