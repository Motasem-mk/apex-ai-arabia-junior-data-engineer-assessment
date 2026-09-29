"""Apex healthcare batch pipeline: raw files -> validated curated SQLite."""
import argparse
import logging
import sqlite3
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
RAW, REJECTED = DATA / "raw", DATA / "rejected"
LOGS, DB_PATH = DATA / "logs", DATA / "apex.db"

RENAMES = {
    "appointments": {"appointment_time": "scheduled_start", "booking_created_at": "created_at", "status": "appointment_status"},
    "service_events": {"appt_id": "appointment_id", "service_timestamp": "service_time", "last_updated": "updated_at"},
    "support_interactions": {"appointment_ref": "appointment_id", "contact_channel": "channel", "topic": "category", "ticket_status": "support_status", "modified_at": "updated_at"},
}
REQUIRED = {
    "appointments": {"appointment_id", "patient_id", "department", "appointment_time", "booking_created_at", "status", "booking_channel", "updated_at"},
    "service_events": {"service_id", "appt_id", "patient_id", "service_timestamp", "service_type", "amount", "claim_status", "last_updated"},
    "support_interactions": {"interaction_id", "appointment_ref", "patient_id", "opened_at", "closed_at", "contact_channel", "topic", "ticket_status", "modified_at"},
}
ALLOWED = {
    "appointment_status": {"scheduled", "completed", "cancelled", "no_show"},
    "booking_channel": {"web", "mobile_app", "call_center", "walk_in"},
    "claim_status": {"submitted", "paid", "rejected"},
    "service_type": {"consultation", "lab", "xray", "procedure", "physiotherapy"},
    "support_status": {"open", "pending", "resolved"}, "channel": {"phone", "email", "chat"},
    "category": {"appointment_information", "appointment_change", "appointment_cancellation", "billing_question"},
}
KEYS = {"appointments": "appointment_id", "service_events": "service_id", "support_interactions": "interaction_id"}
COLUMNS = {
    "appointments": ["appointment_id", "patient_id", "department", "scheduled_start", "created_at", "appointment_status", "booking_channel", "updated_at"],
    "service_events": ["service_id", "appointment_id", "patient_id", "service_time", "service_type", "amount", "claim_status", "updated_at"],
    "support_interactions": ["interaction_id", "appointment_id", "patient_id", "opened_at", "closed_at", "channel", "category", "support_status", "updated_at"],
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS appointments (
 appointment_id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, department TEXT NOT NULL, scheduled_start TEXT NOT NULL,
 created_at TEXT NOT NULL, appointment_status TEXT NOT NULL, booking_channel TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS service_events (
 service_id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL REFERENCES appointments(appointment_id), patient_id TEXT NOT NULL,
 service_time TEXT NOT NULL, service_type TEXT NOT NULL, amount REAL NOT NULL CHECK(amount>=0), claim_status TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS support_interactions (
 interaction_id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL REFERENCES appointments(appointment_id), patient_id TEXT NOT NULL,
 opened_at TEXT NOT NULL, closed_at TEXT, channel TEXT NOT NULL, category TEXT NOT NULL, support_status TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE VIEW IF NOT EXISTS v_appointment_summary AS
WITH s AS (SELECT appointment_id, COUNT(*) service_count, ROUND(SUM(amount),2) total_service_amount FROM service_events GROUP BY appointment_id),
     t AS (SELECT appointment_id, COUNT(*) support_interaction_count FROM support_interactions GROUP BY appointment_id)
SELECT a.appointment_id, a.patient_id, a.department, a.scheduled_start, a.appointment_status,
 COALESCE(s.service_count,0) service_count, COALESCE(s.total_service_amount,0) total_service_amount,
 COALESCE(t.support_interaction_count,0) support_interaction_count
FROM appointments a LEFT JOIN s ON s.appointment_id=a.appointment_id LEFT JOIN t ON t.appointment_id=a.appointment_id;
"""

def configure_logging() -> None:
    LOGS.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s",
                        handlers=[logging.FileHandler(LOGS / "pipeline.log"), logging.StreamHandler()], force=True)

def normalize(series: pd.Series) -> pd.Series:
    return series.astype("string").str.strip().str.lower().str.replace(r"[\s\-]+", "_", regex=True)

def missing(series: pd.Series) -> pd.Series:
    return series.isna() | series.astype("string").str.strip().eq("").fillna(False)

def add_reason(df: pd.DataFrame, mask: pd.Series, reason: str) -> None:
    df.loc[mask.fillna(False), "rejection_reason"] += f"{reason};"

def db_frame(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    for col in out.select_dtypes(include=["datetime", "datetimetz"]):
        out[col] = out[col].dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    return out.astype(object).where(pd.notna(out), None)

# Fail early when a batch is incomplete or its source schema changed.
def read_batch(batch_id: str) -> dict[str, pd.DataFrame]:
    folder = RAW / f"batch_id={batch_id}"
    paths = {"appointments": folder / "appointments.csv", "service_events": folder / "service_events.csv",
             "support_interactions": folder / "support_interactions.json"}
    absent = [str(p) for p in paths.values() if not p.exists()]
    if absent:
        raise FileNotFoundError("Missing required source file(s): " + ", ".join(absent))
    try:
        raw = {"appointments": pd.read_csv(paths["appointments"]), "service_events": pd.read_csv(paths["service_events"]),
               "support_interactions": pd.read_json(paths["support_interactions"])}
    except pd.errors.EmptyDataError as exc:
        raise ValueError("A CSV file is empty and has no header") from exc
    except ValueError as exc:
        raise ValueError("support_interactions.json is not valid JSON") from exc
    if raw["support_interactions"].empty and len(raw["support_interactions"].columns) == 0:
        raw["support_interactions"] = pd.DataFrame(columns=sorted(REQUIRED["support_interactions"]))
    for source, df in raw.items():
        absent_cols = REQUIRED[source] - set(df.columns)
        if absent_cols:
            raise ValueError(f"{source} missing required column(s): {sorted(absent_cols)}")
    return raw

#  cleaning : rename, normalize categories, parse timestamps.
def prepare(raw: pd.DataFrame, source: str, dates: list[str], tokens: list[str]) -> pd.DataFrame:
    df = raw.rename(columns=RENAMES[source]).copy()
    for col in tokens:
        df[col] = normalize(df[col])
    if source == "appointments":
        df["appointment_status"] = df["appointment_status"].replace({"complete": "completed", "canceled": "cancelled", "booked": "scheduled"})
    for col in dates:
        df[col] = pd.to_datetime(df[col], errors="coerce", utc=True)
    return df

#  business key: newest updated_at wins; equal-time conflicting versions are rejected.
def resolve_versions(df: pd.DataFrame, key: str):
    if df.empty:
        return df.copy(), df.copy(), 0
    unresolved = df.loc[df[key].isna() | df["updated_at"].isna()].copy()
    candidates = df.loc[df[key].notna() & df["updated_at"].notna()].copy()
    kept, conflicts, superseded = [], [], []
    for _, group in candidates.groupby(key, sort=False):
        newest = group.loc[group["updated_at"].eq(group["updated_at"].max())]
        older = group.loc[~group.index.isin(newest.index)]
        if not older.empty: superseded.append(older)
        if len(newest) == 1:
            kept.append(newest)
        elif len(newest.astype(str).drop_duplicates()) == 1:
            kept.append(newest.iloc[[0]])
            superseded.append(newest.iloc[1:])
        else:
            conflict = newest.copy()
            conflict["rejection_reason"] = "timestamp_tie_conflict;"
            conflicts.append(conflict)
    active = pd.concat([unresolved] + kept, ignore_index=True) if kept else unresolved
    bad = pd.concat(conflicts, ignore_index=True) if conflicts else df.iloc[0:0].copy()
    old = pd.concat(superseded, ignore_index=True) if superseded else df.iloc[0:0].copy()
    return active, bad, old

def basic_rules(df: pd.DataFrame, required: list[str], dates: list[str], choices: list[str]) -> None:
    df["rejection_reason"] = ""
    for col in required:
        add_reason(df, missing(df[col]), f"missing_{col}")
    for col in dates:
        add_reason(df, df[col].isna(), f"invalid_{col}")
    for col in choices:
        add_reason(df, ~df[col].isin(ALLOWED[col]), f"invalid_{col}")

def split_rows(df: pd.DataFrame, conflicts: pd.DataFrame):
    failed = df["rejection_reason"].ne("")
    clean = df.loc[~failed].drop(columns="rejection_reason").copy()
    rejected = df.loc[failed].copy()
    if not conflicts.empty:
        rejected = pd.concat([rejected, conflicts], ignore_index=True)
    return clean, rejected

def clean_appointments(raw: pd.DataFrame):
    dates = ["scheduled_start", "created_at", "updated_at"]
    df = prepare(raw, "appointments", dates, ["appointment_status", "booking_channel"])
    df, conflicts, superseded = resolve_versions(df, "appointment_id")
    basic_rules(df, ["appointment_id", "patient_id", "department"], dates, ["appointment_status", "booking_channel"])
    add_reason(df, df["created_at"].notna() & df["scheduled_start"].notna() & df["created_at"].gt(df["scheduled_start"]), "created_after_appointment")
    clean, rejected = split_rows(df, conflicts)
    return clean, rejected, superseded

def appointment_reference(connection: sqlite3.Connection, current: pd.DataFrame) -> pd.DataFrame:
    existing = pd.read_sql_query("SELECT appointment_id, patient_id, updated_at FROM appointments", connection)
    current = current[["appointment_id", "patient_id", "updated_at"]].copy()
    if existing.empty:
        return current
    existing["updated_at"] = pd.to_datetime(existing["updated_at"], utc=True, errors="coerce")
    return pd.concat([existing, current], ignore_index=True).sort_values("updated_at").drop_duplicates("appointment_id", keep="last")

def relation_rules(df: pd.DataFrame, appointments: pd.DataFrame) -> None:
    expected = df["appointment_id"].map(appointments.set_index("appointment_id")["patient_id"])
    add_reason(df, df["appointment_id"].notna() & expected.isna(), "appointment_not_found")
    add_reason(df, expected.notna() & df["patient_id"].notna() & df["patient_id"].ne(expected), "patient_id_does_not_match_appointment")

def clean_services(raw: pd.DataFrame, appointments: pd.DataFrame):
    dates = ["service_time", "updated_at"]
    df = prepare(raw, "service_events", dates, ["claim_status", "service_type"])
    df["amount"] = pd.to_numeric(df["amount"], errors="coerce")
    df, conflicts, superseded = resolve_versions(df, "service_id")
    basic_rules(df, ["service_id", "appointment_id", "patient_id"], dates, ["claim_status", "service_type"])
    add_reason(df, df["amount"].isna(), "invalid_amount")
    add_reason(df, df["amount"].lt(0), "negative_amount")
    relation_rules(df, appointments)
    clean, rejected = split_rows(df, conflicts)
    return clean, rejected, superseded

def clean_support(raw: pd.DataFrame, appointments: pd.DataFrame):
    df = prepare(raw, "support_interactions", ["opened_at", "closed_at", "updated_at"], ["support_status", "channel", "category"])
    df, conflicts, superseded = resolve_versions(df, "interaction_id")
    basic_rules(df, ["interaction_id", "appointment_id", "patient_id"], ["opened_at", "updated_at"], ["support_status", "channel", "category"])
    add_reason(df, df["support_status"].eq("resolved") & df["closed_at"].isna(), "resolved_without_closed_at")
    add_reason(df, df["opened_at"].notna() & df["closed_at"].notna() & df["closed_at"].lt(df["opened_at"]), "closed_before_opened")
    relation_rules(df, appointments)
    clean, rejected = split_rows(df, conflicts)
    return clean, rejected, superseded

# Count actual DB actions, reject equal-timestamp conflicts, then UPSERT only newer versions.
def upsert(connection: sqlite3.Connection, table: str, df: pd.DataFrame) -> dict[str, int]:
    actions = {"inserted": 0, "updated": 0, "unchanged": 0}
    if df.empty:
        return actions
    key, columns = KEYS[table], COLUMNS[table]
    incoming = db_frame(df[columns])
    existing = pd.read_sql_query(f"SELECT * FROM {table}", connection)
    existing = existing.set_index(key) if not existing.empty else None
    for _, row in incoming.iterrows():
        record_id = row[key]
        if existing is None or record_id not in existing.index:
            actions["inserted"] += 1
            continue
        old = existing.loc[record_id]
        new_time, old_time = pd.to_datetime(row["updated_at"], utc=True), pd.to_datetime(old["updated_at"], utc=True)
        if new_time > old_time:
            actions["updated"] += 1
        elif new_time < old_time or all(
            str(row[c]) == str(old[c]) for c in columns if c != key
        ):
            actions["unchanged"] += 1
        else:
            raise ValueError(
                f"{table} {key}={record_id!r} has equal updated_at but conflicting content"
            )
    updates = ", ".join(f"{c}=excluded.{c}" for c in columns if c != key)
    sql = (f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)}) "
           f"ON CONFLICT({key}) DO UPDATE SET {updates} WHERE excluded.updated_at > {table}.updated_at")
    connection.executemany(sql, incoming.itertuples(index=False, name=None))
    return actions

# 11 DQ checks against curated SQLite. pytest tests are separate from these checks.
def run_quality_checks(connection: sqlite3.Connection) -> list[dict]:
    checks = [
        ("appointment_keys_unique", "SELECT COUNT(*) FROM (SELECT appointment_id FROM appointments GROUP BY appointment_id HAVING COUNT(*)>1)"),
        ("service_keys_unique", "SELECT COUNT(*) FROM (SELECT service_id FROM service_events GROUP BY service_id HAVING COUNT(*)>1)"),
        ("support_keys_unique", "SELECT COUNT(*) FROM (SELECT interaction_id FROM support_interactions GROUP BY interaction_id HAVING COUNT(*)>1)"),
        ("appointment_status_valid", "SELECT COUNT(*) FROM appointments WHERE appointment_status NOT IN ('scheduled','completed','cancelled','no_show')"),
        ("service_amount_nonnegative", "SELECT COUNT(*) FROM service_events WHERE amount<0 OR amount IS NULL"),
        ("service_appointment_exists", "SELECT COUNT(*) FROM service_events s LEFT JOIN appointments a ON a.appointment_id=s.appointment_id WHERE a.appointment_id IS NULL"),
        ("support_appointment_exists", "SELECT COUNT(*) FROM support_interactions t LEFT JOIN appointments a ON a.appointment_id=t.appointment_id WHERE a.appointment_id IS NULL"),
        ("service_patient_matches", "SELECT COUNT(*) FROM service_events s JOIN appointments a ON a.appointment_id=s.appointment_id WHERE s.patient_id<>a.patient_id"),
        ("support_patient_matches", "SELECT COUNT(*) FROM support_interactions t JOIN appointments a ON a.appointment_id=t.appointment_id WHERE t.patient_id<>a.patient_id"),
        ("resolved_support_has_closed_at", "SELECT COUNT(*) FROM support_interactions WHERE support_status='resolved' AND closed_at IS NULL"),
        ("support_time_order_valid", "SELECT COUNT(*) FROM support_interactions WHERE closed_at IS NOT NULL AND closed_at<opened_at"),
    ]
    return [{"check": name, "passed": (n := int(connection.execute(sql).fetchone()[0])) == 0, "failures": n} for name, sql in checks]

def save_rejected(rejected: dict[str, pd.DataFrame], batch_id: str) -> None:
    """Save invalid rows for investigation after a successful database load."""
    bad_dir = REJECTED / f"batch_id={batch_id}"
    bad_dir.mkdir(parents=True, exist_ok=True)

    for source in KEYS:
        rejected[source].to_json(
            bad_dir / f"{source}_rejected.jsonl",
            orient="records",
            lines=True,
            date_format="iso",
            mode="w",
        )


def run(batch_id: str) -> dict:
    configure_logging()
    logging.info("Starting batch %s", batch_id)

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.execute("PRAGMA foreign_keys = ON")

    result = {
        "status": "running",
        "batch_id": batch_id,
        "counts": {},
        "database_actions": {},
        "quality_checks": [],
    }

    try:
        # 1. Check the source files and load the batch.
        connection.executescript(SCHEMA)
        connection.commit()
        raw = read_batch(batch_id)
        logging.info(
            "Received | appointments=%d service_events=%d support_interactions=%d",
            len(raw["appointments"]),
            len(raw["service_events"]),
            len(raw["support_interactions"]),
        )

        # 2. Clean, resolve duplicate/older versions, and validate.
        appointments, ar, ap_old = clean_appointments(raw["appointments"])
        reference = appointment_reference(connection, appointments)
        services, sr, se_old = clean_services(raw["service_events"], reference)
        support, ur, su_old = clean_support(raw["support_interactions"], reference)

        clean = {
            "appointments": appointments,
            "service_events": services,
            "support_interactions": support,
        }
        rejected = {
            "appointments": ar,
            "service_events": sr,
            "support_interactions": ur,
        }
        removed_versions = {
            "appointments": ap_old,
            "service_events": se_old,
            "support_interactions": su_old,
        }

        # Every input row must be accepted, rejected, or removed as a duplicate/older version.
        for source in KEYS:
            counts = {
                "received": len(raw[source]),
                "accepted": len(clean[source]),
                "rejected": len(rejected[source]),
                "duplicates_removed": len(removed_versions[source]),
            }
            if counts["received"] != (
                counts["accepted"]
                + counts["rejected"]
                + counts["duplicates_removed"]
            ):
                raise RuntimeError(f"Input reconciliation failed for {source}")
            result["counts"][source] = counts

        # 3. Idempotent UPSERT, then curated DQ checks before commit.
        for table in KEYS:
            result["database_actions"][table] = upsert(
                connection,
                table,
                clean[table],
            )

        result["quality_checks"] = run_quality_checks(connection)
        failed_checks = [
            check for check in result["quality_checks"] if not check["passed"]
        ]
        if failed_checks:
            raise RuntimeError(
                f"Curated quality checks failed: {failed_checks}"
            )

        connection.commit()

        # Save rejected rows only after the database transaction succeeds.
        save_rejected(rejected, batch_id)
        result["status"] = "succeeded"

        for source, counts in result["counts"].items():
            logging.info(
                "%s | received=%d accepted=%d rejected=%d duplicates_removed=%d",
                source,
                counts["received"],
                counts["accepted"],
                counts["rejected"],
                counts["duplicates_removed"],
            )

        for table, actions in result["database_actions"].items():
            logging.info(
                "%s DB | inserted=%d updated=%d unchanged=%d",
                table,
                actions["inserted"],
                actions["updated"],
                actions["unchanged"],
            )

        logging.info("Batch %s succeeded", batch_id)
        return result

    except Exception:
        connection.rollback()
        logging.exception("Batch %s failed", batch_id)
        raise

    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-id", default="batch_001", help="e.g. batch_001")
    report = run(parser.parse_args().batch_id)
    print(f"Pipeline {report['status']}: {report['batch_id']}")
    for source, c in report["counts"].items():
        print(
            f"  {source}: {c['accepted']} accepted, "
            f"{c['rejected']} rejected, "
            f"{c['duplicates_removed']} duplicates removed"
        )
    print(f"Database: {DB_PATH}")

if __name__ == "__main__":
    main()
