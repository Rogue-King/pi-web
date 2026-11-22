import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { listSessionProfiles } from "@/lib/session-profile";
import { readSessionToolSelection } from "@/lib/session-tool-selection";
import { hasSubagentResourceSnapshot } from "@/lib/subagents";
import { hasSideMetadata } from "@/lib/side-session";
import type { SessionEntry } from "@/lib/types";

// Profile recovery must not depend on starting the profile that needs replacing.
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const id = params.get("sessionId");
    let manager: SessionManager | undefined;
    if (id) {
      const wrapper = getRpcSession(id);
      if (wrapper?.isAlive()) manager = wrapper.inner.sessionManager;
      else {
        const file = await resolveSessionPath(id);
        if (!file) return NextResponse.json({ error: "Session not found" }, { status: 404 });
        manager = SessionManager.open(file);
      }
      // SAFETY: these metadata readers use only the SDK entries’ common custom-entry fields.
      const entries = manager.getEntries() as unknown as SessionEntry[];
      if (readSessionToolSelection(entries)?.length === 0 || hasSubagentResourceSnapshot(entries) || hasSideMetadata(entries)) {
        return NextResponse.json({ profiles: [], diagnostics: [] });
      }
    }
    const cwd = manager?.getCwd() ?? params.get("cwd");
    if (!cwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    return NextResponse.json(await listSessionProfiles(manager, cwd));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
