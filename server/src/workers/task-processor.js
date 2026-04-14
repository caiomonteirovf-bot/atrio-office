#!/usr/bin/env node
/**
 * Task Processor - Processa tasks pendentes do Luna v2
 * Roda como cron/job no container
 */

import pkg from 'pg';
const { Pool } = pkg;
import { tools } from '../tools/campelo.js';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'atrio_office',
  user: process.env.DB_USER || 'atrio',
  password: process.env.DB_PASSWORD || 'atrio',
  schema: 'luna_v2'
});

async function processarTasks() {
  const client = await pool.connect();
  try {
    // Buscar tasks pendentes não atribuídas
    const { rows: tasks } = await client.query(`
      SELECT * FROM luna_v2.tasks 
      WHERE status = 'pending' 
        AND agente_designado IS NOT NULL
        AND started_at IS NULL
      ORDER BY created_at ASC
      LIMIT 5
    `);

    for (const task of tasks) {
      console.log(`[TaskProcessor] Processando task ${task.id} - ${task.tipo}`);
      
      // Marcar como iniciada
      await client.query(`
        UPDATE luna_v2.tasks 
        SET status = 'processing', started_at = NOW()
        WHERE id = $1
      `, [task.id]);

      try {
        let resultado = null;

        // Executar baseado no tipo
        if (task.tipo === 'nfse_emitir' && task.agente_designado === 'campelo') {
          const { cnpj, valor, descricao } = task.payload || {};
          
          if (!cnpj || !valor || !descricao) {
            throw new Error(`Dados incompletos: CNPJ=${cnpj}, valor=${valor}, desc=${descricao}`);
          }

          // Buscar prestador pelo telefone do cliente
          const phone = task.cliente_phone || task.payload?.phone;
          let prestador_cnpj = task.payload?.prestador_cnpj;
          
          if (!prestador_cnpj && phone) {
            const { rows: clientes } = await client.query(`
              SELECT cnpj, contatos FROM luna_v2.clients
              WHERE contatos->>'whatsapp' = $1 OR contatos->>'telefone' = $1
              LIMIT 1
            `, [phone]);
            
            if (clientes.length > 0) {
              prestador_cnpj = clientes[0].cnpj;
            }
          }

          if (!prestador_cnpj) {
            throw new Error('CNPJ do prestador não encontrado');
          }

          // Emitir NFSe
          resultado = await tools.emitir_nfse({
            prestador_cnpj,
            tomador_cpf_cnpj: cnpj,
            valor: parseFloat(valor),
            descricao,
            task_id: task.id
          });
        }

        // Marcar como completa
        await client.query(`
          UPDATE luna_v2.tasks 
          SET status = 'completed', 
              completed_at = NOW(),
              resultado = $2
          WHERE id = $1
        `, [task.id, JSON.stringify(resultado)]);

        console.log(`[TaskProcessor] Task ${task.id} completada`);

      } catch (err) {
        console.error(`[TaskProcessor] Erro na task ${task.id}:`, err.message);
        
        await client.query(`
          UPDATE luna_v2.tasks 
          SET status = 'failed',
              resultado = $2,
              tentativas = tentativas + 1
          WHERE id = $1
        `, [task.id, JSON.stringify({ erro: err.message })]);
      }
    }

  } finally {
    client.release();
  }
}

// Rodar imediatamente e a cada 30 segundos
console.log('[TaskProcessor] Iniciado');
processarTasks();
setInterval(processarTasks, 30000);
