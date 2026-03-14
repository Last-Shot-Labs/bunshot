import { authConnection, mongoose } from "@lib/mongo";
import type { Document, Model } from "mongoose";

interface IAuthUser {
  email?: string | null;
  password?: string | null;
  /** Compound provider keys: ["google:123456", "apple:000111"] */
  providerIds: string[];
  /** App-defined roles assigned to this user: ["admin", "editor", ...] */
  roles: string[];
  /** Whether the user's email address has been verified. */
  emailVerified: boolean;
}

type AuthUserDocument = IAuthUser & Document;

// Lazily register the model — authConnection and mongoose are proxies that
// resolve once connectAuthMongo() / connectMongo() has been called.
let _AuthUser: Model<AuthUserDocument> | null = null;

function getAuthUser() {
  if (!_AuthUser) {
    const { Schema } = mongoose as unknown as typeof import("mongoose");
    const schema = new Schema<AuthUserDocument>(
      {
        email: { type: String, unique: true, sparse: true, lowercase: true },
        password: { type: String },
        /** Compound provider keys: ["google:123456", "apple:000111"] */
        providerIds: [{ type: String }],
        /** App-defined roles assigned to this user: ["admin", "editor", ...] */
        roles: [{ type: String }],
        /** Whether the user's email address has been verified. */
        emailVerified: { type: Boolean, default: false },
      },
      { timestamps: true }
    );

    schema.index({ providerIds: 1 });
    _AuthUser = authConnection.model<AuthUserDocument>("AuthUser", schema);
  }
  return _AuthUser;
}

// Export a Proxy so callers can use AuthUser.findOne() etc. at any time after
// connectAuthMongo() / connectMongo() has been called.
export const AuthUser = new Proxy({} as Model<AuthUserDocument>, {
  get(_, prop) {
    const model = getAuthUser();
    const val = (model as Record<string | symbol, unknown>)[prop];
    return typeof val === "function" ? (val as (...args: unknown[]) => unknown).bind(model) : val;
  },
});
