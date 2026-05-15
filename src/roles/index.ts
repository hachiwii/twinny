import type { RoleName, TwinnyConfig } from "../types.js";

export function resolveRoleForSender(senderOpenId: string, ownerOpenId: string): RoleName {
  return senderOpenId === ownerOpenId ? "owner" : "guest";
}

export function getRoleCodexHome(config: TwinnyConfig, role: RoleName): string {
  return config.roles[role].codexHome;
}

export { defaultOwnerCodexTarget } from "./owner.js";
export {
  createGuestCodexConfigDocument,
  DEFAULT_GUEST_CODEX_MODEL,
  ensureGuestWorkspaceProjectTrusted,
  renderGuestAgents,
  serializeGuestCodexConfig,
  validateGuestCodexConfigDocument,
  type GuestCodexConfigOptions,
  type GuestSafetyCheck
} from "./guest.js";
