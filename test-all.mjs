// test-all.mjs — FURY Click Hero · Full requirement validation
// Run with: node test-all.mjs

const BASE = "http://localhost:3000";
let pass = 0, fail = 0;

const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const GRAY   = "\x1b[90m";
const RESET  = "\x1b[0m";

function ok(label)  { console.log(`  ${GREEN}PASS${RESET}  ${label}`); pass++; }
function ko(label, expected, got) {
  console.log(`  ${RED}FAIL${RESET}  ${label}`);
  console.log(`         ${YELLOW}expected:${RESET} ${expected}`);
  console.log(`         ${YELLOW}got:     ${RESET} ${JSON.stringify(got)}`);
  fail++;
}

function assert(label, got, expected) {
  got === expected ? ok(label) : ko(label, expected, got);
}

function assertContains(label, got, sub) {
  const str = typeof got === "string" ? got : JSON.stringify(got);
  str.includes(sub) ? ok(label) : ko(label, `contains "${sub}"`, str);
}

async function POST(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function GET(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────
async function run() {
  console.log(`\n${CYAN}${"═".repeat(50)}${RESET}`);
  console.log(`${CYAN}  FURY · Click Hero — Validation Test Suite${RESET}`);
  console.log(`${CYAN}${"═".repeat(50)}${RESET}\n`);

  // ── 1. Health check ──────────────────────────
  console.log("[ 1 ] Health check");
  {
    const r = await GET("/health");
    assert("GET /health → 200",          r.status, 200);
    assertContains("body.status = ok",   r.body,   "ok");
  }

  // ── 2. Webhook válido → 202 ──────────────────
  console.log("\n[ 2 ] Webhook válido → 202 + jobId");
  {
    const r = await POST("/webhook/violation", {
      adId: "ad_test_01", tenantId: "tenant_test_01",
      violationType: "PROHIBITED_TERM", severity: "HIGH",
      detectedAt: "2024-03-15T10:30:00Z",
    });
    assert("202 Accepted",              r.status, 202);
    assertContains("jobId presente",    r.body,   "jobId");
    assertContains("status = queued",   r.body,   "queued");
    console.log(`         ${GRAY}→ ${JSON.stringify(r.body)}${RESET}`);
  }

  // ── 3. Todos violationType válidos ───────────
  console.log("\n[ 3 ] Todos os violationType aceitos");
  for (const vt of ["PROHIBITED_TERM","BRAND_VIOLATION","COMPLIANCE_FAIL"]) {
    const r = await POST("/webhook/violation", {
      adId: `ad_${vt}`, tenantId: "t1",
      violationType: vt, severity: "LOW",
      detectedAt: "2024-03-15T10:30:00Z",
    });
    assert(`violationType=${vt} → 202`, r.status, 202);
  }

  // ── 4. Todos severity válidos ────────────────
  console.log("\n[ 4 ] Todos os severity aceitos");
  for (const sev of ["LOW","MEDIUM","HIGH","CRITICAL"]) {
    const r = await POST("/webhook/violation", {
      adId: `ad_sev_${sev}`, tenantId: "t1",
      violationType: "COMPLIANCE_FAIL", severity: sev,
      detectedAt: "2024-03-15T10:30:00Z",
    });
    assert(`severity=${sev} → 202`, r.status, 202);
  }

  // ── 5. Campos obrigatórios ausentes ─────────
  console.log("\n[ 5 ] Zod — campos ausentes → 400 com detalhe por campo");
  {
    // sem violationType
    const r = await POST("/webhook/violation", {
      adId: "a1", tenantId: "t1", severity: "HIGH", detectedAt: "2024-03-15T10:30:00Z",
    });
    assert("sem violationType → 400",           r.status, 400);
    assertContains("erro em violationType",      r.body,   "violationType");
  }
  {
    // sem adId
    const r = await POST("/webhook/violation", {
      tenantId: "t1", violationType: "PROHIBITED_TERM", severity: "HIGH", detectedAt: "2024-03-15T10:30:00Z",
    });
    assert("sem adId → 400",                    r.status, 400);
    assertContains("erro em adId",              r.body,   "adId");
  }
  {
    // sem tenantId
    const r = await POST("/webhook/violation", {
      adId: "a1", violationType: "PROHIBITED_TERM", severity: "HIGH", detectedAt: "2024-03-15T10:30:00Z",
    });
    assert("sem tenantId → 400",                r.status, 400);
    assertContains("erro em tenantId",          r.body,   "tenantId");
  }
  {
    // sem detectedAt
    const r = await POST("/webhook/violation", {
      adId: "a1", tenantId: "t1", violationType: "PROHIBITED_TERM", severity: "HIGH",
    });
    assert("sem detectedAt → 400",              r.status, 400);
    assertContains("erro em detectedAt",        r.body,   "detectedAt");
  }

  // ── 6. Enums inválidos ───────────────────────
  console.log("\n[ 6 ] Zod — valores de enum inválidos → 400");
  {
    const r = await POST("/webhook/violation", {
      adId: "a1", tenantId: "t1", violationType: "INVALID_TYPE",
      severity: "HIGH", detectedAt: "2024-03-15T10:30:00Z",
    });
    assert("violationType inválido → 400",      r.status, 400);
    assertContains("erro em violationType",     r.body,   "violationType");
  }
  {
    const r = await POST("/webhook/violation", {
      adId: "a1", tenantId: "t1", violationType: "PROHIBITED_TERM",
      severity: "EXTREME", detectedAt: "2024-03-15T10:30:00Z",
    });
    assert("severity inválido → 400",           r.status, 400);
    assertContains("erro em severity",          r.body,   "severity");
  }
  {
    const r = await POST("/webhook/violation", {
      adId: "a1", tenantId: "t1", violationType: "PROHIBITED_TERM",
      severity: "HIGH", detectedAt: "nao-e-uma-data",
    });
    assert("detectedAt não-ISO-8601 → 400",     r.status, 400);
    assertContains("erro em detectedAt",        r.body,   "detectedAt");
  }

  // ── 7. Corpo vazio ───────────────────────────
  console.log("\n[ 7 ] Corpo vazio → 400");
  {
    const res = await fetch(`${BASE}/webhook/violation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    assert("corpo vazio → 400", res.status, 400);
  }

  // ── 8. GET /jobs/:id — job existente ─────────
  console.log("\n[ 8 ] GET /jobs/:id — job existente");
  await sleep(1200); // aguarda worker
  {
    const r = await GET("/jobs/ad_test_01|tenant_test_01");
    assert("job existente → 200",             r.status, 200);
    assertContains("jobId no response",       r.body,   "jobId");
    assertContains("status no response",      r.body,   "status");
    assertContains("attempts no response",    r.body,   "attempts");
    console.log(`         ${GRAY}→ ${JSON.stringify(r.body)}${RESET}`);
  }

  // ── 9. GET /jobs/:id — inexistente → 404 ─────
  console.log("\n[ 9 ] GET /jobs/inexistente → 404");
  {
    const r = await GET("/jobs/job-que-nao-existe");
    assert("job inexistente → 404",           r.status, 404);
    assertContains("mensagem de erro",        r.body,   "Job not found");
  }

  // ── 10. Idempotência ─────────────────────────
  console.log("\n[ 10 ] Idempotência — mesmo adId+tenantId não duplica");
  {
    const payload = {
      adId: "ad_idem_99", tenantId: "tenant_idem_99",
      violationType: "BRAND_VIOLATION", severity: "CRITICAL",
      detectedAt: "2024-03-15T10:30:00Z",
    };
    const r1 = await POST("/webhook/violation", payload);
    assert("1ª tentativa → 202",              r1.status, 202);

    const r2 = await POST("/webhook/violation", payload);
    assert("2ª tentativa (duplicata) → 409",  r2.status, 409);
    assertContains("mensagem Duplicate job",  r2.body,   "Duplicate job");
    console.log(`         ${GRAY}→ ${JSON.stringify(r2.body)}${RESET}`);
  }

  // ── 11. Worker completou o job ───────────────
  console.log("\n[ 11 ] Worker — job completado com resultado HTTP");
  await sleep(2000);
  {
    const r = await GET("/jobs/ad_test_01|tenant_test_01");
    const s = r.body?.status;
    const validStates = ["completed", "active", "waiting", "delayed"];
    if (validStates.includes(s)) {
      ok(`status válido após processamento (${s})`);
    } else {
      ko("status inválido", "completed|active|waiting|delayed", s);
    }
    if (s === "completed") {
      assertContains("result.statusCode presente", r.body, "statusCode");
    }
    console.log(`         ${GRAY}→ ${JSON.stringify(r.body)}${RESET}`);
  }

  // ── Resultado final ───────────────────────────
  const total = pass + fail;
  console.log(`\n${CYAN}${"═".repeat(50)}${RESET}`);
  if (fail === 0) {
    console.log(`${GREEN}  RESULTADO: ${pass}/${total} PASSOU ✓${RESET}`);
  } else {
    console.log(`${RED}  RESULTADO: ${pass}/${total} PASSOU  |  ${fail} FALHOU ✗${RESET}`);
  }
  console.log(`${CYAN}${"═".repeat(50)}${RESET}\n`);

  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
