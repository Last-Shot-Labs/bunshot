import { authConnection, mongoose } from "@lib/mongo";

// Lazily register the model — authConnection and mongoose are proxies that
// resolve once connectAuthMongo() / connectMongo() has been called.
let _AuthUser: ReturnType<typeof authConnection.model> | null = null;

function getAuthUser() {
  if (!_AuthUser) {
    const schema = new (mongoose as { Schema: new (...args: unknown[]) => unknown }).Schema({
      email: { type: String, unique: true, sparse: true, lowercase: true },
      password: { type: String },
      /** Compound provider keys: ["google:123456", "apple:000111"] */
      providerIds: [{ type: String }],
      /** App-defined roles assigned to this user: ["admin", "editor", ...] */
      roles: [{ type: String }],
      /** Whether the user's email address has been verified. */
      emailVerified: { type: Boolean, default: false },
    }, { timestamps: true });

    (schema as unknown as { index: (fields: object) => void }).index({ providerIds: 1 });
    _AuthUser = authConnection.model("AuthUser", schema as never);
  }
  return _AuthUser;
}

// Export a Proxy so callers can use AuthUser.findOne() etc. at any time after
// connectAuthMongo() / connectMongo() has been called.
export const AuthUser = new Proxy({} as ReturnType<typeof authConnection.model>, {
  get(_, prop) {
    const model = getAuthUser();
    const val = (model as Record<string | symbol, unknown>)[prop as string];
    return typeof val === "function" ? (val as (...args: unknown[]) => unknown).bind(model) : val;
  },
});
