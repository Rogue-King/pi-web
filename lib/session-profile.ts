import type { ExtensionAPI, InlineExtension, LoadExtensionsResult, SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { WorkflowProfilesResponse } from "./api-types";

const ENTRY_TYPE = "pi-profile-switch:profile";
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
let cleanup: Promise<void> | undefined;

function createProfileLoader() {
  // Next starts in the installed package root; webpack embeds the build path in import.meta.url.
  return createJiti(join(process.cwd(), "package.json"));
}

export function readSessionProfile(entries: readonly { type: string; customType?: string; data?: unknown }[]): string | undefined {
  const entry = entries.findLast((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE);
  if (!entry) return undefined;
  const data = entry.data as { version?: unknown; profile?: unknown } | null;
  if (!data || data.version !== 1 || typeof data.profile !== "string" || !PROFILE_NAME.test(data.profile)) {
    throw new Error("Invalid saved session profile");
  }
  return data.profile;
}

export function validateSessionProfile(profile: unknown): string {
  if (typeof profile !== "string" || !PROFILE_NAME.test(profile)) throw new Error("Invalid profile name");
  return profile;
}

export async function listSessionProfiles(sessionManager: SessionManager | undefined, cwd: string): Promise<WorkflowProfilesResponse> {
  const active = (sessionManager && readSessionProfile(sessionManager.getEntries())) ?? process.env.PI_WEB_PROFILE;
  if (!active) return { profiles: [], diagnostics: [] };
  const jiti = createProfileLoader();
  const { listProfiles } = await jiti.import<typeof import("pi-profile-switch/src/switching/list-profiles.ts")>("pi-profile-switch/src/switching/list-profiles.ts");
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const diagnostics: string[] = [];
  const profiles = await listProfiles({ realAgentDir: getAgentDir(), cwd, onDiagnostic: (message) => diagnostics.push(message) });
  return { active, profiles, diagnostics };
}

// The upstream factory reads process.env; SDK sessions must use an explicit, private runtime instead.
export function preferSessionProfileExtension(base: LoadExtensionsResult): LoadExtensionsResult {
  const isNativeProfile = (path: string) => /[/\\]extensions[/\\]pi-profile[/\\]index\.[jt]s$/.test(path);
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !isNativeProfile(extension.path)),
    errors: base.errors.filter((error) => !isNativeProfile(error.path)),
  };
}

export async function prepareSessionProfile(options: {
  agentDir: string;
  cwd: string;
  sessionManager: SessionManager;
  profile?: string;
}): Promise<{ agentDir: string; extension: InlineExtension } | undefined> {
  const selected = options.profile ?? readSessionProfile(options.sessionManager.getEntries()) ?? process.env.PI_WEB_PROFILE;
  if (selected === undefined) return undefined;
  validateSessionProfile(selected);

  // shortcut: upstream has no SDK export; the pinned package carries the explicit runtime/state patch.
  const jiti = createProfileLoader();
  const { resolveInitialProfile } = await jiti.import<typeof import("pi-profile-switch/src/launcher/initial-profile.ts")>("pi-profile-switch/src/launcher/initial-profile.ts");
  const { generateRuntimeDir } = await jiti.import<typeof import("pi-profile-switch/src/settings-generator.ts")>("pi-profile-switch/src/settings-generator.ts");
  const { ensureStarterAssets } = await jiti.import<typeof import("pi-profile-switch/src/starter-assets.ts")>("pi-profile-switch/src/starter-assets.ts");
  const { readLaunchPlanFile } = await jiti.import<typeof import("pi-profile-switch/src/switching/apply-plan.ts")>("pi-profile-switch/src/switching/apply-plan.ts");
  const { default: profileExtension } = await jiti.import<typeof import("pi-profile-switch/extensions/pi-profile/index.ts")>("pi-profile-switch/extensions/pi-profile/index.ts");
  const { sweepStaleInstances } = await jiti.import<typeof import("pi-profile-switch/src/launcher/runtime-cleanup.ts")>("pi-profile-switch/src/launcher/runtime-cleanup.ts");
  cleanup ??= sweepStaleInstances(options.agentDir).then((result) => {
    for (const message of [...result.notices, ...result.warnings]) console.warn(`[pi-web profile] ${message}`);
  }).catch((error: unknown) => console.warn("[pi-web profile] Runtime cleanup failed:", error));
  await cleanup;
  const assets = await ensureStarterAssets({ agentDir: options.agentDir });
  const initial = await resolveInitialProfile(selected, { agentDir: options.agentDir, cwd: options.cwd });
  const generated = await generateRuntimeDir(initial.plan, {
    agentDir: options.agentDir, discovery: initial.discovery, projectDir: initial.projectDir,
  });
  for (const warning of new Set([...assets.warnings, ...initial.warnings, ...generated.warnings])) {
    console.warn(`[pi-web profile] ${warning}`);
  }
  // Keep live sessions out of the CLI's stale-runtime sweep. Reclaimed after the Web process exits.
  await writeFile(join(generated.runtimeDir, "pid"), String(process.pid));
  return {
    agentDir: generated.runtimeDir,
    extension: {
      name: "pi-web-session-profile",
      factory: (pi: ExtensionAPI) => {
        profileExtension(pi, {
          runtimeDir: generated.runtimeDir,
          stateDir: generated.runtimeDir,
          onChange: async () => {
            const plan = await readLaunchPlanFile(generated.runtimeDir);
            if (plan && readSessionProfile(options.sessionManager.getEntries()) !== plan.profile) {
              pi.appendEntry(ENTRY_TYPE, { version: 1, profile: plan.profile });
            }
          },
        });
      },
    },
  };
}
