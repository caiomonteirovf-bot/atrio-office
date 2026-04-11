import { query } from '../db/pool.js'

// Handler registry — maps handler names to async functions
const handlers = {}

export function registerCronHandler(name, fn) {
  handlers[name] = fn
}

export function getCronHandler(name) {
  return handlers[name] || null
}

// Execute a cron job and record the run in cron_runs
export async function executeCronJob(job) {
  const startedAt = new Date()
  try {
    const handler = handlers[job.handler]
    let output = 'No handler registered'

    if (handler) {
      output = await handler() || 'OK'
    }

    const duration = Date.now() - startedAt.getTime()

    // Record successful run
    await query(
      `INSERT INTO cron_runs (cron_job_id, status, duration_ms, output, started_at, finished_at)
       VALUES ($1, 'success', $2, $3, $4, NOW())`,
      [job.id, duration, String(output).substring(0, 1000), startedAt]
    )

    // Update job stats
    await query(
      `UPDATE cron_jobs SET last_run = NOW(), last_result = 'success', run_count = run_count + 1, last_error = NULL WHERE id = $1`,
      [job.id]
    )

    console.log(`[CRON] ${job.name} completed in ${duration}ms`)
    return { success: true, duration, output }
  } catch (err) {
    const duration = Date.now() - startedAt.getTime()

    await query(
      `INSERT INTO cron_runs (cron_job_id, status, duration_ms, error, started_at, finished_at)
       VALUES ($1, 'error', $2, $3, $4, NOW())`,
      [job.id, duration, err.message, startedAt]
    ).catch(() => {})

    await query(
      `UPDATE cron_jobs SET last_run = NOW(), last_result = 'error', run_count = run_count + 1, last_error = $2 WHERE id = $1`,
      [job.id, err.message]
    ).catch(() => {})

    console.error(`[CRON] ${job.name} failed:`, err.message)
    return { success: false, duration, error: err.message }
  }
}

// Parse cron schedule and check if it should run now
function shouldRunNow(schedule) {
  const now = new Date()
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return false

  const [min, hour, dom, month, dow] = parts

  const matches = (field, value) => {
    if (field === '*') return true
    if (field.startsWith('*/')) {
      const interval = parseInt(field.substring(2))
      return interval > 0 && value % interval === 0
    }
    if (field.includes(',')) return field.split(',').map(Number).includes(value)
    if (field.includes('-')) {
      const [start, end] = field.split('-').map(Number)
      return value >= start && value <= end
    }
    return parseInt(field) === value
  }

  return matches(min, now.getMinutes()) &&
         matches(hour, now.getHours()) &&
         matches(dom, now.getDate()) &&
         matches(month, now.getMonth() + 1) &&
         matches(dow, now.getDay())
}

// Main ticker — runs every minute, checks all active cron jobs
let tickerInterval = null

export async function startCronScheduler() {
  console.log('[CRON] Scheduler starting...')

  // Run check every 60 seconds
  tickerInterval = setInterval(async () => {
    try {
      const { rows: jobs } = await query("SELECT * FROM cron_jobs WHERE status = 'active'")

      for (const job of jobs) {
        if (shouldRunNow(job.schedule)) {
          // Avoid double-execution: skip if last_run was less than 60 seconds ago
          if (job.last_run) {
            const lastRun = new Date(job.last_run)
            if (Date.now() - lastRun.getTime() < 55000) continue
          }
          executeCronJob(job) // fire-and-forget
        }
      }
    } catch (err) {
      console.error('[CRON] Ticker error:', err.message)
    }
  }, 60000)

  console.log('[CRON] Scheduler active — checking every 60s')
}

export function stopCronScheduler() {
  if (tickerInterval) {
    clearInterval(tickerInterval)
    tickerInterval = null
    console.log('[CRON] Scheduler stopped')
  }
}
