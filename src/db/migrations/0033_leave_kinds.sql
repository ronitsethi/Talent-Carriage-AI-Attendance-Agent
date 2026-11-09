-- Kinds of leave in the code meanings, so a leave code says which leave it is.
-- Each behaves like leave_approved; leave_approved stays for a leave whose kind is not given.
ALTER TYPE "attendance_meaning" ADD VALUE IF NOT EXISTS 'leave_earned' AFTER 'leave_approved';
--> statement-breakpoint
ALTER TYPE "attendance_meaning" ADD VALUE IF NOT EXISTS 'leave_casual' AFTER 'leave_earned';
--> statement-breakpoint
ALTER TYPE "attendance_meaning" ADD VALUE IF NOT EXISTS 'leave_sick' AFTER 'leave_casual';
--> statement-breakpoint
ALTER TYPE "attendance_meaning" ADD VALUE IF NOT EXISTS 'leave_maternity' AFTER 'leave_sick';
--> statement-breakpoint
ALTER TYPE "attendance_meaning" ADD VALUE IF NOT EXISTS 'leave_paternity' AFTER 'leave_maternity';
--> statement-breakpoint
ALTER TYPE "attendance_meaning" ADD VALUE IF NOT EXISTS 'leave_marriage' AFTER 'leave_paternity';
--> statement-breakpoint
ALTER TYPE "attendance_meaning" ADD VALUE IF NOT EXISTS 'leave_bereavement' AFTER 'leave_marriage';
--> statement-breakpoint
ALTER TYPE "attendance_meaning" ADD VALUE IF NOT EXISTS 'leave_other' AFTER 'leave_bereavement';
