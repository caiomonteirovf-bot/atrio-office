#!/usr/bin/env node
/**
 * WARNING: NAO REMOVER. prebuild hook do package.json depende disso.
 * Sem cache busting do SW, navegadores servem bundle antigo apos deploy
 * (problema recorrente que custou horas de debug em 07/05/2026).
 * Ver: RUNBOOK.md > "Browser mostra UI antiga após deploy"
 *
 * Pre-build: atualiza CACHE_VERSION no public/sw.js pra forçar o navegador a baixar
 * o bundle novo (invalida cache do Service Worker).
 *
 * Sem isso, usuários ficam vendo a versão antiga depois de cada deploy. Já aconteceu.
 *
 * Uso: rodado automaticamente pelo "prebuild" no package.json antes de "vite build".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const swPath = path.resolve(__dirname, '..', 'public', 'sw.js');

if (!fs.existsSync(swPath)) {
  console.warn(`[bump-sw] ${swPath} não existe — pulando.`);
  process.exit(0);
}

const src = fs.readFileSync(swPath, 'utf-8');
const newVersion = `atrio-office-v${Date.now()}`;
const re = /CACHE_VERSION\s*=\s*['"][^'"]*['"]/;

if (!re.test(src)) {
  console.warn('[bump-sw] CACHE_VERSION não encontrada no sw.js — verificar formato esperado.');
  process.exit(0);
}

const updated = src.replace(re, `CACHE_VERSION = '${newVersion}'`);
fs.writeFileSync(swPath, updated);
console.log(`[bump-sw] CACHE_VERSION → ${newVersion}`);
