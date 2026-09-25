import { randomUUID } from 'node:crypto';
import {
  failure,
  success,
  type ApplyLeaveInput,
  type ApplyRegularisationInput,
  type ApproveInput,
  type HrmsCapability,
  type HrmsConnector,
  type HrmsRequest,
  type HrmsResponse,
  type LeaveBalance,
} from './types';

export type MockEmployee = {
  employeeCode: string;
  name?: string;
  balances: Record<string, number>;
  /** Probation, notice period, or anything else that blocks a request. */
  blocked?: string;
};

export type MockOptions = {
  /** How far back a leave or regularisation may be applied. */
  backdatingWindowDays?: number;
  maxRegularisationsPerMonth?: number;
  /** Simulate an HRMS that accepts writes but returns no reference. */
  returnsNoReference?: boolean;
  /** Simulate an HRMS that is down. */
  unavailable?: boolean;
  /** Restrict what this "HRMS" can do, to exercise the fallback routes. */
  capabilities?: HrmsCapability[];
};

const ALL: HrmsCapability[] = [
  'fetch_employees',
  'fetch_attendance',
  'fetch_leave_balance',
  'apply_leave',
  'apply_regularisation',
  'approve_request',
  'cancel_request',
  'read_request_status',
];

const LEAVE_LABELS: Record<string, string> = {
  CL: 'Casual leave',
  SL: 'Sick leave',
  EL: 'Earned leave',
  LWP: 'Leave without pay',
};

/**
 * A stand-in HRMS with real behaviour: balances that go down, duplicate
 * detection, backdating windows, approval states and reference numbers.
 *
 * The action engine is built and tested against this, so when a customer's
 * connector arrives only the transport changes, not the rules.
 */
export class MockHrms implements HrmsConnector {
  readonly name = 'mock';
  readonly capabilities: HrmsCapability[];

  private readonly employees = new Map<string, MockEmployee>();
  private readonly requests = new Map<string, HrmsRequest>();
  /** idempotency key -> reference, which is what makes a retry safe. */
  private readonly byIdempotencyKey = new Map<string, string>();

  constructor(private readonly options: MockOptions = {}) {
    this.capabilities = options.capabilities ?? ALL;
  }

  supports(capability: HrmsCapability): boolean {
    return this.capabilities.includes(capability);
  }

  seed(employee: Partial<MockEmployee> & { employeeCode: string }) {
    this.employees.set(employee.employeeCode, {
      ...employee,
      balances: employee.balances ?? { CL: 6, SL: 6, EL: 12, LWP: 999 },
    });
    return this;
  }

  /** Everything this HRMS currently holds, for assertions and the demo screen. */
  snapshot() {
    return {
      employees: [...this.employees.values()],
      requests: [...this.requests.values()],
    };
  }

  private guard<T>(capability: HrmsCapability): HrmsResponse<T> | null {
    if (this.options.unavailable) return failure('unavailable', 'The HRMS is not responding', true);
    if (!this.supports(capability)) {
      return failure('not_supported', `This HRMS cannot ${capability.replace(/_/g, ' ')}`);
    }
    return null;
  }

  async fetchLeaveBalance(employeeCode: string): Promise<HrmsResponse<LeaveBalance[]>> {
    const blocked = this.guard<LeaveBalance[]>('fetch_leave_balance');
    if (blocked) return blocked;

    const employee = this.employees.get(employeeCode);
    if (!employee) return failure('invalid', `No employee ${employeeCode} in the HRMS`);

    const asOf = new Date().toISOString();
    return success(
      Object.entries(employee.balances).map(([leaveType, balanceDays]) => ({
        leaveType,
        label: LEAVE_LABELS[leaveType] ?? leaveType,
        balanceDays,
        asOf,
      })),
    );
  }

  async applyLeave(input: ApplyLeaveInput): Promise<HrmsResponse<HrmsRequest>> {
    const blocked = this.guard<HrmsRequest>('apply_leave');
    if (blocked) return blocked;

    const replay = this.replay(input.idempotencyKey);
    if (replay) return replay;

    const employee = this.employees.get(input.employeeCode);
    if (!employee) return failure('invalid', `No employee ${input.employeeCode} in the HRMS`);
    if (employee.blocked) return failure('not_eligible', employee.blocked);

    const windowError = this.checkBackdating(input.fromDate);
    if (windowError) return windowError;

    const days = input.halfDay ? 0.5 : dayCount(input.fromDate, input.toDate);
    const balance = employee.balances[input.leaveType];
    if (balance === undefined) return failure('invalid', `Unknown leave type ${input.leaveType}`);
    if (balance < days) {
      return failure('not_eligible', `Only ${balance} day(s) of ${input.leaveType} left, ${days} needed`);
    }

    if (this.overlaps(input.employeeCode, input.fromDate, input.toDate)) {
      return failure('duplicate', 'A request already exists for those dates');
    }

    const request: HrmsRequest = {
      reference: `LV-${new Date(input.fromDate).getFullYear()}-${randomUUID().slice(0, 6).toUpperCase()}`,
      kind: 'leave',
      employeeCode: input.employeeCode,
      fromDate: input.fromDate,
      toDate: input.toDate,
      leaveType: input.leaveType,
      halfDay: input.halfDay ?? null,
      reason: input.reason,
      status: 'pending',
      submittedAt: new Date().toISOString(),
    };
    this.save(request, input.idempotencyKey);
    return this.respond(request);
  }

  async applyRegularisation(input: ApplyRegularisationInput): Promise<HrmsResponse<HrmsRequest>> {
    const blocked = this.guard<HrmsRequest>('apply_regularisation');
    if (blocked) return blocked;

    const replay = this.replay(input.idempotencyKey);
    if (replay) return replay;

    const employee = this.employees.get(input.employeeCode);
    if (!employee) return failure('invalid', `No employee ${input.employeeCode} in the HRMS`);

    const windowError = this.checkBackdating(input.date);
    if (windowError) return windowError;

    const limit = this.options.maxRegularisationsPerMonth;
    if (limit !== undefined) {
      const month = input.date.slice(0, 7);
      const used = [...this.requests.values()].filter(
        (r) => r.employeeCode === input.employeeCode && r.kind === 'regularisation' && r.fromDate.startsWith(month),
      ).length;
      if (used >= limit) return failure('not_eligible', `Monthly regularisation limit of ${limit} already used`);
    }

    if (this.overlaps(input.employeeCode, input.date, input.date)) {
      return failure('duplicate', 'A request already exists for that date');
    }

    const request: HrmsRequest = {
      reference: `RG-${new Date(input.date).getFullYear()}-${randomUUID().slice(0, 6).toUpperCase()}`,
      kind: 'regularisation',
      employeeCode: input.employeeCode,
      fromDate: input.date,
      toDate: input.date,
      halfDay: input.halfDay ?? null,
      reason: input.reason,
      status: 'pending',
      submittedAt: new Date().toISOString(),
    };
    this.save(request, input.idempotencyKey);
    return this.respond(request);
  }

  async approve(input: ApproveInput): Promise<HrmsResponse<HrmsRequest>> {
    const blocked = this.guard<HrmsRequest>('approve_request');
    if (blocked) return blocked;

    const replay = this.replay(input.idempotencyKey);
    if (replay) return replay;

    const request = this.requests.get(input.reference);
    if (!request) return failure('invalid', `No request ${input.reference}`);
    if (request.status !== 'pending') return failure('duplicate', `Request is already ${request.status}`);

    request.status = input.decision === 'approve' ? 'approved' : 'rejected';
    request.approver = input.approverCode;
    request.decidedAt = new Date().toISOString();

    // An approved leave consumes balance, as a real HRMS would.
    if (request.status === 'approved' && request.kind === 'leave' && request.leaveType) {
      const employee = this.employees.get(request.employeeCode);
      const days = request.halfDay ? 0.5 : dayCount(request.fromDate, request.toDate);
      if (employee && employee.balances[request.leaveType] !== undefined) {
        employee.balances[request.leaveType] = (employee.balances[request.leaveType] ?? 0) - days;
      }
    }

    this.byIdempotencyKey.set(input.idempotencyKey, request.reference);
    return success(request);
  }

  async readRequest(reference: string): Promise<HrmsResponse<HrmsRequest>> {
    const blocked = this.guard<HrmsRequest>('read_request_status');
    if (blocked) return blocked;
    const request = this.requests.get(reference);
    return request ? success(request) : failure('invalid', `No request ${reference}`);
  }

  async listOpenRequests(employeeCode: string): Promise<HrmsResponse<HrmsRequest[]>> {
    const blocked = this.guard<HrmsRequest[]>('read_request_status');
    if (blocked) return blocked;
    return success(
      [...this.requests.values()].filter((r) => r.employeeCode === employeeCode && r.status === 'pending'),
    );
  }

  private checkBackdating(date: string) {
    const window = this.options.backdatingWindowDays;
    if (window === undefined) return null;
    const age = (Date.now() - new Date(`${date}T00:00:00Z`).getTime()) / 86_400_000;
    if (age > window) {
      return failure('not_eligible', `${date} is outside the ${window}-day backdating window`);
    }
    return null;
  }

  private overlaps(employeeCode: string, from: string, to: string) {
    return [...this.requests.values()].some(
      (r) =>
        r.employeeCode === employeeCode &&
        r.status !== 'rejected' &&
        r.status !== 'cancelled' &&
        !(r.toDate < from || r.fromDate > to),
    );
  }

  private save(request: HrmsRequest, idempotencyKey: string) {
    this.requests.set(request.reference, request);
    this.byIdempotencyKey.set(idempotencyKey, request.reference);
  }

  /** A repeated call with the same key returns the original, never a second request. */
  private replay(idempotencyKey: string): HrmsResponse<HrmsRequest> | null {
    const reference = this.byIdempotencyKey.get(idempotencyKey);
    if (!reference) return null;
    const request = this.requests.get(reference);
    return request ? success(request) : null;
  }

  /** Some HRMS products accept a write and tell you nothing useful back. */
  private respond(request: HrmsRequest): HrmsResponse<HrmsRequest> {
    if (this.options.returnsNoReference) {
      return success({ ...request, reference: '' });
    }
    return success(request);
  }
}

function dayCount(from: string, to: string): number {
  const days = (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000;
  return Math.max(1, Math.round(days) + 1);
}
