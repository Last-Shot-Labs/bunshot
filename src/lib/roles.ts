import { getAuthAdapter } from "./authAdapter";

const requireMethod = (method: string) => {
  throw new Error(`Auth adapter does not implement ${method} — add it to your adapter to manage roles`);
};

export const setUserRoles = async (userId: string, roles: string[]): Promise<void> => {
  const adapter = getAuthAdapter();
  if (!adapter.setRoles) requireMethod("setRoles");
  await adapter.setRoles!(userId, roles);
};

export const addUserRole = async (userId: string, role: string): Promise<void> => {
  const adapter = getAuthAdapter();
  if (!adapter.addRole) requireMethod("addRole");
  await adapter.addRole!(userId, role);
};

export const removeUserRole = async (userId: string, role: string): Promise<void> => {
  const adapter = getAuthAdapter();
  if (!adapter.removeRole) requireMethod("removeRole");
  await adapter.removeRole!(userId, role);
};

// ---------------------------------------------------------------------------
// Tenant-scoped role helpers
// ---------------------------------------------------------------------------

export const getTenantRoles = async (userId: string, tenantId: string): Promise<string[]> => {
  const adapter = getAuthAdapter();
  if (!adapter.getTenantRoles) requireMethod("getTenantRoles");
  return adapter.getTenantRoles!(userId, tenantId);
};

export const setTenantRoles = async (userId: string, tenantId: string, roles: string[]): Promise<void> => {
  const adapter = getAuthAdapter();
  if (!adapter.setTenantRoles) requireMethod("setTenantRoles");
  await adapter.setTenantRoles!(userId, tenantId, roles);
};

export const addTenantRole = async (userId: string, tenantId: string, role: string): Promise<void> => {
  const adapter = getAuthAdapter();
  if (!adapter.addTenantRole) requireMethod("addTenantRole");
  await adapter.addTenantRole!(userId, tenantId, role);
};

export const removeTenantRole = async (userId: string, tenantId: string, role: string): Promise<void> => {
  const adapter = getAuthAdapter();
  if (!adapter.removeTenantRole) requireMethod("removeTenantRole");
  await adapter.removeTenantRole!(userId, tenantId, role);
};
