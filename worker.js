/* ============================================================
   Worker do Painel de Manutenção Âmbar Energia
   - Serve o painel estático (index.html) para tudo que não é /api/*
   - Expõe API REST simples sobre D1 para Planos de Ação e Análises
     de Falha, para que fiquem salvos online e compartilhados entre
     todos os usuários autenticados pelo Cloudflare Access.
   ============================================================ */

const TABLES = { analyses: 'analyses', actions: 'actions' };

/* Único e-mail autorizado a enviar/excluir Documentos Corporativos.
   Qualquer outro usuário autenticado só pode listar/baixar. */
const DOCS_ADMIN_EMAIL = 'cesar.silva@ambarenergia.com.br';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function userEmail(request) {
  return request.headers.get('Cf-Access-Authenticated-User-Email') || 'desconhecido';
}

async function listRecords(env, table) {
  const { results } = await env.DB.prepare(
    `SELECT id, data, created_by, updated_by, created_at, updated_at FROM ${table} ORDER BY updated_at DESC`
  ).all();
  return results.map(r => ({ ...JSON.parse(r.data), _createdBy: r.created_by, _updatedBy: r.updated_by, _createdAt: r.created_at, _updatedAt: r.updated_at }));
}

async function upsertRecord(env, table, record, email) {
  if (!record || !record.id) throw new Error('Registro sem id.');
  const now = new Date().toISOString();
  const existing = await env.DB.prepare(`SELECT created_by, created_at FROM ${table} WHERE id = ?`).bind(record.id).first();
  const createdBy = existing ? existing.created_by : email;
  const createdAt = existing ? existing.created_at : now;
  await env.DB.prepare(
    `INSERT INTO ${table} (id, data, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_by=excluded.updated_by, updated_at=excluded.updated_at`
  ).bind(record.id, JSON.stringify(record), createdBy, email, createdAt, now).run();
  return { id: record.id, _createdBy: createdBy, _updatedBy: email, _createdAt: createdAt, _updatedAt: now };
}

async function deleteRecord(env, table, id) {
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
}

async function handleApi(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','analyses', maybe id]
  const resource = parts[1];
  const id = parts[2];
  if (!TABLES[resource]) return json({ error: 'Recurso não encontrado.' }, 404);
  const table = TABLES[resource];
  const email = userEmail(request);

  try {
    if (request.method === 'GET') {
      const data = await listRecords(env, table);
      return json({ items: data });
    }
    if (request.method === 'POST' || request.method === 'PUT') {
      const body = await request.json();
      const saved = await upsertRecord(env, table, body, email);
      return json(saved);
    }
    if (request.method === 'DELETE') {
      if (!id) return json({ error: 'Id ausente.' }, 400);
      await deleteRecord(env, table, id);
      return json({ ok: true });
    }
    return json({ error: 'Método não suportado.' }, 405);
  } catch (err) {
    return json({ error: String(err && err.message || err) }, 500);
  }
}

/* ------------------------------------------------------------
   Documentos Corporativos: metadados no D1 (tabela "docs"),
   conteúdo binário no R2 (bucket DOCS_BUCKET). Evita embutir
   arquivos em base64 dentro do HTML estático do painel.
   ------------------------------------------------------------ */
async function handleDocsApi(request, env, url, id, sub) {
  const email = userEmail(request);
  const isAdmin = email.toLowerCase() === DOCS_ADMIN_EMAIL.toLowerCase();
  try {
    if ((request.method === 'POST' || request.method === 'DELETE') && !isAdmin) {
      return json({ error: 'Somente o administrador pode enviar ou excluir documentos.' }, 403);
    }
    if (request.method === 'GET' && !id) {
      const { results } = await env.DB.prepare(
        `SELECT id, name, category, size, content_type, created_by, created_at FROM docs ORDER BY created_at DESC`
      ).all();
      return json({ items: results });
    }

    if (request.method === 'GET' && id && sub === 'download') {
      const meta = await env.DB.prepare(`SELECT * FROM docs WHERE id = ?`).bind(id).first();
      if (!meta) return json({ error: 'Documento não encontrado.' }, 404);
      const obj = await env.DOCS_BUCKET.get(meta.r2_key);
      if (!obj) return json({ error: 'Arquivo não encontrado no armazenamento.' }, 404);
      const safeName = String(meta.name || 'documento').replace(/"/g, '');
      return new Response(obj.body, {
        headers: {
          'content-type': meta.content_type || 'application/octet-stream',
          'content-disposition': `attachment; filename="${safeName}"`,
        },
      });
    }

    if (request.method === 'POST' && !id) {
      const form = await request.formData();
      const file = form.get('file');
      const docId = form.get('id');
      const category = form.get('category') || '';
      if (!file || !docId) return json({ error: 'Dados incompletos.' }, 400);
      const r2Key = 'docs/' + docId;
      const buf = await file.arrayBuffer();
      await env.DOCS_BUCKET.put(r2Key, buf, { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO docs (id, name, category, size, content_type, r2_key, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)`
      ).bind(docId, file.name, category, file.size, file.type || '', r2Key, email, now).run();
      return json({ id: docId, name: file.name, category, size: file.size, content_type: file.type || '', created_by: email, created_at: now });
    }

    if (request.method === 'DELETE' && id) {
      const meta = await env.DB.prepare(`SELECT r2_key FROM docs WHERE id = ?`).bind(id).first();
      if (meta) {
        await env.DOCS_BUCKET.delete(meta.r2_key);
        await env.DB.prepare(`DELETE FROM docs WHERE id = ?`).bind(id).run();
      }
      return json({ ok: true });
    }

    return json({ error: 'Método não suportado.' }, 405);
  } catch (err) {
    return json({ error: String(err && err.message || err) }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/me') {
      const email = userEmail(request);
      return json({ email, isDocsAdmin: email.toLowerCase() === DOCS_ADMIN_EMAIL.toLowerCase() });
    }
    if (url.pathname.startsWith('/api/docs')) {
      const parts = url.pathname.split('/').filter(Boolean); // ['api','docs', maybe id, maybe 'download']
      return handleDocsApi(request, env, url, parts[2], parts[3]);
    }
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }
    return env.ASSETS.fetch(request);
  },
};
