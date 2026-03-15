import { authConnection, mongoose } from "@lib/mongo";
import type { Document, Model } from "mongoose";

interface ITenantRole {
  userId: string;
  tenantId: string;
  roles: string[];
}

type TenantRoleDocument = ITenantRole & Document;

let _TenantRole: Model<TenantRoleDocument> | null = null;

function getTenantRole() {
  if (!_TenantRole) {
    const { Schema } = mongoose as unknown as typeof import("mongoose");
    const schema = new Schema<TenantRoleDocument>(
      {
        userId: { type: String, required: true },
        tenantId: { type: String, required: true },
        roles: [{ type: String }],
      },
      { timestamps: true }
    );

    schema.index({ userId: 1, tenantId: 1 }, { unique: true });
    schema.index({ tenantId: 1 });

    _TenantRole = authConnection.model<TenantRoleDocument>("TenantRole", schema);
  }
  return _TenantRole;
}

export const TenantRole = new Proxy({} as Model<TenantRoleDocument>, {
  get(_, prop) {
    const model = getTenantRole();
    const val = (model as unknown as Record<string | symbol, unknown>)[prop];
    return typeof val === "function" ? (val as (...args: unknown[]) => unknown).bind(model) : val;
  },
});
