import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function GET(req, { params }) {
  const client = await pool.connect();
  const { id } = params;

  try {
    const result = await client.query(
      `SELECT p.*, s.supplier_name, s.company_name
       FROM products p
       LEFT JOIN suppliers s ON p.supplier_id = s.id
       WHERE p.id = $1;`,
      [id]
    );

    if (result.rows.length === 0) {
      return new Response(JSON.stringify({ error: 'Product not found' }), { status: 404 });
    }

    return new Response(JSON.stringify(result.rows[0]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('GET error:', err);
    return new Response(JSON.stringify({ error: 'Failed to fetch product' }), { status: 500 });
  } finally {
    client.release();
  }
}

export async function PUT(req, { params }) {
  const client = await pool.connect();
  const { id } = params;
  const { name, sku, code, comment } = await req.json();

  try {
    const result = await client.query(
      `UPDATE products
       SET name = $1, sku = $2, code = $3, comment = $4
       WHERE id = $5
       RETURNING *;`,
      [name, sku, code || null, comment || null, id]
    );

    if (result.rows.length === 0) {
      return new Response(JSON.stringify({ error: 'Product not found' }), { status: 404 });
    }

    return new Response(JSON.stringify({ message: 'Product updated', product: result.rows[0] }), {
      status: 200,
    });
  } catch (err) {
    console.error('PUT error:', err);
    return new Response(JSON.stringify({ error: 'Failed to update product' }), { status: 500 });
  } finally {
    client.release();
  }
}

export async function DELETE(req, { params }) {
  const client = await pool.connect();
  const { id } = params;

  try {
    const result = await client.query(`DELETE FROM products WHERE id = $1 RETURNING *;`, [id]);

    if (result.rows.length === 0) {
      return new Response(JSON.stringify({ error: 'Product not found' }), { status: 404 });
    }

    return new Response(JSON.stringify({ message: 'Product deleted' }), { status: 200 });
  } catch (err) {
    console.error('DELETE error:', err);
    return new Response(JSON.stringify({ error: 'Failed to delete product' }), { status: 500 });
  } finally {
    client.release();
  }
}
