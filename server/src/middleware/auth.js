/**
 * Atrio Office — Middleware de auth compartilhado com Gesthub.
 *
 * Estratégia: o cookie httpOnly `gesthub_session` é setado pelo Gesthub
 * em http://31.97.175.200/ (porta 80). Como o Office roda no mesmo IP
 * (porta 3010, mas frontend é servido via mesmo nginx em /office/* OR
 * direto na 3010), o cookie chega aqui.
 *
 * Usamos o mesmo GESTHUB_JWT_SECRET pra decodar o JWT localmente.
 * Sem chamada cross-domain.
 */
import jwt from 'jsonwebtoken';

const SECRET = process.env.GESTHUB_JWT_SECRET || 'dev-secret-change-me-in-prod-2026';
const COOKIE_NAME = 'gesthub_session';


function parseCookieHeader(header) {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map(c => {
      const [k, ...rest] = c.trim().split('=');
      return [k, decodeURIComponent(rest.join('='))];
    })
  );
}


export function decodeSession(req) {
  const cookies = parseCookieHeader(req.headers.cookie || '');
  const token = cookies[COOKIE_NAME] ||
                (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    return jwt.verify(token, SECRET, { issuer: 'gesthub' });
  } catch {
    return null;
  }
}


/** Coloca req.user (se autenticado) sem bloquear. */
export function attachUser(req, res, next) {
  const payload = decodeSession(req);
  if (payload) {
    req.user = {
      id: parseInt(payload.sub, 10),
      role: payload.role,
      email: payload.email,
    };
  }
  next();
}


/** Bloqueia se não autenticado. */
export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Sessão inválida ou ausente.' });
  }
  next();
}


/** Bloqueia se não for admin. */
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito (admin).' });
  }
  next();
}
