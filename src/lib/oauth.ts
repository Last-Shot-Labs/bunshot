import { Google, Apple, MicrosoftEntraId, GitHub, generateState, generateCodeVerifier } from "arctic";
import { getRedis } from "./redis";
import { appConnection, mongoose } from "./mongo";
import { getAppName } from "./appConfig";
import { sqliteStoreOAuthState, sqliteConsumeOAuthState } from "../adapters/sqliteAuth";
import { memoryStoreOAuthState, memoryConsumeOAuthState } from "../adapters/memoryAuth";

export type OAuthProviderConfig = {
  google?: { clientId: string; clientSecret: string; redirectUri: string };
  apple?: { clientId: string; teamId: string; keyId: string; privateKey: string; redirectUri: string };
  microsoft?: { tenantId: string; clientId: string; clientSecret: string; redirectUri: string };
  github?: { clientId: string; clientSecret: string; redirectUri: string };
};

type Providers = { google?: Google; apple?: Apple; microsoft?: MicrosoftEntraId; github?: GitHub };

let _providers: Providers = {};

export const initOAuthProviders = (config: OAuthProviderConfig) => {
  if (config.google) {
    const { clientId, clientSecret, redirectUri } = config.google;
    _providers.google = new Google(clientId, clientSecret, redirectUri);
  }
  if (config.apple) {
    const { clientId, teamId, keyId, privateKey, redirectUri } = config.apple;
    _providers.apple = new Apple(clientId, teamId, keyId, new TextEncoder().encode(privateKey), redirectUri);
  }
  if (config.microsoft) {
    const { tenantId, clientId, clientSecret, redirectUri } = config.microsoft;
    _providers.microsoft = new MicrosoftEntraId(tenantId, clientId, clientSecret, redirectUri);
  }
  if (config.github) {
    const { clientId, clientSecret, redirectUri } = config.github;
    _providers.github = new GitHub(clientId, clientSecret, redirectUri);
  }
};

export const getGoogle = (): Google => {
  if (!_providers.google) throw new Error("Google OAuth not configured");
  return _providers.google;
};

export const getApple = (): Apple => {
  if (!_providers.apple) throw new Error("Apple OAuth not configured");
  return _providers.apple;
};

export const getMicrosoft = (): MicrosoftEntraId => {
  if (!_providers.microsoft) throw new Error("Microsoft Entra ID OAuth not configured");
  return _providers.microsoft;
};

export const getGitHub = (): GitHub => {
  if (!_providers.github) throw new Error("GitHub OAuth not configured");
  return _providers.github;
};

export const getConfiguredOAuthProviders = (): string[] =>
  (Object.entries(_providers) as [string, unknown][])
    .filter(([, v]) => v != null)
    .map(([k]) => k);

// ---------------------------------------------------------------------------
// Mongo OAuth state model
// ---------------------------------------------------------------------------

interface OAuthStateDoc {
  state: string;
  codeVerifier?: string;
  linkUserId?: string;
  expiresAt: Date;
}

function getOAuthStateModel() {
  if (appConnection.models["OAuthState"]) return appConnection.models["OAuthState"];
  const { Schema } = mongoose as unknown as typeof import("mongoose");
  const oauthStateSchema = new Schema<OAuthStateDoc>(
    {
      state:        { type: String, required: true, unique: true },
      codeVerifier: { type: String },
      linkUserId:   { type: String },
      expiresAt:    { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    },
    { collection: "oauth_states" }
  );
  return appConnection.model<OAuthStateDoc>("OAuthState", oauthStateSchema);
}

// ---------------------------------------------------------------------------
// Store configuration — set once at startup via setOAuthStateStore()
// ---------------------------------------------------------------------------

type OAuthStateStore = "redis" | "mongo" | "sqlite" | "memory";
let _oauthStore: OAuthStateStore = "redis";
export const setOAuthStateStore = (store: OAuthStateStore) => { _oauthStore = store; };

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

const STATE_TTL = 300; // 5 minutes

export const storeOAuthState = async (state: string, codeVerifier?: string, linkUserId?: string): Promise<void> => {
  if (_oauthStore === "memory") { memoryStoreOAuthState(state, codeVerifier, linkUserId); return; }
  if (_oauthStore === "sqlite") {
    sqliteStoreOAuthState(state, codeVerifier, linkUserId);
    return;
  }
  if (_oauthStore === "mongo") {
    const expiresAt = new Date(Date.now() + STATE_TTL * 1000);
    await getOAuthStateModel().create({ state, codeVerifier, linkUserId, expiresAt });
    return;
  }
  await getRedis().set(`oauth:${getAppName()}:state:${state}`, JSON.stringify({ codeVerifier, linkUserId }), "EX", STATE_TTL);
};

export const consumeOAuthState = async (state: string): Promise<{ codeVerifier?: string; linkUserId?: string } | null> => {
  if (_oauthStore === "memory") return memoryConsumeOAuthState(state);
  if (_oauthStore === "sqlite") return sqliteConsumeOAuthState(state);
  if (_oauthStore === "mongo") {
    const doc = await getOAuthStateModel()
      .findOneAndDelete({ state, expiresAt: { $gt: new Date() } })
      .lean();
    return doc ? { codeVerifier: doc.codeVerifier, linkUserId: doc.linkUserId } : null;
  }
  const key = `oauth:${getAppName()}:state:${state}`;
  const value = await getRedis().get(key);
  if (!value) return null;
  await getRedis().del(key);
  return JSON.parse(value);
};

export { generateState, generateCodeVerifier };
