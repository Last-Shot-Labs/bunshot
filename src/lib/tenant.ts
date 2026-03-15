import { authConnection, mongoose } from "@lib/mongo";
import type { Document, Model } from "mongoose";

// ---------------------------------------------------------------------------
// Tenant record schema (stored in auth database)
// ---------------------------------------------------------------------------

export interface TenantInfo {
  tenantId: string;
  displayName?: string;
  config?: Record<string, unknown>;
  createdAt: Date;
  deletedAt?: Date | null;
}

interface ITenantDoc {
  tenantId: string;
  displayName?: string;
  config?: Record<string, unknown>;
  deletedAt?: Date | null;
}

type TenantDocument = ITenantDoc & Document;

let _TenantModel: Model<TenantDocument> | null = null;

function getTenantModel() {
  if (!_TenantModel) {
    const { Schema } = mongoose as unknown as typeof import("mongoose");
    const schema = new Schema<TenantDocument>(
      {
        tenantId: { type: String, required: true, unique: true },
        displayName: { type: String },
        config: { type: Schema.Types.Mixed },
        deletedAt: { type: Date, default: null },
      },
      { timestamps: true }
    );
    _TenantModel = authConnection.model<TenantDocument>("Tenant", schema);
  }
  return _TenantModel;
}

// Proxy for lazy model resolution (same pattern as AuthUser)
const Tenant = new Proxy({} as Model<TenantDocument>, {
  get(_, prop) {
    const model = getTenantModel();
    const val = (model as unknown as Record<string | symbol, unknown>)[prop];
    return typeof val === "function" ? (val as (...args: unknown[]) => unknown).bind(model) : val;
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateTenantOptions {
  displayName?: string;
  config?: Record<string, unknown>;
}

export const createTenant = async (tenantId: string, options?: CreateTenantOptions): Promise<void> => {
  const existing = await Tenant.findOne({ tenantId }).lean();
  if (existing && !existing.deletedAt) {
    throw new Error(`Tenant "${tenantId}" already exists`);
  }
  if (existing && existing.deletedAt) {
    // Reactivate soft-deleted tenant
    await Tenant.findOneAndUpdate(
      { tenantId },
      { deletedAt: null, displayName: options?.displayName, config: options?.config }
    );
    return;
  }
  await Tenant.create({
    tenantId,
    displayName: options?.displayName,
    config: options?.config,
  });
};

export const deleteTenant = async (tenantId: string): Promise<void> => {
  const { invalidateTenantCache } = await import("@middleware/tenant");
  // Soft-delete
  await Tenant.findOneAndUpdate({ tenantId }, { deletedAt: new Date() });
  invalidateTenantCache(tenantId);
};

export const getTenant = async (tenantId: string): Promise<TenantInfo | null> => {
  const doc = await Tenant.findOne({ tenantId, deletedAt: null }).lean();
  if (!doc) return null;
  return {
    tenantId: doc.tenantId as string,
    displayName: doc.displayName as string | undefined,
    config: doc.config as Record<string, unknown> | undefined,
    createdAt: (doc as unknown as { createdAt: Date }).createdAt,
  };
};

export const listTenants = async (): Promise<TenantInfo[]> => {
  const docs = await Tenant.find({ deletedAt: null }).lean();
  return docs.map((doc) => ({
    tenantId: doc.tenantId as string,
    displayName: doc.displayName as string | undefined,
    config: doc.config as Record<string, unknown> | undefined,
    createdAt: (doc as unknown as { createdAt: Date }).createdAt,
  }));
};
