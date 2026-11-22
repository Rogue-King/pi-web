"use client";

import { useRef, useState, type MouseEvent } from "react";
import type { WorkflowProfilesResponse } from "@/lib/api-types";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { SidebarMenu, type SidebarMenuAnchor, type SidebarMenuItem } from "./SidebarMenu";

export function ProfileSelector({ loadProfiles, onSelect, showLabel, isStrayClick }: {
  loadProfiles: () => Promise<WorkflowProfilesResponse>;
  onSelect: (name: string) => Promise<void>;
  showLabel: boolean;
  isStrayClick: (event: MouseEvent<HTMLButtonElement>) => boolean;
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const button = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const [anchor, setAnchor] = useState<SidebarMenuAnchor | null>(null);
  const [data, setData] = useState<WorkflowProfilesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const close = () => { generation.current++; setAnchor(null); };
  const open = async () => {
    const request = ++generation.current;
    setAnchor({ kind: "rect", rect: button.current!.getBoundingClientRect(), align: "end" });
    setData(null);
    setError(null);
    try {
      const result = await loadProfiles();
      if (generation.current === request) setData(result);
    } catch (error) {
      if (generation.current === request) setError(error instanceof Error ? error.message : String(error));
    }
  };
  const items: SidebarMenuItem[] = data?.profiles.map((profile) => ({
    type: "item",
    id: profile.name,
    label: profile.name,
    note: profile.label ?? profile.description ?? profile.source,
    title: [profile.error, ...(profile.warnings ?? [])].filter(Boolean).join("\n") || undefined,
    checked: profile.name === data.active,
    disabled: switching || !profile.available,
    disabledReason: profile.error,
    onSelect: (event) => {
      if (switching || !profile.available || profile.name === data.active) return;
      event.keepOpen();
      setSwitching(true);
      setError(null);
      void onSelect(profile.name).then(close, (error: unknown) => {
        setError(error instanceof Error ? error.message : String(error));
      }).finally(() => setSwitching(false));
    },
  })) ?? [];
  if (!items.length) items.push({ type: "header", id: "status", label: error ? t("chat.profilesFailed") : data ? t("chat.profilesEmpty") : t("sessionPanel.loading") });
  if (error) items.push({ type: "item", id: "retry", label: t("chat.profilesRetry"), onSelect: (event) => { event.keepOpen(); void open(); } });

  return <>
    <button
      ref={button}
      type="button"
      title={t("chat.changeProfile")}
      aria-label={t("chat.changeProfile")}
      aria-haspopup="menu"
      aria-expanded={anchor !== null}
      onClick={(event) => { if (!isStrayClick(event)) { if (anchor) close(); else void open(); } }}
      style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
        padding: isMobile ? "0 10px" : "8px 12px", height: isMobile ? 44 : 32,
        background: anchor ? "var(--bg-hover)" : "none", border: "none", borderRadius: 9,
        color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}
      onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = anchor ? "var(--bg-hover)" : "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="var(--bg)" /><circle cx="15" cy="17" r="3" fill="var(--bg)" />
      </svg>
      {showLabel && <span style={{ whiteSpace: "nowrap" }}>{t("chat.profiles")}</span>}
    </button>
    <SidebarMenu open={anchor !== null} anchor={anchor} sheet={isMobile}
      ariaLabel={t("chat.changeProfile")} title={t("chat.changeProfile")}
      cancelLabel={t("sidebar.cancel")} items={items} onClose={close}
      returnFocusTo={button.current} focusKey={error ? "error" : data ? "loaded" : "loading"}
      footer={(switching || error || data?.diagnostics.length) ? <div role="status" style={{ padding: 12, fontSize: 12, overflowWrap: "anywhere" }}>{switching ? t("chat.profilesSwitching") : error ?? data?.diagnostics.join("\n")}</div> : undefined}
    />
  </>;
}
