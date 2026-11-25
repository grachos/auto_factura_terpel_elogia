// Matriz central de permisos: la usan la API (requirePermission) y la UI (me.permissions).
export type AppRole = 'admin' | 'facturacion' | 'operator' | 'viewer';
export const ALL_ROLES: AppRole[] = ['admin', 'facturacion', 'operator', 'viewer'];

export type Permission =
  | 'results.view'
  | 'import.run'
  | 'recon.run'
  | 'recon.resolve'
  | 'params.view'
  | 'params.edit'
  | 'users.manage'
  | 'credentials.manage'
  | 'mail.config'
  | 'adjustments.view'
  | 'adjustments.generate'
  | 'adjustments.approve'
  | 'adjustments.apply'
  | 'adjustments.config';

const RUNNERS: AppRole[] = ['admin', 'facturacion', 'operator'];

export const PERMISSION_ROLES: Record<Permission, AppRole[]> = {
  'results.view': ALL_ROLES,
  'import.run': RUNNERS,
  'recon.run': RUNNERS,
  'recon.resolve': RUNNERS,
  'params.view': ['admin', 'facturacion'],
  'params.edit': ['admin'],
  'users.manage': ['admin'],
  'credentials.manage': ['admin'],
  'mail.config': ['admin'],
  'adjustments.view': ALL_ROLES,
  'adjustments.generate': ['admin', 'facturacion'],
  'adjustments.approve': ['admin', 'facturacion'],
  'adjustments.apply': ['admin', 'facturacion'],
  'adjustments.config': ['admin'],
};

export function can(role: AppRole, permission: Permission): boolean {
  return PERMISSION_ROLES[permission].includes(role);
}

export function permissionsOf(role: AppRole): Permission[] {
  return (Object.keys(PERMISSION_ROLES) as Permission[]).filter((p) => can(role, p));
}
