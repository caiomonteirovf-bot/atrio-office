// routes/skills.js
// Endpoints publicos para o catalogo de skills.

import { listSkills, getSkill, renderSkill, loadSkills } from '../services/skill-registry.js';

export function registerSkillsRoutes(app) {
  app.get('/api/skills', async (_req, res) => {
    try { res.json({ ok: true, data: await listSkills() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/skills/:name', async (req, res) => {
    try {
      const s = await getSkill(req.params.name);
      if (!s) return res.status(404).json({ error: 'skill nao encontrada' });
      res.json({ ok: true, data: s });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/skills/:name/render', async (req, res) => {
    try {
      const { params = {}, agent = null } = req.body || {};
      const rendered = await renderSkill(req.params.name, params, agent);
      res.json({ ok: true, ...rendered });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/skills/reload', async (_req, res) => {
    try {
      await loadSkills(true);
      res.json({ ok: true, reloaded: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
