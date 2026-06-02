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

  // Create indexes (safe with IF NOT EXISTS)
  await client.query('CREATE INDEX IF NOT EXISTS idx_audio_records_user ON audio_records(user_id);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_audio_records_status ON audio_records(status);');
  await client.query('CREATE INDEX IF NOT EXISTS idx_patient_records_pid ON patient_records(patient_id);');
  await client.query('CREATE INDEX IF NOT EXISTS stg_chunks_disease_idx ON stg_chunks(disease);');
  await client.query('CREATE INDEX IF NOT EXISTS stg_chunks_section_idx ON stg_chunks(section);');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS stg_chunks_source_content_hash_idx ON stg_chunks(source, content_hash);');
  await client.query(`CREATE INDEX IF NOT EXISTS stg_chunks_embedding_idx ON stg_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);`);
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
