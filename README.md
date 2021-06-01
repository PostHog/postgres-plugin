# PostgreSQL Plugin

Export PostHog events to a PostgreSQL instance on ingestion.

## Instructions

### 1. Make sure PostHog can access your instance

Wherever your instance is hosted, make sure it is set to accept incoming connections so that we can connect to the database and insert events. If this is not possible in your case, you should consider using our [S3 plugin](https://posthog.com/plugins/s3-export) and then setting up your own system for getting data into your Postgres instance.

### 2. Create a user with table creation priviledges

We need to create a new table to store events and execute `INSERT` queries. You can and should block us from doing anything else on any other tables. Giving us table creation permissions should be enough to ensure this:

```sql
CREATE USER posthog WITH PASSWORD '123456yZ';
GRANT CREATE ON DATABASE your_database TO posthog;
```

### 3. Add the connection details at the plugin configuration step in PostHog
