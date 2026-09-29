-- Apex AI Arabia - SQL analysis
-- Run with:
-- sqlite3 data/apex.db < sql/analysis.sql


-- 1. Appointment status counts by department
-- Purpose: simple operational view of appointment outcomes.
SELECT
    department,
    appointment_status,
    COUNT(*) AS appointment_count
FROM appointments
GROUP BY department, appointment_status
ORDER BY department, appointment_status;


-- 2. Service activity and value by department
-- Purpose: JOIN + aggregation across appointments and service events.
SELECT
    a.department,
    COUNT(s.service_id) AS service_count,
    ROUND(SUM(s.amount), 2) AS total_service_amount
FROM appointments AS a
JOIN service_events AS s
    ON a.appointment_id = s.appointment_id
GROUP BY a.department
ORDER BY total_service_amount DESC;


-- 3. Support workload by channel
-- Purpose: understand where support demand is coming from.
SELECT
    channel,
    COUNT(*) AS interaction_count
FROM support_interactions
GROUP BY channel
ORDER BY interaction_count DESC;


-- 4. Appointment completion rate by department
-- Purpose: operational KPI.
SELECT
    department,
    COUNT(*) AS total_appointments,
    SUM(
        CASE
            WHEN appointment_status = 'completed' THEN 1
            ELSE 0
        END
    ) AS completed_appointments,
    ROUND(
        100.0 * SUM(
            CASE
                WHEN appointment_status = 'completed' THEN 1
                ELSE 0
            END
        ) / COUNT(*),
        2
    ) AS completion_rate_percent
FROM appointments
GROUP BY department
ORDER BY completion_rate_percent DESC;


-- 5. Data-quality investigation: orphan service records
-- Expected result in curated data: zero rows.
SELECT
    s.service_id,
    s.appointment_id,
    s.patient_id
FROM service_events AS s
LEFT JOIN appointments AS a
    ON s.appointment_id = a.appointment_id
WHERE a.appointment_id IS NULL;


-- 6. Curated appointment summary using the prepared view
SELECT
    appointment_id,
    patient_id,
    department,
    scheduled_start,
    appointment_status,
    service_count,
    total_service_amount,
    support_interaction_count
FROM v_appointment_summary
ORDER BY appointment_id;