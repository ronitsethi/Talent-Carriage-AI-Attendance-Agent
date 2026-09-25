/**
 * The contract every HRMS connector satisfies.
 *
 * A connector declares what its HRMS can actually do, and the action engine only
 * offers an employee what can genuinely be delivered — so a customer whose HRMS
 * has no write API never sees "shall I apply that for you?".
 */

export type HrmsCapability =
  | 'fetch_employees'
  | 'fetch_attendance'
  | 'fetch_leave_balance'
  | 'apply_leave'
  | 'apply_regularisation'
  | 'approve_request'
  | 'cancel_request'
  | 'read_request_status';

export type LeaveBalance = { leaveType: string; label: string; balanceDays: number; asOf: string };

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'unknown';

export type HrmsRequest = {
  reference: string;
  kind: 'leave' | 'regularisation';
  employeeCode: string;
  fromDate: string;
  toDate: string;
  leaveType?: string;
  halfDay?: 'first' | 'second' | null;
  reason?: string;
  status: RequestStatus;
  approver?: string;
  submittedAt?: string;
  decidedAt?: string;
};

export type ApplyLeaveInput = {
  employeeCode: string;
  fromDate: string;
  toDate: string;
  leaveType: string;
  halfDay?: 'first' | 'second' | null;
  reason?: string;
  /** Same key for the same intent: a retry must never create a second request. */
  idempotencyKey: string;
};

export type ApplyRegularisationInput = {
  employeeCode: string;
  date: string;
  halfDay?: 'first' | 'second' | null;
  reason: string;
  inTime?: string;
  outTime?: string;
  idempotencyKey: string;
};

export type ApproveInput = {
  reference: string;
  approverCode: string;
  decision: 'approve' | 'reject';
  note?: string;
  idempotencyKey: string;
};

export type HrmsResult<T> = {
  ok: true;
  data: T;
  /** Raw provider response, stored on the action as evidence. */
  raw?: unknown;
};

export type HrmsFailure = {
  ok: false;
  /** Machine-readable, so the engine can react (retry, ask HR, tell the employee). */
  code: 'not_supported' | 'not_eligible' | 'duplicate' | 'auth' | 'unavailable' | 'invalid' | 'unknown';
  message: string;
  retryable: boolean;
  raw?: unknown;
};

export type HrmsResponse<T> = HrmsResult<T> | HrmsFailure;

export interface HrmsConnector {
  readonly name: string;
  readonly capabilities: HrmsCapability[];
  supports(capability: HrmsCapability): boolean;

  fetchLeaveBalance(employeeCode: string): Promise<HrmsResponse<LeaveBalance[]>>;
  applyLeave(input: ApplyLeaveInput): Promise<HrmsResponse<HrmsRequest>>;
  applyRegularisation(input: ApplyRegularisationInput): Promise<HrmsResponse<HrmsRequest>>;
  approve(input: ApproveInput): Promise<HrmsResponse<HrmsRequest>>;
  /** Used to verify an action the HRMS did not confirm, and to close cases. */
  readRequest(reference: string): Promise<HrmsResponse<HrmsRequest>>;
  listOpenRequests(employeeCode: string): Promise<HrmsResponse<HrmsRequest[]>>;
}

export const failure = (
  code: HrmsFailure['code'],
  message: string,
  retryable = false,
  raw?: unknown,
): HrmsFailure => ({ ok: false, code, message, retryable, raw });

export const success = <T>(data: T, raw?: unknown): HrmsResult<T> => ({ ok: true, data, raw });
