import sqlite3

import pandas as pd
import pytest

import pipeline


# Small appointment row used by several tests.
def appointment_row(status="Scheduled", updated_at="2026-09-28T10:00:00Z"):
    return {
        "appointment_id": "A1000",
        "patient_id": "P1000",
        "department": "cardiology",
        "appointment_time": "2026-09-30T09:00:00Z",
        "booking_created_at": "2026-09-27T08:00:00Z",
        "status": status,
        "booking_channel": "Web",
        "updated_at": updated_at,
    }


# Create a temporary SQLite database in memory.
def make_connection():
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executescript(pipeline.SCHEMA)
    return connection


# Test 1: status and channel values are normalized correctly.
def test_appointment_normalization():
    raw = pd.DataFrame([appointment_row(status="COMPLETE")])

    clean, rejected, duplicates = pipeline.clean_appointments(raw)

    assert len(clean) == 1
    assert len(rejected) == 0
    assert len(duplicates) == 0
    assert clean.iloc[0]["appointment_status"] == "completed"
    assert clean.iloc[0]["booking_channel"] == "web"


# Test 2: an exact duplicate is removed and only one row is kept.
def test_duplicate_is_removed():
    row = appointment_row()
    raw = pd.DataFrame([row, row])

    clean, rejected, duplicates = pipeline.clean_appointments(raw)

    assert len(clean) == 1
    assert len(rejected) == 0
    assert len(duplicates) == 1


# Test 3: running the same clean row twice does not create a duplicate.
def test_upsert_is_idempotent():
    connection = make_connection()
    raw = pd.DataFrame([appointment_row()])
    clean, _, _ = pipeline.clean_appointments(raw)

    first_run = pipeline.upsert(connection, "appointments", clean)
    second_run = pipeline.upsert(connection, "appointments", clean)

    row_count = connection.execute(
        "SELECT COUNT(*) FROM appointments"
    ).fetchone()[0]

    assert first_run["inserted"] == 1
    assert second_run["unchanged"] == 1
    assert row_count == 1

    connection.close()


# Test 4: a newer version updates the existing database row.
def test_newer_record_updates_existing_row():
    connection = make_connection()

    first_raw = pd.DataFrame([
        appointment_row(status="Scheduled", updated_at="2026-09-28T10:00:00Z")
    ])
    first_clean, _, _ = pipeline.clean_appointments(first_raw)
    pipeline.upsert(connection, "appointments", first_clean)

    corrected_raw = pd.DataFrame([
        appointment_row(status="COMPLETE", updated_at="2026-09-29T10:00:00Z")
    ])
    corrected_clean, _, _ = pipeline.clean_appointments(corrected_raw)
    actions = pipeline.upsert(connection, "appointments", corrected_clean)

    status = connection.execute(
        "SELECT appointment_status FROM appointments WHERE appointment_id='A1000'"
    ).fetchone()[0]

    assert actions["updated"] == 1
    assert status == "completed"

    connection.close()


# Test 5: same ID + same updated_at + conflicting data fails clearly.
def test_equal_timestamp_conflict_fails():
    connection = make_connection()

    first_raw = pd.DataFrame([
        appointment_row(status="Scheduled", updated_at="2026-09-28T10:00:00Z")
    ])
    first_clean, _, _ = pipeline.clean_appointments(first_raw)
    pipeline.upsert(connection, "appointments", first_clean)

    conflict_raw = pd.DataFrame([
        appointment_row(status="COMPLETE", updated_at="2026-09-28T10:00:00Z")
    ])
    conflict_clean, _, _ = pipeline.clean_appointments(conflict_raw)

    with pytest.raises(ValueError):
        pipeline.upsert(connection, "appointments", conflict_clean)

    connection.close()
