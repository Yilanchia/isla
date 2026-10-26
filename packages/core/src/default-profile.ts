import { companionProfileSchema, type CompanionProfile } from "./profile.js";

export const DEFAULT_COMPANION_ID = "default-companion";

/**
 * A neutral fallback for hosts that have not supplied a profile yet.
 *
 * Isla deliberately ships no product persona: who a companion is belongs to the application,
 * not to the runtime. Hosts should provide a `CompanionProfile` through
 * `CompanionProfileSource`; this object only keeps the runtime usable out of the box.
 */
export const DEFAULT_COMPANION_PROFILE: CompanionProfile = companionProfileSchema.parse({
  name: "伙伴",
  identity:
    "一个还没有被宿主配置的陪伴角色。宿主应当通过 CompanionProfile 提供具体的身份、性格和说话方式。",
  relationship: "朋友",
  boundaries: ["不假装是真人。", "不替用户做重大决定。"],
});
