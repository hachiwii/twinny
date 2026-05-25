import { GUEST_PROFILE_NAME, HOST_PROFILE_NAME, type ProfileName, type TwinnyConfig } from "../types.js";

export function defaultProfileForSender(senderOpenId: string, ownerOpenId: string): ProfileName {
  return senderOpenId === ownerOpenId ? HOST_PROFILE_NAME : GUEST_PROFILE_NAME;
}

export function getProfileCodexHome(config: TwinnyConfig, profile: ProfileName): string {
  const resolved = config.profiles[profile];
  if (!resolved) {
    throw new Error(`Unknown Twinny profile: ${profile}`);
  }
  return resolved.codexHome;
}

export { defaultOwnerCodexTarget } from "./owner.js";
export {
  createGuestCodexConfigDocument,
  DEFAULT_GUEST_CODEX_MODEL,
  ensureProjectTrust,
  ensureWorkspaceTrust,
  ensureWorkspaceTrust as ensureGuestWorkspaceTrust,
  ensureWorkspaceTrust as ensureGuestWorkspaceProjectTrusted,
  renderGuestAgents,
  serializeGuestCodexConfig,
  validateGuestCodexConfigDocument,
  type GuestCodexConfigOptions,
  type GuestSafetyCheck
} from "./guest.js";
