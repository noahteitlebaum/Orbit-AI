"use client";

import { useEffect, useState } from "react";
import { NOTION_CHANNEL } from "@/lib/connectors/notion-client";

// Notion's sign-in pop-up lands here and hands the one-time code back to the Orbit tab (same-origin channel).
export default function NotionRedirect() {
  const [msg, setMsg] = useState("Connecting Notion…");
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const ch = new BroadcastChannel(NOTION_CHANNEL);
    ch.postMessage({ code: q.get("code") ?? undefined, state: q.get("state") ?? undefined, error: q.get("error") ?? undefined });
    ch.close();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when opened
    setMsg(q.get("code") ? "Notion connected. You can close this window." : "Notion wasn't connected. You can close this window.");
    setTimeout(() => window.close(), 400);
  }, []);
  return <p className="p-6 text-sm text-ink-muted">{msg}</p>;
}
