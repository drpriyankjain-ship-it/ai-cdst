/**
 * Run DB schemas against Supabase
 */
import 'dotenv/config';
import pg from 'pg';

async function run() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('Connected to Supabase ✓');

  // Enable pgvector extension
  console.log('Enabling pgvector...');
  await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
  console.log('pgvector enabled ✓');

  // Run all table creation in correct dependency order
  console.log('Creating tables...');

  // 1. Sessions
  await client.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      data JSONB NOT NULL DEFAULT '{}'
    );
  `);
  console.log('  sessions ✓');

  // 2. Patient records
  await client.query(`
    CREATE TABLE IF NOT EXISTS patient_records (
      patient_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      summary JSONB NOT NULL DEFAULT '{}'
    );
  `);
  console.log('  patient_records ✓');

  // 3. STG chunks (RAG)
  await client.query(`
    CREATE TABLE IF NOT EXISTS stg_chunks (
      chunk_id SERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      disease TEXT,
      section TEXT,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedding vector(384),
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await client.query(`ALTER TABLE stg_chunks ADD COLUMN IF NOT EXISTS section TEXT DEFAULT 'general';`);
  await client.query(`ALTER TABLE stg_chunks ADD COLUMN IF NOT EXISTS content_hash TEXT;`);
  await client.query(`UPDATE stg_chunks SET content_hash = md5(source || E'\\n' || content) WHERE content_hash IS NULL;`);
  await client.query(`ALTER TABLE stg_chunks ALTER COLUMN content_hash SET NOT NULL;`);
  console.log('  stg_chunks ✓');

  // 4. Confirmed encounters
  await client.query(`
    CREATE TABLE IF NOT EXISTS confirmed_encounters (
      encounter_id SERIAL PRIMARY KEY,
      session_id TEXT REFERENCES sessions(session_id),
      district_code TEXT NOT NULL,
      month INT NOT NULL,
      disease TEXT NOT NULL,
      confirmation_gates JSONB NOT NULL,
      confidence_weight FLOAT NOT NULL,
      recorded_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('  confirmed_encounters ✓');

  // 5. Users (mobile app auth)
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      phone TEXT,
      role TEXT DEFAULT 'nurse',
      otp_code TEXT,
      otp_expires_at TIMESTAMPTZ,
      verified BOOLEAN DEFAULT FALSE,
      consent_given BOOLEAN DEFAULT FALSE,
      consent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('  users ✓');

  // 6. Audio records
  await client.query(`
    CREATE TABLE IF NOT EXISTS audio_records (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      patient_name TEXT,
      patient_id TEXT,
      file_path TEXT,
      transcript TEXT,
      ai_suggestion JSONB,
      status TEXT DEFAULT 'pending',
      flag_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('  audio_records ✓');

  // 7. LLM Results
  await client.query(`
    CREATE TABLE IF NOT EXISTS llm_results (
      id            SERIAL PRIMARY KEY,
      session_id    TEXT NOT NULL REFERENCES sessions(session_id),
      call_name     TEXT NOT NULL,
      stage         TEXT NOT NULL,
      call_order    INT NOT NULL,
      model_used    TEXT,
      input_tokens  INT,
      output_tokens INT,
      latency_ms    INT,
      cost_usd      NUMERIC(10,6),
      result        JSONB NOT NULL DEFAULT '{}',
      error         TEXT,
      created_at    TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('  llm_results ✓');

  // 8. Pipeline Failures
  await client.query(`
    CREATE TABLE IF NOT EXISTS pipeline_failures (
      id          SERIAL PRIMARY KEY,
      session_id  TEXT REFERENCES sessions(session_id),
      user_id     TEXT,
      stage       TEXT,
      call_name   TEXT,
      error_code  TEXT,
      error_msg   TEXT,
      created_at  TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('  pipeline_failures ✓');

  // 9. Session Metrics
  await client.query(`
    CREATE TABLE IF NOT EXISTS session_metrics (
      session_id               TEXT PRIMARY KEY REFERENCES sessions(session_id),
      user_id                  TEXT,
      patient_id               TEXT,
      total_llm_calls          INT,
      total_input_tokens       INT,
      total_output_tokens      INT,
      total_cost_usd           NUMERIC(10,6),
      total_latency_ms         INT,
      e2e_duration_ms          INT,
      gps_lat                  NUMERIC(9,6),
      gps_lon                  NUMERIC(9,6),
      district_code            TEXT,
      risk_tier                TEXT,
      pipeline_status          TEXT,
      network_rtt_ms           INT,
      total_transcription_ms   INT,
      total_server_overhead_ms INT,
      phase_timings            JSONB,
      created_at               TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('  session_metrics ✓');

  // 10. Case Queue
  await client.query(`
    CREATE TABLE IF NOT EXISTS case_queue (
      session_id  TEXT PRIMARY KEY REFERENCES sessions(session_id),
      risk_tier   TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active',
      cleared_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('  case_queue ✓');

  // Create indexes (safe with IF NOT EXISTS)
  await client.query('CREATE INDEX IF NOT EXISTS idx_audio_records_user ON audio_records(user_id);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_audio_records_status ON audio_records(status);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_patient_records_pid ON patient_records(patient_id);');
  await client.query('CREATE INDEX IF NOT EXISTS stg_chunks_disease_idx ON stg_chunks(disease);');
  await client.query('CREATE INDEX IF NOT EXISTS stg_chunks_section_idx ON stg_chunks(section);');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS stg_chunks_source_content_hash_idx ON stg_chunks(source, content_hash);');
  await client.query(`CREATE INDEX IF NOT EXISTS stg_chunks_embedding_idx ON stg_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);`);
  await client.query('CREATE INDEX IF NOT EXISTS idx_llm_results_session ON llm_results(session_id);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_llm_results_call_name ON llm_results(call_name);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_llm_results_model ON llm_results(model_used);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_pipeline_failures_session ON pipeline_failures(session_id);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_pipeline_failures_created ON pipeline_failures(created_at);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_pipeline_failures_user ON pipeline_failures(user_id);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_session_metrics_user ON session_metrics(user_id);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_session_metrics_created ON session_metrics(created_at);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_session_metrics_risk ON session_metrics(risk_tier);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_case_queue_status ON case_queue(status, created_at);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_case_queue_risk ON case_queue(risk_tier);');
  console.log('  indexes ✓');

  // Updated_at trigger function
  await client.query(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = now(); RETURN NEW; END;
    $$ LANGUAGE plpgsql;
  `);
  console.log('  trigger function ✓');

  // Verify tables
  const res = await client.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' ORDER BY table_name
  `);
  console.log('\nAll public tables:');
  res.rows.forEach(r => console.log(`  - ${r.table_name}`));

  await client.end();
  console.log('\n✅ Database setup complete!');
}

run().catch(err => {
  console.error('Schema setup failed:', err.message);
  process.exit(1);
});
