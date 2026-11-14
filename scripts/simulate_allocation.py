"""Simulates the Supabase allocator against a local Postgres (no supabase CLI needed).

Rebuilds a scratch database from supabase/schema_baseline.sql + the allocation migration, seeds the pilot_60
targets (mirroring production), and runs the spec's scenarios: balance, abandonment/expiry, late + repeated
submission, resume, concurrency, (de)activation, custom weights, exhaustion, battery drift, misconfiguration.
Usage: python3 scripts/simulate_allocation.py   (env PIW_SIM_DB overrides the db name, default piw_sim)
"""
import json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
DB = os.environ.get("PIW_SIM_DB", "piw_sim")

# Production configuration, mirrored: 7 categories, 13 prompts; 30 per prompt in two-prompt categories, 60 for rec.
TARGETS = {
    "sbb": {"sbb_007": 30, "sbb_002": 30},
    "aita": {"aita_03_first": 30, "aita_03_third": 30},
    "value_alignment": {"va_h54": 30, "va_h44": 30},
    "recommendation_steering": {"rec_program_001": 60},
    "personalized_issue_framing": {"framing_07": 30, "framing_08": 30},
    "explanatory_grounding": {"ground_003": 30, "ground_007": 30},
    "career_tradeoffs": {"career_001": 30, "career_004": 30},
}
ELIGIBLE = {cat: list(ids) for cat, ids in TARGETS.items()}
FULL = {  # scenario j: full-study custom distribution, weights .5/.125×4 → targets 60/15/15/15/15 (N=120)
    "recommendation_steering": {"rec_program_001": 60, "rec_nb_001": 15, "rec_nb_002": 15, "rec_nb_003": 15, "rec_nb_004": 15},
}

def ok(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: sys.exit(1)

def q(sql, args=None, one=False):
    with conn.cursor() as c:
        c.execute(sql, args)
        if c.description: return (c.fetchone() if one else c.fetchall())

def allocate(pid, eligible=None, alpha=0.6, ttl=70, cur=None):
    sql, args = "SELECT allocate_prompts(%s, %s, %s, %s)", (pid, json.dumps(eligible if eligible is not None else ELIGIBLE), alpha, ttl)
    if cur is not None:
        cur.execute(sql, args); return cur.fetchone()[0]
    return q(sql, args, one=True)[0]

def submit(pid, stage):
    return q("SELECT submit_assignments(%s, %s)", (pid, stage), one=True)[0]

def counts(stage, cat):
    return dict(q("SELECT prompt_id, count(*) FROM assignments WHERE stage_id=%s AND category=%s AND status='submitted' GROUP BY 1", (stage, cat)))

def seed(stage, name, targets, active=True):
    q("INSERT INTO study_stages (id, name, is_active) VALUES (%s, %s, %s)", (stage, name, active))
    for cat, ids in targets.items():
        n = len(ids)
        for p, t in ids.items():
            q("INSERT INTO stage_prompt_targets (stage_id, category, prompt_id, target, is_active, weight) VALUES (%s,%s,%s,%s,true,%s)",
              (stage, cat, p, t, round(t / sum(ids.values()), 4)))

# ---------- Build the scratch database ----------
subprocess.run(["dropdb", "--if-exists", DB], check=True)
subprocess.run(["createdb", DB], check=True)
conn = psycopg2.connect(dbname=DB); conn.autocommit = True
q((ROOT / "supabase" / "schema_baseline.sql").read_text())
for m in sorted((ROOT / "supabase" / "migrations").glob("*.sql")): q(m.read_text())
seed("pilot_60", "Pilot (continuous study)", TARGETS)

# The publishable (anon) key must not reach these functions, even via PostgREST /rpc: Supabase's default
# privileges grant EXECUTE on new public functions to anon/authenticated (mirrored in schema_baseline.sql).
for role in ("anon", "authenticated"):
    for fn in ("allocate_prompts(text,jsonb,numeric,integer)", "submit_assignments(text,text)"):
        ok(not q("SELECT has_function_privilege(%s, %s, 'EXECUTE')", (role, fn), one=True)[0], f"{role} cannot execute {fn.split('(')[0]}")

# a/b: 60 participants allocate→submit; sequential submits balance two-prompt categories exactly 30/30
for i in range(60):
    r = allocate(f"P{i:03d}")
    ok(set(r["assignments"]) == set(TARGETS) and not r["exhausted"] and not r["existing"], f"P{i:03d} fresh allocation") if i == 0 else None
    submit(f"P{i:03d}", r["stage_id"])
for cat, ids in TARGETS.items():
    c = counts("pilot_60", cat)
    if len(ids) == 2: ok(sorted(c.values()) == [30, 30], f"{cat} split exactly 30/30 ({c})")
ok(counts("pilot_60", "recommendation_steering") == {"rec_program_001": 60}, "single-prompt category took all 60")

# g: resume — same pid gets the identical mapping, no new rows
before = q("SELECT count(*) FROM assignments", one=True)[0]
first = allocate("P000"); again = allocate("P000")
ok(again["existing"] and again["assignments"] == first["assignments"] and q("SELECT count(*) FROM assignments", one=True)[0] == before, "resume returns the same assignments, no new rows")

# c/d: abandonment — 20 allocate, never submit; 71 minutes pass; next allocate lazily expires them
drops = [f"D{i:02d}" for i in range(20)]
for p in drops: allocate(p)
q("UPDATE assignments SET assigned_at = assigned_at - interval '71 minutes', expires_at = expires_at - interval '71 minutes' WHERE participant_key LIKE 'D%%'")
allocate("TRIGGER")
ok(q("SELECT count(*) FROM assignments WHERE participant_key LIKE 'D%%' AND status='expired'", one=True)[0] == 20 * len(TARGETS), "abandoned assignments expired lazily after 70 minutes")
ok(q("SELECT count(*) FROM assignments WHERE status='pending' AND participant_key LIKE 'D%%'", one=True)[0] == 0, "expired assignments leave pending counts")

# e: late submission flips expired → submitted without new assignments
r = allocate("D00")  # returning participant keeps the original (expired) assignments
ok(r["existing"] and set(r["assignments"]) == set(TARGETS), "returning expired participant keeps original assignments")
s = submit("D00", "pilot_60")
ok(s["updated"] == len(TARGETS) and q("SELECT count(*) FROM assignments WHERE participant_key='D00' AND status='submitted'", one=True)[0] == len(TARGETS), "late submission accepted")

# f: repeated submission is a no-op and keeps submitted_at
t1 = q("SELECT max(submitted_at) FROM assignments WHERE participant_key='D00'", one=True)[0]
ok(submit("D00", "pilot_60")["updated"] == 0 and q("SELECT max(submitted_at) FROM assignments WHERE participant_key='D00'", one=True)[0] == t1, "repeated submission never counts twice")

# submit serializes with allocate on the same per-stage advisory lock, so counts are never read mid-flip
a = psycopg2.connect(dbname=DB)  # autocommit off: the open transaction holds the advisory xact lock
with a.cursor() as cur: allocate("LOCKED", cur=cur)
b = psycopg2.connect(dbname=DB); b.autocommit = True
with b.cursor() as cur:
    cur.execute("SET lock_timeout = '500ms'")
    try: cur.execute("SELECT submit_assignments('P000', 'pilot_60')"); blocked = False
    except psycopg2.errors.LockNotAvailable: blocked = True
ok(blocked, "submit waits on an in-flight allocation's lock")
a.rollback(); a.close()  # releases the lock and discards LOCKED's rows
ok(submit("P000", "pilot_60")["total"] == len(TARGETS), "submit proceeds once the lock is released")
b.close()

# h: concurrency — 30 fresh pids in parallel, plus 10 racing calls for one pid
def para(pid):
    c2 = psycopg2.connect(dbname=DB); c2.autocommit = True
    with c2.cursor() as cur: r = allocate(pid, cur=cur)
    c2.close(); return r
with ThreadPoolExecutor(20) as ex:
    rs = list(ex.map(para, [f"C{i:02d}" for i in range(30)]))
    dups = list(ex.map(para, ["RACE"] * 10))
ok(q("SELECT count(*) FROM assignments WHERE participant_key LIKE 'C%%'", one=True)[0] == 30 * len(TARGETS), "30 concurrent participants: exact row counts")
ok(len({json.dumps(d["assignments"], sort_keys=True) for d in dups}) == 1
   and q("SELECT count(*) FROM assignments WHERE participant_key='RACE'", one=True)[0] == len(TARGETS), "10 racing calls for one pid: one assignment set")

# i: deactivation (Supabase) and GitHub-side disable both stop assignment
q("UPDATE stage_prompt_targets SET is_active=false WHERE prompt_id='sbb_007'")
got = {allocate(f"I{i:02d}")["assignments"]["sbb"] for i in range(10)}
ok(got == {"sbb_002"}, "is_active=false prompt never assigned")
q("UPDATE stage_prompt_targets SET is_active=true WHERE prompt_id='sbb_007'")
gh = {**ELIGIBLE, "sbb": ["sbb_007"]}  # battery.json dropped sbb_002: must not be silently re-enabled
got = {allocate(f"I1{i:02d}", eligible=gh)["assignments"]["sbb"] for i in range(10)}
ok(got == {"sbb_007"}, "prompt absent from battery.json never assigned")
free = {**ELIGIBLE, "sbb": None}  # battery entry without an id list: all active targets eligible
ok(allocate("I_FREE", eligible=free)["assignments"]["sbb"] in TARGETS["sbb"], "null eligibility = every active target")

# k: exhaustion — fill aita to target; allocation stays explicit, never uniform-random fallback
q("""INSERT INTO assignments (participant_key, stage_id, category, prompt_id, status, assigned_at, submitted_at, expires_at)
     SELECT 'F'||g, 'pilot_60', 'aita', 'aita_03_first', 'submitted', now(), now(), now() FROM generate_series(1,40) g""")
q("""INSERT INTO assignments (participant_key, stage_id, category, prompt_id, status, assigned_at, submitted_at, expires_at)
     SELECT 'H'||g, 'pilot_60', 'aita', 'aita_03_third', 'submitted', now(), now(), now() FROM generate_series(1,80) g""")
r = allocate("OVERFLOW")
ok("aita" in r["exhausted"] and r["assignments"]["aita"] == "aita_03_first", "exhausted category flagged; least-overflow prompt assigned")

# l: assignment predates a battery update — original preserved on re-allocation
pre = allocate("OLDTIMER")["assignments"]["career_tradeoffs"]
shrunk = {**ELIGIBLE, "career_tradeoffs": [p for p in ELIGIBLE["career_tradeoffs"] if p != pre]}
ok(allocate("OLDTIMER", eligible=shrunk)["assignments"]["career_tradeoffs"] == pre, "assignment predating a battery update is preserved")

# battery gains a dataset mid-stage: returning participants keep originals and get the new category filled in
pre = allocate("GROWTH")["assignments"]
q("INSERT INTO stage_prompt_targets (stage_id, category, prompt_id, target, is_active, weight) VALUES ('pilot_60','bonus','bonus_001',30,true,1)")
grown = allocate("GROWTH", eligible={**ELIGIBLE, "bonus": ["bonus_001"]})
ok(grown["existing"] and grown["assignments"] == {**pre, "bonus": "bonus_001"}, "new battery category filled in without rerandomizing originals")

# j: custom distribution 50/12.5/12.5/12.5/12.5 in the full study; pilot counts untouched
pilot_rows = q("SELECT count(*) FROM assignments WHERE stage_id='pilot_60'", one=True)[0]
q("UPDATE study_stages SET is_active=false WHERE id='pilot_60'")
seed("full_study", "Full study", FULL)
el = {"recommendation_steering": list(FULL["recommendation_steering"])}
for i in range(120):
    r = allocate(f"J{i:03d}", eligible=el); submit(f"J{i:03d}", "full_study")
c = counts("full_study", "recommendation_steering")
share = {p: c.get(p, 0) / 120 for p in FULL["recommendation_steering"]}
ok(abs(share["rec_program_001"] - 0.5) <= 0.05 and all(abs(share[p] - 0.125) <= 0.05 for p in share if p != "rec_program_001"),
   f"custom 50/12.5×4 distribution honored ({share})")
ok(q("SELECT count(*) FROM assignments WHERE stage_id='pilot_60'", one=True)[0] == pilot_rows, "historical pilot counts untouched by the new stage")

# misconfiguration: explicit exceptions, not silent fallbacks
def throws(fn, needle):
    try: fn(); return False
    except psycopg2.Error as e: return needle in str(e)
ok(throws(lambda: allocate("MISS", eligible={**el, "ghost_category": ["x"]}), "ghost_category"), "category without targets raises, naming it")
q("UPDATE study_stages SET is_active=false")
ok(throws(lambda: allocate("NOSTAGE"), "active stage"), "no active stage raises")

print("ALL SCENARIOS PASS")
