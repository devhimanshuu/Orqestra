/**
 * Shared HTTP contract for Orqestra route handlers.
 *
 * Stable error envelope so clients never have to branch on message strings:
 *   { "error": { "code": "...", "message": "...", "details": ... } }
 */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
