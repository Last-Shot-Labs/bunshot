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
