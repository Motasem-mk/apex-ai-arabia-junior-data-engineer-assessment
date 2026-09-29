# AI and External Tool Disclosure

## Tools used

### ChatGPT

I used ChatGPT as a coding and review assistant during the assessment.

Main uses:

- discussing the pipeline design and keeping the solution simple
- reviewing Python logic
- helping draft automated tests
- helping draft SQL queries
- helping structure the README and documentation
- checking edge cases such as idempotency, duplicate delivery and corrected records

I did not treat generated suggestions as final automatically. I reviewed the design decisions, ran the code locally, fixed issues, and simplified parts that I did not want in the final solution.

### Python / Pandas

Used for reading, cleaning, validating and transforming the synthetic source data.

### SQLite

Used for the curated local database, UPSERT logic, relationships and SQL analysis.

### Pytest

Used for automated tests beyond the pipeline data-quality checks.

### VS Code / Terminal

Used to edit the project and run the pipeline, tests and SQL locally.

## What I verified myself

I ran the pipeline locally and verified the batch counts.

I ran the automated tests locally:

```text
5 passed
```

I also ran the SQL analysis against the generated SQLite database and checked the outputs.

## What is not independently validated

This project is a local assessment solution only.

I did not validate production-scale performance, real healthcare security controls, distributed processing, or cloud deployment because they are outside the implemented scope.
