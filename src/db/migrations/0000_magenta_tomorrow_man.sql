CREATE TYPE "public"."action_status" AS ENUM('draft', 'pre_check_failed', 'awaiting_approval', 'approved', 'rejected', 'executing', 'executed', 'unconfirmed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."action_type" AS ENUM('apply_leave', 'apply_regularisation', 'apply_unpaid_leave', 'approve_leave', 'approve_regularisation', 'cancel_request', 'raise_hr_ticket', 'nudge_manager', 'close_case');--> statement-breakpoint
CREATE TYPE "public"."approval_decision" AS ENUM('pending', 'approved', 'rejected', 'expired', 'delegated');--> statement-breakpoint
CREATE TYPE "public"."attendance_meaning" AS ENUM('present', 'absent_full', 'absent_first_half', 'absent_second_half', 'absent_half_unspecified', 'missed_punch', 'short_hours', 'late_in', 'early_out', 'leave_approved', 'leave_pending', 'leave_rejected', 'leave_unpaid', 'on_duty', 'work_from_home', 'travel', 'training', 'comp_off', 'weekly_off', 'holiday', 'optional_holiday', 'suspension', 'long_leave', 'not_employed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."call_outcome" AS ENUM('completed_confirmed', 'not_completed', 'needs_help', 'no_answer', 'busy', 'wrong_number', 'failed');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('queued', 'asked', 'delivered', 'read', 'answered', 'awaiting_action', 'awaiting_approval', 'resolved', 'needs_hr', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('whatsapp', 'voice', 'sms', 'email', 'portal');--> statement-breakpoint
CREATE TYPE "public"."import_source" AS ENUM('upload', 'sftp', 'blob', 'api_pull', 'db_read', 'push', 'seed');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('running', 'completed', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'claimed', 'done', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."mapping_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('template', 'text', 'interactive', 'voice', 'note');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('queued', 'sent', 'delivered', 'read', 'failed', 'received', 'simulated');--> statement-breakpoint
CREATE TYPE "public"."reply_intent" AS ENUM('was_absent', 'was_working', 'leave_already_applied', 'regularisation_already_sent', 'question', 'needs_help', 'other', 'unclear');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('onboarding', 'active', 'suspended', 'offboarded');--> statement-breakpoint
CREATE TYPE "public"."usage_kind" AS ENUM('whatsapp_conversation', 'whatsapp_message', 'ai_call', 'voice_minute', 'case_created', 'case_resolved', 'action_executed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('platform_admin', 'hr_admin', 'hr_user', 'manager', 'auditor');--> statement-breakpoint
CREATE TABLE "tenant_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"identifier" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"check_time" time DEFAULT '10:30' NOT NULL,
	"scheduler_enabled" boolean DEFAULT false NOT NULL,
	"sending_enabled" boolean DEFAULT false NOT NULL,
	"chase_meanings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"late_grace_minutes" integer DEFAULT 15 NOT NULL,
	"short_hours_grace_minutes" integer DEFAULT 30 NOT NULL,
	"quiet_hours_start" time DEFAULT '20:00' NOT NULL,
	"quiet_hours_end" time DEFAULT '09:00' NOT NULL,
	"message_on_non_working_days" boolean DEFAULT false NOT NULL,
	"exclude_first_days" integer DEFAULT 0 NOT NULL,
	"exclude_exited_employees" boolean DEFAULT true NOT NULL,
	"excluded_departments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excluded_employee_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_outstanding_questions" integer DEFAULT 0 NOT NULL,
	"send_backlog_summary" boolean DEFAULT true NOT NULL,
	"follow_up_after_days" integer DEFAULT 2 NOT NULL,
	"call_after_days" integer DEFAULT 3 NOT NULL,
	"call_retries" smallint DEFAULT 2 NOT NULL,
	"approval_timeout_hours" integer DEFAULT 24 NOT NULL,
	"approval_escalates_to" text DEFAULT 'hr' NOT NULL,
	"default_language" text DEFAULT 'en' NOT NULL,
	"languages" jsonb DEFAULT '["en"]'::jsonb NOT NULL,
	"actions_enabled" boolean DEFAULT false NOT NULL,
	"allowed_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_leave_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conversational_replies_enabled" boolean DEFAULT true NOT NULL,
	"policy_answers_enabled" boolean DEFAULT false NOT NULL,
	"model_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signature" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "tenant_status" DEFAULT 'onboarding' NOT NULL,
	"licensed_headcount" integer,
	"logo_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"password_hash" text,
	"department_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"name" text
);
--> statement-breakpoint
CREATE TABLE "calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"source" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"emp_code" text NOT NULL,
	"full_name" text NOT NULL,
	"mobile_e164" text,
	"mobile_raw" text,
	"email" text,
	"department" text,
	"branch" text,
	"location" text,
	"designation" text,
	"shift_code" text,
	"calendar_code" text,
	"manager_employee_id" uuid,
	"manager_ref" text,
	"manager_mobile_e164" text,
	"date_of_joining" date,
	"exit_date" date,
	"employment_status" text,
	"language" text,
	"whatsapp_opt_out" boolean DEFAULT false NOT NULL,
	"call_opt_out" boolean DEFAULT false NOT NULL,
	"consent_at" timestamp with time zone,
	"source_row" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"leave_type" text NOT NULL,
	"balance_days" smallint NOT NULL,
	"as_of" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"start_time" time,
	"end_time" time,
	"weekly_off_days" jsonb DEFAULT '[0]'::jsonb NOT NULL,
	"min_minutes_full_day" integer,
	"min_minutes_half_day" integer,
	"is_default" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"code" text NOT NULL,
	"meaning" "attendance_meaning" NOT NULL,
	"chase" boolean,
	"notes" text,
	"ai_suggested" boolean DEFAULT false NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" "import_source" NOT NULL,
	"status" "import_status" DEFAULT 'running' NOT NULL,
	"profile_id" uuid,
	"filename" text,
	"source_ref" text,
	"date_from" text,
	"date_to" text,
	"report" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "mapping_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "mapping_status" DEFAULT 'draft' NOT NULL,
	"hrms_hint" text,
	"field_map" jsonb NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"superseded_by" uuid
);
--> statement-breakpoint
CREATE TABLE "unmapped_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"sample_employee_code" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attendance_days" (
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"att_date" date NOT NULL,
	"raw_status" text,
	"first_half" text,
	"second_half" text,
	"meaning" "attendance_meaning" NOT NULL,
	"worked_minutes" integer,
	"late_minutes" integer,
	"early_out_minutes" integer,
	"shift_code" text,
	"is_working_day" boolean DEFAULT true NOT NULL,
	"import_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_days_tenant_id_employee_id_att_date_pk" PRIMARY KEY("tenant_id","employee_id","att_date")
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"att_date" date NOT NULL,
	"meaning" "attendance_meaning" NOT NULL,
	"raw_status" text,
	"status" "case_status" DEFAULT 'queued' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"asked_at" timestamp with time zone,
	"first_message_id" uuid,
	"answered_at" timestamp with time zone,
	"reply_option" smallint,
	"reply_intent" "reply_intent",
	"reply_text" text,
	"ai_used" boolean DEFAULT false NOT NULL,
	"follow_up_due_at" timestamp with time zone,
	"follow_up_sent_at" timestamp with time zone,
	"follow_up_reply" text,
	"call_due_at" timestamp with time zone,
	"call_attempts" integer DEFAULT 0 NOT NULL,
	"closed_by_revision" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone,
	"close_reason" text,
	"needs_hr_reason" text,
	"assigned_to_user_id" uuid,
	"error" text,
	"detected_by_import_id" uuid,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "detection_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_for" date NOT NULL,
	"trigger" text NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"gaps_found" integer DEFAULT 0 NOT NULL,
	"cases_created" integer DEFAULT 0 NOT NULL,
	"cases_queued" integer DEFAULT 0 NOT NULL,
	"messages_sent" integer DEFAULT 0 NOT NULL,
	"skipped" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"channel" "channel" DEFAULT 'whatsapp' NOT NULL,
	"window_expires_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"active_case_id" uuid,
	"language" text,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid,
	"case_id" uuid,
	"direction" "message_direction" NOT NULL,
	"channel" "channel" DEFAULT 'whatsapp' NOT NULL,
	"kind" "message_kind" NOT NULL,
	"status" "message_status" DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"reply_to_provider_id" text,
	"wa_id" text,
	"template_name" text,
	"language" text,
	"body" text,
	"buttons" jsonb,
	"payload" jsonb,
	"ai_model" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"provider_name" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"body_preview" text NOT NULL,
	"variable_count" integer DEFAULT 2 NOT NULL,
	"buttons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_status" text DEFAULT 'unknown' NOT NULL,
	"approval_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid,
	"employee_id" uuid NOT NULL,
	"type" "action_type" NOT NULL,
	"status" "action_status" DEFAULT 'draft' NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pre_checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_via" "channel",
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by_user_id" uuid,
	"idempotency_key" text NOT NULL,
	"connector" text,
	"hrms_reference" text,
	"hrms_response" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"executed_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"approver_employee_id" uuid,
	"approver_user_id" uuid,
	"sequence" smallint DEFAULT 1 NOT NULL,
	"decision" "approval_decision" DEFAULT 'pending' NOT NULL,
	"channel" "channel" DEFAULT 'whatsapp' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"note" text,
	"nudges" smallint DEFAULT 0 NOT NULL,
	"timeout_at" timestamp with time zone,
	"escalated_to" text,
	"delegated_to_employee_id" uuid
);
--> statement-breakpoint
CREATE TABLE "ai_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid,
	"message_id" uuid,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_text" text,
	"output" jsonb,
	"confidence" text,
	"fallback_used" boolean DEFAULT false NOT NULL,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"citations" jsonb,
	"reviewed_by" uuid,
	"review_verdict" text,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid,
	"employee_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_call_id" text,
	"from_number" text,
	"to_number" text,
	"attempt" smallint DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"outcome" "call_outcome",
	"transcript" jsonb,
	"recording_uri" text,
	"used_keypad_fallback" boolean DEFAULT false NOT NULL,
	"duration_seconds" integer,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "consent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text,
	"priority" smallint DEFAULT 5 NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"max_attempts" smallint DEFAULT 5 NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"finished_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pack_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"heading" text,
	"text" text NOT NULL,
	"citation" text
);
--> statement-breakpoint
CREATE TABLE "policy_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pack_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"uri" text,
	"text" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "usage_kind" NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"cost_micros" bigint,
	"channel" "channel",
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_channels" ADD CONSTRAINT "tenant_channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_days" ADD CONSTRAINT "calendar_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_days" ADD CONSTRAINT "calendar_days_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_history" ADD CONSTRAINT "employee_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_history" ADD CONSTRAINT "employee_history_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_mappings" ADD CONSTRAINT "code_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_mappings" ADD CONSTRAINT "code_mappings_profile_id_mapping_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."mapping_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_profile_id_mapping_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."mapping_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_profiles" ADD CONSTRAINT "mapping_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_profiles" ADD CONSTRAINT "mapping_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmapped_codes" ADD CONSTRAINT "unmapped_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_detected_by_import_id_imports_id_fk" FOREIGN KEY ("detected_by_import_id") REFERENCES "public"."imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detection_runs" ADD CONSTRAINT "detection_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_active_case_id_cases_id_fk" FOREIGN KEY ("active_case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_employee_id_employees_id_fk" FOREIGN KEY ("approver_employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_chunks" ADD CONSTRAINT "policy_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_chunks" ADD CONSTRAINT "policy_chunks_pack_id_policy_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."policy_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_chunks" ADD CONSTRAINT "policy_chunks_source_id_policy_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."policy_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_packs" ADD CONSTRAINT "policy_packs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_packs" ADD CONSTRAINT "policy_packs_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_sources" ADD CONSTRAINT "policy_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_sources" ADD CONSTRAINT "policy_sources_pack_id_policy_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."policy_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_channels_kind_key" ON "tenant_channels" USING btree ("tenant_id","kind","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_days_key" ON "calendar_days" USING btree ("calendar_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_tenant_code_key" ON "calendars" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "employee_history_employee_idx" ON "employee_history" USING btree ("employee_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_tenant_code_key" ON "employees" USING btree ("tenant_id","emp_code");--> statement-breakpoint
CREATE INDEX "employees_tenant_mobile_idx" ON "employees" USING btree ("tenant_id","mobile_e164");--> statement-breakpoint
CREATE INDEX "employees_manager_idx" ON "employees" USING btree ("manager_employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_balances_key" ON "leave_balances" USING btree ("employee_id","leave_type");--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_tenant_code_key" ON "shifts" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "code_mappings_key" ON "code_mappings" USING btree ("profile_id","code");--> statement-breakpoint
CREATE INDEX "imports_tenant_idx" ON "imports" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mapping_profiles_version_key" ON "mapping_profiles" USING btree ("tenant_id","name","version");--> statement-breakpoint
CREATE INDEX "mapping_profiles_active_idx" ON "mapping_profiles" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "unmapped_codes_key" ON "unmapped_codes" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "attendance_days_date_idx" ON "attendance_days" USING btree ("tenant_id","att_date","meaning");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_employee_date_key" ON "cases" USING btree ("tenant_id","employee_id","att_date");--> statement-breakpoint
CREATE INDEX "cases_tenant_status_idx" ON "cases" USING btree ("tenant_id","status","att_date");--> statement-breakpoint
CREATE INDEX "cases_employee_open_idx" ON "cases" USING btree ("employee_id","status","att_date");--> statement-breakpoint
CREATE INDEX "cases_follow_up_idx" ON "cases" USING btree ("tenant_id","follow_up_due_at");--> statement-breakpoint
CREATE INDEX "cases_call_due_idx" ON "cases" USING btree ("tenant_id","call_due_at");--> statement-breakpoint
CREATE INDEX "detection_runs_tenant_idx" ON "detection_runs" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_employee_channel_key" ON "conversations" USING btree ("employee_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_id_key" ON "messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "messages_case_idx" ON "messages" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_tenant_idx" ON "messages" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_key" ON "templates" USING btree ("tenant_id","purpose","language");--> statement-breakpoint
CREATE UNIQUE INDEX "actions_idempotency_key" ON "actions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "actions_case_idx" ON "actions" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "actions_status_idx" ON "actions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "approvals_action_idx" ON "approvals" USING btree ("action_id","sequence");--> statement-breakpoint
CREATE INDEX "approvals_pending_idx" ON "approvals" USING btree ("tenant_id","decision","timeout_at");--> statement-breakpoint
CREATE INDEX "ai_decisions_tenant_idx" ON "ai_decisions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_decisions_review_idx" ON "ai_decisions" USING btree ("tenant_id","review_verdict");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_idx" ON "audit_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "calls_case_idx" ON "calls" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "calls_tenant_idx" ON "calls" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "consent_events_employee_idx" ON "consent_events" USING btree ("employee_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_key" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_ready_idx" ON "jobs" USING btree ("status","run_at","priority");--> statement-breakpoint
CREATE INDEX "policy_chunks_pack_idx" ON "policy_chunks" USING btree ("pack_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_packs_key" ON "policy_packs" USING btree ("tenant_id","name","version");--> statement-breakpoint
CREATE INDEX "policy_sources_pack_idx" ON "policy_sources" USING btree ("pack_id");--> statement-breakpoint
CREATE INDEX "usage_events_tenant_idx" ON "usage_events" USING btree ("tenant_id","kind","occurred_at");