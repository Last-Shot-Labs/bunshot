import mongoose from "mongoose";
import { authConnection } from "@lib/mongo";

const AuthUserSchema = new mongoose.Schema({
  email: { type: String, unique: true, sparse: true, lowercase: true },
  password: { type: String },
  /** Compound provider keys: ["google:123456", "apple:000111"] */
  providerIds: [{ type: String }],
  /** App-defined roles assigned to this user: ["admin", "editor", ...] */
  roles: [{ type: String }],
  /** Whether the user's email address has been verified. */
  emailVerified: { type: Boolean, default: false },
}, { timestamps: true });

AuthUserSchema.index({ providerIds: 1 });

export const AuthUser = authConnection.model("AuthUser", AuthUserSchema);
