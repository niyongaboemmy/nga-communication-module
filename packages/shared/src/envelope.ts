/**
 * The response envelope every NGA app speaks — MIS, TaskMentor and
 * Discipline all return `{success, data?, message?}`, so Tupo does too.
 * Sharing the shape here is what lets the web client's api helper be
 * written once instead of per page.
 */
export interface Envelope<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  total?: number;
}

export const ok = <T>(data: T, extra?: { total?: number }): Envelope<T> => ({
  success: true,
  data,
  ...(extra?.total !== undefined ? { total: extra.total } : {}),
});

export const fail = (message: string): Envelope<never> => ({ success: false, message });
