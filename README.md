# Apex AI Arabia - Junior Data Engineer Assessment

## Project summary

This is a small local data pipeline for the fictional healthcare scenario in the assessment.

I kept it simple on purpose. The pipeline reads messy daily files, cleans and validates them, rejects bad rows instead of silently dropping them, and loads the valid data into SQLite.

Main tools:

- Python + Pandas
- SQLite
- SQL
- Pytest
- Python logging

All data is synthetic.

---

## Source data

The pipeline reads 3 files from:

```text
data/raw/batch_id=batch_001/
├── appointments.csv
├── service_events.csv
└── support_interactions.json
```

They represent:

- appointments / scheduling
- service and claims activity
- support interactions

I intentionally added data-quality problems such as:

- exact duplicates
- missing patient IDs
- invalid timestamps
- status variations like `COMPLETE`, `CANCELED`, `Booked`
- channel variations like `Web`, `CALL CENTER`
- negative service amount
- orphan appointment references
- patient/appointment mismatch
- support closed before opened
- resolved support without `closed_at`

A detailed list of the intentionally injected data-quality issues and their expected handling is available in `data/synthetic_data_issue_manifest.csv`.

### batch_001 result

| Source | Received | Accepted | Rejected | Duplicates removed |
|---|---:|---:|---:|---:|
| appointments | 220 | 217 | 2 | 1 |
| service_events | 160 | 154 | 5 | 1 |
| support_interactions | 100 | 92 | 7 | 1 |

The pipeline checks:

```text
received = accepted + rejected + duplicates removed
```

So rows are not silently lost.

---

## Pipeline workflow

```text
Raw daily files
      |
      v
Check files + required columns
      |
      v
Rename / standardize columns
      |
      v
Normalize status / channel / timestamps
      |
      v
Resolve duplicate or older versions
      |
      v
Apply validation rules
      |
      +---------------------+
      |                     |
      v                     v
Rejected rows           Valid rows
data/rejected/               |
                              v
                       Idempotent UPSERT
                              |
                              v
                         SQLite curated
                         data/apex.db
                              |
                              v
                        11 DQ checks
                              |
                        pass / fail
                         /       \
                    rollback     commit
```

Execution details are written to:

```text
data/logs/pipeline.log
```

The log shows received, accepted, rejected, duplicates removed, inserts, updates and unchanged records.

---

## Data model

I used 3 curated tables.

```text
                         appointments
                     PK appointment_id
                           patient_id
                               |
                +--------------+--------------+
                |                             |
                | 1                           | 1
                |                             |
                | many                        | many
                v                             v
         service_events              support_interactions
         PK service_id               PK interaction_id
         FK appointment_id           FK appointment_id
         patient_id                  patient_id
```

Relationships:

```text
appointments 1 ----< service_events
appointments 1 ----< support_interactions
```

I kept the 3 event types separate because they have different grains:

- 1 appointment row = 1 appointment
- 1 service row = 1 service event
- 1 support row = 1 support interaction

This also avoids double counting when services and support both have multiple rows for the same appointment.

The database also contains:

```text
v_appointment_summary
```

This view aggregates service and support data by appointment before joining them.

I did not create a patient dimension because there is no separate patient master dataset in the scenario.

---

## Curated schema

### appointments

| Column | Meaning |
|---|---|
| `appointment_id` | Primary/business key |
| `patient_id` | Synthetic patient ID |
| `department` | Hospital department |
| `scheduled_start` | Appointment time |
| `created_at` | Booking creation time |
| `appointment_status` | scheduled / completed / cancelled / no_show |
| `booking_channel` | web / mobile_app / call_center / walk_in |
| `updated_at` | Source update time |

### service_events

| Column | Meaning |
|---|---|
| `service_id` | Primary/business key |
| `appointment_id` | FK to appointments |
| `patient_id` | Synthetic patient ID |
| `service_time` | Service time |
| `service_type` | Service type |
| `amount` | Synthetic amount |
| `claim_status` | submitted / paid / rejected |
| `updated_at` | Source update time |

### support_interactions

| Column | Meaning |
|---|---|
| `interaction_id` | Primary/business key |
| `appointment_id` | FK to appointments |
| `patient_id` | Synthetic patient ID |
| `opened_at` | Open time |
| `closed_at` | Close time, nullable |
| `channel` | phone / email / chat |
| `category` | Support category |
| `support_status` | open / pending / resolved |
| `updated_at` | Source update time |

---

## Cleaning and validation

Before loading SQLite, the pipeline:

- checks that all expected files exist
- checks required source columns
- renames inconsistent columns
- normalizes text values
- parses timestamps as UTC
- normalizes known status aliases
- checks missing required values
- checks accepted status/category values
- checks negative or invalid amounts
- checks appointment references
- checks patient/appointment consistency
- checks support timestamps
- handles duplicates and multiple versions
- reconciles all input rows

Rejected rows are saved under:

```text
data/rejected/batch_id=<batch_id>/
```

Each rejected row has a `rejection_reason`.

---

## Data-quality checks

After the UPSERT and before commit, 11 checks run against SQLite:

1. appointment keys unique
2. service keys unique
3. support keys unique
4. appointment status valid
5. service amount non-negative
6. service appointment exists
7. support appointment exists
8. service patient matches appointment patient
9. support patient matches appointment patient
10. resolved support has `closed_at`
11. support close time is not before open time

There are also pre-load checks for schema, nulls, timestamps, accepted values, duplicates and row-count reconciliation.

If a curated DQ check fails, the transaction is rolled back.

---

## Incremental loading and idempotency

Business keys:

```text
appointments         -> appointment_id
service_events       -> service_id
support_interactions -> interaction_id
```

UPSERT logic:

```text
new ID
    -> INSERT

existing ID + newer updated_at
    -> UPDATE

existing ID + same data/timestamp
    -> UNCHANGED

existing ID + older updated_at
    -> UNCHANGED

same ID + same updated_at + different content
    -> FAIL
```

This means a repeated delivery does not create duplicate curated rows.

A corrected record from a later batch updates the old row only when `updated_at` is newer.

A late-arriving record is inserted if its business key is new, even if its event time is older.

---

## Logging and controlled failures

Log file:

```text
data/logs/pipeline.log
```

The pipeline logs:

- batch start
- source row counts
- accepted / rejected / duplicate counts
- inserted / updated / unchanged counts
- errors with traceback

### Failure example 1 - missing file

If one required file is missing:

```text
FileNotFoundError: Missing required source file(s): ...
```

I would check the batch folder, fix the delivery, then rerun the same batch.

### Failure example 2 - renamed/missing column

If a required column such as `appointment_time` is renamed or missing:

```text
ValueError: appointments missing required column(s): ['appointment_time']
```

I chose to fail instead of guessing the new schema.

---

## SQL analysis

SQL is in:

```text
sql/analysis.sql
```

It contains more than the required 5 queries, including:

- appointment status by department
- service count/value by department
- support workload by channel
- completion-rate KPI
- orphan-service DQ investigation
- appointment summary using `v_appointment_summary`

Run:

```bash
sqlite3 -header -column data/apex.db < sql/analysis.sql
```

---

## Automated tests

Tests are in:

```text
tests/test_pipeline.py
```

The 5 tests cover:

- normalization
- duplicate removal
- idempotent UPSERT
- newer corrected record update
- equal-timestamp conflict failure

Run:

```bash
python -m pytest tests/test_pipeline.py -v
```

Current result:

```text
5 passed
```

These tests are separate from the pipeline DQ checks.

---

## Setup and run

Requirements:

- Python 3.9+
- SQLite
- packages from `requirements.txt`

Setup:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Run the default batch:

```bash
python pipeline.py
```

The default is `batch_001`.

Run another batch:

```bash
python pipeline.py --batch-id batch_002
```

The folder should be:

```text
data/raw/batch_id=batch_002/
```

and contain the same 3 expected source files.

Run tests:

```bash
python -m pytest tests/test_pipeline.py -v
```

Run SQL:

```bash
sqlite3 -header -column data/apex.db < sql/analysis.sql
```

---

## Project structure

```text
apex_ai_arabia/
├── pipeline.py
├── README.md
├── requirements.txt
├── HANDOFF.md
├── AI_DISCLOSURE.md
├── data/
│   ├── raw/
│   │   └── batch_id=batch_001/
│   │       ├── appointments.csv
│   │       ├── service_events.csv
│   │       └── support_interactions.json
│   ├── rejected/
│   ├── logs/
│   │   └── pipeline.log
│   └── apex.db
├── sql/
│   └── analysis.sql
└── tests/
    └── test_pipeline.py
```

---

## Assumptions

- all input data is synthetic
- every daily batch should contain all 3 source files
- business keys are stable
- `updated_at` represents source record version time
- timestamps are normalized to UTC
- unknown statuses are rejected, not guessed
- service/support records should reference an appointment
- SQLite is enough for this local assessment

---

## Known limitations

This is not a production healthcare platform.

Main limitations:

- SQLite is local and not designed for large concurrent workloads
- the pipeline is daily batch, not CDC/streaming
- no scheduler/orchestrator is used locally
- no patient master table is included
- curated tables keep the latest accepted version, not full history
- rejected rows do not yet have an automated replay workflow
- monitoring is a local log file
- real healthcare security controls are not implemented because all data is synthetic

---

## Production evolution

I would keep the same rules but change the infrastructure:

```text
Source systems
     |
     v
Secure landing / object storage
     |
     v
Schema + batch checks
     |
     v
Orchestrated transformation
     |
     +----> quarantine / replay
     |
     v
Warehouse / lakehouse
     |
     v
DQ monitoring + alerts
     |
     v
BI / AI / product use
```

Main improvements:

1. durable object storage instead of local folders
2. Airflow/Kestra or similar for scheduling and retries
3. production warehouse/database instead of SQLite
4. bulk/partitioned processing for millions of rows
5. monitoring, metrics and alerts
6. batch manifests/checksums
7. quarantine/replay process
8. encryption, RBAC and audit logging for real healthcare data
9. CDC only if near-real-time latency is actually needed

I would not add Spark or streaming unless the real scale or latency needs it.

---

## Assessment requirement coverage

| Requirement | Covered by |
|---|---|
| 3 synthetic datasets | `data/raw/batch_id=batch_001/` |
| Intentional DQ issues | source data + README |
| Python + SQL pipeline | `pipeline.py` + `sql/analysis.sql` |
| Curated model + relationships | SQLite + Data model section |
| 8+ DQ checks | 11 curated checks + pre-load checks |
| Incremental/idempotent processing | UPSERT + tests |
| Late/corrected records | `updated_at` logic |
| Logging/error handling | `pipeline.log` |
| 2 controlled failure examples | Logging section |
| 5+ SQL queries | `sql/analysis.sql` |
| 3+ tests beyond DQ | 5 Pytest tests |
| README/data dictionary/flow | this file |
| Handoff note | `HANDOFF.md` |
| AI/tool disclosure | `AI_DISCLOSURE.md` |
| Limitations + production plan | sections above |

---

## Main design choice

I intentionally kept the local solution small.

Python + Pandas + SQLite is enough for this amount of data and is easy to run and explain. I did not add Spark, cloud, Airflow or extra warehouse layers because they are not needed for this assessment.

If the scale changes, the infrastructure can change without changing the main data-quality and idempotency rules.
