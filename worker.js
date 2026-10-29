/* ============================================================
   Worker do Painel de Manutenção Âmbar Energia
   - Serve o painel estático (index.html) para tudo que não é /api/*
   - Expõe API REST simples sobre D1 para Planos de Ação e Análises
     de Falha, para que fiquem salvos online e compartilhados entre
     todos os usuários autenticados pelo Cloudflare Access.
   - Expõe também /api/os (relação de Ordens de Serviço): guarda as
     colunas originais da planilha (sem nenhum campo calculado — o
     cálculo continua 100% no navegador, como sempre), para que o
     assistente possa atualizar a base direto por este Worker, sem
     passar por upload manual de Excel nem por novo deploy do painel.
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
   Relação de Ordens de Serviço: cada linha fica guardada como
   um JSON com as colunas originais da planilha (as mesmas 56
   colunas "Grupo | Subcampo" que o painel já sabe ler), em
   `os_relacao.data`. Nenhum campo calculado é salvo aqui — classe,
   situação, criticidade, variação de prazo, execução reativa,
   origem etc. continuam sendo calculados no navegador, pela mesma
   lógica (buildPayloadFromWorkbook) de sempre.

   Protegido por uma chave de importação própria (cabeçalho
   X-Import-Key, comparado com o secret IMPORT_KEY do Worker),
   independente do Cloudflare Access — para permitir que a
   importação seja feita por automação (o assistente, por este
   Worker) mesmo que a rota tenha bypass de login configurado no
   Access.
   ------------------------------------------------------------ */
async function handleOsImport(request, env, url) {
  const key = request.headers.get('X-Import-Key');
  if (!env.IMPORT_KEY || !key || key !== env.IMPORT_KEY) {
    return json({ error: 'Não autorizado.' }, 401);
  }

  let rows;
  try {
    rows = await request.json();
  } catch (e) {
    return json({ error: 'JSON inválido no corpo da requisição.' }, 400);
  }
  if (!Array.isArray(rows)) {
    return json({ error: 'Esperado um array de registros (cada um é um objeto com as colunas da planilha).' }, 400);
  }

  const now = new Date().toISOString();
  try {
    // Só apaga a base anterior quando for o primeiro lote de uma importação
    // (?first=1). Isso permite enviar a relação completa em vários POSTs
    // menores (o corpo de uma requisição tem limite de tamanho no Worker),
    // sem que cada lote apague o que o lote anterior acabou de gravar.
    const isFirst = url.searchParams.get('first') === '1';
    if (isFirst) {
      await env.DB.prepare('DELETE FROM os_relacao').run();
      // Limpa também o cache de páginas pré-renderizadas: senão o painel
      // continuaria servindo páginas antigas até alguém reconstruir todas de novo.
      await env.DB.prepare('DELETE FROM os_pages').run();
    }

    const CHUNK = 200; // conservador: fica bem abaixo do limite de variáveis por statement do D1,
                        // já que cada INSERT aqui usa só 2 parâmetros e vai num batch() por fora.
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const stmts = slice.map(r =>
        env.DB.prepare('INSERT INTO os_relacao (data, updated_at) VALUES (?, ?)').bind(JSON.stringify(r), now)
      );
      await env.DB.batch(stmts);
      inserted += slice.length;
    }
    return json({ ok: true, inserted, updated_at: now });
  } catch (err) {
    return json({ error: String(err && err.message || err) }, 500);
  }
}

// Tamanho fixo de página usado na pré-renderização (handleOsBuildPage) e na
// leitura rápida por página (handleOsList com ?page=). Precisa combinar com
// o LIMIT usado pelo painel em buildPayloadFromApi (index.html).
const OS_PAGE_SIZE = 1000;

async function handleOsList(env, url) {
  try {
    // No plano Free do Workers cada requisição tem um orçamento de CPU de
    // ~10ms. Fazer JSON.parse/stringify de milhares de linhas de uma vez (o
    // caminho antigo, abaixo) ultrapassa esse limite e a requisição cai com
    // 503 — mesmo que a consulta ao D1 em si seja rápida. Por isso, sempre
    // que o painel pedir por número de página (?page=N), a resposta vem
    // pronta, já formatada, de uma tabela de cache (os_pages), montada uma
    // única vez em handleOsBuildPage logo depois de cada importação. Isso
    // tira praticamente todo o trabalho de CPU do caminho de leitura: aqui é
    // só um SELECT e devolver o texto já pronto, sem reprocessar nada.
    const pageParam = url.searchParams.get('page');
    if (pageParam !== null) {
      const page = Math.max(parseInt(pageParam, 10) || 0, 0);
      const row = await env.DB.prepare('SELECT body FROM os_pages WHERE page = ?').bind(page).first();
      if (row && row.body) {
        return new Response(row.body, { headers: { 'content-type': 'application/json; charset=utf-8' } });
      }
      // Página inexistente (além do fim dos dados, ou cache ainda não
      // construído para ela): devolve uma resposta vazia, mas no mesmo
      // formato, pra o painel simplesmente parar de paginar em vez de dar erro.
      return json({ columns: [], rows: [], updated_at: null, total: null, offset: page * OS_PAGE_SIZE, limit: OS_PAGE_SIZE, returned: 0 });
    }

    // Caminho antigo (?offset=&limit=), mantido como fallback/depuração manual
    // para fatias pequenas — consultas grandes por aqui ainda podem exceder o
    // limite de CPU do plano Free.
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '1000', 10) || 1000, 1), 4000);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

    const { results } = await env.DB.prepare('SELECT data, updated_at FROM os_relacao ORDER BY id LIMIT ? OFFSET ?').bind(limit, offset).all();

    const colSet = new Set();
    const parsed = results.map(r => JSON.parse(r.data));
    for (const obj of parsed) for (const k of Object.keys(obj)) colSet.add(k);
    const columns = [...colSet];
    const rows = parsed.map(obj => columns.map(c => (c in obj ? obj[c] : null)));
    const updatedAt = results.length ? results[results.length - 1].updated_at : null;

    let total = null;
    if (offset === 0) {
      const countRow = await env.DB.prepare('SELECT COUNT(*) as n FROM os_relacao').first();
      total = countRow ? countRow.n : rows.length;
    }

    return json({ columns, rows, updated_at: updatedAt, total, offset, limit, returned: rows.length });
  } catch (err) {
    return json({ error: String(err && err.message || err) }, 500);
  }
}

/* ------------------------------------------------------------
   Pré-renderização das páginas de /api/os (uma de cada vez, sob
   demanda da automação de importação — nunca do navegador do
   usuário). Protegida pela mesma chave X-Import-Key.

   Cada chamada processa só OS_PAGE_SIZE linhas (bem abaixo do que
   já se mostrou estourar o limite de CPU do plano Free), monta o
   JSON final no mesmo formato colunar que o painel espera, e grava
   esse texto pronto na tabela os_pages. Depois disso, ler essa
   página via GET /api/os?page=N não faz nenhum parse/stringify —
   só um SELECT e devolve o texto como está.
   ------------------------------------------------------------ */
async function handleOsBuildPage(request, env, url) {
  const key = request.headers.get('X-Import-Key');
  if (!env.IMPORT_KEY || !key || key !== env.IMPORT_KEY) {
    return json({ error: 'Não autorizado.' }, 401);
  }
  try {
    const page = Math.max(parseInt(url.searchParams.get('page') || '0', 10) || 0, 0);
    const offset = page * OS_PAGE_SIZE;

    const { results } = await env.DB.prepare('SELECT data, updated_at FROM os_relacao ORDER BY id LIMIT ? OFFSET ?').bind(OS_PAGE_SIZE, offset).all();

    const colSet = new Set();
    const parsed = results.map(r => JSON.parse(r.data));
    for (const obj of parsed) for (const k of Object.keys(obj)) colSet.add(k);
    const columns = [...colSet];
    const rows = parsed.map(obj => columns.map(c => (c in obj ? obj[c] : null)));
    const updatedAt = results.length ? results[results.length - 1].updated_at : new Date().toISOString();

    const countRow = await env.DB.prepare('SELECT COUNT(*) as n FROM os_relacao').first();
    const total = countRow ? countRow.n : rows.length;

    const body = JSON.stringify({ columns, rows, updated_at: updatedAt, total, offset, limit: OS_PAGE_SIZE, returned: rows.length });

    await env.DB.prepare(
      `INSERT INTO os_pages (page, body, rows, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(page) DO UPDATE SET body = excluded.body, rows = excluded.rows, updated_at = excluded.updated_at`
    ).bind(page, body, rows.length, updatedAt).run();

    return json({ ok: true, page, rows: rows.length, total, hasMore: offset + rows.length < total });
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
    if ((request.method === 'POST' || request.method === 'DELETE' || request.method === 'PUT') && !isAdmin) {
      return json({ error: 'Somente o administrador pode enviar, editar ou excluir documentos.' }, 403);
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

    if (request.method === 'PUT' && id) {
      const body = await request.json();
      const meta = await env.DB.prepare(`SELECT id FROM docs WHERE id = ?`).bind(id).first();
      if (!meta) return json({ error: 'Documento não encontrado.' }, 404);
      await env.DB.prepare(`UPDATE docs SET name = ?, category = ? WHERE id = ?`)
        .bind(body.name, body.category || '', id).run();
      return json({ ok: true, id, name: body.name, category: body.category || '' });
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
    if (url.pathname === '/api/os/import' && request.method === 'POST') {
      return handleOsImport(request, env, url);
    }
    if (url.pathname === '/api/os' && request.method === 'GET') {
      return handleOsList(env, url);
    }
    if (url.pathname === '/api/os/build-page' && request.method === 'POST') {
      return handleOsBuildPage(request, env, url);
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
