/**
 * Anniversary Photos API — Cloudflare Worker + R2
 *
 * Endpoints:
 *   GET  /photos/:year           → lista foto per anno (es. /photos/2021-2022)
 *   GET  /photos/:year/:key      → serve la foto (immagine raw)
 *   POST /photos/:year           → upload foto (multipart/form-data, campo "file")
 *   DELETE /photos/:year/:key    → elimina foto
 *   GET  /photos/:year/:key/note → leggi nota sul retro
 *   PUT  /photos/:year/:key/note → salva nota sul retro (body JSON: { "note": "..." })
 *
 * Tutte le richieste richiedono il token nell'header Authorization: Bearer <token>
 * oppure come query param ?token=<token>
 *
 * Le foto sono salvate in R2 come: photos/<year>/<timestamp>-<filename>
 * Le note sono salvate in R2 come: notes/<year>/<photo-key>.txt
 */

const YEARS = ['2022-2023', '2023-2024', '2024-2025', '2025-2026'];
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function errorResponse(message, status = 400, origin) {
  return jsonResponse({ error: message }, status, origin);
}

/** Verifica il token di accesso */
function authenticate(request, env) {
  const url = new URL(request.url);
  const tokenParam = url.searchParams.get('token');
  const authHeader = request.headers.get('Authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = bearerToken || tokenParam;
  return token === env.ACCESS_TOKEN;
}

/** Estrai anno, chiave e sotto-risorsa dal path */
function parsePath(pathname) {
  // /photos/2021-2022                    → { year, key: null, sub: null }
  // /photos/2021-2022/abc.jpg            → { year, key: 'abc.jpg', sub: null }
  // /photos/2021-2022/abc.jpg/note       → { year, key: 'abc.jpg', sub: 'note' }
  const match = pathname.match(/^\/photos\/([\d]{4}-[\d]{4})(?:\/(.*?))?$/);
  if (!match) return null;
  const year = match[1];
  const rest = match[2] || null;
  if (!rest) return { year, key: null, sub: null };
  // Controlla se finisce con /note
  if (rest.endsWith('/note')) {
    const key = rest.slice(0, -5); // rimuovi '/note'
    return { year, key, sub: 'note' };
  }
  return { year, key: rest, sub: null };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');

    // Preflight CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Auth check
    if (!authenticate(request, env)) {
      return errorResponse('Non autorizzato', 401, origin);
    }

    const url = new URL(request.url);
    const parsed = parsePath(url.pathname);

    if (!parsed) {
      return errorResponse('Endpoint non valido. Usa /photos/<anno>', 404, origin);
    }

    const { year, key, sub } = parsed;

    if (!YEARS.includes(year)) {
      return errorResponse(`Anno non valido. Usa: ${YEARS.join(', ')}`, 400, origin);
    }

    const prefix = `photos/${year}/`;

    // ─── GET /photos/:year/:key/note — leggi nota ───
    if (request.method === 'GET' && key && sub === 'note') {
      const noteKey = `notes/${year}/${key}.txt`;
      const obj = await env.PHOTOS.get(noteKey);
      const note = obj ? await obj.text() : '';
      return jsonResponse({ key, note }, 200, origin);
    }

    // ─── PUT /photos/:year/:key/note — salva nota ───
    if (request.method === 'PUT' && key && sub === 'note') {
      try {
        const body = await request.json();
        const note = (body.note || '').slice(0, 500); // max 500 caratteri
        const noteKey = `notes/${year}/${key}.txt`;
        await env.PHOTOS.put(noteKey, note, {
          httpMetadata: { contentType: 'text/plain' },
        });
        return jsonResponse({ success: true, key, note }, 200, origin);
      } catch (e) {
        return errorResponse(`Errore salvataggio nota: ${e.message}`, 500, origin);
      }
    }

    // ─── GET /photos/:year — lista foto ───
    if (request.method === 'GET' && !key) {
      const list = await env.PHOTOS.list({ prefix });
      const photos = list.objects.map((obj) => ({
        key: obj.key.replace(prefix, ''),
        size: obj.size,
        uploaded: obj.uploaded.toISOString(),
        url: `${url.origin}/photos/${year}/${obj.key.replace(prefix, '')}`,
      }));
      // Ordina per data di upload (più recenti prima)
      photos.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
      return jsonResponse({ year, count: photos.length, photos }, 200, origin);
    }

    // ─── GET /photos/:year/:key — serve immagine ───
    if (request.method === 'GET' && key) {
      const object = await env.PHOTOS.get(`${prefix}${key}`);
      if (!object) {
        return errorResponse('Foto non trovata', 404, origin);
      }
      const headers = new Headers(corsHeaders(origin));
      object.writeHttpMetadata(headers);
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return new Response(object.body, { headers });
    }

    // ─── POST /photos/:year — upload foto ───
    if (request.method === 'POST' && !key) {
      try {
        const formData = await request.formData();
        const file = formData.get('file');

        if (!file || !(file instanceof File)) {
          return errorResponse('Campo "file" mancante', 400, origin);
        }

        if (file.size > MAX_FILE_SIZE) {
          return errorResponse('File troppo grande (max 15MB)', 413, origin);
        }

        // Determina tipo MIME
        const type = file.type || 'image/jpeg';
        if (!ALLOWED_TYPES.includes(type)) {
          return errorResponse(`Tipo non permesso: ${type}. Usa JPEG, PNG o WebP.`, 415, origin);
        }

        // Nome file: timestamp + nome originale (sanitizzato)
        const safeName = file.name
          .replace(/[^a-zA-Z0-9._-]/g, '_')
          .replace(/__+/g, '_')
          .toLowerCase();
        const objectKey = `${prefix}${Date.now()}-${safeName}`;

        await env.PHOTOS.put(objectKey, file.stream(), {
          httpMetadata: { contentType: type },
          customMetadata: { originalName: file.name },
        });

        return jsonResponse(
          {
            success: true,
            key: objectKey.replace(prefix, ''),
            url: `${url.origin}/photos/${year}/${objectKey.replace(prefix, '')}`,
          },
          201,
          origin
        );
      } catch (e) {
        return errorResponse(`Errore upload: ${e.message}`, 500, origin);
      }
    }

    // ─── DELETE /photos/:year/:key — elimina foto + nota ───
    if (request.method === 'DELETE' && key) {
      const existing = await env.PHOTOS.head(`${prefix}${key}`);
      if (!existing) {
        return errorResponse('Foto non trovata', 404, origin);
      }
      await env.PHOTOS.delete(`${prefix}${key}`);
      // Elimina anche la nota associata (se esiste)
      await env.PHOTOS.delete(`notes/${year}/${key}.txt`);
      return jsonResponse({ success: true, deleted: key }, 200, origin);
    }

    return errorResponse('Metodo non permesso', 405, origin);
  },
};
