-- Add the 'rn_review' case status. Completed drafts now wait here for the RN to review/edit and
-- then explicitly "Send to doctor for review" (-> physician_review), instead of auto-routing to the
-- doctor's queue. (Ryan 2026-06-04: "once a draft is complete it should not route to the doctor
-- ... they ... click a button to send to doctor for review.")
--
-- The Prisma enum CaseStatus maps to the Postgres type "case_status". ADD VALUE is safe on the
-- RDS Postgres version (>= 12) and AFTER 'drafting' keeps the DB order matching schema.prisma.
ALTER TYPE "case_status" ADD VALUE IF NOT EXISTS 'rn_review' AFTER 'drafting';
