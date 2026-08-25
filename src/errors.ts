export const ExitCode = {
  success: 0,
  failure: 1,
  usage: 2,
  authentication: 3,
  authorization: 4,
  notFound: 5,
  conflict: 6,
  rateLimited: 7,
  unavailable: 8,
  admission: 9,
  configuration: 10,
  interrupted: 130,
} as const;

export class CliError extends Error {
  public constructor(
    message: string,
    public readonly exitCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CliError";
  }
}

export class UsageError extends CliError {
  public constructor(message: string) {
    super(message, ExitCode.usage);
  }
}

export class ConfigurationError extends CliError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.configuration, options);
  }
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  retryable: boolean;
  traceId: string;
  details: Record<string, unknown>;
}

export class ApiError extends CliError {
  public constructor(
    public readonly problem: ProblemDetails,
    public readonly retryAfterMs?: number,
  ) {
    super(problem.detail, exitCodeForStatus(problem.status));
  }
}

export function exitCodeForStatus(status: number): number {
  if (status === 400) return ExitCode.usage;
  if (status === 401) return ExitCode.authentication;
  if (status === 403) return ExitCode.authorization;
  if (status === 404) return ExitCode.notFound;
  if (status === 409) return ExitCode.conflict;
  if (status === 429) return ExitCode.rateLimited;
  if (status === 402) return ExitCode.admission;
  if (status >= 500) return ExitCode.unavailable;
  return ExitCode.failure;
}
