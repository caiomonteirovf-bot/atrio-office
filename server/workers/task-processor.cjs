#!/usr/bin/env node
/**
 * Task Processor CommonJS - Processa tasks pendentes
 */

const { Pool } = require('pg');
const { tools } = require('../tools/campelo.js');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'atrio_office',
  user: process.env.DB_USER || 'atrio',
  password: process.env.DB_PASSWORD || 'atrio'
});

async function processarTasks() {
  const client = await pool.connect();
  try {
    const { rows: tasks } = await client.query(`
      SELECT * FROM luna_v2.tasks 
      WHERE status = 'pending' 
        AND agente_designado = 'campelo'
      ORDER BY created_at ASC
      LIMIT 3
    `);

    for (const task of tasks) {
      console.log(`[TaskProcessor] Processando ${task.id}`);
      
      await client.query(`
        UPDATE luna_v2.tasks SET status = 'processing', started_at = NOW()
        WHERE id = $1
      `, [task.id]);

      try {
        if (task.tipo === 'nfse_emitir') {
          const payload = task.payload || {};
          const { cnpj, valor, descricao } = payload;
          
          if (!cnpj || !valor || !descricao) {
            throw new Error('Dados incompletos');
          }

          const resultado = await tools.emitir_nfse({
            prestador_cnpj: payload.prestador_cnpj || '12345678000195',
            tomador_cpf_cnpj: cnpj,
            valor: parseFloat(valor),
            descricao,
            task_id: task.id
          });

          await client.query(`
            UPDATE luna_v2.tasks 
            SET status = 'completed', completed_at = NOW(), resultado = $2
            WHERE id = $1
          `, [task.id, JSON.stringify(resultado)]);

          console.log(`[TaskProcessor] Task ${task.id} OK`);
        }
      } catch (err) {
        console.error(`[TaskProcessor] Erro ${task.id}:`, err.message);
        await client.query(`
          UPDATE luna_v2.tasks 
          SET status = 'failed', resultado = $2, tentativas = tentativas + 1
          WHERE id = $1
        `, [task.id, JSON.stringify({ erro: err.message })]);
      }
    }
  } finally {
    client.release();
  }
}

console.log('[TaskProcessor] Iniciado');
processarTasks();
setInterval(processarTasks, 30000);
