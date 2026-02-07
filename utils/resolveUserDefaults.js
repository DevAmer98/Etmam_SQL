const ROLE_TABLE = {
  salesRep: 'salesreps',
  manager: 'managers',
  supervisor: 'supervisors',
};

const normalizeName = (value) => String(value || '').trim().toLowerCase();

export async function resolveUserDefaults({ client, role, clerkId, username }) {
  if (!client) return { medad_salesman_id: null, warehouse_no: null, resolvedClerkId: clerkId || null };
  const table = ROLE_TABLE[role];
  if (!table) return { medad_salesman_id: null, warehouse_no: null, resolvedClerkId: clerkId || null };

  let row = null;
  if (clerkId) {
    const res = await client.query(
      `SELECT medad_salesman_id, clerk_id FROM ${table} WHERE clerk_id = $1 LIMIT 1`,
      [clerkId]
    );
    row = res.rows[0] || null;
  }

  if (!row && username) {
    const res = await client.query(
      `SELECT medad_salesman_id, clerk_id FROM ${table} WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1`,
      [normalizeName(username)]
    );
    row = res.rows[0] || null;
  }

  const resolvedClerkId = row?.clerk_id || clerkId || null;
  const medad_salesman_id = row?.medad_salesman_id || null;

  let warehouse_no = null;
  if (resolvedClerkId) {
    try {
      const wh = await client.query(
        'SELECT warehouse_code, warehouse_codes FROM user_warehouses WHERE clerk_id = $1',
        [resolvedClerkId]
      );
      if (wh.rows.length) {
        warehouse_no = wh.rows[0].warehouse_code || wh.rows[0].warehouse_codes?.[0] || null;
      }
    } catch {
      warehouse_no = null;
    }
  }

  return { medad_salesman_id, warehouse_no, resolvedClerkId };
}
