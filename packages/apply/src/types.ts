/** Shared types for @applyrn/apply (avoids circular imports). */
export type { ApplicationProfile, ProfileAnswer, FieldPlan } from "./profile.js";
export type { PausedField, SessionStatus } from "./session.js";

export type PausedFieldInput = {
  label: string;
  key: string | null;
  reason: string;
  required: boolean;
};
