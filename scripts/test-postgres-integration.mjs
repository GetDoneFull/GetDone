import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";

const baseConnectionString = process.env.DATABASE_URL?.trim();
if (!baseConnectionString) throw new Error("DATABASE_URL is required");

const ssl = process.env.GETDONE_DB_SSL === "false"
  ? false
  : { rejectUnauthorized: true };

function databaseUrl(name) {
  const url = new URL(baseConnectionString);
  url.pathname = `/${name}`;
  return url.toString();
}

function quoteIdentifier(value) {
  return '"' + value.replaceAll('"', '""') + '"';
}

function runNode(scriptPath, env = {}) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(
      `${scriptPath} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
  return result.stdout.trim();
}

async function withPool(connectionString, operation) {
  const pool = new pg.Pool({
    connectionString,
    max: 6,
    application_name: "getdone-postgres-integration",
    ssl
  });
  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
}

async function createDatabase(adminPool, name) {
  await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
  await adminPool.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
}

async function dropDatabase(adminPool, name) {
  await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
}

function runMigrations(connectionString, target) {
  runNode("scripts/migrate-postgres.mjs", {
    DATABASE_URL: connectionString,
    GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false",
    ...(target ? { GETDONE_MIGRATION_TARGET: target } : {})
  });
}

function runProductionVerifier(connectionString) {
  return runNode("scripts/verify-postgres-production.mjs", {
    DATABASE_URL: connectionString,
    GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false",
    GETDONE_BACKUP_MAX_AGE_HOURS: "24"
  });
}

async function seedVerifiedBackupFixture(pool) {
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO database_backup_evidence
      (id,completed_at,status,backup_ref_hash,verification_hash,payload)
     VALUES($1,$2,'verified',$3,$4,$5::jsonb)`,
    [
      crypto.randomUUID(),
      now,
      "b".repeat(64),
      "a".repeat(64),
      JSON.stringify({
        source: "postgres-integration-fixture",
        completedAt: now,
        status: "verified"
      })
    ]
  );
}

async function assertMigrationState(pool, expectedLatest, expectedVersions) {
  const result = await pool.query(
    "SELECT version FROM getdone_schema_migrations ORDER BY version"
  );
  const versions = result.rows.map((row) => row.version);
  const latest = versions.at(-1);
  if (latest !== expectedLatest) {
    throw new Error(`Expected latest migration ${expectedLatest}, got ${latest ?? "none"}`);
  }
  if (expectedVersions) {
    const actual = JSON.stringify(versions);
    const expected = JSON.stringify(expectedVersions);
    if (actual !== expected) {
      throw new Error(`Migration sequence mismatch. Expected ${expected}, got ${actual}`);
    }
  }
}

async function assertOneUniqueViolation(label, operations) {
  const results = await Promise.allSettled(operations);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  if (fulfilled.length !== 1 || rejected.length !== 1) {
    throw new Error(`${label}: expected one success and one rejected concurrent write`);
  }
  const code = rejected[0].reason?.code;
  if (code !== "23505") {
    throw new Error(`${label}: expected PostgreSQL unique violation 23505, got ${String(code)}`);
  }
}

async function transactionalInsert(client, sql, values) {
  await client.query("BEGIN");
  try {
    await client.query(sql, values);
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  }
}

async function testConcurrentConstraints(connectionString) {
  return withPool(connectionString, async (pool) => {
    await pool.query(
      `INSERT INTO authorization_grants
        (id,portfolio_id,company_id,status,expires_at,grant_hash,payload)
       VALUES('grant-race','portfolio','company','active',now() + interval '1 hour',$1,$2::jsonb)`,
      ["g".repeat(64), JSON.stringify({ id: "grant-race" })]
    );

    const authA = await pool.connect();
    const authB = await pool.connect();
    try {
      await assertOneUniqueViolation("authorization consumption uniqueness", [
        transactionalInsert(
          authA,
          `INSERT INTO authorization_consumptions
            (id,grant_id,consumer_type,consumer_id,consumption_hash,consumed_at,payload)
           VALUES('consumption-a','grant-race','task','task-a',$1,now(),$2::jsonb)`,
          ["1".repeat(64), JSON.stringify({ id: "consumption-a" })]
        ),
        transactionalInsert(
          authB,
          `INSERT INTO authorization_consumptions
            (id,grant_id,consumer_type,consumer_id,consumption_hash,consumed_at,payload)
           VALUES('consumption-b','grant-race','task','task-b',$1,now(),$2::jsonb)`,
          ["2".repeat(64), JSON.stringify({ id: "consumption-b" })]
        )
      ]);
    } finally {
      authA.release();
      authB.release();
    }

    const leaseA = await pool.connect();
    const leaseB = await pool.connect();
    try {
      await assertOneUniqueViolation("active Job lease uniqueness", [
        transactionalInsert(
          leaseA,
          `INSERT INTO job_leases
            (id,job_id,worker_id,state,expires_at,lease_hash,version,payload)
           VALUES('lease-a','job-race','worker-a','active',now() + interval '1 minute',$1,1,$2::jsonb)`,
          ["3".repeat(64), JSON.stringify({ id: "lease-a" })]
        ),
        transactionalInsert(
          leaseB,
          `INSERT INTO job_leases
            (id,job_id,worker_id,state,expires_at,lease_hash,version,payload)
           VALUES('lease-b','job-race','worker-b','active',now() + interval '1 minute',$1,1,$2::jsonb)`,
          ["4".repeat(64), JSON.stringify({ id: "lease-b" })]
        )
      ]);
    } finally {
      leaseA.release();
      leaseB.release();
    }

    const txA = await pool.connect();
    const txB = await pool.connect();
    try {
      await assertOneUniqueViolation("Job runtime transaction idempotency", [
        transactionalInsert(
          txA,
          `INSERT INTO job_runtime_transactions
            (id,job_id,operation,idempotency_key,transaction_hash,payload,occurred_at)
           VALUES('runtime-tx-a','job-tx','claim','idem-race',$1,$2::jsonb,now())`,
          ["5".repeat(64), JSON.stringify({ id: "runtime-tx-a" })]
        ),
        transactionalInsert(
          txB,
          `INSERT INTO job_runtime_transactions
            (id,job_id,operation,idempotency_key,transaction_hash,payload,occurred_at)
           VALUES('runtime-tx-b','job-tx','claim','idem-race',$1,$2::jsonb,now())`,
          ["6".repeat(64), JSON.stringify({ id: "runtime-tx-b" })]
        )
      ]);
    } finally {
      txA.release();
      txB.release();
    }

    await pool.query(
      `INSERT INTO capacity_ledgers
        (id,portfolio_id,company_id,revision,ledger_hash,payload)
       VALUES('ledger-race','portfolio','company',1,$1,$2::jsonb)`,
      ["7".repeat(64), JSON.stringify({ id: "ledger-race", revision: 1 })]
    );

    const serialA = await pool.connect();
    const serialB = await pool.connect();
    try {
      await Promise.all([
        serialA.query("BEGIN ISOLATION LEVEL SERIALIZABLE"),
        serialB.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
      ]);
      await Promise.all([
        serialA.query("SELECT revision FROM capacity_ledgers WHERE id='ledger-race'"),
        serialB.query("SELECT revision FROM capacity_ledgers WHERE id='ledger-race'")
      ]);

      async function updateAndCommit(client, suffix) {
        try {
          await client.query(
            `UPDATE capacity_ledgers
             SET revision=revision+1,ledger_hash=$1,payload=$2::jsonb
             WHERE id='ledger-race'`,
            [suffix.repeat(64), JSON.stringify({ id: "ledger-race", writer: suffix })]
          );
          await client.query("COMMIT");
        } catch (error) {
          try { await client.query("ROLLBACK"); } catch {}
          throw error;
        }
      }

      const serialResults = await Promise.allSettled([
        updateAndCommit(serialA, "8"),
        updateAndCommit(serialB, "9")
      ]);
      const serialSuccesses = serialResults.filter((result) => result.status === "fulfilled");
      const serialFailures = serialResults.filter((result) => result.status === "rejected");
      if (serialSuccesses.length !== 1 || serialFailures.length !== 1) {
        throw new Error("Serializable race: expected exactly one committed writer");
      }
      if (serialFailures[0].reason?.code !== "40001") {
        throw new Error(
          `Serializable race: expected serialization failure 40001, got ${String(serialFailures[0].reason?.code)}`
        );
      }
    } finally {
      serialA.release();
      serialB.release();
    }
  });
}

const adminPool = new pg.Pool({
  connectionString: baseConnectionString,
  max: 2,
  application_name: "getdone-postgres-integration-admin",
  ssl
});

const suffix = process.pid.toString(36);
const databases = {
  empty: `getdone_it_empty_${suffix}`,
  upgrade: `getdone_it_upgrade_${suffix}`,
  concurrency: `getdone_it_concurrency_${suffix}`
};
const allMigrationVersions = [
  "2026-09-21.1",
  "2026-09-21.2",
  "2026-09-21.3",
  "2026-09-21.4",
  "2026-09-21.5",
  "2026-09-22.1",
  "2026-09-22.2",
  "2026-09-22.3",
  "2026-09-23.1",
  "2026-09-23.2",
  "2026-09-23.3",
  "2026-09-24.1",
  "2026-09-24.2",
  "2026-09-24.3",
  "2026-09-25.1",
  "2026-09-25.2",
  "2026-09-25.3",
  "2026-09-28.1",
  "2026-09-28.2",
  "2026-09-28.3",
  "2026-09-28.4",
  "2026-09-28.5",
  "2026-09-28.6"
];

try {
  const version = await adminPool.query("SHOW server_version_num");
  const serverVersionNum = Number(version.rows[0]?.server_version_num);
  if (!Number.isFinite(serverVersionNum) || serverVersionNum < 160000) {
    throw new Error(`PostgreSQL 16+ is required; server_version_num=${serverVersionNum}`);
  }

  for (const name of Object.values(databases)) await createDatabase(adminPool, name);

  const emptyUrl = databaseUrl(databases.empty);
  runMigrations(emptyUrl);
  await withPool(emptyUrl, async (pool) => {
    await assertMigrationState(pool, "2026-09-28.6", allMigrationVersions);
    await seedVerifiedBackupFixture(pool);
  });
  const emptyVerification = runProductionVerifier(emptyUrl);

  const upgradeUrl = databaseUrl(databases.upgrade);
  runMigrations(upgradeUrl, "2026-09-22.3");
  await withPool(upgradeUrl, async (pool) => {
    await assertMigrationState(
      pool,
      "2026-09-22.3",
      allMigrationVersions.slice(0, -15)
    );
  });
  runMigrations(upgradeUrl);
  await withPool(upgradeUrl, async (pool) => {
    await assertMigrationState(pool, "2026-09-28.6", allMigrationVersions);
    await seedVerifiedBackupFixture(pool);
  });
  const upgradeVerification = runProductionVerifier(upgradeUrl);

  const concurrencyUrl = databaseUrl(databases.concurrency);
  runMigrations(concurrencyUrl);
  await testConcurrentConstraints(concurrencyUrl);

  console.log(JSON.stringify({
    postgresMajor: Math.floor(serverVersionNum / 10000),
    latestMigration: "2026-09-28.6",
    emptyDatabaseMigration: "verified",
    previousVersionUpgrade: "verified",
    productionVerifierEmptyDatabase: JSON.parse(emptyVerification),
    productionVerifierUpgradeDatabase: JSON.parse(upgradeVerification),
    authorizationConsumptionRace: "verified",
    activeJobLeaseRace: "verified",
    jobRuntimeTransactionRace: "verified",
    serializableWriteRace: "verified"
  }, null, 2));
} finally {
  for (const name of Object.values(databases)) {
    try { await dropDatabase(adminPool, name); } catch {}
  }
  await adminPool.end();
}
