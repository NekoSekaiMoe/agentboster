DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'notifications_notificationType'
  ) THEN
    ALTER TYPE "notifications_notificationType" ADD VALUE IF NOT EXISTS 'tidy_report';
  END IF;
END $$;
