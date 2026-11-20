import type { Queryable } from './db/types.js';

export async function audit(
  q: Queryable,
  actor: string | null,
  action: string,
  entity: string,
  entityId: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await q.query(`insert into audit_log (actor, action, entity, entity_id, data) values ($1,$2,$3,$4,$5::jsonb)`, [
    actor,
    action,
    entity,
    entityId,
    JSON.stringify(data),
  ]);
}
